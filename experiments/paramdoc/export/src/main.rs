//! paramdoc-export: compiles a slot-dialect template with Typst, exports its frames as a parametric document
//! and checks that nothing outside the declared slots depends on the data.
//!
//! Usage: paramdoc-export <fixture-dir> [--data file.json] [--fonts dir] [--out dir] [--fuzz N] [--seed S]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};
use typst::diag::{FileError, FileResult, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime, Duration, Label, Value};
use typst::introspection::{MetadataElem, Tag};
use typst::layout::{Abs, Frame, FrameItem, Point, Size, Transform};
use typst_layout::PagedDocument;
use typst::model::Document as _;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::{LazyHash, PicoStr};
use typst::visualize::{Curve, CurveItem, FixedStroke, Geometry, ImageKind, Paint, Shape};
use typst::{Library, LibraryExt, World, WorldExt};
use typst_pdf::PdfOptions;

use paramdoc_ir as ir;

// ---------------------------------------------------------------------------------------------------------
// World

struct LoadedFont {
    font: Font,
    file: String,
    sha256: String,
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
// Export

#[derive(Clone, Copy, Debug)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }

impl Rect {
    fn same(&self, other: &Rect) -> bool {
        const EPS: f64 = 1e-6;
        (self.x - other.x).abs() < EPS && (self.y - other.y).abs() < EPS && (self.w - other.w).abs() < EPS && (self.h - other.h).abs() < EPS
    }
}

struct SlotMeta { name: String, align: String, overflow: String, max_length: Option<u32>, descent: f64 }

struct TextStyle { font: usize, size: f64, fill: ir::Color, pen_x: f64 }

/// What Typst itself laid out inside a slot for some data: the runtime compares its own output with this.
#[derive(serde::Serialize)]
pub struct ReferenceGlyph { pub id: u16, pub x: f64 }

#[derive(serde::Serialize)]
pub struct ReferenceSlot { pub name: String, pub baseline: f64, pub size: f64, pub glyphs: Vec<ReferenceGlyph> }

struct SlotRecord { meta: SlotMeta, page: usize, rect: Rect, style: Option<TextStyle>, sample: String, baselines: Vec<f64>, glyphs: Vec<(u16, f64)> }

struct Exporter<'a> {
    fonts: &'a [LoadedFont],
    ir_fonts: Vec<ir::Font>,
    ir_font_of: HashMap<(usize, u32), usize>,
    slot_label: Label,
}

fn pt(a: Abs) -> f64 { a.to_pt() }
fn point(p: Point) -> [f64; 2] { [pt(p.x), pt(p.y)] }

fn matrix(t: Transform) -> [f64; 6] { [t.sx.get(), t.ky.get(), t.kx.get(), t.sy.get(), pt(t.tx), pt(t.ty)] }

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
        Paint::Solid(c) => {
            let rgb = c.to_rgb();
            Ok(ir::Color { r: rgb.red, g: rgb.green, b: rgb.blue, a: rgb.alpha })
        }
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

fn shape(pos: Point, s: &Shape) -> Result<ir::Item> {
    let geometry = match &s.geometry {
        Geometry::Line(to) => ir::Geometry::Line { to: point(*to) },
        Geometry::Rect(size) => ir::Geometry::Rect { width: pt(size.x), height: pt(size.y) },
        Geometry::Curve(curve) => ir::Geometry::Path { ops: curve_ops(curve) },
    };
    Ok(ir::Item::Shape {
        x: pt(pos.x), y: pt(pos.y), geometry,
        fill: s.fill.as_ref().map(color).transpose()?,
        stroke: s.stroke.as_ref().map(stroke).transpose()?,
    })
}

/// Absolute transform of a child frame placed at `pos` inside a parent with absolute transform `acc`.
/// Maps a point through a transform: `x' = sx·x + kx·y + tx`, `y' = ky·x + sy·y + ty`.
fn apply(t: Transform, p: Point) -> Point {
    Point::new(t.sx.get() * p.x + t.kx.get() * p.y + t.tx, t.ky.get() * p.x + t.sy.get() * p.y + t.ty)
}

fn child_transform(acc: Transform, pos: Point, own: Transform) -> Transform {
    acc.pre_concat(Transform::translate(pos.x, pos.y)).pre_concat(own)
}

impl<'a> Exporter<'a> {
    fn new(fonts: &'a [LoadedFont]) -> Result<Self> {
        let slot_label = Label::new(PicoStr::intern("paramdoc-slot")).ok_or_else(|| anyhow!("empty label"))?;
        Ok(Self { fonts, ir_fonts: Vec::new(), ir_font_of: HashMap::new(), slot_label })
    }

    fn font_id(&mut self, font: &Font) -> Result<usize> {
        let key = (font.data().as_ptr() as usize, font.index());
        if let Some(&id) = self.ir_font_of.get(&key) { return Ok(id); }
        let loaded = self.fonts.iter()
            .find(|f| f.font.data().as_ptr() == font.data().as_ptr() && f.font.index() == font.index())
            .ok_or_else(|| anyhow!("text uses a font that was not loaded from the fonts directory: {}", font.info().family))?;
        let id = self.ir_fonts.len();
        self.ir_fonts.push(ir::Font { family: font.info().family.to_string(), index: font.index(), sha256: loaded.sha256.clone(), file: loaded.file.clone() });
        self.ir_font_of.insert(key, id);
        Ok(id)
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
        let descent = match dict.get("descent") {
            Ok(Value::Float(f)) => *f,
            Ok(Value::Int(n)) => *n as f64,
            Ok(Value::Length(l)) => l.abs.to_pt(),
            other => bail!("slot metadata `descent` is not a number of points: {other:?}"),
        };
        Ok(SlotMeta { name: string("name")?, align: string("align")?, overflow: string("overflow")?, max_length, descent })
    }

    /// Pass 1: every slot tag and the clipped box it sits in.
    fn collect_slots(&self, page: usize, frame: &Frame, acc: Transform, clipped: Option<Rect>, out: &mut Vec<SlotRecord>) -> Result<()> {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let t = child_transform(acc, *pos, group.transform);
                    let rect = if group.clip.is_some() { Some(self.rect_of(t, group.frame.size())?) } else { clipped };
                    self.collect_slots(page, &group.frame, t, rect, out)?;
                }
                FrameItem::Tag(Tag::Start(content, _)) if content.label() == Some(self.slot_label) => {
                    let elem = content.to_packed::<MetadataElem>().ok_or_else(|| anyhow!("slot label on a non-metadata element"))?;
                    let meta = self.slot_meta(&elem.value)?;
                    let rect = clipped.ok_or_else(|| anyhow!("slot `{}` is not inside a clipped box", meta.name))?;
                    out.push(SlotRecord { meta, page, rect, style: None, sample: String::new(), baselines: Vec::new(), glyphs: Vec::new() });
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn rect_of(&self, t: Transform, size: Size) -> Result<Rect> {
        let translation_only = (t.sx.get() - 1.0).abs() < 1e-9 && (t.sy.get() - 1.0).abs() < 1e-9 && t.kx.get().abs() < 1e-9 && t.ky.get().abs() < 1e-9;
        if !translation_only { bail!("a clipped group with a non-translation transform is not supported yet: {t:?}"); }
        let origin = apply(t, Point::zero());
        Ok(Rect { x: pt(origin.x), y: pt(origin.y), w: pt(size.x), h: pt(size.y) })
    }

    /// Pass 2: static items. Everything inside a slot's clipped box is dynamic: its text only informs the
    /// slot's style and is otherwise dropped. Membership is by frame hierarchy, not geometry, so a run that
    /// starts exactly at a slot's edge is never mistaken for slot content.
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
                    items.push(ir::Item::Group {
                        x: pt(pos.x), y: pt(pos.y), transform: matrix(group.transform),
                        clip: group.clip.as_ref().map(curve_ops), items: inner,
                    });
                }
                FrameItem::Text(text) => {
                    let font = self.font_id(text.font.font())?;
                    let fill = color(&text.fill)?;
                    if let Some(index) = current {
                        let abs = apply(acc, *pos);
                        let slot = &mut slots[index];
                        if slot.style.is_none() {
                            slot.style = Some(TextStyle { font, size: pt(text.size), fill, pen_x: pt(abs.x) });
                        }
                        if !slot.baselines.iter().any(|b| (b - pt(abs.y)).abs() < 1e-6) { slot.baselines.push(pt(abs.y)); }
                        slot.sample.push_str(&text.text);
                        let mut pen = pt(abs.x);
                        for g in &text.glyphs {
                            slot.glyphs.push((g.id, pen + pt(g.x_offset.at(text.size))));
                            pen += pt(g.x_advance.at(text.size));
                        }
                        continue;
                    }
                    items.push(ir::Item::Text {
                        x: pt(pos.x), y: pt(pos.y), font, size: pt(text.size), fill, text: text.text.to_string(),
                        glyphs: text.glyphs.iter().map(|g| ir::Glyph {
                            id: g.id,
                            x_advance: pt(g.x_advance.at(text.size)),
                            x_offset: pt(g.x_offset.at(text.size)),
                            y_offset: pt(g.y_offset.at(text.size)),
                        }).collect(),
                    });
                }
                FrameItem::Shape(s, _) => items.push(shape(*pos, s)?),
                FrameItem::Image(image, size, _) => {
                    let (format, sha256) = match image.kind() {
                        ImageKind::Raster(raster) => (format!("{:?}", raster.format()).to_ascii_lowercase(), hex(&Sha256::digest(raster.data()))),
                        ImageKind::Svg(_) => ("svg".to_string(), String::new()),
                        ImageKind::Pdf(_) => ("pdf".to_string(), String::new()),
                    };
                    items.push(ir::Item::Image { x: pt(pos.x), y: pt(pos.y), width: pt(size.x), height: pt(size.y), format, sha256 });
                }
                FrameItem::Link(..) | FrameItem::Tag(..) => {}
            }
        }
        Ok(items)
    }

    /// Exports the document. With `strict`, a slot whose sample is empty is an error, because its style
    /// cannot be observed; without it (fuzz builds) such slots get placeholder styles and are reported in
    /// the second return value so the caller can exclude them from the style comparison.
    fn export(mut self, doc: &PagedDocument, strict: bool) -> Result<(ir::Document, Vec<String>, Vec<ReferenceSlot>)> {
        let mut unstyled = Vec::new();
        let mut reference = Vec::new();
        let mut slots = Vec::new();
        for (index, page) in doc.pages().iter().enumerate() {
            self.collect_slots(index, &page.frame, Transform::identity(), None, &mut slots)?;
        }
        let mut pages = Vec::new();
        for (index, page) in doc.pages().iter().enumerate() {
            let items = self.export_frame(index, &page.frame, Transform::identity(), &mut slots, None)?;
            pages.push(ir::Page { width: pt(page.frame.width()), height: pt(page.frame.height()), items });
        }
        let slots = slots.into_iter().map(|s| {
            let style = match s.style {
                Some(style) => style,
                None if strict => bail!("slot `{}` has no sample text; give it a non-empty sample value", s.meta.name),
                None => { unstyled.push(s.meta.name.clone()); TextStyle { font: 0, size: 0.0, fill: ir::Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }, pen_x: 0.0 } }
            };
            // The contract is geometric: the slot's baseline is the box bottom minus the declared descent (the
            // dialect aligns the text's baseline there). The sample only tells us the style; it is checked.
            let baseline = s.rect.y + s.rect.h - s.meta.descent;
            if strict && s.baselines.len() > 1 {
                eprintln!("warning: slot `{}`: the sample wrapped to {} lines; the runtime draws a single line", s.meta.name, s.baselines.len());
            }
            if strict && !s.baselines.iter().any(|b| (b - baseline).abs() < 0.01) {
                eprintln!("warning: slot `{}`: the sample's baseline(s) {:?} are not at the box bottom {baseline:.2}", s.meta.name, s.baselines);
            }
            reference.push(ReferenceSlot {
                name: s.meta.name.clone(), baseline: s.baselines.last().copied().unwrap_or(baseline), size: style.size,
                glyphs: s.glyphs.iter().map(|(id, x)| ReferenceGlyph { id: *id, x: *x }).collect(),
            });
            Ok(ir::Slot {
                name: s.meta.name, page: s.page, x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h,
                baseline, descent: s.meta.descent, pen_x: style.pen_x, font: style.font, size: style.size, fill: style.fill,
                align: s.meta.align, overflow: s.meta.overflow, max_length: s.meta.max_length, sample: s.sample,
            })
        }).collect::<Result<Vec<_>>>()?;
        Ok((ir::Document {
            version: ir::VERSION,
            title: doc.info().title.as_ref().map(|t| t.to_string()),
            fonts: self.ir_fonts,
            pages,
            slots,
        }, unstyled, reference))
    }
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

fn mutate(value: &mut serde_json::Value, rng: &mut Rng) {
    match value {
        serde_json::Value::String(s) => {
            let max = (s.chars().count().max(8) * 2) as u64;
            let len = rng.below(max + 1) as usize;
            *s = (0..len).map(|_| CHARSET[rng.below(CHARSET.len() as u64) as usize] as char).collect();
        }
        serde_json::Value::Number(_) => *value = serde_json::Value::from(rng.below(1000)),
        serde_json::Value::Bool(b) => *b = !*b,
        serde_json::Value::Array(items) => items.iter_mut().for_each(|v| mutate(v, rng)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| mutate(v, rng)),
        serde_json::Value::Null => {}
    }
}

/// The layout contract: everything except what the data is allowed to change. Font references are resolved
/// to the font's identity, because the table is built from what the frames use and a slot with an empty
/// sample uses nothing; the table itself is left out.
fn static_view(doc: &ir::Document) -> serde_json::Value {
    let mut doc = doc.clone();
    for slot in &mut doc.slots { slot.sample.clear(); slot.pen_x = 0.0; }
    let identities: Vec<String> = doc.fonts.iter().map(|f| format!("{}#{}@{}", f.family, f.index, &f.sha256[..8])).collect();
    let mut value = serde_json::to_value(doc).expect("serializable");
    fn resolve(value: &mut serde_json::Value, identities: &[String]) {
        match value {
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::Number(n)) = map.get("font")
                    && let Some(identity) = n.as_u64().and_then(|i| identities.get(i as usize))
                {
                    map.insert("font".into(), serde_json::Value::String(identity.clone()));
                }
                map.values_mut().for_each(|v| resolve(v, identities));
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|v| resolve(v, identities)),
            _ => {}
        }
    }
    resolve(&mut value, &identities);
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
    let fixture = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S]"))?);
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

struct Built { doc: PagedDocument, exported: ir::Document, unstyled: Vec<String>, reference: Vec<ReferenceSlot> }

fn build(fixture: &Path, data: &[u8], fonts: &[LoadedFont], strict: bool) -> Result<Built> {
    let world = MemWorld::new(fixture, data, fonts)?;
    let doc = compile(&world)?;
    let (exported, unstyled, reference) = Exporter::new(fonts)?.export(&doc, strict)?;
    Ok(Built { doc, exported, unstyled, reference })
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
    let Built { doc, exported, .. } = build(&args.fixture, &data, &fonts, true)?;
    let compiled_in = started.elapsed();
    let pdf = typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("pdf export failed: {e:?}"))?;
    fs::write(args.out.join("baseline.pdf"), &pdf)?;
    fs::write(args.out.join("doc.json"), serde_json::to_string_pretty(&exported)?)?;
    let font_dir = args.out.join("fonts");
    fs::create_dir_all(&font_dir)?;
    for font in &exported.fonts {
        let source = fonts.iter().find(|f| f.file == font.file).expect("exported font was loaded");
        fs::write(font_dir.join(&font.file), source.font.data().as_ref() as &[u8])?;
    }

    fn count(items: &[ir::Item]) -> (usize, usize, usize) {
        items.iter().fold((0, 0, 0), |(t, s, g), item| match item {
            ir::Item::Text { .. } => (t + 1, s, g),
            ir::Item::Shape { .. } => (t, s + 1, g),
            ir::Item::Group { items, .. } => { let (a, b, c) = count(items); (t + a, s + b, g + 1 + c) }
            ir::Item::Image { .. } => (t, s, g),
        })
    }
    println!("compiled and exported in {compiled_in:.1?}: {} page(s), {} font(s), {} slot(s), baseline PDF {} bytes",
        exported.pages.len(), exported.fonts.len(), exported.slots.len(), pdf.len());
    for (i, page) in exported.pages.iter().enumerate() {
        let (t, s, g) = count(&page.items);
        println!("  page {i}: {:.1} x {:.1} pt, {t} static text runs, {s} shapes, {g} groups", page.width, page.height);
    }
    for slot in &exported.slots {
        println!("  slot {:<10} page {} rect ({:.2}, {:.2}) {:.2} x {:.2}  baseline y {:.2}  pen x {:.2}  font #{} {:.1}pt  align {:<6} sample {:?}",
            slot.name, slot.page, slot.x, slot.y, slot.width, slot.height, slot.baseline, slot.pen_x, slot.font, slot.size, slot.align, slot.sample);
    }

    // Typst's own layout of some other data, for the runtime to compare against: reference.json / reference.pdf.
    if let Some(path) = &args.reference {
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let Built { doc, reference, .. } = build(&args.fixture, &bytes, &fonts, false)?;
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
        let Built { doc, exported: mut fuzzed, unstyled, .. } = match build(&args.fixture, &bytes, &fonts, false) {
            Ok(built) => built,
            Err(error) => { leaks += 1; println!("sample {i}: compile failed: {error}"); continue; }
        };
        // An empty sample shows no style; copy the baseline's so only the geometry is compared for that slot.
        for name in &unstyled {
            let Some(from) = exported.slots.iter().find(|s| &s.name == name) else { continue };
            let entry = exported.fonts[from.font].clone();
            let font = match fuzzed.fonts.iter().position(|f| f == &entry) {
                Some(index) => index,
                None => { fuzzed.fonts.push(entry); fuzzed.fonts.len() - 1 }
            };
            if let Some(to) = fuzzed.slots.iter_mut().find(|s| &s.name == name) {
                to.font = font; to.size = from.size; to.fill = from.fill;
            }
        }
        if i == 0 {
            fs::write(args.out.join("fuzz-0.json"), serde_json::to_string_pretty(&sample)?)?;
            fs::write(args.out.join("fuzz-0.pdf"), typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|e| anyhow!("{e:?}"))?)?;
        }
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
