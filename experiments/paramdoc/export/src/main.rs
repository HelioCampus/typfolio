//! paramdoc-export: compiles a slot-dialect template with Typst, exports its frames as a parametric document
//! and checks that nothing outside the declared slots depends on the data.
//!
//! Usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};
use subsetter::GlyphRemapper;
use ttf_parser::GlyphId;
use typst::diag::{FileError, FileResult, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime, Duration, Label, Smart, StyleChain, Value};
use typst::introspection::{Location, MetadataElem, Tag};
use typst::layout::{Abs, Frame, FrameItem, HideElem, Point, RepeatElem, Size, Transform};
use typst::model::{Destination, Document as _, EnumElem, EnumItem, FigureElem, HeadingElem, LinkMarker, ListElem, ListItem, ParElem, TableCell, TableElem};
use typst::pdf::{ArtifactElem, PdfMarkerTag, PdfMarkerTagKind, TableCellKind, TableHeaderScope};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, TextItem};
use typst::utils::{LazyHash, PicoStr};
use typst::visualize::{Curve, CurveItem, ExchangeFormat, FixedStroke, Geometry, Image, ImageElem, ImageKind, ImageScaling, Paint, RasterFormat, Shape};
use typst::{Library, LibraryExt, World, WorldExt};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

use paramdoc_ir as ir;

// ---------------------------------------------------------------------------------------------------------
// World

/// A font from the fonts directory, with the character map and advances the runtimes will read from it, and
/// the name of a table that makes it one they cannot draw as Typst does (colour glyphs, variation axes).
struct LoadedFont { font: Font, file: String, sha256: String, cmap: HashMap<char, u16>, advances: Vec<u16>, units_per_em: f64, unsupported: Option<&'static str> }

fn font_tables(face: &ttf_parser::Face) -> (HashMap<char, u16>, Vec<u16>, f64, Option<&'static str>) {
    let mut chars = BTreeSet::new();
    if let Some(table) = face.tables().cmap {
        for subtable in table.subtables {
            if subtable.is_unicode() { subtable.codepoints(|cp| { if let Some(c) = char::from_u32(cp) { chars.insert(c); } }); }
        }
    }
    let cmap = chars.into_iter().filter_map(|c| face.glyph_index(c).map(|g| (c, g.0))).collect();
    let advances = (0..face.number_of_glyphs()).map(|g| face.glyph_hor_advance(GlyphId(g)).unwrap_or(0)).collect();
    let t = face.tables();
    let unsupported = if t.colr.is_some() { Some("COLR (colour glyphs)") }
        else if t.cbdt.is_some() { Some("CBDT (bitmap colour glyphs)") }
        else if t.sbix.is_some() { Some("sbix (bitmap glyphs)") }
        else if t.svg.is_some() { Some("SVG (colour glyphs)") }
        else if t.fvar.is_some() { Some("fvar (variation axes)") }
        else { None };
    (cmap, advances, face.units_per_em() as f64, unsupported)
}

struct MemWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    files: HashMap<FileId, Bytes>,
    main: FileId,
}

fn file_id(vpath: &str) -> Result<FileId> {
    let path = VirtualPath::new(vpath).map_err(|e| anyhow!("invalid virtual path {vpath}: {e:?}"))?;
    Ok(FileId::new(RootedPath::new(VirtualRoot::Project, path)))
}

impl MemWorld {
    /// `forced` is a band name and variant: the compile then sees `sys.inputs.paramdoc-variant = "<band>=<k>"`.
    fn new(fixture: &Path, data: &[u8], fonts: &[LoadedFont], forced: Option<(&str, u32)>) -> Result<Self> {
        let mut files = HashMap::new();
        for path in walk_files(fixture)? {
            let rel = path.strip_prefix(fixture)?.to_string_lossy().replace('\\', "/");
            let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            files.insert(file_id(&format!("/{rel}"))?, Bytes::new(bytes));
        }
        // Images arrive in the data as data URLs; Typst reads files, so each becomes one under /paramdoc-images/.
        let (data, images) = virtualize_images(data)?;
        files.insert(file_id("/data.json")?, Bytes::new(data));
        for (path, bytes) in images { files.insert(file_id(&path)?, Bytes::new(bytes)); }
        let fonts: Vec<Font> = fonts.iter().map(|f| f.font.clone()).collect();
        Ok(Self {
            library: LazyHash::new(match forced {
                Some((name, k)) => {
                    let mut inputs = typst::foundations::Dict::new();
                    inputs.insert("paramdoc-variant".into(), Value::Str(format!("{name}={k}").into()));
                    Library::builder().with_inputs(inputs).build()
                }
                None => Library::default(),
            }),
            book: LazyHash::new(FontBook::from_fonts(&fonts)),
            fonts,
            files,
            main: file_id("/main.typ")?,
        })
    }
}

impl World for MemWorld {
    fn library(&self) -> &LazyHash<Library> { &self.library }
    fn book(&self) -> &LazyHash<FontBook> { &self.book }
    fn main(&self) -> FileId { self.main }
    fn source(&self, id: FileId) -> FileResult<Source> {
        let bytes = self.file(id)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, text.to_string()))
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.get(&id).cloned().ok_or_else(|| FileError::NotFound(PathBuf::from(id.get().vpath().get_with_slash())))
    }
    fn font(&self, index: usize) -> Option<Font> { self.fonts.get(index).cloned() }
    // Fixed so that `datetime.today()` cannot make the layout differ between runs.
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> { Datetime::from_ymd(2026, 10, 24) }
}

fn walk_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() { out.extend(walk_files(&path)?); } else { out.push(path); }
    }
    out.sort();
    Ok(out)
}

/// Replaces every `data:image/…;base64,…` string in the JSON data with the path of a virtual file holding the
/// decoded bytes, so that the sample compiles from the same data the runtime gets.
fn virtualize_images(data: &[u8]) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>)> {
    let mut value: serde_json::Value = serde_json::from_slice(data).context("parsing the data")?;
    fn walk(value: &mut serde_json::Value, images: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
        match value {
            serde_json::Value::String(s) if s.starts_with("data:image/") => {
                let (ext, bytes) = decode_data_url(s)?;
                let path = format!("/paramdoc-images/{}.{ext}", images.len());
                images.push((path.clone(), bytes));
                *s = path;
            }
            serde_json::Value::Array(items) => for item in items { walk(item, images)?; },
            serde_json::Value::Object(map) => for item in map.values_mut() { walk(item, images)?; },
            _ => {}
        }
        Ok(())
    }
    let mut images = Vec::new();
    walk(&mut value, &mut images)?;
    Ok((serde_json::to_vec(&value)?, images))
}

/// The extension and bytes of a `data:image/png;base64,…` or `data:image/jpeg;base64,…` URL.
fn decode_data_url(url: &str) -> Result<(&'static str, Vec<u8>)> {
    let rest = url.strip_prefix("data:").ok_or_else(|| anyhow!("not a data URL"))?;
    let (header, payload) = rest.split_once(',').ok_or_else(|| anyhow!("data URL without a comma"))?;
    let (mime, encoding) = header.split_once(';').unwrap_or((header, ""));
    if encoding != "base64" { bail!("data URL is not base64-encoded: {header}"); }
    let ext = match mime { "image/png" => "png", "image/jpeg" | "image/jpg" => "jpg", other => bail!("unsupported image type {other} (PNG or JPEG)") };
    Ok((ext, base64_decode(payload)?))
}

fn base64_decode(text: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62, b'/' | b'_' => 63, b'=' | b'\n' | b'\r' | b' ' => continue,
            other => bail!("invalid base64 character {:?}", other as char),
        };
        buffer = (buffer << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((buffer >> bits) as u8); buffer &= (1 << bits) - 1; }
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (chunk.get(1).copied().unwrap_or(0) as u32) << 8 | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn load_fonts(dir: &Path) -> Result<Vec<LoadedFont>> {
    let mut fonts = Vec::new();
    for path in walk_files(dir)? {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "otf" | "ttf" | "ttc" | "otc") { continue; }
        let data = fs::read(&path)?;
        let sha256 = hex(&Sha256::digest(&data));
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        let mut tables = Vec::new();
        for index in 0..64u32 {
            let Ok(face) = ttf_parser::Face::parse(&data, index) else { break };
            tables.push(font_tables(&face));
        }
        let bytes = Bytes::new(data);
        for (index, (cmap, advances, units_per_em, unsupported)) in tables.into_iter().enumerate() {
            match Font::new(bytes.clone(), index as u32) {
                Some(font) => fonts.push(LoadedFont { font, file: file.clone(), sha256: sha256.clone(), cmap, advances, units_per_em, unsupported }),
                None => break,
            }
        }
    }
    if fonts.is_empty() { bail!("no fonts found in {}", dir.display()); }
    Ok(fonts)
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

// ---------------------------------------------------------------------------------------------------------
// Compile

fn compile(world: &MemWorld) -> Result<PagedDocument> {
    let Warned { output, warnings } = typst::compile::<PagedDocument>(world);
    for warning in &warnings { eprintln!("warning: {}", format_diag(world, warning)); }
    output.map_err(|errors| anyhow!("{}", errors.iter().map(|e| format_diag(world, e)).collect::<Vec<_>>().join("\n")))
}

fn format_diag(world: &MemWorld, diag: &SourceDiagnostic) -> String {
    let mut text = String::new();
    if let Some(id) = diag.span.id()
        && let Ok(source) = world.source(id)
        && let Some(range) = world.range(diag.span)
    {
        let line = source.lines().byte_to_line(range.start).map(|l| l + 1).unwrap_or(0);
        let column = source.lines().byte_to_column(range.start).map(|c| c + 1).unwrap_or(0);
        text.push_str(&format!("{}:{line}:{column}: ", id.get().vpath().get_with_slash()));
    }
    text.push_str(&diag.message);
    for hint in &diag.hints { text.push_str(&format!("\n  hint: {}", hint.v)); }
    text
}

// ---------------------------------------------------------------------------------------------------------
// Geometry and item conversion

#[derive(Clone, Copy, Debug)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }

impl Rect {
    const EPS: f64 = 1e-6;
    fn same(&self, other: &Rect) -> bool {
        (self.x - other.x).abs() < Self::EPS && (self.y - other.y).abs() < Self::EPS && (self.w - other.w).abs() < Self::EPS && (self.h - other.h).abs() < Self::EPS
    }
    fn bottom(&self) -> f64 { self.y + self.h }
    /// Whether `inner` lies inside this rectangle (with a small tolerance).
    fn encloses(&self, inner: &Rect) -> bool {
        inner.x >= self.x - 0.01 && inner.y >= self.y - 0.01 && inner.x + inner.w <= self.x + self.w + 0.01 && inner.bottom() <= self.bottom() + 0.01
    }
}

fn pt(a: Abs) -> f64 { a.to_pt() }
fn point(p: Point) -> [f64; 2] { [pt(p.x), pt(p.y)] }
fn matrix(t: Transform) -> [f64; 6] { [t.sx.get(), t.ky.get(), t.kx.get(), t.sy.get(), pt(t.tx), pt(t.ty)] }

fn is_translation(t: Transform) -> bool {
    (t.sx.get() - 1.0).abs() < 1e-9 && (t.sy.get() - 1.0).abs() < 1e-9 && t.kx.get().abs() < 1e-9 && t.ky.get().abs() < 1e-9
}

/// Maps a point through a transform: `x' = sx·x + kx·y + tx`, `y' = ky·x + sy·y + ty`.
fn apply(t: Transform, p: Point) -> Point {
    Point::new(t.sx.get() * p.x + t.kx.get() * p.y + t.tx, t.ky.get() * p.x + t.sy.get() * p.y + t.ty)
}

/// Absolute transform of a child frame placed at `pos` inside a parent with absolute transform `acc`.
fn child_transform(acc: Transform, pos: Point, own: Transform) -> Transform {
    acc.pre_concat(Transform::translate(pos.x, pos.y)).pre_concat(own)
}

fn curve_ops(curve: &Curve) -> Vec<ir::PathOp> {
    curve.0.iter().map(|item| match item {
        CurveItem::Move(p) => ir::PathOp::Move { to: point(*p) },
        CurveItem::Line(p) => ir::PathOp::Line { to: point(*p) },
        CurveItem::Cubic(c1, c2, p) => ir::PathOp::Cubic { c1: point(*c1), c2: point(*c2), to: point(*p) },
        CurveItem::Close => ir::PathOp::Close,
    }).collect()
}

fn describe_color(c: &ir::Color) -> String {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if c.a < 1.0 { format!("#{:02x}{:02x}{:02x}{:02x}", byte(c.r), byte(c.g), byte(c.b), byte(c.a)) } else { format!("#{:02x}{:02x}{:02x}", byte(c.r), byte(c.g), byte(c.b)) }
}

fn color(paint: &Paint) -> Result<ir::Color> {
    match paint {
        Paint::Solid(c) => { let rgb = c.to_rgb(); Ok(ir::Color { r: rgb.red, g: rgb.green, b: rgb.blue, a: rgb.alpha }) }
        other => bail!("unsupported paint (only solid colours for now): {other:?}"),
    }
}

fn stroke(s: &FixedStroke) -> Result<ir::Stroke> {
    Ok(ir::Stroke {
        paint: color(&s.paint)?,
        thickness: pt(s.thickness),
        cap: format!("{:?}", s.cap).to_ascii_lowercase(),
        join: format!("{:?}", s.join).to_ascii_lowercase(),
        dash: s.dash.as_ref().map(|d| ir::Dash { array: d.array.iter().map(|a| pt(*a)).collect(), phase: pt(d.phase) }),
        miter_limit: s.miter_limit.get(),
    })
}

fn shape_item(pos: Point, s: &Shape, node: Option<usize>) -> Result<ir::Item> {
    let geometry = match &s.geometry {
        Geometry::Line(to) => ir::Geometry::Line { to: point(*to) },
        Geometry::Rect(size) => ir::Geometry::Rect { width: pt(size.x), height: pt(size.y) },
        Geometry::Curve(curve) => ir::Geometry::Path { ops: curve_ops(curve) },
    };
    Ok(ir::Item::Shape {
        x: pt(pos.x), y: pt(pos.y), geometry,
        fill: s.fill.as_ref().map(color).transpose()?,
        stroke: s.stroke.as_ref().map(stroke).transpose()?,
        node,
    })
}

fn shape_bbox(abs: Point, s: &Shape) -> Rect {
    let b = s.bbox(true);
    Rect { x: pt(abs.x) + pt(b.min.x), y: pt(abs.y) + pt(b.min.y), w: pt(b.max.x - b.min.x), h: pt(b.max.y - b.min.y) }
}

/// The format, pixel size and bytes of a raster image the runtimes can draw: PNG or JPEG.
fn raster_of(image: &Image) -> Result<(&'static str, u32, u32, &Bytes)> {
    if image.scaling() == Smart::Custom(ImageScaling::Smooth) { bail!("image(scaling: \"smooth\") is not supported: the runtimes do not write the PDF's interpolation flag; leave `scaling` at auto"); }
    match image.kind() {
        ImageKind::Raster(raster) => {
            let format = match raster.format() {
                RasterFormat::Exchange(ExchangeFormat::Png) => "png",
                RasterFormat::Exchange(ExchangeFormat::Jpg) => "jpg",
                other => bail!("unsupported image format {other:?}: the runtimes draw PNG and JPEG"),
            };
            Ok((format, raster.width(), raster.height(), raster.data()))
        }
        ImageKind::Svg(_) => bail!("SVG images are not supported: the runtimes have no SVG renderer; rasterize the image to PNG"),
        ImageKind::Pdf(_) => bail!("embedded PDF images are not supported"),
    }
}

/// A static raster image's bytes, written next to the document as `images/<sha256 prefix>.<ext>`.
struct ImageBytes { format: &'static str, width: u32, height: u32, bytes: Vec<u8> }

fn image_files_of(images: &BTreeMap<String, ImageBytes>) -> Vec<ir::ImageFile> {
    images.iter().map(|(sha, i)| ir::ImageFile { sha256: sha.clone(), file: format!("{}.{}", &sha[..16], i.format), format: i.format.to_string(), width: i.width, height: i.height }).collect()
}


fn shift(item: &mut ir::Item, dx: f64, dy: f64) {
    match item {
        ir::Item::Group { x, y, .. } | ir::Item::Text { x, y, .. } | ir::Item::Shape { x, y, .. } | ir::Item::Image { x, y, .. } => { *x += dx; *y += dy; }
    }
}

fn node_refs(items: &[ir::Item], used: &mut BTreeSet<usize>) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => node_refs(items, used),
            ir::Item::Text { node, .. } | ir::Item::Shape { node, .. } | ir::Item::Image { node, .. } => { if let Some(n) = node { used.insert(*n); } }
        }
    }
}

fn renumber(items: &mut [ir::Item], map: &HashMap<usize, usize>) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => renumber(items, map),
            ir::Item::Text { node, .. } | ir::Item::Shape { node, .. } | ir::Item::Image { node, .. } => { *node = node.and_then(|n| map.get(&n).copied()); }
        }
    }
}

/// The part of the page's structure a fragment uses (its items' and slots' nodes and their ancestors), as a
/// local node list; the items and slots are renumbered to it. Parents keep coming before children.
fn localize(items: &mut [ir::Item], holes: &mut HoleSet, nodes: &[ir::Node]) -> Vec<ir::Node> {
    let mut used = BTreeSet::new();
    node_refs(items, &mut used);
    for slot in holes.slots.iter() { if let Some(n) = slot.node { used.insert(n); } }
    for bar in holes.bars.iter() { if let Some(n) = bar.node { used.insert(n); } }
    for image in holes.images.iter() { if let Some(n) = image.node { used.insert(n); } }
    for link in holes.links.iter() { if let Some(n) = link.node { used.insert(n); } }
    let mut all = BTreeSet::new();
    for &n in &used {
        let mut current = Some(n);
        while let Some(c) = current { if !all.insert(c) { break; } current = nodes[c].parent; }
    }
    let order: Vec<usize> = all.into_iter().collect();
    let map: HashMap<usize, usize> = order.iter().enumerate().map(|(i, &n)| (n, i)).collect();
    renumber(items, &map);
    for slot in holes.slots.iter_mut() { slot.node = slot.node.and_then(|n| map.get(&n).copied()); }
    for bar in holes.bars.iter_mut() { bar.node = bar.node.and_then(|n| map.get(&n).copied()); }
    for image in holes.images.iter_mut() { image.node = image.node.and_then(|n| map.get(&n).copied()); }
    for link in holes.links.iter_mut() { link.node = link.node.and_then(|n| map.get(&n).copied()); }
    order.iter().map(|&n| ir::Node { role: nodes[n].role.clone(), parent: nodes[n].parent.map(|p| map[&p]), alt: nodes[n].alt.clone(), scope: nodes[n].scope.clone() }).collect()
}

// ---------------------------------------------------------------------------------------------------------
// Tags found in the frames

struct SlotMeta { name: String, align: String, overflow: String, max_length: Option<u32>, descent: f64, charset: Option<String>, lines: u32, line_height: f64, pitch: f64, auto_lines: Option<u32>, link: bool }
struct TextStyle { font: usize, size: f64, fill: ir::Color, pen_x: f64 }
/// `runs` are the sample's text items (x, baseline y, width); `links` Typst's link rectangles in the box and `url`
/// their destination, for a link slot.
struct SlotRecord { meta: SlotMeta, page: usize, rect: Rect, style: Option<TextStyle>, sample: String, baselines: Vec<f64>, glyphs: Vec<(u16, f64, f64)>, node: Option<usize>, runs: Vec<(f64, f64, f64)>, links: Vec<Rect>, url: Option<(String, Option<String>)> }
/// A static link: the rectangles of one link element on one page, its destination and its Link node.
struct LinkRecord { page: usize, rects: Vec<Rect>, url: String, alt: Option<String>, node: usize }
struct BarMeta { name: String, value: f64, max: f64, radius: f64 }
/// `shapes` are the shapes Typst drew inside the bar's box, in absolute coordinates: the bar itself.
struct BarRecord { meta: BarMeta, page: usize, rect: Rect, shapes: Vec<ir::Item>, node: Option<usize> }
struct ImageMeta { name: String, fit: String, alt: Option<String> }
/// `placed` is the image Typst put inside the box: its absolute rectangle, pixel size and format.
struct ImageRecord { meta: ImageMeta, page: usize, rect: Rect, placed: Option<(Rect, u32, u32, &'static str)>, node: Option<usize> }
/// The hole records of a compile, borrowed together while the frames are walked.
struct Records<'r> { slots: &'r mut Vec<SlotRecord>, bars: &'r mut Vec<BarRecord>, images: &'r mut Vec<ImageRecord>, links: &'r mut Vec<LinkRecord> }
/// What the frame being walked is inside of: a hole's clipped box, or none.
#[derive(Clone, Copy, PartialEq)]
enum Inside { Nothing, Slot(usize), Bar(usize), Image(usize) }
struct BandTag { name: String, repeat_on_break: bool, page: usize, rect: Rect, variants: u32, select: Option<ir::Select>, variant: Option<u32>, single: bool }
struct OverlayTag { page: usize, rect: Rect }
struct Margins { top: f64, bottom: f64, left: f64, right: f64 }

#[derive(Default)]
struct Tags { slots: Vec<SlotRecord>, bars: Vec<BarRecord>, images: Vec<ImageRecord>, links: Vec<LinkRecord>, bands: Vec<BandTag>, overlays: Vec<OverlayTag>, pages: Option<Margins> }

/// What Typst itself laid out inside a slot for some data: the runtime compares its own output with this.
#[derive(serde::Serialize)]
pub struct ReferenceGlyph { pub id: u16, pub x: f64, pub y: f64 }

/// For a text slot, its glyphs; for a bar, the absolute path of the shape Typst drew (`ops`) and its box
/// (`rect`); for an image slot, the rectangle the image was placed in (`rect`).
#[derive(serde::Serialize)]
pub struct ReferenceSlot {
    pub name: String, pub baseline: f64, pub size: f64, pub glyphs: Vec<ReferenceGlyph>, pub font: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub ops: Option<Vec<ir::PathOp>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub rect: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")] pub rects: Option<Vec<[f64; 4]>>,
}

/// A top-level piece of the sample page after flattening: a leaf item, or a clipped/transformed group.
struct Atom { rect: Rect, item: ir::Item, kind: AtomKind }

enum AtomKind { Static, Band { name: String, repeat_on_break: bool, variants: u32, select: Option<ir::Select>, variant: Option<u32>, single: bool }, Overlay }

struct Labels { slot: Label, band: Label, overlay: Label, pages: Label, bar: Label, image: Label }

/// An element whose start tag was seen and whose end tag was not: what the content in between belongs to.
struct Open { location: Location, node: Option<usize>, artifact: bool }

struct Exporter<'a> {
    fonts: &'a [LoadedFont],
    ir_fonts: Vec<ir::Font>,
    ir_font_of: HashMap<(usize, u32), usize>,
    labels: Labels,
    /// Structure of the page being exported: open elements, nodes so far, TR nodes by (table, row).
    stack: Vec<Open>,
    nodes: Vec<ir::Node>,
    table_rows: HashMap<(usize, usize), usize>,
    lang: Option<String>,
    /// Static raster images by hash, for the document's image files.
    images: BTreeMap<String, ImageBytes>,
}

fn dict_number(dict: &typst::foundations::Dict, key: &str) -> Result<f64> {
    match dict.get(key) {
        Ok(Value::Float(f)) => Ok(*f),
        Ok(Value::Int(n)) => Ok(*n as f64),
        Ok(Value::Length(l)) => Ok(l.abs.to_pt()),
        other => bail!("metadata `{key}` is not a number of points: {other:?}"),
    }
}

impl<'a> Exporter<'a> {
    fn new(fonts: &'a [LoadedFont]) -> Result<Self> {
        let label = |name: &str| Label::new(PicoStr::intern(name)).ok_or_else(|| anyhow!("empty label"));
        Ok(Self {
            fonts, ir_fonts: Vec::new(), ir_font_of: HashMap::new(),
            labels: Labels { slot: label("paramdoc-slot")?, band: label("paramdoc-band")?, overlay: label("paramdoc-overlay")?, pages: label("paramdoc-pages")?, bar: label("paramdoc-bar")?, image: label("paramdoc-image")? },
            stack: Vec::new(), nodes: Vec::new(), table_rows: HashMap::new(), lang: None, images: BTreeMap::new(),
        })
    }

    // -- Structure -------------------------------------------------------------------------------------

    fn reset_structure(&mut self) { self.stack.clear(); self.nodes.clear(); self.table_rows.clear(); }

    fn current(&self) -> (Option<usize>, bool) { self.stack.last().map(|o| (o.node, o.artifact)).unwrap_or((None, false)) }

    /// The node a leaf item belongs to: `None` for artifacts and for content outside any element.
    fn content_node(&self) -> Option<usize> { let (node, artifact) = self.current(); if artifact { None } else { node } }

    fn push_node(&mut self, role: &str, parent: Option<usize>, alt: Option<String>, scope: Option<String>) -> usize {
        self.nodes.push(ir::Node { role: role.to_string(), parent, alt, scope });
        self.nodes.len() - 1
    }

    fn nearest(&self, mut node: Option<usize>, role: &str) -> Option<usize> {
        while let Some(n) = node { if self.nodes[n].role == role { return Some(n); } node = self.nodes[n].parent; }
        None
    }

    /// Follows Typst's element tags the way typst-pdf does: headings, paragraphs, tables and cells, figures
    /// and images, lists become nodes; `pdf.artifact`, hidden and repeated content become artifacts;
    /// everything else is transparent and inherits its parent's node.
    fn on_tag(&mut self, tag: &Tag) {
        match tag {
            Tag::Start(content, _) => {
                let Some(location) = content.location() else { return };
                let (parent, mut artifact) = self.current();
                let mut node = parent;
                if !artifact {
                    if content.is::<ArtifactElem>() || content.is::<HideElem>() || content.is::<RepeatElem>() {
                        artifact = true;
                    } else if let Some(heading) = content.to_packed::<HeadingElem>() {
                        let level = heading.resolve_level(StyleChain::default()).get().min(6);
                        node = Some(self.push_node(&format!("H{level}"), parent, None, None));
                    } else if content.is::<ParElem>() {
                        node = Some(self.push_node("P", parent, None, None));
                    } else if content.is::<TableElem>() {
                        node = Some(self.push_node("Table", parent, None, None));
                    } else if let Some(cell) = content.to_packed::<TableCell>() {
                        if cell.is_repeated.get(StyleChain::default()) {
                            artifact = true;
                        } else if let Some(table) = self.nearest(parent, "Table") {
                            let y = match cell.y.get(StyleChain::default()) { Smart::Custom(y) => y, Smart::Auto => 0 };
                            let row = match self.table_rows.get(&(table, y)) {
                                Some(&row) => row,
                                None => { let row = self.push_node("TR", Some(table), None, None); self.table_rows.insert((table, y), row); row }
                            };
                            let (role, scope) = match cell.kind.get(StyleChain::default()) {
                                Smart::Custom(TableCellKind::Header(_, scope)) => ("TH", Some(match scope {
                                    TableHeaderScope::Column => "column", TableHeaderScope::Row => "row", TableHeaderScope::Both => "both",
                                }.to_string())),
                                _ => ("TD", None),
                            };
                            node = Some(self.push_node(role, Some(row), None, scope));
                        }
                    } else if let Some(figure) = content.to_packed::<FigureElem>() {
                        let alt = figure.alt.get_cloned(StyleChain::default()).map(|a| a.to_string());
                        node = Some(self.push_node("Figure", parent, alt, None));
                    } else if let Some(image) = content.to_packed::<ImageElem>() {
                        let alt = image.alt.get_cloned(StyleChain::default()).map(|a| a.to_string());
                        match self.nearest(parent, "Figure") {
                            Some(figure) => { if self.nodes[figure].alt.is_none() { self.nodes[figure].alt = alt; } node = Some(figure); }
                            None => node = Some(self.push_node("Figure", parent, alt, None)),
                        }
                    } else if let Some(marker) = content.to_packed::<LinkMarker>() {
                        // Everything linked to one destination; its alternative text is Typst's description of it.
                        node = Some(self.push_node("Link", parent, marker.alt.as_ref().map(|a| a.to_string()), None));
                    } else if content.is::<ListElem>() || content.is::<EnumElem>() {
                        node = Some(self.push_node("L", parent, None, None));
                    } else if content.is::<ListItem>() || content.is::<EnumItem>() {
                        node = Some(self.push_node("LI", parent, None, None));
                    } else if let Some(marker) = content.to_packed::<PdfMarkerTag>() {
                        match marker.kind {
                            PdfMarkerTagKind::ListItemLabel => node = Some(self.push_node("Lbl", parent, None, None)),
                            PdfMarkerTagKind::ListItemBody => node = Some(self.push_node("LBody", parent, None, None)),
                            _ => {}
                        }
                    }
                }
                self.stack.push(Open { location, node, artifact });
            }
            Tag::End(location, _, _) => {
                if let Some(position) = self.stack.iter().rposition(|o| o.location == *location) { self.stack.truncate(position); }
            }
        }
    }

    fn loaded_font(&self, font: &Font) -> Result<&'a LoadedFont> {
        self.fonts.iter()
            .find(|f| f.font.data().as_ptr() == font.data().as_ptr() && f.font.index() == font.index())
            .ok_or_else(|| anyhow!("text uses a font that was not loaded from the fonts directory: {}", font.info().family))
    }

    fn font_id(&mut self, font: &Font) -> Result<usize> {
        let key = (font.data().as_ptr() as usize, font.index());
        if let Some(&id) = self.ir_font_of.get(&key) { return Ok(id); }
        let loaded = self.loaded_font(font)?;
        if let Some(table) = loaded.unsupported { bail!("font {} has a {table} table; colour and variable fonts are not supported, the runtimes draw plain outlines at the default instance: use a static outline font", loaded.file); }
        let id = self.ir_fonts.len();
        self.ir_fonts.push(ir::Font { family: font.info().family.to_string(), index: font.index(), sha256: loaded.sha256.clone(), source_sha256: loaded.sha256.clone(), file: loaded.file.clone(), ..Default::default() });
        self.ir_font_of.insert(key, id);
        Ok(id)
    }

    fn text_item(&mut self, pos: Point, text: &TextItem) -> Result<ir::Item> {
        if text.stroke.is_some() { bail!("stroked text ({:?}) is not supported; the runtimes draw fills only, so remove `stroke:` from the text style", text.text); }
        if self.lang.is_none() { self.lang = Some(text.lang.as_str().to_string()); }
        let node = self.content_node();
        Ok(ir::Item::Text {
            x: pt(pos.x), y: pt(pos.y), font: self.font_id(text.font.font())?, size: pt(text.size), fill: color(&text.fill)?, text: text.text.to_string(), node,
            glyphs: text.glyphs.iter().map(|g| {
                let covered = text.text.get(g.range.start as usize..g.range.end as usize).unwrap_or("");
                ir::Glyph {
                    id: g.id,
                    x_advance: pt(g.x_advance.at(text.size)),
                    x_offset: pt(g.x_offset.at(text.size)),
                    y_offset: pt(g.y_offset.at(text.size)),
                    chars: (covered.chars().count() != 1).then(|| covered.to_string()),
                }
            }).collect(),
        })
    }

    fn slot_meta(&self, value: &Value) -> Result<SlotMeta> {
        let Value::Dict(dict) = value else { bail!("slot metadata is not a dictionary: {value:?}") };
        let string = |key: &str| -> Result<String> {
            match dict.get(key) { Ok(Value::Str(s)) => Ok(s.as_str().to_string()), other => bail!("slot metadata `{key}` is not a string: {other:?}") }
        };
        let max_length = match dict.get("max-length") {
            Ok(Value::Int(n)) if *n >= 0 => Some(*n as u32),
            Ok(Value::None) | Err(_) => None,
            other => bail!("slot metadata `max-length` is not an integer: {other:?}"),
        };
        let charset = match dict.get("charset") { Ok(Value::Str(s)) => Some(s.as_str().to_string()), _ => None };
        let lines = match dict.get("lines") {
            Ok(Value::Int(n)) if *n >= 1 => *n as u32,
            Err(_) => 1,
            other => bail!("slot metadata `lines` is not a positive integer: {other:?}"),
        };
        let number_or = |key: &str, default: f64| -> Result<f64> { if dict.get(key).is_ok() { dict_number(dict, key) } else { Ok(default) } };
        let (line_height, pitch) = (number_or("line-height", 0.0)?, number_or("pitch", 0.0)?);
        let name = string("name")?;
        if let Some(cs) = &charset {
            for c in cs.chars() {
                if let Some(reason) = unsupported_reason(c) { bail!("slot `{name}`: `charset` contains {c:?} (U+{:04X}), {reason}; the runtimes refuse what they cannot lay out as Typst does", c as u32); }
            }
        }
        if lines > 1 && !(line_height > 0.0 && pitch > 0.0) { bail!("slot `{name}`: a wrapping slot needs `line-height` and `pitch` in its metadata"); }
        let auto_lines = match dict.get("auto-lines") { Ok(Value::Int(n)) if *n >= 1 => Some(*n as u32), Err(_) => None, other => bail!("slot `{name}`: `auto-lines` is not a positive integer: {other:?}") };
        Ok(SlotMeta { name, align: string("align")?, overflow: string("overflow")?, max_length, descent: dict_number(dict, "descent")?, charset, lines, line_height, pitch, auto_lines, link: matches!(dict.get("link"), Ok(Value::Bool(true))) })
    }

    fn bar_meta(&self, value: &Value) -> Result<BarMeta> {
        let Value::Dict(dict) = value else { bail!("bar metadata is not a dictionary: {value:?}") };
        let name = match dict.get("name") { Ok(Value::Str(s)) => s.as_str().to_string(), other => bail!("bar metadata `name` is not a string: {other:?}") };
        let (value, max, radius) = (dict_number(dict, "value")?, dict_number(dict, "max")?, dict_number(dict, "radius")?);
        if !(max > 0.0) { bail!("bar `{name}`: `max` must be positive"); }
        if radius < 0.0 { bail!("bar `{name}`: `radius` must not be negative"); }
        Ok(BarMeta { name, value, max, radius })
    }

    fn image_meta(&self, value: &Value) -> Result<ImageMeta> {
        let Value::Dict(dict) = value else { bail!("image slot metadata is not a dictionary: {value:?}") };
        let string = |key: &str| -> Result<String> {
            match dict.get(key) { Ok(Value::Str(s)) => Ok(s.as_str().to_string()), other => bail!("image slot metadata `{key}` is not a string: {other:?}") }
        };
        let alt = match dict.get("alt") { Ok(Value::Str(s)) => Some(s.as_str().to_string()), Ok(Value::None) | Err(_) => None, other => bail!("image slot metadata `alt` is not a string: {other:?}") };
        Ok(ImageMeta { name: string("name")?, fit: string("fit")?, alt })
    }

    /// A static image item; its bytes are kept for the document's image files.
    fn image_item(&mut self, pos: Point, image: &Image, size: Size, node: Option<usize>) -> Result<ir::Item> {
        let (format, width, height, bytes) = raster_of(image)?;
        let sha256 = hex(&Sha256::digest(bytes));
        self.images.entry(sha256.clone()).or_insert_with(|| ImageBytes { format, width, height, bytes: bytes.to_vec() });
        Ok(ir::Item::Image { x: pt(pos.x), y: pt(pos.y), width: pt(size.x), height: pt(size.y), format: format.to_string(), sha256, node })
    }

    fn rect_of(&self, t: Transform, size: Size) -> Result<Rect> {
        if !is_translation(t) { bail!("a clipped group with a non-translation transform is not supported yet: {t:?}"); }
        let origin = apply(t, Point::zero());
        Ok(Rect { x: pt(origin.x), y: pt(origin.y), w: pt(size.x), h: pt(size.y) })
    }

    /// Pass 1: every dialect tag and the clipped box it sits in.
    /// The destination of a link as the runtime can write it: a URL. Links to places in the document are refused.
    fn link_url(dest: &Destination, what: &str) -> Result<String> {
        match dest {
            Destination::Url(url) => Ok(url.as_str().to_string()),
            Destination::Position(_) | Destination::Location(_) => bail!("{what} links to a place in the document (a label, location or page); only web addresses (URLs) are supported"),
        }
    }

    /// The page rectangle of a link item under the accumulated transform, as typst-pdf computes it. A rotated or
    /// skewed link would get a bounding box where a PDF/UA quadrilateral is due: refused.
    fn link_rect(acc: Transform, pos: Point, size: Size) -> Result<Rect> {
        if acc.kx.get().abs() > 1e-9 || acc.ky.get().abs() > 1e-9 { bail!("a rotated or skewed link is not supported: its clickable area would be a bounding box, not Typst's quadrilateral"); }
        let corners = [pos, pos + Point::with_x(size.x), pos + Point::with_y(size.y), pos + size.to_point()];
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for c in corners { let p = apply(acc, c); x0 = x0.min(pt(p.x)); y0 = y0.min(pt(p.y)); x1 = x1.max(pt(p.x)); y1 = y1.max(pt(p.y)); }
        Ok(Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }

    /// Records a static link: its rectangle joins those of the same link element (one per line it spans). The
    /// link must sit in a Link node, so not in an artifact (PDF/UA forbids links there).
    fn record_link(&self, records: &mut Records, page: usize, rect: Rect, dest: &Destination) -> Result<()> {
        let url = Self::link_url(dest, "the template")?;
        let Some(node) = self.content_node() else { bail!("a link to {url} sits inside an artifact (a repeated table header, hidden content or `pdf.artifact`), which PDF/UA forbids") };
        let Some(link) = self.nearest(Some(node), "Link") else { bail!("a link to {url} outside a link element") };
        match records.links.iter_mut().find(|l| l.page == page && l.node == link) {
            Some(record) => record.rects.push(rect),
            None => records.links.push(LinkRecord { page, rects: vec![rect], url, alt: self.nodes[link].alt.clone(), node: link }),
        }
        Ok(())
    }

    fn collect_tags(&self, page: usize, frame: &Frame, acc: Transform, clipped: Option<Rect>, tags: &mut Tags) -> Result<()> {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    let rect = if group.clip.is_some() { Some(self.rect_of(t, group.frame.size())?) } else { clipped };
                    self.collect_tags(page, &group.frame, t, rect, tags)?;
                }
                FrameItem::Tag(Tag::Start(content, _)) if content.label().is_some() => {
                    let label = content.label().unwrap();
                    let value = || content.to_packed::<MetadataElem>().map(|m| &m.value).ok_or_else(|| anyhow!("dialect label on a non-metadata element"));
                    if label == self.labels.slot {
                        let meta = self.slot_meta(value()?)?;
                        let rect = clipped.ok_or_else(|| anyhow!("slot `{}` is not inside a clipped box", meta.name))?;
                        tags.slots.push(SlotRecord { meta, page, rect, style: None, sample: String::new(), baselines: Vec::new(), glyphs: Vec::new(), node: None, runs: Vec::new(), links: Vec::new(), url: None });
                    } else if label == self.labels.band {
                        let Value::Dict(dict) = value()? else { bail!("band metadata is not a dictionary") };
                        let name = match dict.get("name") { Ok(Value::Str(s)) => s.as_str().to_string(), other => bail!("band `name` is not a string: {other:?}") };
                        let repeat_on_break = matches!(dict.get("repeat-on-break"), Ok(Value::Bool(true)));
                        let rect = clipped.ok_or_else(|| anyhow!("band `{name}` is not inside a clipped block"))?;
                        let variants = match dict.get("variants") { Ok(Value::Int(n)) if *n >= 1 => *n as u32, Err(_) => 1, other => bail!("band `{name}`: `variants` is not a positive integer: {other:?}") };
                        let variant = match dict.get("variant") { Ok(Value::Int(n)) if *n >= 1 => Some(*n as u32), Ok(Value::Auto) | Ok(Value::None) | Err(_) => None, other => bail!("band `{name}`: `variant` is not a positive integer or auto: {other:?}") };
                        let single = matches!(dict.get("single"), Ok(Value::Bool(true)));
                        let select = match dict.get("select") {
                            Ok(Value::Array(parts)) => {
                                let part = |i: usize| -> Result<String> { match parts.at(i as i64, None) { Ok(Value::Str(s)) => Ok(s.as_str().to_string()), other => bail!("band `{name}`: `select` part {i} is not a string: {other:?}") } };
                                Some(match part(0)?.as_str() {
                                    "parity" => ir::Select::Parity,
                                    "flag" => ir::Select::Flag { path: part(1)? },
                                    "lines" => ir::Select::Lines { slot: part(1)? },
                                    other => bail!("band `{name}`: unknown selector {other:?} (parity, flag or lines)"),
                                })
                            }
                            Ok(Value::None) | Err(_) => None,
                            other => bail!("band `{name}`: `select` is not an array: {other:?}"),
                        };
                        if variants > 1 && select.is_none() { bail!("band `{name}` has {variants} variants but no `select`"); }
                        tags.bands.push(BandTag { name, repeat_on_break, page, rect, variants, select, variant, single });
                    } else if label == self.labels.bar {
                        let meta = self.bar_meta(value()?)?;
                        let rect = clipped.ok_or_else(|| anyhow!("bar `{}` is not inside a clipped box", meta.name))?;
                        tags.bars.push(BarRecord { meta, page, rect, shapes: Vec::new(), node: None });
                    } else if label == self.labels.image {
                        let meta = self.image_meta(value()?)?;
                        let rect = clipped.ok_or_else(|| anyhow!("image slot `{}` is not inside a clipped box", meta.name))?;
                        tags.images.push(ImageRecord { meta, page, rect, placed: None, node: None });
                    } else if label == self.labels.overlay {
                        let rect = clipped.ok_or_else(|| anyhow!("overlay is not inside a clipped box"))?;
                        tags.overlays.push(OverlayTag { page, rect });
                    } else if label == self.labels.pages {
                        let Value::Dict(dict) = value()? else { bail!("pages metadata is not a dictionary") };
                        tags.pages = Some(Margins { top: dict_number(dict, "top")?, bottom: dict_number(dict, "bottom")?, left: dict_number(dict, "left")?, right: dict_number(dict, "right")? });
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// The hole a clipped group at `rect` is, if any.
    fn inside_of(records: &Records, page: usize, rect: &Rect) -> Inside {
        if let Some(i) = records.slots.iter().position(|s| s.page == page && s.rect.same(rect)) { return Inside::Slot(i); }
        if let Some(i) = records.bars.iter().position(|b| b.page == page && b.rect.same(rect)) { return Inside::Bar(i); }
        if let Some(i) = records.images.iter().position(|b| b.page == page && b.rect.same(rect)) { return Inside::Image(i); }
        Inside::Nothing
    }

    /// Pass 2: static items of a frame, relative to the frame. Everything inside a hole's clipped box is
    /// dynamic and is not exported: a slot's text only informs the slot's style, a bar's shape and an image
    /// slot's image only inform the contract checks. Membership is by frame hierarchy, not geometry, so a run
    /// that starts exactly at a slot's edge is never mistaken for slot content.
    fn export_frame(&mut self, page: usize, frame: &Frame, acc: Transform, records: &mut Records, current: Inside) -> Result<Vec<ir::Item>> {
        let mut items = Vec::new();
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    let mut inside = current;
                    if group.clip.is_some() && current == Inside::Nothing {
                        inside = Self::inside_of(records, page, &self.rect_of(t, group.frame.size())?);
                    }
                    let inner = self.export_frame(page, &group.frame, t, records, inside)?;
                    // An unclipped frame left with nothing (a paragraph whose text and link a hole consumed) draws
                    // nothing and is not part of the layout; whether Typst nested it depends on the text.
                    if inner.is_empty() && group.clip.is_none() { continue; }
                    items.push(ir::Item::Group { x: pt(pos.x), y: pt(pos.y), transform: matrix(group.transform), clip: group.clip.as_ref().map(curve_ops), items: inner });
                }
                FrameItem::Text(text) => {
                    match current {
                        Inside::Slot(index) => {
                            let abs = apply(acc, *pos);
                            let font = self.font_id(text.font.font())?;
                            let loaded = self.loaded_font(text.font.font())?;
                            let slot = &mut records.slots[index];
                            let name = slot.meta.name.as_str();
                            if text.stroke.is_some() { bail!("slot `{name}`: stroked text is not supported; the runtimes draw fills only"); }
                            let (size, fill) = (pt(text.size), color(&text.fill)?);
                            match &slot.style {
                                None => slot.style = Some(TextStyle { font, size, fill, pen_x: pt(abs.x) }),
                                Some(style) if style.font != font || (style.size - size).abs() > 1e-9 || style.fill != fill => bail!(
                                    "slot `{name}`: its text has two styles ({} {:.2}pt {} and {} {:.2}pt {}); a slot has one font, size and colour (a `show` rule in the template?)",
                                    self.ir_fonts[style.font].family, style.size, describe_color(&style.fill), self.ir_fonts[font].family, size, describe_color(&fill)),
                                Some(_) => {}
                            }
                            // The runtimes draw one glyph per character, the character map's, at the font's advance and
                            // no offset; Typst must have done the same here, or a feature, language or style rule is at
                            // work that they cannot reproduce. Checked on every compile: the sample, the references,
                            // the repertoire proof and the fuzz.
                            for g in &text.glyphs {
                                let covered = text.text.get(g.range.start as usize..g.range.end as usize).unwrap_or("");
                                let mut it = covered.chars();
                                let (Some(c), None) = (it.next(), it.next()) else { bail!("slot `{name}`: Typst drew one glyph for {covered:?}; the runtimes draw one glyph per character (a ligature or a decomposition in the font)") };
                                let expected = loaded.cmap.get(&c).copied();
                                if expected != Some(g.id) {
                                    bail!("slot `{name}`: Typst drew glyph {} for {c:?} (U+{:04X}) where the font's character map gives {}; a font feature, language or style rule the runtimes cannot reproduce",
                                        g.id, c as u32, expected.map(|e| e.to_string()).unwrap_or_else(|| "nothing".into()));
                                }
                                let advance = loaded.advances.get(g.id as usize).copied().unwrap_or(0) as f64 / loaded.units_per_em * size;
                                let (adv, dx, dy) = (pt(g.x_advance.at(text.size)), pt(g.x_offset.at(text.size)), pt(g.y_offset.at(text.size)));
                                // A space may be narrower: trailing whitespace stays in the run at zero advance (Typst trims
                                // it for layout) and an overfull line shrinks its spaces by up to a third; the runtimes do
                                // both. Wider than the font's advance is a stretch (justification, `spacing`), not ported.
                                let narrowed = c.is_whitespace() && adv >= -1e-9 && adv <= advance + 1e-6;
                                if ((adv - advance).abs() > 1e-6 && !narrowed) || dx.abs() > 1e-9 || dy.abs() > 1e-9 {
                                    bail!("slot `{name}`: Typst advanced {c:?} by {adv:.4} pt (offset {dx:.4}, {dy:.4}) where the font's advance is {advance:.4}; tracking, spacing, kerning or a feature the runtimes cannot reproduce");
                                }
                            }
                            if !slot.baselines.iter().any(|b| (b - pt(abs.y)).abs() < 1e-6) { slot.baselines.push(pt(abs.y)); }
                            slot.sample.push_str(&text.text);
                            let mut pen = pt(abs.x);
                            for g in &text.glyphs {
                                slot.glyphs.push((g.id, pen + pt(g.x_offset.at(text.size)), pt(abs.y)));
                                pen += pt(g.x_advance.at(text.size));
                            }
                            slot.runs.push((pt(abs.x), pt(abs.y), pen - pt(abs.x)));
                            continue;
                        }
                        Inside::Bar(i) => bail!("bar `{}` contains text", records.bars[i].meta.name),
                        Inside::Image(i) => bail!("image slot `{}` contains text", records.images[i].meta.name),
                        Inside::Nothing => {}
                    }
                    items.push(self.text_item(*pos, text)?);
                }
                FrameItem::Shape(s, _) => {
                    match current {
                        Inside::Bar(i) => {
                            // The bar is its cell's content (a table cell with nothing tagged in it would be dropped).
                            let node = self.content_node();
                            records.bars[i].shapes.push(shape_item(apply(acc, *pos), s, None)?);
                            records.bars[i].node = node;
                            continue;
                        }
                        Inside::Image(i) => bail!("image slot `{}` contains a shape", records.images[i].meta.name),
                        Inside::Slot(i) => bail!("slot `{}` contains a shape (an underline or a box from a show rule?); a slot's content must be text only", records.slots[i].meta.name),
                        Inside::Nothing => {}
                    }
                    let node = self.nearest(self.content_node(), "Figure");
                    items.push(shape_item(*pos, s, node)?)
                }
                FrameItem::Image(image, size, _) => {
                    match current {
                        Inside::Image(i) => {
                            let node = self.content_node();
                            let (format, w, h, _) = raster_of(image)?;
                            let abs = apply(acc, *pos);
                            let record = &mut records.images[i];
                            if record.placed.is_some() { bail!("image slot `{}` contains two images", record.meta.name); }
                            record.placed = Some((Rect { x: pt(abs.x), y: pt(abs.y), w: pt(size.x), h: pt(size.y) }, w, h, format));
                            record.node = node;
                            continue;
                        }
                        Inside::Bar(i) => bail!("bar `{}` contains an image", records.bars[i].meta.name),
                        Inside::Slot(i) => bail!("slot `{}` contains an image; use an image slot", records.slots[i].meta.name),
                        Inside::Nothing => {}
                    }
                    let node = self.content_node();
                    items.push(self.image_item(*pos, image, *size, node)?)
                }
                FrameItem::Tag(tag) => {
                    if let (Inside::Slot(index), Tag::Start(content, _)) = (current, tag) && content.label() == Some(self.labels.slot) {
                        records.slots[index].node = self.content_node();
                    }
                    self.on_tag(tag);
                }
                FrameItem::Link(dest, size) => {
                    let rect = Self::link_rect(acc, *pos, *size)?;
                    match current {
                        Inside::Slot(index) => {
                            // A link slot: the rectangle and destination inform the contract check; the slot's text
                            // belongs to the Link node from here on.
                            let what = format!("slot `{}`", records.slots[index].meta.name);
                            let url = Self::link_url(dest, &what)?;
                            let node = self.content_node();
                            let alt = self.nearest(node, "Link").and_then(|n| self.nodes[n].alt.clone());
                            let slot = &mut records.slots[index];
                            if slot.url.as_ref().is_some_and(|(known, _)| known != &url) { bail!("{what} links to two destinations"); }
                            slot.url = Some((url, alt));
                            slot.links.push(rect);
                            slot.node = node;
                        }
                        Inside::Bar(i) => bail!("bar `{}` contains a link", records.bars[i].meta.name),
                        Inside::Image(i) => bail!("image slot `{}` contains a link", records.images[i].meta.name),
                        Inside::Nothing => self.record_link(records, page, rect, dest)?,
                    }
                }
            }
        }
        Ok(items)
    }

    /// The sample page as a flat list of atoms in absolute coordinates: unclipped translation-only groups
    /// are flattened; clipped or transformed groups (holes, bands, overlays, boxes) stay whole.
    fn flatten(&mut self, page: usize, frame: &Frame, acc: Transform, records: &mut Records, bands: &[BandTag], overlays: &[OverlayTag], out: &mut Vec<Atom>) -> Result<()> {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    if group.clip.is_none() && is_translation(group.transform) {
                        self.flatten(page, &group.frame, t, records, bands, overlays, out)?;
                        continue;
                    }
                    let origin = apply(t, Point::zero());
                    let rect = Rect { x: pt(origin.x), y: pt(origin.y), w: pt(group.frame.width()), h: pt(group.frame.height()) };
                    let current = Self::inside_of(records, page, &rect);
                    let inner = self.export_frame(page, &group.frame, t, records, current)?;
                    let kind = if let Some(b) = bands.iter().find(|b| b.page == page && b.rect.same(&rect)) {
                        AtomKind::Band { name: b.name.clone(), repeat_on_break: b.repeat_on_break, variants: b.variants, select: b.select.clone(), variant: b.variant, single: b.single }
                    } else if overlays.iter().any(|o| o.page == page && o.rect.same(&rect)) {
                        AtomKind::Overlay
                    } else { AtomKind::Static };
                    out.push(Atom { rect, item: ir::Item::Group { x: rect.x, y: rect.y, transform: matrix(group.transform), clip: group.clip.as_ref().map(curve_ops), items: inner }, kind });
                }
                FrameItem::Text(text) => {
                    let abs = apply(acc, *pos);
                    let size = pt(text.size);
                    let width: f64 = text.glyphs.iter().map(|g| pt(g.x_advance.at(text.size))).sum();
                    let item = self.text_item(abs, text)?;
                    out.push(Atom { rect: Rect { x: pt(abs.x), y: pt(abs.y) - 0.8 * size, w: width, h: 1.05 * size }, item, kind: AtomKind::Static });
                }
                FrameItem::Shape(s, _) => {
                    let abs = apply(acc, *pos);
                    let node = self.nearest(self.content_node(), "Figure");
                    out.push(Atom { rect: shape_bbox(abs, s), item: shape_item(abs, s, node)?, kind: AtomKind::Static });
                }
                FrameItem::Image(image, size, _) => {
                    let abs = apply(acc, *pos);
                    let node = self.content_node();
                    out.push(Atom { rect: Rect { x: pt(abs.x), y: pt(abs.y), w: pt(size.x), h: pt(size.y) }, item: self.image_item(abs, image, *size, node)?, kind: AtomKind::Static });
                }
                FrameItem::Tag(tag) => self.on_tag(tag),
                FrameItem::Link(dest, size) => { let rect = Self::link_rect(acc, *pos, *size)?; self.record_link(records, page, rect, dest)?; }
            }
        }
        Ok(())
    }

    /// Slot records to absolute slots plus their reference layouts. A slot whose sample is empty shows no
    /// style: with `strict` that is an error, otherwise it gets placeholders and is listed in `unstyled`.
    /// `link_refs` carry the slot index they belong to, for naming in flow documents.
    fn finish_slots(&self, records: Vec<SlotRecord>, strict: bool) -> Result<(Vec<ir::Slot>, Vec<String>, Vec<ReferenceSlot>, Vec<(usize, ReferenceSlot)>)> {
        let mut unstyled = Vec::new();
        let mut reference = Vec::new();
        let mut link_refs = Vec::new();
        let mut slots = Vec::new();
        for (index, s) in records.into_iter().enumerate() {
            let style = match s.style {
                Some(style) => style,
                None if strict => bail!("slot `{}` has no sample text; give it a non-empty sample value", s.meta.name),
                None => { unstyled.push(s.meta.name.clone()); TextStyle { font: 0, size: 0.0, fill: ir::Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }, pen_x: 0.0 } }
            };
            // The contract is geometric: a single line's baseline is the box bottom minus the declared descent (the
            // dialect aligns the text's baseline there); a wrapping slot's first baseline is the box top plus the
            // line height, and line k sits k pitches lower. The sample only tells us the style; it is checked.
            let multi = s.meta.lines > 1;
            if multi && s.meta.overflow == "shrink" { bail!("slot `{}`: `shrink` is not an overflow policy for a wrapping slot; use error, clip or ellipsis", s.meta.name); }
            let baseline = if multi { s.rect.y + s.meta.line_height } else { s.rect.bottom() - s.meta.descent };
            if strict && !multi && s.baselines.len() > 1 {
                bail!("slot `{}`: the sample wrapped to {} lines; the runtime draws a single line (give the slot `lines:` or a shorter sample)", s.meta.name, s.baselines.len());
            }
            if strict && !multi && !s.baselines.iter().any(|b| (b - baseline).abs() < 0.01) {
                bail!("slot `{}`: the sample's baseline(s) {:?} are not at the box bottom minus descent ({baseline:.2}); a `baseline:` or `top-edge` setting reaches the slot", s.meta.name, s.baselines);
            }
            if strict && multi {
                for b in &s.baselines {
                    let k = ((b - baseline) / s.meta.pitch).round();
                    if (b - (baseline + k * s.meta.pitch)).abs() > 0.01 {
                        bail!("slot `{}`: the sample's baseline {b:.2} is off the line grid ({baseline:.2} + k × {:.2}); a `baseline:`, `top-edge` or `leading` setting reaches the slot", s.meta.name, s.meta.pitch);
                    }
                }
                if s.baselines.len() > s.meta.lines as usize {
                    bail!("slot `{}`: the sample wraps to {} lines but the slot holds {}; Typst clips the rest (give it a shorter sample or more lines)", s.meta.name, s.baselines.len(), s.meta.lines);
                }
                // `lines: auto` measured the sample's height and rounded; the lines Typst then laid out must agree,
                // or the measurement sat on a rounding tie (G10). Whitespace-only lines leave no run, so a sample
                // with hard breaks is not checked this way.
                if let Some(cap) = s.meta.auto_lines && s.meta.lines < cap && !s.sample.contains('\n') && s.baselines.len() != s.meta.lines as usize {
                    bail!("slot `{}`: `lines: auto` measured {} lines for the sample but Typst laid out {}; a rounding tie in the measurement (change the sample)", s.meta.name, s.meta.lines, s.baselines.len());
                }
            }
            // A dropped line of an overfull wrapping slot sits `pitch − descent` below the box; if the repertoire's
            // tallest glyph rises higher than that, Typst's clipped box would show its top and the runtime, which
            // drops whole lines, would not (G9). Only the policies that draw an overfull text are concerned.
            if multi && matches!(s.meta.overflow.as_str(), "clip" | "ellipsis") {
                let ir_font = &self.ir_fonts[style.font];
                if let Some(loaded) = self.fonts.iter().find(|f| f.sha256 == ir_font.source_sha256 && f.font.index() == ir_font.index)
                    && let Ok(face) = ttf_parser::Face::parse(loaded.font.data(), ir_font.index)
                {
                    let repertoire = s.meta.charset.as_deref().unwrap_or(DEFAULT_REPERTOIRE);
                    let top = repertoire.chars().chain(std::iter::once('…')).filter_map(|c| loaded.cmap.get(&c)).filter_map(|&g| face.glyph_bounding_box(GlyphId(g)).map(|b| b.y_max as f64))
                        .fold(0.0, f64::max) / loaded.units_per_em * style.size;
                    let room = s.meta.pitch - s.meta.descent;
                    if top > room + 1e-6 {
                        bail!("slot `{}`: its leading is too small for the `{}` policy: the tallest glyph of its repertoire rises {top:.2} pt above the baseline, and a line Typst clips would start {room:.2} pt below the box (set `par.leading` higher or give the slot a larger descent)", s.meta.name, s.meta.overflow);
                    }
                }
            }
            // A link slot: Typst put one link rectangle on every text run of the sample, and the runtime will put
            // one on every line it draws, so each rectangle must be its run's box extended by the same amounts
            // above and below the baseline (the text's edges plus half the leading, as Typst's `modify_text` does).
            let link = if s.meta.link {
                if s.links.is_empty() { bail!("slot `{}`: the sample has an `href` but Typst placed no link in the box", s.meta.name); }
                let mut geometry: Option<ir::SlotLink> = None;
                let mut fit = |rect: &Rect, x: f64, y: f64, w: f64| -> Result<()> {
                    if (rect.x - x).abs() > 1e-6 || (rect.w - w).abs() > 1e-6 { bail!("slot `{}`: the link rectangle at x {:.4} of width {:.4} is not its text run's (x {x:.4}, width {w:.4})", s.meta.name, rect.x, rect.w); }
                    let (above, below) = (y - rect.y, rect.bottom() - y);
                    match geometry {
                        None => geometry = Some(ir::SlotLink { above, below }),
                        Some(g) if (g.above - above).abs() < 1e-6 && (g.below - below).abs() < 1e-6 => {}
                        Some(g) => bail!("slot `{}`: link rectangles of different heights around the baseline ({:.4} + {:.4} and {above:.4} + {below:.4})", s.meta.name, g.above, g.below),
                    }
                    Ok(())
                };
                if s.runs.is_empty() {
                    // Empty text: Typst still places one link rectangle, of no width, on the (empty) first line.
                    for rect in &s.links { fit(rect, rect.x, baseline, 0.0)?; }
                } else {
                    if s.links.len() != s.runs.len() { bail!("slot `{}`: Typst placed {} link rectangle(s) on {} text run(s); the runtime expects one per line", s.meta.name, s.links.len(), s.runs.len()); }
                    for (rect, &(x, y, w)) in s.links.iter().zip(&s.runs) { fit(rect, x, y, w)?; }
                }
                geometry
            } else {
                if !s.links.is_empty() { bail!("slot `{}` contains a link in its content; give the slot a `(text: …, href: …)` value instead", s.meta.name); }
                None
            };
            // The reference is what is visible: a wrapping slot's lines below the box are clipped by Typst and
            // dropped by the runtimes.
            let bottom = s.rect.bottom() + 1e-6;
            reference.push(ReferenceSlot {
                name: s.meta.name.clone(), size: style.size,
                baseline: if multi { s.baselines.first() } else { s.baselines.last() }.copied().unwrap_or(baseline),
                glyphs: s.glyphs.iter().filter(|(_, _, y)| !multi || *y <= bottom).map(|(id, x, y)| ReferenceGlyph { id: *id, x: *x, y: *y }).collect(),
                font: self.ir_fonts.get(style.font).map(|f| f.source_sha256.clone()).unwrap_or_default(),
                ops: None, rect: None, rects: None,
            });
            if let Some(g) = link {
                let rects = s.links.iter().filter(|r| r.y + g.above <= bottom).map(|r| [r.x, r.y, r.w, r.h]).collect();
                link_refs.push((index, ReferenceSlot { name: format!("{}#link", s.meta.name), size: 0.0, baseline: 0.0, glyphs: Vec::new(), font: String::new(), ops: None, rect: None, rects: Some(rects) }));
            }
            slots.push(ir::Slot {
                name: s.meta.name, page: s.page, x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h,
                baseline, descent: s.meta.descent, pen_x: style.pen_x, font: style.font, size: style.size, fill: style.fill,
                align: s.meta.align, overflow: s.meta.overflow, max_length: s.meta.max_length, sample: s.sample, node: s.node,
                charset: s.meta.charset, lines: s.meta.lines, pitch: s.meta.pitch, auto_lines: s.meta.auto_lines, link,
            });
        }
        Ok((slots, unstyled, reference, link_refs))
    }

    /// Bar records to bars plus references. The one shape Typst drew inside the box must be the bar the
    /// runtime would draw for the sample value, which checks the rounded-rectangle port against Typst on
    /// every compile (the sample, every reference and every fuzz sample).
    fn finish_bars(&self, records: Vec<BarRecord>) -> Result<(Vec<ir::Bar>, Vec<ReferenceSlot>)> {
        let mut bars = Vec::new();
        let mut reference = Vec::new();
        for b in records {
            let name = &b.meta.name;
            let [shape] = b.shapes.as_slice() else { bail!("bar `{name}`: expected one shape inside the bar's box, found {}", b.shapes.len()) };
            let ir::Item::Shape { x, y, geometry, fill: Some(fill), stroke: None, .. } = shape else { bail!("bar `{name}`: the shape inside the box is not a plain filled shape") };
            let ratio = (b.meta.value / b.meta.max).clamp(0.0, 1.0);
            let expected = ir::geometry::ops_of(&ir::geometry::rounded_rect(ratio * b.rect.w, b.rect.h, b.meta.radius), b.rect.x, b.rect.y);
            let actual = ir::geometry::ops_of(geometry, *x, *y);
            if !ir::geometry::same_ops(&expected, &actual, 1e-6) {
                bail!("bar `{name}`: Typst's shape for value {} of {} is not the bar the runtime would draw (width {:.4} of {:.4}, radius {:.2}):\n  typst   {actual:?}\n  runtime {expected:?}", b.meta.value, b.meta.max, ratio * b.rect.w, b.rect.w, b.meta.radius);
            }
            // Trace names carry the hole kind, because a bar may share its data key with a text slot.
            reference.push(ReferenceSlot { name: format!("{name}#bar"), baseline: 0.0, size: 0.0, glyphs: Vec::new(), font: String::new(), ops: Some(actual), rect: Some([b.rect.x, b.rect.y, ratio * b.rect.w, b.rect.h]), rects: None });
            bars.push(ir::Bar { name: name.clone(), page: b.page, x: b.rect.x, y: b.rect.y, width: b.rect.w, height: b.rect.h, max: b.meta.max, fill: *fill, radius: b.meta.radius, node: b.node, sample: b.meta.value });
        }
        Ok((bars, reference))
    }

    /// Image records to image slots plus references. The sample's image must sit where `fit_image` puts it,
    /// which checks the port of Typst's image layout on every compile. The caller resets the Figure node's
    /// alternative text to the template's, because the data supplies its own at runtime.
    fn finish_images(&self, records: Vec<ImageRecord>) -> Result<(Vec<ir::ImageSlot>, Vec<ReferenceSlot>)> {
        let mut images = Vec::new();
        let mut reference = Vec::new();
        for r in records {
            let name = &r.meta.name;
            let Some((placed, px_w, px_h, format)) = r.placed else { bail!("image slot `{name}`: no image inside the box; give it a sample image") };
            let expected = ir::geometry::fit_image(&r.meta.fit, r.rect.w, r.rect.h, px_w as f64, px_h as f64).map_err(|e| anyhow!("image slot `{name}`: {e}"))?;
            let actual = [placed.x - r.rect.x, placed.y - r.rect.y, placed.w, placed.h];
            if expected.iter().zip(&actual).any(|(a, b)| (a - b).abs() > 1e-6) {
                bail!("image slot `{name}`: Typst placed the {px_w} x {px_h} {format} at {actual:?} in the box, the runtime would place it at {expected:?} (fit {})", r.meta.fit);
            }
            reference.push(ReferenceSlot { name: format!("{name}#image"), baseline: 0.0, size: 0.0, glyphs: Vec::new(), font: String::new(), ops: None, rect: Some([placed.x, placed.y, placed.w, placed.h]), rects: None });
            images.push(ir::ImageSlot { name: name.clone(), page: r.page, x: r.rect.x, y: r.rect.y, width: r.rect.w, height: r.rect.h, fit: r.meta.fit, alt: r.meta.alt, node: r.node, sample: format!("{px_w}x{px_h} {format}") });
        }
        Ok((images, reference))
    }

    fn finish_links(records: Vec<LinkRecord>) -> Vec<ir::Link> {
        records.into_iter().map(|r| ir::Link { page: r.page, rects: r.rects.iter().map(|r| [r.x, r.y, r.w, r.h]).collect(), url: r.url, alt: r.alt, node: Some(r.node) }).collect()
    }

    fn export(self, doc: &PagedDocument, strict: bool) -> Result<Exported> {
        let mut tags = Tags::default();
        for (index, page) in doc.pages().iter().enumerate() {
            self.collect_tags(index, &page.frame, Transform::identity(), None, &mut tags)?;
        }
        let title = doc.info().title.as_ref().map(|t| t.to_string());
        if tags.pages.is_some() { self.export_flow(doc, tags, title, strict) } else { self.export_fixed(doc, tags, title, strict) }
    }

    /// A document without bands: fixed pages with absolute slots.
    fn export_fixed(mut self, doc: &PagedDocument, mut tags: Tags, title: Option<String>, strict: bool) -> Result<Exported> {
        if !tags.bands.is_empty() { bail!("bands need a `paged` wrapper so the runtime knows the flow area"); }
        let mut pages = Vec::new();
        let mut records = Records { slots: &mut tags.slots, bars: &mut tags.bars, images: &mut tags.images, links: &mut tags.links };
        for (index, page) in doc.pages().iter().enumerate() {
            self.reset_structure();
            let items = self.export_frame(index, &page.frame, Transform::identity(), &mut records, Inside::Nothing)?;
            pages.push(ir::Page { width: pt(page.frame.width()), height: pt(page.frame.height()), items, nodes: std::mem::take(&mut self.nodes) });
        }
        let (slots, unstyled, mut reference, link_refs) = self.finish_slots(tags.slots, strict)?;
        let (bars, bar_refs) = self.finish_bars(tags.bars)?;
        let (images, image_refs) = self.finish_images(tags.images)?;
        let links = Self::finish_links(tags.links);
        for image in &images { if let Some(n) = image.node { pages[image.page].nodes[n].alt = image.alt.clone(); } }
        // A link slot's Link node describes the data's destination, not the sample's.
        for slot in &slots { if slot.link.is_some() && let Some(n) = slot.node { pages[slot.page].nodes[n].alt = None; } }
        reference.extend(bar_refs);
        reference.extend(image_refs);
        reference.extend(link_refs.into_iter().map(|(_, r)| r));
        let image_files = image_files_of(&self.images);
        Ok(Exported {
            doc: ir::Document { version: ir::VERSION, title, lang: self.lang.clone(), fonts: self.ir_fonts, image_files, pages, slots, bars, images, links, flow: None },
            unstyled, reference, declared: HashMap::new(), images: self.images,
        })
    }

    /// A flow document: the single sample page segmented into static blocks, repeat regions and overlays.
    fn export_flow(mut self, doc: &PagedDocument, mut tags: Tags, title: Option<String>, strict: bool) -> Result<Exported> {
        if doc.pages().len() != 1 { bail!("a flow template's sample must fit on one page; it has {} pages (use fewer sample rows)", doc.pages().len()); }
        let page = &doc.pages()[0];
        let margins = tags.pages.take().expect("flow mode has margins");
        let (page_width, page_height) = (pt(page.frame.width()), pt(page.frame.height()));
        let area = ir::Area { x: margins.left, y: margins.top, width: page_width - margins.left - margins.right, height: page_height - margins.top - margins.bottom };

        let mut atoms = Vec::new();
        self.reset_structure();
        {
            let mut records = Records { slots: &mut tags.slots, bars: &mut tags.bars, images: &mut tags.images, links: &mut tags.links };
            self.flatten(0, &page.frame, Transform::identity(), &mut records, &tags.bands, &tags.overlays, &mut atoms)?;
        }
        let mut page_nodes = std::mem::take(&mut self.nodes);
        let (abs_slots, unstyled, slot_refs, link_refs) = self.finish_slots(tags.slots, strict)?;
        let (abs_bars, bar_refs) = self.finish_bars(tags.bars)?;
        let (abs_images, image_refs) = self.finish_images(tags.images)?;
        let abs_links = Self::finish_links(tags.links);
        for image in &abs_images { if let Some(n) = image.node { page_nodes[n].alt = image.alt.clone(); } }
        for slot in &abs_slots { if slot.link.is_some() && let Some(n) = slot.node { page_nodes[n].alt = None; } }
        atoms.sort_by(|a, b| a.rect.y.partial_cmp(&b.rect.y).unwrap_or(std::cmp::Ordering::Equal));
        let (overlay_atoms, flow_atoms): (Vec<Atom>, Vec<Atom>) = atoms.into_iter().partition(|a| matches!(a.kind, AtomKind::Overlay));

        // Every hole is taken by the band instance, overlay or static block whose rectangle encloses it.
        let (mut slots, mut bars, mut images, mut links) = (Taken::new(abs_slots), Taken::new(abs_bars), Taken::new(abs_images), Taken::new(abs_links));
        let mut take_inside = |rect: &Rect, owner: Owner| -> HoleSet { HoleSet { slots: slots.take(rect, &owner), bars: bars.take(rect, &owner), images: images.take(rect, &owner), links: links.take(rect, &owner) } };
        let fragment_of = |atom: &Atom, mut holes: HoleSet, y: f64| -> Result<ir::Fragment> {
            let ir::Item::Group { items, .. } = &atom.item else { bail!("a band or overlay atom is not a group") };
            let mut items = items.clone();
            let nodes = localize(&mut items, &mut holes, &page_nodes);
            Ok(ir::Fragment { x: atom.rect.x, y, width: atom.rect.w, height: atom.rect.h, items, slots: holes.slots, bars: holes.bars, images: holes.images, links: holes.links, nodes })
        };

        let mut blocks = Vec::new();
        let mut bands: Vec<ir::Band> = Vec::new();
        let mut pending: Vec<&Atom> = Vec::new();
        let mut prev_bottom = area.y;
        let mut declared: HashMap<String, Declared> = HashMap::new();

        let mut i = 0;
        while i < flow_atoms.len() {
            let atom = &flow_atoms[i];
            let AtomKind::Band { name, repeat_on_break, variants, select, variant, single } = &atom.kind else { pending.push(atom); i += 1; continue };
            // Everything above this region is a static block ending where the region starts.
            let top = prev_bottom;
            let bottom = atom.rect.y;
            if bottom < top - 0.01 { bail!("band `{name}` at y {bottom:.2} overlaps the content before it (ends at {top:.2})"); }
            if !pending.is_empty() || bottom > top + 1e-6 {
                blocks.push(static_fragment(&pending, top, bottom - top, page_width, &page_nodes, &mut |rect| take_inside(rect, Owner::Flow)));
                pending.clear();
            }
            if *single {
                // A choice block: one instance of a band, picked among its variants by the selector.
                if bands.iter().any(|b| &b.name == name) { bail!("choice block `{name}` appears twice"); }
                let holes = take_inside(&atom.rect, Owner::Band { name: name.clone(), instance: None });
                let count = holes.len();
                bands.push(ir::Band { name: name.clone(), repeat_on_break: false, fragments: vec![fragment_of(atom, holes, 0.0)?], select: select.clone() });
                declared.insert(name.clone(), Declared { variants: *variants, select: select.clone(), instances: vec![Instance { x: atom.rect.x, w: atom.rect.w, h: atom.rect.h, variant: *variant, slots: count }] });
                blocks.push(ir::Block::Choice { band: name.clone() });
                prev_bottom = atom.rect.bottom();
                i += 1;
                continue;
            }
            let mut header = None;
            let mut header_gap = 0.0;
            let mut j = i;
            if *repeat_on_break {
                if bands.iter().any(|b| &b.name == name) { bail!("header band `{name}` appears twice"); }
                let holes = take_inside(&atom.rect, Owner::Band { name: name.clone(), instance: None });
                bands.push(ir::Band { name: name.clone(), repeat_on_break: true, fragments: vec![fragment_of(atom, holes, 0.0)?], select: None });
                header = Some(name.clone());
                j += 1;
                let next = flow_atoms.get(j).ok_or_else(|| anyhow!("header band `{name}` is not followed by row bands"))?;
                header_gap = { let g = next.rect.y - atom.rect.bottom(); if g.abs() < 0.01 { 0.0 } else { g } };
            }
            let AtomKind::Band { name: row_name, repeat_on_break: false, variants: row_variants, select: row_select, .. } = &flow_atoms.get(j).map(|a| &a.kind).ok_or_else(|| anyhow!("expected row bands"))? else {
                bail!("header band `{name}` must be followed directly by its row bands")
            };
            let first = &flow_atoms[j];
            let mut k = j;
            let mut gap = 0.0;
            let mut count = 0;
            let mut rows: Vec<Instance> = Vec::new();
            while let Some(a) = flow_atoms.get(k) && let AtomKind::Band { name, repeat_on_break: false, variant, .. } = &a.kind && name == row_name {
                let n;
                if count == 0 {
                    if bands.iter().any(|b| &b.name == row_name) { bail!("band `{row_name}` is used in two repeat regions"); }
                    let holes = take_inside(&a.rect, Owner::Band { name: row_name.clone(), instance: Some(0) });
                    n = holes.len();
                    bands.push(ir::Band { name: row_name.clone(), repeat_on_break: false, fragments: vec![fragment_of(a, holes, 0.0)?], select: row_select.clone() });
                } else {
                    // With variants, instances may differ in height; `build` checks each against the variants later.
                    if *row_variants == 1 && ((a.rect.h - first.rect.h).abs() > 0.01 || (a.rect.w - first.rect.w).abs() > 0.01 || (a.rect.x - first.rect.x).abs() > 0.01) {
                        bail!("band `{row_name}`: instance {count} is {:.2} x {:.2} at x {:.2}, the first is {:.2} x {:.2} at x {:.2}; rows must have a fixed size unless the band declares `variants`", a.rect.w, a.rect.h, a.rect.x, first.rect.w, first.rect.h, first.rect.x);
                    }
                    let this_gap = { let g = a.rect.y - flow_atoms[k - 1].rect.bottom(); if g.abs() < 0.01 { 0.0 } else { g } };
                    if count == 1 { gap = this_gap; } else if (this_gap - gap).abs() > 0.01 { bail!("band `{row_name}`: the gap between rows varies ({gap:.2} vs {this_gap:.2})"); }
                    // Holes of later instances are not exported, only accounted for.
                    n = take_inside(&a.rect, Owner::Band { name: row_name.clone(), instance: Some(count) }).len();
                    let exported = hole_count(&bands.last().unwrap().fragments[0]);
                    if *row_variants == 1 && n != exported { bail!("band `{row_name}`: instance {count} has {n} holes, the first has {exported}"); }
                }
                rows.push(Instance { x: a.rect.x, w: a.rect.w, h: a.rect.h, variant: *variant, slots: n });
                count += 1;
                k += 1;
            }
            declared.insert(row_name.clone(), Declared { variants: *row_variants, select: row_select.clone(), instances: rows });
            blocks.push(ir::Block::Repeat { band: row_name.clone(), header, header_gap, gap, sample_rows: count });
            prev_bottom = flow_atoms[k - 1].rect.bottom();
            i = k;
        }
        if !pending.is_empty() {
            let bottom = pending.iter().map(|a| a.rect.bottom()).fold(prev_bottom, f64::max);
            blocks.push(static_fragment(&pending, prev_bottom, bottom - prev_bottom, page_width, &page_nodes, &mut |rect| take_inside(rect, Owner::Flow)));
        }
        let mut overlays = Vec::new();
        for atom in &overlay_atoms {
            let holes = take_inside(&atom.rect, Owner::Overlay);
            overlays.push(fragment_of(atom, holes, atom.rect.y)?);
        }
        for (what, left) in [("slot", slots.untaken()), ("bar", bars.untaken()), ("image slot", images.untaken()), ("link", links.untaken())] {
            if let Some(name) = left { bail!("{what} `{name}` is not inside any block, band or overlay"); }
        }

        let named = |r: ReferenceSlot, owner: &Owner| -> ReferenceSlot {
            let name = match owner {
                Owner::Band { name, instance: Some(i) } => format!("{name}[{i}].{}", r.name),
                Owner::Band { name, instance: None } => format!("{name}.{}", r.name),
                Owner::Overlay => format!("page[0].{}", r.name),
                Owner::Flow => r.name.clone(),
            };
            ReferenceSlot { name, ..r }
        };
        let reference = slot_refs.into_iter().zip(&slots.owners).chain(bar_refs.into_iter().zip(&bars.owners)).chain(image_refs.into_iter().zip(&images.owners))
            .chain(link_refs.into_iter().map(|(i, r)| (r, &slots.owners[i]))).map(|(r, o)| named(r, o)).collect();
        let image_files = image_files_of(&self.images);
        Ok(Exported {
            doc: ir::Document {
                version: ir::VERSION, title, lang: self.lang.clone(), fonts: self.ir_fonts, image_files, pages: Vec::new(), slots: Vec::new(), bars: Vec::new(), images: Vec::new(), links: Vec::new(),
                flow: Some(ir::Flow { page_width, page_height, area, blocks, bands, overlays }),
            },
            unstyled, reference, declared, images: self.images,
        })
    }
}

/// Where a hole of the sample page ended up: in a band instance, in an overlay, or in the flow's static blocks.
#[derive(Clone)]
enum Owner { Band { name: String, instance: Option<usize> }, Overlay, Flow }

/// The three kinds of hole a fragment can have, plus its static links, which travel with it the same way.
#[derive(Default)]
struct HoleSet { slots: Vec<ir::Slot>, bars: Vec<ir::Bar>, images: Vec<ir::ImageSlot>, links: Vec<ir::Link> }

impl HoleSet { fn len(&self) -> usize { self.slots.len() + self.bars.len() + self.images.len() + self.links.len() } }

fn hole_count(fragment: &ir::Fragment) -> usize { fragment.slots.len() + fragment.bars.len() + fragment.images.len() + fragment.links.len() }

/// A hole in absolute page coordinates that can be made relative to the fragment that takes it.
trait Hole: Clone {
    fn rect(&self) -> Rect;
    fn relocate(&mut self, dx: f64, dy: f64);
    fn name(&self) -> &str;
}

impl Hole for ir::Slot {
    fn rect(&self) -> Rect { Rect { x: self.x, y: self.y, w: self.width, h: self.height } }
    fn relocate(&mut self, dx: f64, dy: f64) { self.page = 0; self.x += dx; self.y += dy; self.baseline += dy; self.pen_x += dx; }
    fn name(&self) -> &str { &self.name }
}

impl Hole for ir::Bar {
    fn rect(&self) -> Rect { Rect { x: self.x, y: self.y, w: self.width, h: self.height } }
    fn relocate(&mut self, dx: f64, dy: f64) { self.page = 0; self.x += dx; self.y += dy; }
    fn name(&self) -> &str { &self.name }
}

impl Hole for ir::ImageSlot {
    fn rect(&self) -> Rect { Rect { x: self.x, y: self.y, w: self.width, h: self.height } }
    fn relocate(&mut self, dx: f64, dy: f64) { self.page = 0; self.x += dx; self.y += dy; }
    fn name(&self) -> &str { &self.name }
}

impl Hole for ir::Link {
    fn rect(&self) -> Rect {
        let (x0, y0) = (self.rects.iter().map(|r| r[0]).fold(f64::INFINITY, f64::min), self.rects.iter().map(|r| r[1]).fold(f64::INFINITY, f64::min));
        let (x1, y1) = (self.rects.iter().map(|r| r[0] + r[2]).fold(f64::NEG_INFINITY, f64::max), self.rects.iter().map(|r| r[1] + r[3]).fold(f64::NEG_INFINITY, f64::max));
        Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    fn relocate(&mut self, dx: f64, dy: f64) { self.page = 0; for r in &mut self.rects { r[0] += dx; r[1] += dy; } }
    fn name(&self) -> &str { &self.url }
}

/// The holes of one kind on the sample page and, per hole, whether and by whom it was taken.
struct Taken<H> { all: Vec<H>, taken: Vec<bool>, owners: Vec<Owner> }

impl<H: Hole> Taken<H> {
    fn new(all: Vec<H>) -> Self { let n = all.len(); Self { all, taken: vec![false; n], owners: vec![Owner::Flow; n] } }

    /// The holes inside `rect` that nobody took yet, made relative to its corner.
    fn take(&mut self, rect: &Rect, owner: &Owner) -> Vec<H> {
        let mut out = Vec::new();
        for (i, hole) in self.all.iter().enumerate() {
            if !self.taken[i] && rect.encloses(&hole.rect()) {
                self.taken[i] = true;
                self.owners[i] = owner.clone();
                let mut relative = hole.clone();
                relative.relocate(-rect.x, -rect.y);
                out.push(relative);
            }
        }
        out
    }

    fn untaken(&self) -> Option<&str> { self.taken.iter().position(|t| !t).map(|i| self.all[i].name()) }
}

/// A static block from the atoms between two regions: items shifted so that `top` becomes 0; holes taken
/// from the vertical range.
fn static_fragment(atoms: &[&Atom], top: f64, height: f64, width: f64, nodes: &[ir::Node], take: &mut dyn FnMut(&Rect) -> HoleSet) -> ir::Block {
    let mut items: Vec<ir::Item> = atoms.iter().map(|a| { let mut item = a.item.clone(); shift(&mut item, 0.0, -top); item }).collect();
    // The fragment spans the page width from x = 0, so hole x positions stay absolute.
    let mut holes = take(&Rect { x: 0.0, y: top, w: 1e9, h: height.max(0.0) });
    let nodes = localize(&mut items, &mut holes, nodes);
    ir::Block::Static { fragment: ir::Fragment { x: 0.0, y: 0.0, width, height, items, slots: holes.slots, bars: holes.bars, images: holes.images, links: holes.links, nodes } }
}

struct Exported { doc: ir::Document, unstyled: Vec<String>, reference: Vec<ReferenceSlot>, declared: HashMap<String, Declared>, images: BTreeMap<String, ImageBytes> }

/// What the sample said about a band with variants: how many, how to pick, and each sample instance's size,
/// declared variant (`None` when only the layout can tell) and hole count, for `build` to check against the
/// variant layouts.
struct Declared { variants: u32, select: Option<ir::Select>, instances: Vec<Instance> }
struct Instance { x: f64, w: f64, h: f64, variant: Option<u32>, slots: usize }

// ---------------------------------------------------------------------------------------------------------
// Export-time font subsetting

/// What a slot may contain unless it declares a `charset`: printable ASCII, Latin-1 and common typography,
/// minus the soft hyphen (Typst draws a hyphen where a line ends on one) and the middle dot (Typst shrinks and
/// justifies it as CJK punctuation); neither is ported.
const DEFAULT_REPERTOIRE: &str = concat!(
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    "\u{a0}¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
    "–—‘’‚“”„•…€‹›™−",
);

/// Why a character cannot be in a slot's repertoire, or `None` for the candidates the runtimes' one-character-
/// one-glyph model can hold (`PLAN.md` M12): the default set, Latin Extended, Greek, Cyrillic, a few
/// punctuation and currency characters. The whitelist names candidates; the repertoire proof and the fuzz
/// (`run`) admit them, so a template with a `charset` beyond the default is proven on export.
fn unsupported_reason(c: char) -> Option<&'static str> {
    if DEFAULT_REPERTOIRE.contains(c) || c == '…' { return None; }
    Some(match c as u32 {
        0x00AD => "a soft hyphen: Typst draws a hyphen where a line ends on one and the runtimes do not yet (strip them)",
        0x00B7 => "a middle dot, which Typst shrinks and justifies as CJK punctuation (typst-layout `shaping.rs`, `is_cjk_center_aligned_punctuation`); not ported yet",
        0x0100..=0x024F | 0x1E00..=0x1EFF => return None,                     // Latin Extended-A, -B and Additional
        0x0370..=0x03FF => return None,                                        // Greek and Coptic
        0x0483..=0x0489 => "a combining mark; the runtimes place no marks (send precomposed characters)",
        0x0400..=0x052F => return None,                                        // Cyrillic and its Supplement
        0x2000..=0x200A | 0x2010..=0x2014 | 0x2016 | 0x2018..=0x2022 | 0x2024..=0x2027 | 0x2030..=0x2033 | 0x2035..=0x2037 | 0x2039..=0x203B | 0x2044 | 0x202F => return None,
        0x20A0..=0x20C0 => return None,                                        // currency symbols
        0x2122 | 0x2212 => return None,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F => "a combining mark; the runtimes place no marks (send precomposed characters)",
        0x0000..=0x001F | 0x007F..=0x009F => "a control character",
        0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x061C | 0xFEFF => "a format or bidi control character",
        0xFE00..=0xFE0F | 0xE0100..=0xE01EF => "a variation selector",
        0x0590..=0x08FF | 0x0900..=0x0DFF | 0x0E00..=0x0FFF | 0x1000..=0x109F | 0x1780..=0x17FF => "a script that needs a shaper (Hebrew, Arabic, Indic, Thai and the like)",
        0x2E80..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF => "an East Asian character; the runtimes have no East Asian line breaking",
        0x1F000..=0x1FAFF => "an emoji or pictograph; colour fonts are not supported",
        0xE000..=0xF8FF | 0xF0000..=0x10FFFF => "a private-use character",
        0xFDD0..=0xFDEF => "a noncharacter",
        u if u & 0xFFFE == 0xFFFE => "a noncharacter",
        _ => "not in the supported scripts (Latin, Greek and Cyrillic, precomposed)",
    })
}

struct SubsetFont { file: String, bytes: Vec<u8>, map: HashMap<u16, u16>, source_sha256: String }

fn each_items_mut(doc: &mut ir::Document, f: &mut dyn FnMut(&mut Vec<ir::Item>)) {
    for page in &mut doc.pages { f(&mut page.items); }
    if let Some(flow) = &mut doc.flow {
        for block in &mut flow.blocks { if let ir::Block::Static { fragment } = block { f(&mut fragment.items); } }
        for band in &mut flow.bands { for fragment in &mut band.fragments { f(&mut fragment.items); } }
        for overlay in &mut flow.overlays { f(&mut overlay.items); }
    }
}

fn each_slot(doc: &ir::Document, f: &mut dyn FnMut(&ir::Slot)) {
    for slot in &doc.slots { f(slot); }
    if let Some(flow) = &doc.flow {
        for block in &flow.blocks { if let ir::Block::Static { fragment } = block { for slot in &fragment.slots { f(slot); } } }
        for band in &flow.bands { for fragment in &band.fragments { for slot in &fragment.slots { f(slot); } } }
        for overlay in &flow.overlays { for slot in &overlay.slots { f(slot); } }
    }
}

fn used_glyphs(items: &[ir::Item], used: &mut [BTreeSet<u16>]) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => used_glyphs(items, used),
            ir::Item::Text { font, glyphs, .. } => used[*font].extend(glyphs.iter().map(|g| g.id)),
            _ => {}
        }
    }
}

fn rewrite_glyphs(items: &mut [ir::Item], maps: &[HashMap<u16, u16>]) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => rewrite_glyphs(items, maps),
            ir::Item::Text { font, glyphs, .. } => for g in glyphs { g.id = maps.get(*font).and_then(|m| m.get(&g.id)).copied().unwrap_or(g.id); },
            _ => {}
        }
    }
}

/// Subsets every font to the glyphs the static items use plus the glyphs of each slot's repertoire, rewrites
/// the document's glyph ids to the subset, and fills the font records with the metrics, advances and
/// character map the runtimes read instead of parsing fonts.
fn subset_fonts(doc: &mut ir::Document, loaded: &[LoadedFont]) -> Result<Vec<SubsetFont>> {
    let count = doc.fonts.len();
    let mut used: Vec<BTreeSet<u16>> = vec![BTreeSet::new(); count];
    each_items_mut(doc, &mut |items| used_glyphs(items, &mut used));
    let mut repertoire: Vec<BTreeSet<char>> = vec![BTreeSet::new(); count];
    each_slot(doc, &mut |slot| {
        let set = repertoire.get_mut(slot.font).expect("slot font index");
        set.extend(slot.charset.as_deref().unwrap_or(DEFAULT_REPERTOIRE).chars());
        set.insert('…'); // the ellipsis policy
    });
    let mut outputs = Vec::new();
    for (i, font) in doc.fonts.iter_mut().enumerate() {
        let source = loaded.iter().find(|l| l.sha256 == font.source_sha256 && l.font.index() == font.index)
            .ok_or_else(|| anyhow!("font {} is not among the loaded fonts", font.file))?;
        let data: &[u8] = source.font.data();
        let face = ttf_parser::Face::parse(data, font.index).map_err(|e| anyhow!("parsing {}: {e}", font.file))?;
        // Characters of the static glyphs, so ToUnicode covers them too.
        let mut reverse: HashMap<u16, char> = HashMap::new();
        if let Some(cmap) = face.tables().cmap {
            for subtable in cmap.subtables {
                if !subtable.is_unicode() { continue; }
                subtable.codepoints(|cp| {
                    if let (Some(c), Some(g)) = (char::from_u32(cp), subtable.glyph_index(cp)) { reverse.entry(g.0).or_insert(c); }
                });
            }
        }
        let mut chars = repertoire[i].clone();
        for g in &used[i] { if let Some(c) = reverse.get(g) { chars.insert(*c); } }
        let mut char_gids: BTreeMap<char, u16> = BTreeMap::new();
        for c in &chars {
            match face.glyph_index(*c) {
                Some(g) => { char_gids.insert(*c, g.0); }
                None if repertoire[i].contains(c) => bail!("font {} has no glyph for {c:?} (U+{:04X}), which is in a slot's repertoire{}", font.file, *c as u32,
                    if *c == '…' { " (the ellipsis policy needs it)" } else { "; remove it from `charset:` or use a font that has it" }),
                None => {}
            }
        }
        let mut gids: BTreeSet<u16> = used[i].clone();
        gids.extend(char_gids.values().copied());
        gids.insert(0);
        let gid_list: Vec<u16> = gids.into_iter().collect();
        let remapper = GlyphRemapper::new_from_glyphs(&gid_list);
        let bytes = subsetter::subset(data, font.index, &remapper).map_err(|e| anyhow!("subsetting {}: {e:?}", font.file))?;
        let map: HashMap<u16, u16> = gid_list.iter().map(|g| (*g, remapper.get(*g).expect("glyph in remapper"))).collect();
        let program = match bytes.get(..4) { Some(b"OTTO") => "opentype-cff", Some([0, 1, 0, 0]) | Some(b"true") => "truetype", _ => "cff" };
        let mut advances = vec![0.0; remapper.num_gids() as usize];
        for (old, new) in &map { advances[*new as usize] = face.glyph_hor_advance(GlyphId(*old)).unwrap_or(0) as f64; }
        let bbox = face.global_bounding_box();
        let stem = font.file.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| font.file.clone());
        let file = format!("{stem}.subset.{}", match program { "cff" => "cff", "opentype-cff" => "otf", _ => "ttf" });
        let subset = ir::Font {
            family: font.family.clone(), index: font.index, sha256: hex(&Sha256::digest(&bytes)), source_sha256: font.source_sha256.clone(),
            file: file.clone(), program: program.to_string(), units_per_em: face.units_per_em() as f64,
            ascender: face.ascender() as f64, descender: face.descender() as f64,
            cap_height: face.capital_height().unwrap_or(face.ascender()) as f64,
            bbox: [bbox.x_min as f64, bbox.y_min as f64, bbox.x_max as f64, bbox.y_max as f64],
            italic_angle: face.italic_angle() as f64, italic: face.is_italic(), advances,
            cmap: char_gids.iter().map(|(c, g)| (c.to_string(), map[g])).collect(),
        };
        outputs.push(SubsetFont { file, bytes, map, source_sha256: font.source_sha256.clone() });
        *font = subset;
    }
    let maps: Vec<HashMap<u16, u16>> = outputs.iter().map(|o| o.map.clone()).collect();
    each_items_mut(doc, &mut |items| rewrite_glyphs(items, &maps));
    Ok(outputs)
}

// ---------------------------------------------------------------------------------------------------------
// Fuzz and diff

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12; x ^= x << 25; x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 { if n == 0 { 0 } else { self.next() % n } }
}

/// The fuzz alphabet of every text slot: its whole repertoire with spaces made frequent, so random texts of
/// every admitted character meet Typst's line breaking and shaping; `default` for strings that are no slot's.
struct Alphabets { slots: HashMap<String, Vec<char>>, default: Vec<char> }

fn alphabet_of(repertoire: &str) -> Vec<char> {
    let mut set: Vec<char> = repertoire.chars().filter(|c| !c.is_control()).collect();
    let spaces = (set.len() / 8).max(8);
    set.extend(std::iter::repeat_n(' ', spaces));
    set
}

fn alphabets_of(doc: &ir::Document) -> Alphabets {
    let mut slots = HashMap::new();
    each_slot(doc, &mut |slot| { slots.entry(slot.name.clone()).or_insert_with(|| alphabet_of(slot.charset.as_deref().unwrap_or(DEFAULT_REPERTOIRE))); });
    Alphabets { slots, default: alphabet_of(DEFAULT_REPERTOIRE) }
}

/// The names of the bars, whose values the probe must leave numeric (a template may print and plot one value).
fn bar_names(doc: &ir::Document) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = doc.bars.iter().map(|b| b.name.clone()).collect();
    if let Some(flow) = &doc.flow {
        for block in &flow.blocks { if let ir::Block::Static { fragment } = block { out.extend(fragment.bars.iter().map(|b| b.name.clone())); } }
        for band in &flow.bands { for fragment in &band.fragments { out.extend(fragment.bars.iter().map(|b| b.name.clone())); } }
        for overlay in &flow.overlays { out.extend(overlay.bars.iter().map(|b| b.name.clone())); }
    }
    out
}

/// Every text slot's repertoire by name, for the repertoire proof.
fn repertoires_of(doc: &ir::Document) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    each_slot(doc, &mut |slot| { out.entry(slot.name.clone()).or_insert_with(|| slot.charset.clone().unwrap_or_else(|| DEFAULT_REPERTOIRE.to_string())); });
    out
}

/// A slot's whole repertoire as one text, a space every eight characters so that it wraps.
fn probe_text(repertoire: &str) -> String {
    let mut out = String::new();
    for (i, c) in repertoire.chars().enumerate() { if i > 0 && i % 8 == 0 { out.push(' '); } out.push(c); }
    out
}

/// The sample data with every text slot's value (a string, number or boolean) replaced by its repertoire text;
/// a link slot keeps its `href`. `reached` collects the slots the data gave a value to.
fn probe_values(value: &mut serde_json::Value, slot: Option<&str>, repertoires: &BTreeMap<String, String>, bars: &BTreeSet<String>, reached: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::String(s) if s.starts_with("data:image/") => {}
        serde_json::Value::Number(_) if slot.is_some_and(|n| bars.contains(n)) => {}
        serde_json::Value::String(_) | serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {
            if let Some(r) = slot.and_then(|n| repertoires.get_key_value(n)) { *value = serde_json::Value::String(probe_text(r.1)); reached.insert(r.0.clone()); }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(|v| probe_values(v, slot, repertoires, bars, reached)),
        serde_json::Value::Object(map) => map.iter_mut().for_each(|(key, v)| match key.as_str() {
            "href" => {}
            "text" | "alt" | "src" => probe_values(v, slot, repertoires, bars, reached),
            key => probe_values(v, Some(key), repertoires, bars, reached),
        }),
        serde_json::Value::Null => {}
    }
}

/// Random data of the same shape: strings of random length (up to twice the sample's) from the slot's alphabet,
/// random numbers, arrays of 1 to 2N rows cloned from the sample rows and mutated.
fn mutate(value: &mut serde_json::Value, rng: &mut Rng, slot: Option<&str>, alphabets: &Alphabets) {
    match value {
        serde_json::Value::String(s) if s.starts_with("data:image/") => *s = random_png_data_url(rng),
        serde_json::Value::String(s) => {
            let max = (s.chars().count().max(8) * 2) as u64;
            let len = rng.below(max + 1) as usize;
            let set: &[char] = slot.and_then(|name| alphabets.slots.get(name)).map(|v| v.as_slice()).unwrap_or(&alphabets.default);
            let mut text: Vec<char> = (0..len).map(|_| set[rng.below(set.len() as u64) as usize]).collect();
            // One string in four carries a web address somewhere, so wrapping slots meet Typst's link breaking.
            if rng.below(4) == 0 {
                let at = rng.below(text.len() as u64 + 1) as usize;
                text.splice(at..at, random_address(rng).chars());
            }
            *s = text.into_iter().collect();
        }
        // Half the numbers stay in a bar's usual range so that bars get every width.
        serde_json::Value::Number(_) => *value = serde_json::Value::from(if rng.below(2) == 0 { rng.below(101) } else { rng.below(1000) }),
        serde_json::Value::Bool(b) => *b = !*b,
        serde_json::Value::Array(items) => {
            if items.is_empty() { return; }
            let n = 1 + rng.below(2 * items.len() as u64) as usize;
            let template = items.clone();
            *items = (0..n).map(|i| template[i % template.len()].clone()).collect();
            items.iter_mut().for_each(|v| mutate(v, rng, slot, alphabets));
        }
        // An `href` stays a web address, so link slots keep their links; a link's `text` and an image's `alt`
        // belong to the slot their object is the value of.
        serde_json::Value::Object(map) => map.iter_mut().for_each(|(key, v)| match key.as_str() {
            "href" => *v = serde_json::Value::String(random_address(rng)),
            "text" | "alt" | "src" => mutate(v, rng, slot, alphabets),
            key => mutate(v, rng, Some(key), alphabets),
        }),
        serde_json::Value::Null => {}
    }
}

/// A web address for the fuzzer: a scheme or `www.`, a host, a path of words and digits, sometimes a port, a
/// query, a long hash (16 or more characters, after each of which Typst allows a break), brackets or trailing
/// punctuation, so wrapping slots meet every rule of Typst's link breaking.
fn random_address(rng: &mut Rng) -> String {
    fn word(rng: &mut Rng, min: u64, max: u64) -> String { (0..min + rng.below(max - min + 1)).map(|_| (b'a' + rng.below(26) as u8) as char).collect() }
    let mut s = ["https://", "http://", "www.", "https://www."][rng.below(4) as usize].to_string();
    s += &word(rng, 2, 10);
    s.push('.');
    s += ["org", "com", "edu", "co.uk"][rng.below(4) as usize];
    if rng.below(3) == 0 { s += &format!(":{}", 1000 + rng.below(9000)); }
    for _ in 0..rng.below(4) {
        s.push('/');
        s += &match rng.below(4) { 0 => rng.below(100_000).to_string(), 1 => format!("{}-{}", word(rng, 2, 6), word(rng, 2, 6)), 2 => format!("{}{}", word(rng, 1, 4), rng.below(100)), _ => word(rng, 1, 12) };
    }
    if rng.below(3) == 0 { s += &format!("?{}={}&{}={}", word(rng, 1, 4), rng.below(100), word(rng, 1, 4), word(rng, 1, 6)); }
    if rng.below(3) == 0 { s.push('#'); s.extend((0..16 + rng.below(24)).map(|_| b"0123456789abcdef"[rng.below(16) as usize] as char)); }
    if rng.below(4) == 0 { s = format!("({s})"); }
    if rng.below(3) == 0 { s.push(['.', ',', ')', '!'][rng.below(4) as usize]); }
    s
}

/// A random PNG of 1 to 64 by 1 to 64 pixels, grey, RGB or RGBA, so that image slots are fuzzed with images of
/// every aspect ratio Typst then lays out.
fn random_png_data_url(rng: &mut Rng) -> String {
    let (width, height) = (1 + rng.below(64) as u32, 1 + rng.below(64) as u32);
    let color_type = [0u8, 2, 6][rng.below(3) as usize];
    let channels = match color_type { 0 => 1, 2 => 3, _ => 4 };
    let mut raw = Vec::with_capacity((1 + width as usize * channels) * height as usize);
    for _ in 0..height {
        raw.push(0); // filter: none
        for _ in 0..width as usize * channels { raw.push(rng.below(256) as u8); }
    }
    format!("data:image/png;base64,{}", base64_encode(&encode_png(width, height, color_type, &raw)))
}

/// A PNG with stored (uncompressed) deflate blocks: enough for Typst to decode.
fn encode_png(width: u32, height: u32, color_type: u8, raw: &[u8]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc ^= b as u32;
            for _ in 0..8 { crc = if crc & 1 == 1 { 0xEDB8_8320 ^ (crc >> 1) } else { crc >> 1 }; }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(if i + 1 == blocks.len() { 1 } else { 0 });
        zlib.extend_from_slice(&(block.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    if blocks.is_empty() { zlib.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]); }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in raw { a = (a + byte as u32) % 65521; b = (b + a) % 65521; }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// The layout contract: everything except what the data is allowed to change. Samples, pen positions and
/// sample row counts are stripped; font references are resolved to the font's identity, because the table
/// is built from what the frames use and a slot with an empty sample uses nothing; the table is left out.
fn static_view(doc: &ir::Document) -> serde_json::Value {
    let identities: Vec<String> = doc.fonts.iter().map(|f| format!("{}#{}@{}", f.family, f.index, &f.source_sha256[..8])).collect();
    let mut value = serde_json::to_value(doc).expect("serializable");
    fn strip(value: &mut serde_json::Value, identities: &[String]) {
        match value {
            serde_json::Value::Object(map) => {
                map.remove("sample"); map.remove("pen_x"); map.remove("sample_rows");
                if let Some(serde_json::Value::Number(n)) = map.get("font")
                    && let Some(identity) = n.as_u64().and_then(|i| identities.get(i as usize))
                {
                    map.insert("font".into(), serde_json::Value::String(identity.clone()));
                }
                map.values_mut().for_each(|v| strip(v, identities));
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|v| strip(v, identities)),
            _ => {}
        }
    }
    strip(&mut value, &identities);
    value.as_object_mut().expect("document object").remove("fonts");
    value
}

fn diff(a: &serde_json::Value, b: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    use serde_json::Value::*;
    if out.len() >= 20 { return; }
    match (a, b) {
        (Object(x), Object(y)) => {
            for key in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let p = format!("{path}.{key}");
                match (x.get(key), y.get(key)) {
                    (Some(va), Some(vb)) => diff(va, vb, &p, out),
                    (va, vb) => out.push(format!("{p}: {va:?} vs {vb:?}")),
                }
            }
        }
        (Array(x), Array(y)) => {
            if x.len() != y.len() { out.push(format!("{path}: {} items vs {} items", x.len(), y.len())); }
            for (i, (va, vb)) in x.iter().zip(y).enumerate() { diff(va, vb, &format!("{path}[{i}]"), out); }
        }
        (Number(x), Number(y)) => {
            let (x, y) = (x.as_f64().unwrap_or(f64::NAN), y.as_f64().unwrap_or(f64::NAN));
            if (x - y).abs() > 1e-6 { out.push(format!("{path}: {x} vs {y}")); }
        }
        _ => if a != b { out.push(format!("{path}: {} vs {}", short(a), short(b))); },
    }
}

fn short(v: &serde_json::Value) -> String {
    let s = v.to_string();
    if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
}

// ---------------------------------------------------------------------------------------------------------
// CLI

struct Args { fixture: PathBuf, data: PathBuf, fonts: PathBuf, out: PathBuf, fuzz: usize, seed: u64, references: Vec<PathBuf>, fuzz_references: usize }

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let fixture = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K]"))?);
    let name = fixture.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "doc".into());
    let mut parsed = Args {
        data: fixture.join("data.json"),
        fonts: PathBuf::from("../../fixtures/fonts"),
        out: PathBuf::from("../../.build/paramdoc").join(name),
        fuzz: 0,
        seed: 1,
        references: Vec::new(),
        fuzz_references: 0,
        fixture,
    };
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => parsed.data = value.into(),
            "--fonts" => parsed.fonts = value.into(),
            "--out" => parsed.out = value.into(),
            "--fuzz" => parsed.fuzz = value.parse()?,
            "--seed" => parsed.seed = value.parse()?,
            "--reference" => parsed.references.push(value.into()),
            "--fuzz-references" => parsed.fuzz_references = value.parse()?,
            other => bail!("unknown flag {other}"),
        }
    }
    Ok(parsed)
}

fn build_once(fixture: &Path, data: &[u8], fonts: &[LoadedFont], strict: bool, forced: Option<(&str, u32)>) -> Result<(PagedDocument, Exported)> {
    let world = MemWorld::new(fixture, data, fonts, forced)?;
    let doc = compile(&world)?;
    let exported = Exporter::new(fonts)?.export(&doc, strict)?;
    Ok((doc, exported))
}

/// The sample compile, then one compile per variant of every band that declares variants, each forcing all
/// instances of that band to one variant: the band's fragment from each goes into the sample's band, after a
/// check that nothing outside the band changed and that every sample instance is one of the variants.
fn build(fixture: &Path, data: &[u8], fonts: &[LoadedFont], strict: bool) -> Result<(PagedDocument, Exported)> {
    let (doc, mut exported) = build_once(fixture, data, fonts, strict, None)?;
    let mut plan: Vec<(String, u32)> = exported.declared.iter().filter(|(_, d)| d.variants > 1).map(|(n, d)| (n.clone(), d.variants)).collect();
    plan.sort();
    if plan.is_empty() { return Ok((doc, exported)); }
    let sample_view = without_band_layouts(static_view(&exported.doc));
    for (name, n) in plan {
        let mut fragments = Vec::with_capacity(n as usize);
        for k in 1..=n {
            let (_, forced) = build_once(fixture, data, fonts, false, Some((&name, k))).with_context(|| format!("band `{name}`, variant {k}"))?;
            let mut differences = Vec::new();
            diff(&sample_view, &without_band_layouts(static_view(&forced.doc)), "doc", &mut differences);
            if !differences.is_empty() {
                bail!("band `{name}`, variant {k}: the layout outside the bands differs from the sample's; a variant may only change its own band:\n  {}", differences.iter().take(8).cloned().collect::<Vec<_>>().join("\n  "));
            }
            let band = forced.doc.flow.as_ref().and_then(|f| f.bands.iter().find(|b| b.name == name)).ok_or_else(|| anyhow!("band `{name}` is missing from the variant {k} compile"))?;
            let mut fragment = band.fragments[0].clone();
            adopt_fonts(&mut fragment, &forced.doc.fonts, &mut exported.doc.fonts);
            fragments.push(fragment);
            for (sha, image) in forced.images { exported.images.entry(sha).or_insert(image); }
        }
        let declared = &exported.declared[&name];
        let heights: Vec<String> = fragments.iter().map(|f| format!("{:.2}", f.height)).collect();
        if let Some(ir::Select::Lines { slot }) = &declared.select {
            // Heights must identify the variant, and the selecting slot must be the same width in every variant.
            if !fragments.windows(2).all(|w| w[1].height > w[0].height + 0.01) { bail!("band `{name}`: variants picked by lines must grow with each line; heights are {}", heights.join(", ")); }
            let widths: Vec<f64> = fragments.iter().map(|f| f.slots.iter().find(|s| &s.name == slot).map(|s| s.width).ok_or_else(|| anyhow!("band `{name}`: variant has no slot `{slot}` to pick by"))).collect::<Result<_>>()?;
            if widths.iter().any(|w| (w - widths[0]).abs() > 0.01) { bail!("band `{name}`: slot `{slot}` has a different width per variant"); }
            if fragments.iter().skip(1).any(|f| f.slots.iter().find(|s| &s.name == slot).is_some_and(|s| s.auto_lines.is_none())) { bail!("band `{name}`: slot `{slot}` must be declared `lines: auto` to pick the variant by its lines"); }
        }
        for (i, inst) in declared.instances.iter().enumerate() {
            let v = match inst.variant {
                Some(v) if (v as usize) <= fragments.len() => v as usize - 1,
                Some(v) => bail!("band `{name}`: instance {i} declares variant {v} but the band has {}", fragments.len()),
                None => fragments.iter().position(|f| (f.height - inst.h).abs() < 0.01).ok_or_else(|| anyhow!("band `{name}`: instance {i} is {:.2} pt tall, which is none of the variants ({})", inst.h, heights.join(", ")))?,
            };
            let f = &fragments[v];
            if (f.height - inst.h).abs() > 0.01 || (f.width - inst.w).abs() > 0.01 || (f.x - inst.x).abs() > 0.01 {
                bail!("band `{name}`: instance {i} ({:.2} x {:.2} at x {:.2}) is not variant {} ({:.2} x {:.2} at x {:.2})", inst.w, inst.h, inst.x, v + 1, f.width, f.height, f.x);
            }
            if inst.slots != hole_count(f) { bail!("band `{name}`: instance {i} has {} holes, variant {} has {}", inst.slots, v + 1, hole_count(f)); }
        }
        let band = exported.doc.flow.as_mut().and_then(|f| f.bands.iter_mut().find(|b| b.name == name)).expect("declared band exists");
        band.fragments = fragments;
    }
    exported.doc.image_files = image_files_of(&exported.images);
    Ok((doc, exported))
}

/// A static view with every band's layouts removed: what a variant compile must leave unchanged.
fn without_band_layouts(mut view: serde_json::Value) -> serde_json::Value {
    if let Some(bands) = view.pointer_mut("/flow/bands").and_then(|b| b.as_array_mut()) {
        for band in bands { if let Some(map) = band.as_object_mut() { map.insert("fragments".into(), serde_json::Value::Array(Vec::new())); } }
    }
    view
}

/// Points a fragment from another compile at this document's font table, adding fonts it does not have yet.
/// Font numbering is by order of first use, so it differs between compiles.
fn adopt_fonts(fragment: &mut ir::Fragment, from: &[ir::Font], into: &mut Vec<ir::Font>) {
    let map: Vec<usize> = from.iter().map(|font| {
        match into.iter().position(|f| f.source_sha256 == font.source_sha256 && f.index == font.index) {
            Some(i) => i,
            None => { into.push(font.clone()); into.len() - 1 }
        }
    }).collect();
    fn rewrite(items: &mut [ir::Item], map: &[usize]) {
        for item in items {
            match item {
                ir::Item::Group { items: inner, .. } => rewrite(inner, map),
                ir::Item::Text { font, .. } => *font = map[*font],
                _ => {}
            }
        }
    }
    rewrite(&mut fragment.items, &map);
    for slot in &mut fragment.slots { slot.font = map[slot.font]; }
}

fn count(items: &[ir::Item]) -> (usize, usize, usize) {
    items.iter().fold((0, 0, 0), |(t, s, g), item| match item {
        ir::Item::Text { .. } => (t + 1, s, g),
        ir::Item::Shape { .. } => (t, s + 1, g),
        ir::Item::Group { items, .. } => { let (a, b, c) = count(items); (t + a, s + b, g + 1 + c) }
        ir::Item::Image { .. } => (t, s, g),
    })
}

fn roles(nodes: &[ir::Node]) -> String {
    let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for n in nodes { *counts.entry(n.role.as_str()).or_default() += 1; }
    counts.iter().map(|(r, c)| if *c > 1 { format!("{r}×{c}") } else { r.to_string() }).collect::<Vec<_>>().join(" ")
}

fn describe_slot(slot: &ir::Slot, indent: &str) {
    let mut wrap = if slot.lines > 1 { format!(" lines {} pitch {:.2}", slot.lines, slot.pitch) } else { String::new() };
    if let Some(l) = slot.link { wrap += &format!(" link {:.2}+{:.2}", l.above, l.below); }
    println!("{indent}slot {:<14} rect ({:.2}, {:.2}) {:.2} x {:.2}  baseline y {:.2}  font #{} {:.1}pt  align {:<6}{wrap} sample {:?}",
        slot.name, slot.x, slot.y, slot.width, slot.height, slot.baseline, slot.font, slot.size, slot.align, slot.sample);
}

fn describe_holes(slots: &[ir::Slot], bars: &[ir::Bar], images: &[ir::ImageSlot], links: &[ir::Link], indent: &str) {
    for slot in slots { describe_slot(slot, indent); }
    for link in links {
        let [x, y, w, h] = link.rects[0];
        println!("{indent}link  {:<14} {} rect(s), first ({x:.2}, {y:.2}) {w:.2} x {h:.2}  alt {:?}", link.url, link.rects.len(), link.alt);
    }
    for bar in bars {
        println!("{indent}bar  {:<14} rect ({:.2}, {:.2}) {:.2} x {:.2}  max {} radius {:.2}  sample {}", bar.name, bar.x, bar.y, bar.width, bar.height, bar.max, bar.radius, bar.sample);
    }
    for image in images {
        println!("{indent}image {:<13} rect ({:.2}, {:.2}) {:.2} x {:.2}  fit {} alt {:?}  sample {}", image.name, image.x, image.y, image.width, image.height, image.fit, image.alt, image.sample);
    }
}

fn describe(exported: &ir::Document) {
    for file in &exported.image_files { println!("  image file {}: {} x {} {}", file.file, file.width, file.height, file.format); }
    for (i, page) in exported.pages.iter().enumerate() {
        let (t, s, g) = count(&page.items);
        println!("  page {i}: {:.1} x {:.1} pt, {t} static text runs, {s} shapes, {g} groups, nodes [{}]", page.width, page.height, roles(&page.nodes));
    }
    describe_holes(&exported.slots, &exported.bars, &exported.images, &exported.links, "  ");
    if let Some(flow) = &exported.flow {
        println!("  flow: page {:.1} x {:.1} pt, area x {:.1} y {:.1} w {:.1} h {:.1}", flow.page_width, flow.page_height, flow.area.x, flow.area.y, flow.area.width, flow.area.height);
        for block in &flow.blocks {
            match block {
                ir::Block::Static { fragment } => {
                    let (t, s, g) = count(&fragment.items);
                    println!("  static block: height {:.2}, {t} text runs, {s} shapes, {g} groups, {} hole(s), nodes [{}]", fragment.height, hole_count(fragment), roles(&fragment.nodes));
                    describe_holes(&fragment.slots, &fragment.bars, &fragment.images, &fragment.links, "    ");
                }
                ir::Block::Repeat { band, header, header_gap, gap, sample_rows } => {
                    println!("  repeat `{band}`: header {header:?} (gap after {header_gap:.2}), row gap {gap:.2}, {sample_rows} sample row(s)");
                }
                ir::Block::Choice { band } => println!("  choice `{band}`"),
            }
        }
        for band in &flow.bands {
            for (v, fragment) in band.fragments.iter().enumerate() {
                let (t, s, g) = count(&fragment.items);
                let which = if band.fragments.len() > 1 { format!(" variant {} of {} ({:?})", v + 1, band.fragments.len(), band.select) } else { String::new() };
                println!("  band `{}`{}{which}: x {:.2} w {:.2} h {:.2}, {t} text runs, {s} shapes, {g} groups, {} hole(s), nodes [{}]", band.name, if band.repeat_on_break { " (repeat on break)" } else { "" }, fragment.x, fragment.width, fragment.height, hole_count(fragment), roles(&fragment.nodes));
                describe_holes(&fragment.slots, &fragment.bars, &fragment.images, &fragment.links, "    ");
            }
        }
        for overlay in &flow.overlays {
            println!("  overlay: ({:.2}, {:.2}) {:.2} x {:.2}, {} hole(s)", overlay.x, overlay.y, overlay.width, overlay.height, hole_count(overlay));
            describe_holes(&overlay.slots, &overlay.bars, &overlay.images, &overlay.links, "    ");
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    fs::create_dir_all(&args.out)?;
    let fonts = load_fonts(&args.fonts)?;
    let data = fs::read(&args.data).with_context(|| format!("reading {}", args.data.display()))?;

    let started = std::time::Instant::now();
    let (doc, Exported { doc: mut exported, images, .. }) = build(&args.fixture, &data, &fonts, true)?;
    let compiled_in = started.elapsed();
    let subset_started = std::time::Instant::now();
    let subsets = subset_fonts(&mut exported, &fonts)?;
    let subset_in = subset_started.elapsed();
    let pdf = typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("pdf export failed: {e:?}"))?;
    fs::write(args.out.join("baseline.pdf"), &pdf)?;
    let doc_json = serde_json::to_string_pretty(&exported)?;
    fs::write(args.out.join("doc.json"), &doc_json)?;
    let font_dir = args.out.join("fonts");
    fs::create_dir_all(&font_dir)?;
    for subset in &subsets { fs::write(font_dir.join(&subset.file), &subset.bytes)?; }
    let image_dir = args.out.join("images");
    if !images.is_empty() { fs::create_dir_all(&image_dir)?; }
    for file in &exported.image_files { fs::write(image_dir.join(&file.file), &images[&file.sha256].bytes)?; }
    println!("compiled and exported in {compiled_in:.1?}: {} font(s) subset in {subset_in:.1?}, baseline PDF {} bytes, doc.json {} bytes, {}",
        exported.fonts.len(), pdf.len(), doc_json.len(), if exported.flow.is_some() { "flow document" } else { "fixed pages" });
    for (font, subset) in exported.fonts.iter().zip(&subsets) {
        println!("  font {}: {} glyphs, {} characters in the map, {} bytes ({})", subset.file, font.advances.len(), font.cmap.len(), subset.bytes.len(), font.program);
    }
    describe(&exported);

    // The repertoire proof: every text slot filled with its whole repertoire, through the real template with its
    // fonts, language and rules, so the slot branch of `export_frame` checks each character against the character
    // map and the font's advances, and nothing a slot may contain is left unproven.
    let original: serde_json::Value = serde_json::from_slice(&data)?;
    let repertoires = repertoires_of(&exported);
    let mut probe = original.clone();
    let mut reached = BTreeSet::new();
    probe_values(&mut probe, None, &repertoires, &bar_names(&exported), &mut reached);
    let (_, Exported { doc: probed, .. }) = build(&args.fixture, &serde_json::to_vec(&probe)?, &fonts, false).context("in the repertoire proof (every slot filled with its whole repertoire)")?;
    let mut seen: HashMap<String, BTreeSet<char>> = HashMap::new();
    each_slot(&probed, &mut |slot| seen.entry(slot.name.clone()).or_default().extend(slot.sample.chars()));
    let mut shaped = 0;
    for name in &reached {
        let repertoire = &repertoires[name];
        let missing: String = repertoire.chars().filter(|c| !seen.get(name).is_some_and(|s| s.contains(c))).collect();
        if !missing.is_empty() { bail!("slot `{name}`: the repertoire proof did not shape {missing:?}; Typst dropped these characters"); }
        shaped += repertoire.chars().count();
    }
    let unreached: Vec<&String> = repertoires.keys().filter(|n| !reached.contains(*n)).collect();
    println!("repertoire proof: {shaped} character(s) over {} slot(s) shaped as the character map and the font's advances say{}", reached.len(),
        if unreached.is_empty() { String::new() } else { format!("; {} slot(s) without a text value (page counters, a bar's number) checked on the sample only: {}", unreached.len(), unreached.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")) });

    // Typst's own layout of other data, for the runtimes to compare against: reference.json / reference.pdf for
    // the first `--reference`, reference-<stem>.json / .pdf for every further one.
    for (i, path) in args.references.iter().enumerate() {
        let suffix = if i == 0 { String::new() } else { format!("-{}", path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()) };
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let (doc, Exported { mut reference, .. }) = build(&args.fixture, &bytes, &fonts, false)?;
        // Typst's glyph ids are the original font's; the runtimes report ids in the subset.
        for slot in &mut reference {
            if let Some(subset) = subsets.iter().find(|s| s.source_sha256 == slot.font) {
                for g in &mut slot.glyphs { g.id = subset.map.get(&g.id).copied().unwrap_or(g.id); }
            }
        }
        fs::write(args.out.join(format!("reference{suffix}.json")), serde_json::to_string_pretty(&reference)?)?;
        fs::write(args.out.join(format!("reference{suffix}.pdf")), typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("{e:?}"))?)?;
        println!("reference for {}: {} slot(s) written to reference{suffix}.json and reference{suffix}.pdf", path.display(), reference.len());
    }

    if args.fuzz == 0 { return Ok(()); }
    let alphabets = alphabets_of(&exported);
    let baseline = static_view(&exported);
    let mut leaks = 0;
    let fuzz_started = std::time::Instant::now();
    for i in 0..args.fuzz {
        let mut rng = Rng(args.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(i as u64 + 1));
        let mut sample = original.clone();
        mutate(&mut sample, &mut rng, None, &alphabets);
        let bytes = serde_json::to_vec(&sample)?;
        let (doc, Exported { doc: mut fuzzed, unstyled, mut reference, .. }) = match build(&args.fixture, &bytes, &fonts, false) {
            Ok(built) => built,
            Err(error) => { leaks += 1; println!("sample {i}: compile failed: {error}"); continue; }
        };
        // An empty sample shows no style; copy the baseline's so only the geometry is compared for that slot.
        for name in &unstyled {
            let from = exported.slots.iter().chain(exported.flow.iter().flat_map(|f| f.bands.iter().flat_map(|b| b.fragments.iter().flat_map(|fr| fr.slots.iter())).chain(f.overlays.iter().flat_map(|o| o.slots.iter())).chain(f.blocks.iter().filter_map(|b| match b { ir::Block::Static { fragment } => Some(fragment.slots.iter()), _ => None }).flatten()))).find(|s| &s.name == name);
            let Some(from) = from else { continue };
            let entry = exported.fonts[from.font].clone();
            let font = match fuzzed.fonts.iter().position(|f| f == &entry) { Some(index) => index, None => { fuzzed.fonts.push(entry); fuzzed.fonts.len() - 1 } };
            let (size, fill) = (from.size, from.fill);
            let mut all: Vec<&mut ir::Slot> = fuzzed.slots.iter_mut().collect();
            if let Some(flow) = &mut fuzzed.flow {
                all.extend(flow.bands.iter_mut().flat_map(|b| b.fragments.iter_mut().flat_map(|fr| fr.slots.iter_mut())));
                all.extend(flow.overlays.iter_mut().flat_map(|o| o.slots.iter_mut()));
                all.extend(flow.blocks.iter_mut().filter_map(|b| match b { ir::Block::Static { fragment } => Some(fragment.slots.iter_mut()), _ => None }).flatten());
            }
            for to in all.into_iter().filter(|s| &s.name == name) { to.font = font; to.size = size; to.fill = fill; }
        }
        // The first sample for inspection; the first `--fuzz-references` samples as data plus Typst's layout of
        // them, so the runtimes can be checked on random data too (fuzz-<i>.json, reference-fuzz-<i>.json / .pdf).
        if i == 0 || i < args.fuzz_references {
            fs::write(args.out.join(format!("fuzz-{i}.json")), serde_json::to_string_pretty(&sample)?)?;
            fs::write(args.out.join(format!("fuzz-{i}.pdf")), typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("{e:?}"))?)?;
        }
        if i < args.fuzz_references {
            for slot in &mut reference {
                if let Some(subset) = subsets.iter().find(|s| s.source_sha256 == slot.font) {
                    for g in &mut slot.glyphs { g.id = subset.map.get(&g.id).copied().unwrap_or(g.id); }
                }
            }
            fs::write(args.out.join(format!("reference-fuzz-{i}.json")), serde_json::to_string_pretty(&reference)?)?;
            fs::copy(args.out.join(format!("fuzz-{i}.pdf")), args.out.join(format!("reference-fuzz-{i}.pdf")))?;
        }
        // The baseline's glyph ids are the subset's; map the sample's the same way (a glyph outside the
        // baseline's subset keeps its id and shows up as a difference, which it is).
        let maps: Vec<HashMap<u16, u16>> = fuzzed.fonts.iter().map(|f| subsets.iter().find(|s| s.source_sha256 == f.source_sha256).map(|s| s.map.clone()).unwrap_or_default()).collect();
        each_items_mut(&mut fuzzed, &mut |items| rewrite_glyphs(items, &maps));
        let mut differences = Vec::new();
        diff(&baseline, &static_view(&fuzzed), "doc", &mut differences);
        if !differences.is_empty() {
            leaks += 1;
            println!("sample {i}: layout outside the slots changed ({} difference(s) shown):", differences.len());
            for d in &differences { println!("    {d}"); }
        }
    }
    println!("fuzz: {} sample(s) in {:.1?}, {} with leaks", args.fuzz, fuzz_started.elapsed(), leaks);
    if leaks > 0 { std::process::exit(1); }
    Ok(())
}
