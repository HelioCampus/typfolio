//! paramdoc-export: compiles a slot-dialect template with Typst, exports its frames as a parametric document
//! and checks that nothing outside the declared slots depends on the data.
//!
//! Usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]

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
use typst::model::{Document as _, EnumElem, EnumItem, FigureElem, HeadingElem, ListElem, ListItem, ParElem, TableCell, TableElem};
use typst::pdf::{ArtifactElem, PdfMarkerTag, PdfMarkerTagKind, TableCellKind, TableHeaderScope};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, TextItem};
use typst::utils::{LazyHash, PicoStr};
use typst::visualize::{Curve, CurveItem, FixedStroke, Geometry, Image, ImageElem, ImageKind, Paint, Shape};
use typst::{Library, LibraryExt, World, WorldExt};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

use paramdoc_ir as ir;

// ---------------------------------------------------------------------------------------------------------
// World

struct LoadedFont { font: Font, file: String, sha256: String }

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
    fn new(fixture: &Path, data: &[u8], fonts: &[LoadedFont]) -> Result<Self> {
        let mut files = HashMap::new();
        for path in walk_files(fixture)? {
            let rel = path.strip_prefix(fixture)?.to_string_lossy().replace('\\', "/");
            let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            files.insert(file_id(&format!("/{rel}"))?, Bytes::new(bytes));
        }
        files.insert(file_id("/data.json")?, Bytes::new(data.to_vec()));
        let fonts: Vec<Font> = fonts.iter().map(|f| f.font.clone()).collect();
        Ok(Self {
            library: LazyHash::new(Library::default()),
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

fn load_fonts(dir: &Path) -> Result<Vec<LoadedFont>> {
    let mut fonts = Vec::new();
    for path in walk_files(dir)? {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "otf" | "ttf" | "ttc" | "otc") { continue; }
        let data = fs::read(&path)?;
        let sha256 = hex(&Sha256::digest(&data));
        let bytes = Bytes::new(data);
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        for index in 0..64u32 {
            match Font::new(bytes.clone(), index) {
                Some(font) => fonts.push(LoadedFont { font, file: file.clone(), sha256: sha256.clone() }),
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

fn image_item(pos: Point, image: &Image, size: Size, node: Option<usize>) -> ir::Item {
    let (format, sha256) = match image.kind() {
        ImageKind::Raster(raster) => (format!("{:?}", raster.format()).to_ascii_lowercase(), hex(&Sha256::digest(raster.data()))),
        ImageKind::Svg(_) => ("svg".to_string(), String::new()),
        ImageKind::Pdf(_) => ("pdf".to_string(), String::new()),
    };
    ir::Item::Image { x: pt(pos.x), y: pt(pos.y), width: pt(size.x), height: pt(size.y), format, sha256, node }
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
fn localize(items: &mut [ir::Item], slots: &mut [ir::Slot], nodes: &[ir::Node]) -> Vec<ir::Node> {
    let mut used = BTreeSet::new();
    node_refs(items, &mut used);
    for slot in slots.iter() { if let Some(n) = slot.node { used.insert(n); } }
    let mut all = BTreeSet::new();
    for &n in &used {
        let mut current = Some(n);
        while let Some(c) = current { if !all.insert(c) { break; } current = nodes[c].parent; }
    }
    let order: Vec<usize> = all.into_iter().collect();
    let map: HashMap<usize, usize> = order.iter().enumerate().map(|(i, &n)| (n, i)).collect();
    renumber(items, &map);
    for slot in slots.iter_mut() { slot.node = slot.node.and_then(|n| map.get(&n).copied()); }
    order.iter().map(|&n| ir::Node { role: nodes[n].role.clone(), parent: nodes[n].parent.map(|p| map[&p]), alt: nodes[n].alt.clone(), scope: nodes[n].scope.clone() }).collect()
}

// ---------------------------------------------------------------------------------------------------------
// Tags found in the frames

struct SlotMeta { name: String, align: String, overflow: String, max_length: Option<u32>, descent: f64, charset: Option<String> }
struct TextStyle { font: usize, size: f64, fill: ir::Color, pen_x: f64 }
struct SlotRecord { meta: SlotMeta, page: usize, rect: Rect, style: Option<TextStyle>, sample: String, baselines: Vec<f64>, glyphs: Vec<(u16, f64)>, node: Option<usize> }
struct BandTag { name: String, repeat_on_break: bool, page: usize, rect: Rect }
struct OverlayTag { page: usize, rect: Rect }
struct Margins { top: f64, bottom: f64, left: f64, right: f64 }

#[derive(Default)]
struct Tags { slots: Vec<SlotRecord>, bands: Vec<BandTag>, overlays: Vec<OverlayTag>, pages: Option<Margins> }

/// What Typst itself laid out inside a slot for some data: the runtime compares its own output with this.
#[derive(serde::Serialize)]
pub struct ReferenceGlyph { pub id: u16, pub x: f64 }

#[derive(serde::Serialize)]
pub struct ReferenceSlot { pub name: String, pub baseline: f64, pub size: f64, pub glyphs: Vec<ReferenceGlyph>, pub font: String }

/// A top-level piece of the sample page after flattening: a leaf item, or a clipped/transformed group.
struct Atom { rect: Rect, item: ir::Item, kind: AtomKind }

enum AtomKind { Static, Band { name: String, repeat_on_break: bool }, Overlay }

struct Labels { slot: Label, band: Label, overlay: Label, pages: Label }

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
            labels: Labels { slot: label("paramdoc-slot")?, band: label("paramdoc-band")?, overlay: label("paramdoc-overlay")?, pages: label("paramdoc-pages")? },
            stack: Vec::new(), nodes: Vec::new(), table_rows: HashMap::new(), lang: None,
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

    fn font_id(&mut self, font: &Font) -> Result<usize> {
        let key = (font.data().as_ptr() as usize, font.index());
        if let Some(&id) = self.ir_font_of.get(&key) { return Ok(id); }
        let loaded = self.fonts.iter()
            .find(|f| f.font.data().as_ptr() == font.data().as_ptr() && f.font.index() == font.index())
            .ok_or_else(|| anyhow!("text uses a font that was not loaded from the fonts directory: {}", font.info().family))?;
        let id = self.ir_fonts.len();
        self.ir_fonts.push(ir::Font { family: font.info().family.to_string(), index: font.index(), sha256: loaded.sha256.clone(), source_sha256: loaded.sha256.clone(), file: loaded.file.clone(), ..Default::default() });
        self.ir_font_of.insert(key, id);
        Ok(id)
    }

    fn text_item(&mut self, pos: Point, text: &TextItem) -> Result<ir::Item> {
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
        Ok(SlotMeta { name: string("name")?, align: string("align")?, overflow: string("overflow")?, max_length, descent: dict_number(dict, "descent")?, charset })
    }

    fn rect_of(&self, t: Transform, size: Size) -> Result<Rect> {
        if !is_translation(t) { bail!("a clipped group with a non-translation transform is not supported yet: {t:?}"); }
        let origin = apply(t, Point::zero());
        Ok(Rect { x: pt(origin.x), y: pt(origin.y), w: pt(size.x), h: pt(size.y) })
    }

    /// Pass 1: every dialect tag and the clipped box it sits in.
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
                        tags.slots.push(SlotRecord { meta, page, rect, style: None, sample: String::new(), baselines: Vec::new(), glyphs: Vec::new(), node: None });
                    } else if label == self.labels.band {
                        let Value::Dict(dict) = value()? else { bail!("band metadata is not a dictionary") };
                        let name = match dict.get("name") { Ok(Value::Str(s)) => s.as_str().to_string(), other => bail!("band `name` is not a string: {other:?}") };
                        let repeat_on_break = matches!(dict.get("repeat-on-break"), Ok(Value::Bool(true)));
                        let rect = clipped.ok_or_else(|| anyhow!("band `{name}` is not inside a clipped block"))?;
                        tags.bands.push(BandTag { name, repeat_on_break, page, rect });
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

    /// Pass 2: static items of a frame, relative to the frame. Everything inside a slot's clipped box is
    /// dynamic: its text only informs the slot's style and is otherwise dropped. Membership is by frame
    /// hierarchy, not geometry, so a run that starts exactly at a slot's edge is never mistaken for slot content.
    fn export_frame(&mut self, page: usize, frame: &Frame, acc: Transform, slots: &mut [SlotRecord], current: Option<usize>) -> Result<Vec<ir::Item>> {
        let mut items = Vec::new();
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    let mut inside = current;
                    if group.clip.is_some() {
                        let rect = self.rect_of(t, group.frame.size())?;
                        if let Some(index) = slots.iter().position(|s| s.page == page && s.rect.same(&rect)) { inside = Some(index); }
                    }
                    let inner = self.export_frame(page, &group.frame, t, slots, inside)?;
                    items.push(ir::Item::Group { x: pt(pos.x), y: pt(pos.y), transform: matrix(group.transform), clip: group.clip.as_ref().map(curve_ops), items: inner });
                }
                FrameItem::Text(text) => {
                    if let Some(index) = current {
                        let abs = apply(acc, *pos);
                        let font = self.font_id(text.font.font())?;
                        let slot = &mut slots[index];
                        if slot.style.is_none() { slot.style = Some(TextStyle { font, size: pt(text.size), fill: color(&text.fill)?, pen_x: pt(abs.x) }); }
                        if !slot.baselines.iter().any(|b| (b - pt(abs.y)).abs() < 1e-6) { slot.baselines.push(pt(abs.y)); }
                        slot.sample.push_str(&text.text);
                        let mut pen = pt(abs.x);
                        for g in &text.glyphs {
                            slot.glyphs.push((g.id, pen + pt(g.x_offset.at(text.size))));
                            pen += pt(g.x_advance.at(text.size));
                        }
                        continue;
                    }
                    items.push(self.text_item(*pos, text)?);
                }
                FrameItem::Shape(s, _) => { let node = self.nearest(self.content_node(), "Figure"); items.push(shape_item(*pos, s, node)?) }
                FrameItem::Image(image, size, _) => { let node = self.content_node(); items.push(image_item(*pos, image, *size, node)) }
                FrameItem::Tag(tag) => {
                    if let (Some(index), Tag::Start(content, _)) = (current, tag) && content.label() == Some(self.labels.slot) {
                        slots[index].node = self.content_node();
                    }
                    self.on_tag(tag);
                }
                FrameItem::Link(..) => {}
            }
        }
        Ok(items)
    }

    /// The sample page as a flat list of atoms in absolute coordinates: unclipped translation-only groups
    /// are flattened; clipped or transformed groups (slots, bands, overlays, boxes) stay whole.
    fn flatten(&mut self, page: usize, frame: &Frame, acc: Transform, slots: &mut [SlotRecord], bands: &[BandTag], overlays: &[OverlayTag], out: &mut Vec<Atom>) -> Result<()> {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    if group.clip.is_none() && is_translation(group.transform) {
                        self.flatten(page, &group.frame, t, slots, bands, overlays, out)?;
                        continue;
                    }
                    let origin = apply(t, Point::zero());
                    let rect = Rect { x: pt(origin.x), y: pt(origin.y), w: pt(group.frame.width()), h: pt(group.frame.height()) };
                    let current = slots.iter().position(|s| s.page == page && s.rect.same(&rect));
                    let inner = self.export_frame(page, &group.frame, t, slots, current)?;
                    let kind = if let Some(b) = bands.iter().find(|b| b.page == page && b.rect.same(&rect)) {
                        AtomKind::Band { name: b.name.clone(), repeat_on_break: b.repeat_on_break }
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
                    out.push(Atom { rect: Rect { x: pt(abs.x), y: pt(abs.y), w: pt(size.x), h: pt(size.y) }, item: image_item(abs, image, *size, node), kind: AtomKind::Static });
                }
                FrameItem::Tag(tag) => self.on_tag(tag),
                FrameItem::Link(..) => {}
            }
        }
        Ok(())
    }

    /// Slot records to absolute slots plus their reference layouts. A slot whose sample is empty shows no
    /// style: with `strict` that is an error, otherwise it gets placeholders and is listed in `unstyled`.
    fn finish_slots(&self, records: Vec<SlotRecord>, strict: bool) -> Result<(Vec<ir::Slot>, Vec<String>, Vec<ReferenceSlot>)> {
        let mut unstyled = Vec::new();
        let mut reference = Vec::new();
        let mut slots = Vec::new();
        for s in records {
            let style = match s.style {
                Some(style) => style,
                None if strict => bail!("slot `{}` has no sample text; give it a non-empty sample value", s.meta.name),
                None => { unstyled.push(s.meta.name.clone()); TextStyle { font: 0, size: 0.0, fill: ir::Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }, pen_x: 0.0 } }
            };
            // The contract is geometric: the slot's baseline is the box bottom minus the declared descent (the
            // dialect aligns the text's baseline there). The sample only tells us the style; it is checked.
            let baseline = s.rect.bottom() - s.meta.descent;
            if strict && s.baselines.len() > 1 {
                eprintln!("warning: slot `{}`: the sample wrapped to {} lines; the runtime draws a single line", s.meta.name, s.baselines.len());
            }
            if strict && !s.baselines.iter().any(|b| (b - baseline).abs() < 0.01) {
                eprintln!("warning: slot `{}`: the sample's baseline(s) {:?} are not at the box bottom minus descent ({baseline:.2})", s.meta.name, s.baselines);
            }
            reference.push(ReferenceSlot {
                name: s.meta.name.clone(), baseline: s.baselines.last().copied().unwrap_or(baseline), size: style.size,
                glyphs: s.glyphs.iter().map(|(id, x)| ReferenceGlyph { id: *id, x: *x }).collect(),
                font: self.ir_fonts.get(style.font).map(|f| f.source_sha256.clone()).unwrap_or_default(),
            });
            slots.push(ir::Slot {
                name: s.meta.name, page: s.page, x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h,
                baseline, descent: s.meta.descent, pen_x: style.pen_x, font: style.font, size: style.size, fill: style.fill,
                align: s.meta.align, overflow: s.meta.overflow, max_length: s.meta.max_length, sample: s.sample, node: s.node,
                charset: s.meta.charset,
            });
        }
        Ok((slots, unstyled, reference))
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
        for (index, page) in doc.pages().iter().enumerate() {
            self.reset_structure();
            let items = self.export_frame(index, &page.frame, Transform::identity(), &mut tags.slots, None)?;
            pages.push(ir::Page { width: pt(page.frame.width()), height: pt(page.frame.height()), items, nodes: std::mem::take(&mut self.nodes) });
        }
        let (slots, unstyled, reference) = self.finish_slots(tags.slots, strict)?;
        Ok(Exported { doc: ir::Document { version: ir::VERSION, title, lang: self.lang.clone(), fonts: self.ir_fonts, pages, slots, flow: None }, unstyled, reference })
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
        self.flatten(0, &page.frame, Transform::identity(), &mut tags.slots, &tags.bands, &tags.overlays, &mut atoms)?;
        let page_nodes = std::mem::take(&mut self.nodes);
        let (abs_slots, unstyled, references) = self.finish_slots(tags.slots, strict)?;
        atoms.sort_by(|a, b| a.rect.y.partial_cmp(&b.rect.y).unwrap_or(std::cmp::Ordering::Equal));
        let (overlay_atoms, flow_atoms): (Vec<Atom>, Vec<Atom>) = atoms.into_iter().partition(|a| matches!(a.kind, AtomKind::Overlay));

        // Where each absolute slot ends up, for naming the reference and for assignment.
        enum Owner { Band { name: String, instance: Option<usize> }, Overlay, Flow }
        let mut owners: Vec<Owner> = abs_slots.iter().map(|_| Owner::Flow).collect();
        let mut taken = vec![false; abs_slots.len()];
        let take_inside = |rect: &Rect, taken: &mut Vec<bool>, owners: &mut Vec<Owner>, owner: &dyn Fn() -> Owner| -> Vec<ir::Slot> {
            let mut out = Vec::new();
            for (i, slot) in abs_slots.iter().enumerate() {
                let slot_rect = Rect { x: slot.x, y: slot.y, w: slot.width, h: slot.height };
                if !taken[i] && rect.encloses(&slot_rect) {
                    taken[i] = true;
                    owners[i] = owner();
                    let mut relative = slot.clone();
                    relative.page = 0;
                    relative.x -= rect.x; relative.y -= rect.y; relative.baseline -= rect.y; relative.pen_x -= rect.x;
                    out.push(relative);
                }
            }
            out
        };
        let fragment_of = |atom: &Atom, mut slots: Vec<ir::Slot>, y: f64| -> Result<ir::Fragment> {
            let ir::Item::Group { items, .. } = &atom.item else { bail!("a band or overlay atom is not a group") };
            let mut items = items.clone();
            let nodes = localize(&mut items, &mut slots, &page_nodes);
            Ok(ir::Fragment { x: atom.rect.x, y, width: atom.rect.w, height: atom.rect.h, items, slots, nodes })
        };

        let mut blocks = Vec::new();
        let mut bands: Vec<ir::Band> = Vec::new();
        let mut pending: Vec<&Atom> = Vec::new();
        let mut prev_bottom = area.y;
        let mut instances: HashMap<String, usize> = HashMap::new();

        let mut i = 0;
        while i < flow_atoms.len() {
            let atom = &flow_atoms[i];
            let AtomKind::Band { name, repeat_on_break } = &atom.kind else { pending.push(atom); i += 1; continue };
            // Everything above this region is a static block ending where the region starts.
            let top = prev_bottom;
            let bottom = atom.rect.y;
            if bottom < top - 0.01 { bail!("band `{name}` at y {bottom:.2} overlaps the content before it (ends at {top:.2})"); }
            if !pending.is_empty() || bottom > top + 1e-6 {
                blocks.push(ir::Block::Static { fragment: static_fragment(&pending, top, bottom - top, page_width, &page_nodes, &mut |rect| take_inside(rect, &mut taken, &mut owners, &|| Owner::Flow)) });
                pending.clear();
            }
            let mut header = None;
            let mut header_gap = 0.0;
            let mut j = i;
            if *repeat_on_break {
                if bands.iter().any(|b| &b.name == name) { bail!("header band `{name}` appears twice"); }
                let slots = take_inside(&atom.rect, &mut taken, &mut owners, &|| Owner::Band { name: name.clone(), instance: None });
                bands.push(ir::Band { name: name.clone(), repeat_on_break: true, fragment: fragment_of(atom, slots, 0.0)? });
                header = Some(name.clone());
                j += 1;
                let next = flow_atoms.get(j).ok_or_else(|| anyhow!("header band `{name}` is not followed by row bands"))?;
                header_gap = { let g = next.rect.y - atom.rect.bottom(); if g.abs() < 0.01 { 0.0 } else { g } };
            }
            let AtomKind::Band { name: row_name, repeat_on_break: false } = &flow_atoms.get(j).map(|a| &a.kind).ok_or_else(|| anyhow!("expected row bands"))? else {
                bail!("header band `{name}` must be followed directly by its row bands")
            };
            let first = &flow_atoms[j];
            let mut k = j;
            let mut gap = 0.0;
            let mut count = 0;
            while let Some(a) = flow_atoms.get(k) && matches!(&a.kind, AtomKind::Band { name, repeat_on_break: false } if name == row_name) {
                if count == 0 {
                    if bands.iter().any(|b| &b.name == row_name) { bail!("band `{row_name}` is used in two repeat regions"); }
                    let slots = take_inside(&a.rect, &mut taken, &mut owners, &|| Owner::Band { name: row_name.clone(), instance: Some(0) });
                    bands.push(ir::Band { name: row_name.clone(), repeat_on_break: false, fragment: fragment_of(a, slots, 0.0)? });
                } else {
                    if (a.rect.h - first.rect.h).abs() > 0.01 || (a.rect.w - first.rect.w).abs() > 0.01 || (a.rect.x - first.rect.x).abs() > 0.01 {
                        bail!("band `{row_name}`: instance {count} is {:.2} x {:.2} at x {:.2}, the first is {:.2} x {:.2} at x {:.2}; rows must have a fixed size", a.rect.w, a.rect.h, a.rect.x, first.rect.w, first.rect.h, first.rect.x);
                    }
                    let this_gap = { let g = a.rect.y - flow_atoms[k - 1].rect.bottom(); if g.abs() < 0.01 { 0.0 } else { g } };
                    if count == 1 { gap = this_gap; } else if (this_gap - gap).abs() > 0.01 { bail!("band `{row_name}`: the gap between rows varies ({gap:.2} vs {this_gap:.2})"); }
                    // Slots of later instances are not exported, only accounted for.
                    let n = take_inside(&a.rect, &mut taken, &mut owners, &|| Owner::Band { name: row_name.clone(), instance: Some(count) }).len();
                    if n != bands.last().unwrap().fragment.slots.len() { bail!("band `{row_name}`: instance {count} has {n} slots, the first has {}", bands.last().unwrap().fragment.slots.len()); }
                }
                count += 1;
                k += 1;
            }
            instances.insert(row_name.clone(), count);
            blocks.push(ir::Block::Repeat { band: row_name.clone(), header, header_gap, gap, sample_rows: count });
            prev_bottom = flow_atoms[k - 1].rect.bottom();
            i = k;
        }
        if !pending.is_empty() {
            let bottom = pending.iter().map(|a| a.rect.bottom()).fold(prev_bottom, f64::max);
            blocks.push(ir::Block::Static { fragment: static_fragment(&pending, prev_bottom, bottom - prev_bottom, page_width, &page_nodes, &mut |rect| take_inside(rect, &mut taken, &mut owners, &|| Owner::Flow)) });
        }
        let mut overlays = Vec::new();
        for atom in &overlay_atoms {
            let slots = take_inside(&atom.rect, &mut taken, &mut owners, &|| Owner::Overlay);
            overlays.push(fragment_of(atom, slots, atom.rect.y)?);
        }
        if let Some(i) = taken.iter().position(|t| !t) { bail!("slot `{}` is not inside any block, band or overlay", abs_slots[i].name); }

        let reference = references.into_iter().zip(&owners).map(|(mut r, owner)| {
            r.name = match owner {
                Owner::Band { name, instance: Some(i) } => format!("{name}[{i}].{}", r.name),
                Owner::Band { name, instance: None } => format!("{name}.{}", r.name),
                Owner::Overlay => format!("page[0].{}", r.name),
                Owner::Flow => r.name,
            };
            r
        }).collect();
        let _ = instances;
        Ok(Exported {
            doc: ir::Document {
                version: ir::VERSION, title, lang: self.lang.clone(), fonts: self.ir_fonts, pages: Vec::new(), slots: Vec::new(),
                flow: Some(ir::Flow { page_width, page_height, area, blocks, bands, overlays }),
            },
            unstyled, reference,
        })
    }
}

/// A static block from the atoms between two regions: items shifted so that `top` becomes 0; slots taken
/// from the vertical range.
fn static_fragment(atoms: &[&Atom], top: f64, height: f64, width: f64, nodes: &[ir::Node], take: &mut dyn FnMut(&Rect) -> Vec<ir::Slot>) -> ir::Fragment {
    let mut items: Vec<ir::Item> = atoms.iter().map(|a| { let mut item = a.item.clone(); shift(&mut item, 0.0, -top); item }).collect();
    // The fragment spans the page width from x = 0, so slot x positions stay absolute.
    let mut slots = take(&Rect { x: 0.0, y: top, w: 1e9, h: height.max(0.0) });
    let nodes = localize(&mut items, &mut slots, nodes);
    ir::Fragment { x: 0.0, y: 0.0, width, height, items, slots, nodes }
}

struct Exported { doc: ir::Document, unstyled: Vec<String>, reference: Vec<ReferenceSlot> }

// ---------------------------------------------------------------------------------------------------------
// Export-time font subsetting

/// What a slot may contain unless it declares a `charset`: printable ASCII, Latin-1 and common typography.
const DEFAULT_REPERTOIRE: &str = concat!(
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    "\u{a0}¡¢£¤¥¦§¨©ª«¬\u{ad}®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
    "–—‘’‚“”„•…€‹›™−",
);

struct SubsetFont { file: String, bytes: Vec<u8>, map: HashMap<u16, u16>, source_sha256: String }

fn each_items_mut(doc: &mut ir::Document, f: &mut dyn FnMut(&mut Vec<ir::Item>)) {
    for page in &mut doc.pages { f(&mut page.items); }
    if let Some(flow) = &mut doc.flow {
        for block in &mut flow.blocks { if let ir::Block::Static { fragment } = block { f(&mut fragment.items); } }
        for band in &mut flow.bands { f(&mut band.fragment.items); }
        for overlay in &mut flow.overlays { f(&mut overlay.items); }
    }
}

fn each_slot(doc: &ir::Document, f: &mut dyn FnMut(&ir::Slot)) {
    for slot in &doc.slots { f(slot); }
    if let Some(flow) = &doc.flow {
        for block in &flow.blocks { if let ir::Block::Static { fragment } = block { for slot in &fragment.slots { f(slot); } } }
        for band in &flow.bands { for slot in &band.fragment.slots { f(slot); } }
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
        for c in &chars { if let Some(g) = face.glyph_index(*c) { char_gids.insert(*c, g.0); } }
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

const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 0123456789-.,'";

/// Random data of the same shape: strings of random length (up to twice the sample's), random numbers,
/// arrays of 1 to 2N rows cloned from the sample rows and mutated.
fn mutate(value: &mut serde_json::Value, rng: &mut Rng) {
    match value {
        serde_json::Value::String(s) => {
            let max = (s.chars().count().max(8) * 2) as u64;
            let len = rng.below(max + 1) as usize;
            *s = (0..len).map(|_| CHARSET[rng.below(CHARSET.len() as u64) as usize] as char).collect();
        }
        serde_json::Value::Number(_) => *value = serde_json::Value::from(rng.below(1000)),
        serde_json::Value::Bool(b) => *b = !*b,
        serde_json::Value::Array(items) => {
            if items.is_empty() { return; }
            let n = 1 + rng.below(2 * items.len() as u64) as usize;
            let template = items.clone();
            *items = (0..n).map(|i| template[i % template.len()].clone()).collect();
            items.iter_mut().for_each(|v| mutate(v, rng));
        }
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| mutate(v, rng)),
        serde_json::Value::Null => {}
    }
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

struct Args { fixture: PathBuf, data: PathBuf, fonts: PathBuf, out: PathBuf, fuzz: usize, seed: u64, reference: Option<PathBuf> }

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let fixture = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]"))?);
    let name = fixture.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "doc".into());
    let mut parsed = Args {
        data: fixture.join("data.json"),
        fonts: PathBuf::from("../../fixtures/fonts"),
        out: PathBuf::from("../../.build/paramdoc").join(name),
        fuzz: 0,
        seed: 1,
        reference: None,
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
            "--reference" => parsed.reference = Some(value.into()),
            other => bail!("unknown flag {other}"),
        }
    }
    Ok(parsed)
}

fn build(fixture: &Path, data: &[u8], fonts: &[LoadedFont], strict: bool) -> Result<(PagedDocument, Exported)> {
    let world = MemWorld::new(fixture, data, fonts)?;
    let doc = compile(&world)?;
    let exported = Exporter::new(fonts)?.export(&doc, strict)?;
    Ok((doc, exported))
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
    println!("{indent}slot {:<14} rect ({:.2}, {:.2}) {:.2} x {:.2}  baseline y {:.2}  font #{} {:.1}pt  align {:<6} sample {:?}",
        slot.name, slot.x, slot.y, slot.width, slot.height, slot.baseline, slot.font, slot.size, slot.align, slot.sample);
}

fn describe(exported: &ir::Document) {
    for (i, page) in exported.pages.iter().enumerate() {
        let (t, s, g) = count(&page.items);
        println!("  page {i}: {:.1} x {:.1} pt, {t} static text runs, {s} shapes, {g} groups, nodes [{}]", page.width, page.height, roles(&page.nodes));
    }
    for slot in &exported.slots { describe_slot(slot, "  "); }
    if let Some(flow) = &exported.flow {
        println!("  flow: page {:.1} x {:.1} pt, area x {:.1} y {:.1} w {:.1} h {:.1}", flow.page_width, flow.page_height, flow.area.x, flow.area.y, flow.area.width, flow.area.height);
        for block in &flow.blocks {
            match block {
                ir::Block::Static { fragment } => {
                    let (t, s, g) = count(&fragment.items);
                    println!("  static block: height {:.2}, {t} text runs, {s} shapes, {g} groups, {} slot(s), nodes [{}]", fragment.height, fragment.slots.len(), roles(&fragment.nodes));
                    for slot in &fragment.slots { describe_slot(slot, "    "); }
                }
                ir::Block::Repeat { band, header, header_gap, gap, sample_rows } => {
                    println!("  repeat `{band}`: header {header:?} (gap after {header_gap:.2}), row gap {gap:.2}, {sample_rows} sample row(s)");
                }
            }
        }
        for band in &flow.bands {
            let (t, s, g) = count(&band.fragment.items);
            println!("  band `{}`{}: x {:.2} w {:.2} h {:.2}, {t} text runs, {s} shapes, {g} groups, {} slot(s), nodes [{}]", band.name, if band.repeat_on_break { " (repeat on break)" } else { "" }, band.fragment.x, band.fragment.width, band.fragment.height, band.fragment.slots.len(), roles(&band.fragment.nodes));
            for slot in &band.fragment.slots { describe_slot(slot, "    "); }
        }
        for overlay in &flow.overlays {
            println!("  overlay: ({:.2}, {:.2}) {:.2} x {:.2}, {} slot(s)", overlay.x, overlay.y, overlay.width, overlay.height, overlay.slots.len());
            for slot in &overlay.slots { describe_slot(slot, "    "); }
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
    let (doc, Exported { doc: mut exported, .. }) = build(&args.fixture, &data, &fonts, true)?;
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
    println!("compiled and exported in {compiled_in:.1?}: {} font(s) subset in {subset_in:.1?}, baseline PDF {} bytes, doc.json {} bytes, {}",
        exported.fonts.len(), pdf.len(), doc_json.len(), if exported.flow.is_some() { "flow document" } else { "fixed pages" });
    for (font, subset) in exported.fonts.iter().zip(&subsets) {
        println!("  font {}: {} glyphs, {} characters in the map, {} bytes ({})", subset.file, font.advances.len(), font.cmap.len(), subset.bytes.len(), font.program);
    }
    describe(&exported);

    // Typst's own layout of some other data, for the runtime to compare against: reference.json / reference.pdf.
    if let Some(path) = &args.reference {
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let (doc, Exported { mut reference, .. }) = build(&args.fixture, &bytes, &fonts, false)?;
        // Typst's glyph ids are the original font's; the runtimes report ids in the subset.
        for slot in &mut reference {
            if let Some(subset) = subsets.iter().find(|s| s.source_sha256 == slot.font) {
                for g in &mut slot.glyphs { g.id = subset.map.get(&g.id).copied().unwrap_or(g.id); }
            }
        }
        fs::write(args.out.join("reference.json"), serde_json::to_string_pretty(&reference)?)?;
        fs::write(args.out.join("reference.pdf"), typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("{e:?}"))?)?;
        println!("reference for {}: {} slot(s) written to reference.json and reference.pdf", path.display(), reference.len());
    }

    if args.fuzz == 0 { return Ok(()); }
    let original: serde_json::Value = serde_json::from_slice(&data)?;
    let baseline = static_view(&exported);
    let mut leaks = 0;
    let fuzz_started = std::time::Instant::now();
    for i in 0..args.fuzz {
        let mut rng = Rng(args.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(i as u64 + 1));
        let mut sample = original.clone();
        mutate(&mut sample, &mut rng);
        let bytes = serde_json::to_vec(&sample)?;
        let (doc, Exported { doc: mut fuzzed, unstyled, .. }) = match build(&args.fixture, &bytes, &fonts, false) {
            Ok(built) => built,
            Err(error) => { leaks += 1; println!("sample {i}: compile failed: {error}"); continue; }
        };
        // An empty sample shows no style; copy the baseline's so only the geometry is compared for that slot.
        for name in &unstyled {
            let from = exported.slots.iter().chain(exported.flow.iter().flat_map(|f| f.bands.iter().flat_map(|b| b.fragment.slots.iter()).chain(f.overlays.iter().flat_map(|o| o.slots.iter())).chain(f.blocks.iter().filter_map(|b| match b { ir::Block::Static { fragment } => Some(fragment.slots.iter()), _ => None }).flatten()))).find(|s| &s.name == name);
            let Some(from) = from else { continue };
            let entry = exported.fonts[from.font].clone();
            let font = match fuzzed.fonts.iter().position(|f| f == &entry) { Some(index) => index, None => { fuzzed.fonts.push(entry); fuzzed.fonts.len() - 1 } };
            let (size, fill) = (from.size, from.fill);
            let mut all: Vec<&mut ir::Slot> = fuzzed.slots.iter_mut().collect();
            if let Some(flow) = &mut fuzzed.flow {
                all.extend(flow.bands.iter_mut().flat_map(|b| b.fragment.slots.iter_mut()));
                all.extend(flow.overlays.iter_mut().flat_map(|o| o.slots.iter_mut()));
                all.extend(flow.blocks.iter_mut().filter_map(|b| match b { ir::Block::Static { fragment } => Some(fragment.slots.iter_mut()), _ => None }).flatten());
            }
            for to in all.into_iter().filter(|s| &s.name == name) { to.font = font; to.size = size; to.fill = fill; }
        }
        if i == 0 {
            fs::write(args.out.join("fuzz-0.json"), serde_json::to_string_pretty(&sample)?)?;
            fs::write(args.out.join("fuzz-0.pdf"), typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("{e:?}"))?)?;
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
