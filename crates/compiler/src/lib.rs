//! Typfolio's Typst compiler for WebAssembly, the binary shipped as `@typfolio/wasm`.
//!
//! A [`Compiler`] holds fonts. For each document the caller mounts files at absolute virtual paths (the template's
//! sources, its data as JSON, assets, the files of a Typst package), names the packages those mounts serve, and
//! compiles an entry file to a PDF. The result is the PDF bytes, the document title and the diagnostics as data.
//!
//! Everything is in memory and nothing reaches out of the module: no file system, no network, no clock (the caller
//! passes the time) and no JavaScript callbacks. The generated loader therefore needs only `'wasm-unsafe-eval'` under a
//! Content Security Policy. `@typfolio/core` is the intended caller (`packages/core/src/engine.ts`); this surface is
//! not a public API and can change with any release of that package.

mod diagnostics;
mod options;
mod world;

use typst::diag::Warned;
use typst::model::Document as _;
use typst::syntax::package::PackageSpec;
use typst_layout::PagedDocument;
use wasm_bindgen::prelude::*;

use crate::diagnostics::Diagnostic;
use crate::options::{CompileOptions, feature_names, pdf_options};
use crate::world::{CompileWorld, Fonts, LibraryCache, Vfs, project_file};

/// Memoized Typst results older than this many compiles are dropped after each compile, so repeating a document
/// stays incremental while memory does not grow with every document ever compiled.
const CACHE_AGE: usize = 10;

/// A Typst compiler with its fonts. Mount files, then `compile`; `reset` between documents.
#[wasm_bindgen]
pub struct Compiler {
    fonts: Fonts,
    vfs: Vfs,
    library: LibraryCache,
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Compiler {
        Compiler { fonts: Fonts::default(), vfs: Vfs::default(), library: LibraryCache::default() }
    }

    /// Adds every face of a font file (OpenType, TrueType, or a collection) and returns how many were added.
    /// Fails when the data has no readable face. Fonts are searched in the order they were added.
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, data: Vec<u8>) -> Result<u32, JsError> {
        self.fonts.add(data).map_err(|message| JsError::new(&message))
    }

    /// Mounts a file at an absolute virtual path (`/main.typ`, `/assets/logo.png`) for the next compile.
    pub fn mount(&mut self, path: &str, data: Vec<u8>) -> Result<(), JsError> {
        let id = project_file(path).map_err(|message| JsError::new(&message))?;
        self.vfs.mount(id, data);
        Ok(())
    }

    /// Serves a Typst package (`@local/typfolio:0.1.0`) from a mounted directory: a file `/lib.typ` of the package is
    /// read at `<directory>/lib.typ`. Any other package import fails with a diagnostic naming the available ones.
    #[wasm_bindgen(js_name = mountPackage)]
    pub fn mount_package(&mut self, spec: &str, directory: &str) -> Result<(), JsError> {
        let spec: PackageSpec = spec.parse().map_err(|error| JsError::new(&format!("invalid package spec {spec:?}: {error}")))?;
        let directory = project_file(directory).map_err(|message| JsError::new(&message))?;
        self.vfs.mount_package(spec, directory);
        Ok(())
    }

    /// Unmounts every file and package. A file mounted again with the same bytes keeps its parsed source.
    pub fn reset(&mut self) {
        self.vfs.reset();
    }

    /// Compiles the mounted file at `entrypoint` and exports it as PDF. `options` is JSON:
    /// `{ inputs?: Record<string, string>, pdf?: { standard?, tags?, creationTimestamp? }, features?: string[], now?: { unixSeconds, utcOffsetMinutes? } }`
    /// (see `options.rs`). `features` are Typst's in-development features (`a11y-extras`, `html`, `bundle`); without
    /// the field `a11y-extras` is on. Fails only for a malformed request; a document that does not compile or export is a
    /// `Compiled` without PDF whose diagnostics say why.
    pub fn compile(&mut self, entrypoint: &str, options: &str) -> Result<Compiled, JsError> {
        let options: CompileOptions = serde_json::from_str(options).map_err(|error| JsError::new(&format!("invalid compile options: {error}")))?;
        let main = project_file(entrypoint).map_err(|message| JsError::new(&message))?;
        if !self.vfs.has(main) {
            return Err(JsError::new(&format!("the entrypoint {entrypoint} is not mounted")));
        }
        // Checked before compiling, so a bad standard or feature is a request error and never a compile that went to waste.
        let pdf = pdf_options(&options.pdf, options.now).map_err(|message| JsError::new(&message))?;
        let features = feature_names(&options.features).map_err(|message| JsError::new(&message))?;
        let library = self.library.get(&options.inputs, &features);
        let world = CompileWorld::new(library, &self.fonts, &self.vfs, main, &options);

        let Warned { output, warnings } = typst::compile::<PagedDocument>(&world);
        let mut diagnostics = Vec::new();
        diagnostics::convert(&world, &warnings, &mut diagnostics);
        let result = match output {
            Err(errors) => {
                diagnostics::convert(&world, &errors, &mut diagnostics);
                Compiled::new(None, diagnostics, None)
            }
            Ok(document) => {
                let title = document.info().title.as_ref().map(|title| title.to_string());
                match typst_pdf::pdf(&document, &pdf) {
                    Ok(pdf) => Compiled::new(Some(pdf), diagnostics, title),
                    Err(errors) => {
                        diagnostics::convert(&world, &errors, &mut diagnostics);
                        Compiled::new(None, diagnostics, title)
                    }
                }
            }
        };
        comemo::evict(CACHE_AGE);
        Ok(result)
    }
}

impl Default for Compiler {
    fn default() -> Self {
        Self::new()
    }
}

/// What a compile produced: the PDF when the document compiled and exported, the title, and the diagnostics.
#[wasm_bindgen]
pub struct Compiled {
    ok: bool,
    pdf: Option<Vec<u8>>,
    diagnostics: Vec<Diagnostic>,
    title: Option<String>,
}

impl Compiled {
    fn new(pdf: Option<Vec<u8>>, diagnostics: Vec<Diagnostic>, title: Option<String>) -> Self {
        Compiled { ok: pdf.is_some(), pdf, diagnostics, title }
    }
}

#[wasm_bindgen]
impl Compiled {
    /// Whether a PDF was produced (also after `takePdf`). When `false`, `diagnostics` has at least one error.
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.ok
    }

    /// The PDF bytes, handed over once: the second call returns `undefined`.
    #[wasm_bindgen(js_name = takePdf)]
    pub fn take_pdf(&mut self) -> Option<Vec<u8>> {
        self.pdf.take()
    }

    /// The diagnostics as a JSON array of `{ severity, message, hints?, path?, range?, package? }` (see `diagnostics.rs`).
    #[wasm_bindgen(getter)]
    pub fn diagnostics(&self) -> String {
        serde_json::to_string(&self.diagnostics).expect("diagnostics are plain strings")
    }

    /// The document title (`set document(title: …)`) when the document compiled.
    #[wasm_bindgen(getter)]
    pub fn title(&self) -> Option<String> {
        self.title.clone()
    }
}
