//! The in-memory world a compile runs in: the mounted files, the fonts, the packages served from mounts, the standard
//! library with its `sys.inputs`, and the caller's clock.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::OnceLock;

use typst::diag::{FileError, FileResult, PackageError};
use typst::ecow::eco_format;
use typst::foundations::{Bytes, Datetime, Dict, Duration, Value};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

use crate::options::{CompileOptions, Now, date_from_unix};

/// The id of a file at an absolute virtual path in the project root.
pub fn project_file(path: &str) -> Result<FileId, String> {
    let vpath = VirtualPath::new(path).map_err(|error| format!("invalid virtual path {path:?}: {error}"))?;
    Ok(FileId::new(RootedPath::new(VirtualRoot::Project, vpath)))
}

/// The fonts of a compiler, in the order they were added, and their book.
#[derive(Default)]
pub struct Fonts {
    fonts: Vec<Font>,
    book: LazyHash<FontBook>,
}

impl Fonts {
    /// Adds every face of a font file; returns how many, or an error when the data has none.
    pub fn add(&mut self, data: Vec<u8>) -> Result<u32, String> {
        let bytes = Bytes::new(data);
        let mut added = 0;
        // A collection holds several faces; a single font ends the loop at index 1.
        while let Some(font) = Font::new(bytes.clone(), added) {
            self.fonts.push(font);
            added += 1;
        }
        if added == 0 {
            return Err("not a font file: no face could be read (OpenType, TrueType or a collection of them is expected)".into());
        }
        self.book = LazyHash::new(FontBook::from_fonts(&self.fonts));
        Ok(added)
    }
}

/// A mounted file: its bytes and, once a compile has parsed it as Typst source, that source.
struct Slot {
    bytes: Bytes,
    source: OnceLock<(FileId, FileResult<Source>)>,
}

/// A Typst package served from a mounted directory.
struct PackageMount {
    spec: PackageSpec,
    directory: FileId,
}

/// The virtual file system of the next compile.
#[derive(Default)]
pub struct Vfs {
    files: HashMap<FileId, Slot>,
    packages: Vec<PackageMount>,
    /// The files of the previous document, kept until the next compile so a file mounted again with the same bytes
    /// reuses its parsed source (the common case: the same template with new data).
    previous: HashMap<FileId, Slot>,
}

impl Vfs {
    pub fn mount(&mut self, id: FileId, data: Vec<u8>) {
        let slot = match self.previous.remove(&id) {
            Some(slot) if slot.bytes.as_slice() == data.as_slice() => slot,
            _ => Slot { bytes: Bytes::new(data), source: OnceLock::new() },
        };
        self.files.insert(id, slot);
    }

    pub fn mount_package(&mut self, spec: PackageSpec, directory: FileId) {
        self.packages.retain(|mount| mount.spec != spec);
        self.packages.push(PackageMount { spec, directory });
    }

    pub fn has(&self, id: FileId) -> bool {
        self.files.contains_key(&id)
    }

    pub fn reset(&mut self) {
        self.previous = std::mem::take(&mut self.files);
        self.packages.clear();
    }

    /// The slot a file id reads: a project file directly, a package file through the package's mounted directory.
    fn slot(&self, id: FileId) -> FileResult<&Slot> {
        let rooted = id.get();
        match rooted.root() {
            VirtualRoot::Project => self.files.get(&id).ok_or_else(|| not_found(rooted.vpath().get_with_slash())),
            VirtualRoot::Package(spec) => {
                let Some(mount) = self.packages.iter().find(|mount| mount.spec == *spec) else {
                    let available = self.packages.iter().map(|mount| mount.spec.to_string()).collect::<Vec<_>>();
                    let message = match available.as_slice() {
                        [] => eco_format!("No Typst packages are available; remote Typst packages are not supported (requested {spec})"),
                        _ => eco_format!("Only {} is available; remote Typst packages are not supported (requested {spec})", available.join(", ")),
                    };
                    return Err(FileError::Package(PackageError::Other(Some(message))));
                };
                let path = format!("{}{}", mount.directory.get().vpath().get_with_slash(), rooted.vpath().get_with_slash());
                let vpath = VirtualPath::new(&path).map_err(|_| not_found(&path))?;
                self.files.get(&FileId::new(RootedPath::new(VirtualRoot::Project, vpath))).ok_or_else(|| not_found(&path))
            }
        }
    }
}

fn not_found(path: &str) -> FileError {
    FileError::NotFound(PathBuf::from(path))
}

/// The standard library for the last `sys.inputs` seen; building it is not free, and the inputs rarely change.
#[derive(Default)]
pub struct LibraryCache {
    entry: Option<(BTreeMap<String, String>, LazyHash<Library>)>,
}

impl LibraryCache {
    pub fn get(&mut self, inputs: &BTreeMap<String, String>) -> &LazyHash<Library> {
        if self.entry.as_ref().is_none_or(|(cached, _)| cached != inputs) {
            let dict: Dict = inputs.iter().map(|(key, value)| (key.as_str().into(), Value::Str(value.as_str().into()))).collect();
            let library = Library::builder().with_inputs(dict).build();
            self.entry = Some((inputs.clone(), LazyHash::new(library)));
        }
        &self.entry.as_ref().expect("just set").1
    }
}

/// One compile's view of the compiler's state.
pub struct CompileWorld<'a> {
    library: &'a LazyHash<Library>,
    fonts: &'a Fonts,
    vfs: &'a Vfs,
    main: FileId,
    /// What `datetime.today()` is relative to: the requested creation timestamp, else the caller's clock.
    now: Option<Now>,
}

impl<'a> CompileWorld<'a> {
    pub fn new(library: &'a LazyHash<Library>, fonts: &'a Fonts, vfs: &'a Vfs, main: FileId, options: &CompileOptions) -> Self {
        let now = match (options.pdf.creation_timestamp, options.now) {
            (Some(unix_seconds), clock) => Some(Now { unix_seconds, utc_offset_minutes: clock.map_or(0, |clock| clock.utc_offset_minutes) }),
            (None, clock) => clock,
        };
        CompileWorld { library, fonts, vfs, main, now }
    }
}

impl World for CompileWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.fonts.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        let slot = self.vfs.slot(id)?;
        let parse = || (id, std::str::from_utf8(&slot.bytes).map(|text| Source::new(id, text.into())).map_err(|_| FileError::InvalidUtf8));
        match slot.source.get_or_init(parse) {
            // The same bytes read under another id (a package file also mounted as a project file) are parsed again.
            (cached, _) if *cached != id => parse().1,
            (_, source) => source.clone(),
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        Ok(self.vfs.slot(id)?.bytes.clone())
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.fonts.get(index).cloned()
    }

    /// Without an offset the caller's local date; with one, the UTC date shifted by it (as Typst specifies).
    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let now = self.now?;
        let shift = match offset {
            None => i64::from(now.utc_offset_minutes) * 60,
            Some(offset) => offset.seconds() as i64,
        };
        date_from_unix(now.unix_seconds + shift)
    }
}
