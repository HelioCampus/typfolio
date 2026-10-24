//! paramdoc-runtime: fills a parametric document with data and writes a PDF. No Typst, no shaper: static
//! items are drawn as exported, slot text is mapped to glyphs through the font's cmap and advanced by its
//! horizontal metrics (the dialect turns kerning and ligatures off inside slots, so this matches Typst for
//! simple scripts). A flow document is composed page by page: blocks are stacked, rows break to new pages,
//! header bands repeat, overlays are drawn on every page with the page counters filled.
//!
//! Usage: paramdoc-runtime <doc-dir> --data data.json --out out.pdf [--expect reference.json]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use flate2::{Compression, write::ZlibEncoder};
use pdf_writer::types::{CidFontType, FontFlags, LineCapStyle, LineJoinStyle, SystemInfo};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subsetter::GlyphRemapper;
use ttf_parser::{Face, GlyphId};

use paramdoc_ir as ir;

// ---------------------------------------------------------------------------------------------------------
// Fonts

struct LoadedFont<'a> {
    face: Face<'a>,
    data: &'a [u8],
    units_per_em: f64,
}

impl LoadedFont<'_> {
    fn advance(&self, glyph: u16) -> f64 {
        self.face.glyph_hor_advance(GlyphId(glyph)).unwrap_or(0) as f64 / self.units_per_em
    }
    /// Glyph for a character, or `None` when the font has no glyph for it.
    fn glyph(&self, c: char) -> Option<u16> {
        self.face.glyph_index(c).map(|g| g.0)
    }
}

fn load_fonts<'a>(doc: &ir::Document, dir: &Path, storage: &'a mut Vec<Vec<u8>>) -> Result<Vec<LoadedFont<'a>>> {
    for font in &doc.fonts {
        let path = dir.join("fonts").join(&font.file);
        let data = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let sha = format!("{:x}", Sha256::digest(&data));
        if sha != font.sha256 { bail!("{}: sha256 {sha} does not match the document's {}", font.file, font.sha256); }
        storage.push(data);
    }
    let mut fonts = Vec::new();
    for (font, data) in doc.fonts.iter().zip(storage.iter()) {
        let face = Face::parse(data, font.index).map_err(|e| anyhow!("{}: {e}", font.file))?;
        let units_per_em = face.units_per_em() as f64;
        fonts.push(LoadedFont { face, data, units_per_em });
    }
    Ok(fonts)
}

// ---------------------------------------------------------------------------------------------------------
// Slot filling

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ReferenceGlyph { id: u16, x: f64 }

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ReferenceSlot { name: String, baseline: f64, size: f64, glyphs: Vec<ReferenceGlyph> }

#[derive(Serialize, Debug)]
struct FillTrace { slots: Vec<ReferenceSlot> }

fn text_of(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => bail!("cannot render {other} as text"),
    })
}

/// A filled slot: the text item to draw (clipped to the slot's box) and what was drawn, for the reference check.
struct Filled { slot: ir::Slot, item: ir::Item, trace: ReferenceSlot }

/// Lays out one line of slot text: glyphs from the cmap, advances from hmtx, alignment from the slot,
/// and the slot's overflow policy when the line is wider than the box. `slot` is in absolute coordinates.
fn fill_slot(slot: &ir::Slot, text: &str, font: &LoadedFont, trace_name: String) -> Result<Filled> {
    if let Some(max) = slot.max_length && text.chars().count() > max as usize {
        bail!("slot `{trace_name}`: {text:?} has {} characters, max-length is {max}", text.chars().count());
    }
    let shape = |text: &str, size: f64| -> Result<(Vec<ir::Glyph>, f64)> {
        let mut glyphs = Vec::new();
        let mut width = 0.0;
        for c in text.chars() {
            let id = font.glyph(c).ok_or_else(|| anyhow!("slot `{trace_name}`: the font has no glyph for {c:?} (U+{:04X})", c as u32))?;
            let advance = font.advance(id) * size;
            glyphs.push(ir::Glyph { id, x_advance: advance, x_offset: 0.0, y_offset: 0.0 });
            width += advance;
        }
        Ok((glyphs, width))
    };
    let mut size = slot.size;
    let (mut glyphs, mut width) = shape(text, size)?;
    let mut shown = text.to_string();
    if width > slot.width + 1e-6 {
        match slot.overflow.as_str() {
            "error" => bail!("slot `{trace_name}`: {text:?} is {width:.2} pt wide but the slot is {:.2} pt; declare an overflow policy or a smaller max-length", slot.width),
            "clip" => {} // the box clips anyway, as it does in Typst
            "shrink" => {
                let factor = slot.width / width;
                if factor < 0.5 { bail!("slot `{trace_name}`: shrinking {text:?} to fit would need {factor:.2}x; the limit is 0.5x"); }
                size *= factor;
                (glyphs, width) = shape(text, size)?;
            }
            "ellipsis" => {
                let ellipsis = if font.glyph('…').is_some() { "…" } else { "..." };
                let mut chars: Vec<char> = text.chars().collect();
                loop {
                    chars.pop();
                    shown = chars.iter().collect::<String>() + ellipsis;
                    (glyphs, width) = shape(&shown, size)?;
                    if width <= slot.width || chars.is_empty() { break; }
                }
            }
            other => bail!("slot `{trace_name}`: unknown overflow policy {other:?}"),
        }
    }
    let x = match slot.align.as_str() {
        "left" => slot.x,
        "center" => slot.x + (slot.width - width) / 2.0,
        "right" => slot.x + slot.width - width,
        other => bail!("slot `{trace_name}`: unknown alignment {other:?}"),
    };
    let mut pen = x;
    let trace_glyphs = glyphs.iter().map(|g| { let at = pen; pen += g.x_advance; ReferenceGlyph { id: g.id, x: at } }).collect();
    Ok(Filled {
        slot: slot.clone(),
        item: ir::Item::Text { x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs },
        trace: ReferenceSlot { name: trace_name, baseline: slot.baseline, size, glyphs: trace_glyphs },
    })
}

// ---------------------------------------------------------------------------------------------------------
// Composition

/// One output page: static items in absolute coordinates and the slots filled on it.
struct Composed { width: f64, height: f64, items: Vec<ir::Item>, fills: Vec<Filled> }

/// Values a slot can be filled from: a data object plus, on overlays, the page counters.
struct Scope<'a> { data: &'a serde_json::Value, counters: Option<(usize, usize)> }

impl Scope<'_> {
    fn text(&self, name: &str) -> Result<String> {
        if let Some((number, count)) = self.counters {
            if name == "page-number" { return Ok(number.to_string()); }
            if name == "page-count" { return Ok(count.to_string()); }
        }
        let value = self.data.get(name).ok_or_else(|| anyhow!("data has no value for slot `{name}`"))?;
        text_of(value)
    }
}

fn clip_ops(width: f64, height: f64) -> Vec<ir::PathOp> {
    vec![ir::PathOp::Move { to: [0.0, 0.0] }, ir::PathOp::Line { to: [width, 0.0] }, ir::PathOp::Line { to: [width, height] }, ir::PathOp::Line { to: [0.0, height] }, ir::PathOp::Close]
}

/// Draws a fragment with its top at `top` and fills its slots from `scope`.
fn place(fragment: &ir::Fragment, top: f64, scope: &Scope, fonts: &[LoadedFont], prefix: &str, clip: bool, page: &mut Composed) -> Result<()> {
    page.items.push(ir::Item::Group {
        x: fragment.x, y: top, transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        clip: clip.then(|| clip_ops(fragment.width, fragment.height)), items: fragment.items.clone(),
    });
    for slot in &fragment.slots {
        let mut absolute = slot.clone();
        absolute.x += fragment.x; absolute.pen_x += fragment.x;
        absolute.y += top; absolute.baseline += top;
        let text = scope.text(&slot.name)?;
        page.fills.push(fill_slot(&absolute, &text, &fonts[slot.font], format!("{prefix}{}", slot.name))?);
    }
    Ok(())
}

fn compose_fixed(doc: &ir::Document, data: &serde_json::Value, fonts: &[LoadedFont]) -> Result<Vec<Composed>> {
    let scope = Scope { data, counters: None };
    let mut pages = Vec::new();
    for (index, page) in doc.pages.iter().enumerate() {
        let mut composed = Composed { width: page.width, height: page.height, items: page.items.clone(), fills: Vec::new() };
        for slot in doc.slots.iter().filter(|s| s.page == index) {
            composed.fills.push(fill_slot(slot, &scope.text(&slot.name)?, &fonts[slot.font], slot.name.clone())?);
        }
        pages.push(composed);
    }
    Ok(pages)
}

fn compose_flow(flow: &ir::Flow, data: &serde_json::Value, fonts: &[LoadedFont]) -> Result<Vec<Composed>> {
    const EPS: f64 = 1e-6;
    let area = flow.area;
    let bottom = area.y + area.height;
    let band = |name: &str| flow.bands.iter().find(|b| b.name == name).ok_or_else(|| anyhow!("unknown band `{name}`"));
    let new_page = || Composed { width: flow.page_width, height: flow.page_height, items: Vec::new(), fills: Vec::new() };
    let scope = Scope { data, counters: None };

    let mut pages = vec![new_page()];
    let mut cursor = area.y;
    for block in &flow.blocks {
        match block {
            ir::Block::Static { fragment } => {
                if cursor + fragment.height > bottom + EPS && cursor > area.y + EPS { pages.push(new_page()); cursor = area.y; }
                place(fragment, cursor, &scope, fonts, "", false, pages.last_mut().unwrap())?;
                cursor += fragment.height;
            }
            ir::Block::Repeat { band: name, header, header_gap, gap, .. } => {
                let rows = data.get(name).and_then(|v| v.as_array()).ok_or_else(|| anyhow!("data has no array `{name}` for the repeat region"))?;
                let row_band = band(name)?;
                let header_band = header.as_deref().map(band).transpose()?;
                let header_height = header_band.map(|h| h.fragment.height + header_gap).unwrap_or(0.0);
                let first_row = if rows.is_empty() { 0.0 } else { row_band.fragment.height };
                if cursor + header_height + first_row > bottom + EPS && cursor > area.y + EPS { pages.push(new_page()); cursor = area.y; }
                if let Some(h) = header_band {
                    place(&h.fragment, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap())?;
                    cursor += header_height;
                }
                for (i, row) in rows.iter().enumerate() {
                    if cursor + row_band.fragment.height > bottom + EPS {
                        pages.push(new_page());
                        cursor = area.y;
                        if let Some(h) = header_band {
                            place(&h.fragment, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap())?;
                            cursor += header_height;
                        }
                    }
                    let row_scope = Scope { data: row, counters: None };
                    place(&row_band.fragment, cursor, &row_scope, fonts, &format!("{name}[{i}]."), true, pages.last_mut().unwrap())?;
                    cursor += row_band.fragment.height;
                    if i + 1 < rows.len() { cursor += gap; }
                }
            }
        }
    }
    let count = pages.len();
    for (index, page) in pages.iter_mut().enumerate() {
        let scope = Scope { data, counters: Some((index + 1, count)) };
        for overlay in &flow.overlays {
            place(overlay, overlay.y, &scope, fonts, &format!("page[{index}]."), true, page)?;
        }
    }
    Ok(pages)
}

// ---------------------------------------------------------------------------------------------------------
// PDF writing

struct Writer<'a> {
    fonts: &'a [LoadedFont<'a>],
    /// Original glyph id to subset glyph id, per font.
    remaps: &'a [HashMap<u16, u16>],
    warned_images: bool,
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("in-memory write");
    encoder.finish().expect("in-memory finish")
}

fn collect_glyphs(items: &[ir::Item], used: &mut [BTreeSet<u16>]) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => collect_glyphs(items, used),
            ir::Item::Text { font, glyphs, .. } => used[*font].extend(glyphs.iter().map(|g| g.id)),
            _ => {}
        }
    }
}

fn rgb(c: &ir::Color) -> (f32, f32, f32) { (c.r, c.g, c.b) }

fn path_ops(content: &mut Content, ops: &[ir::PathOp]) {
    for op in ops {
        match op {
            ir::PathOp::Move { to } => { content.move_to(to[0] as f32, to[1] as f32); }
            ir::PathOp::Line { to } => { content.line_to(to[0] as f32, to[1] as f32); }
            ir::PathOp::Cubic { c1, c2, to } => { content.cubic_to(c1[0] as f32, c1[1] as f32, c2[0] as f32, c2[1] as f32, to[0] as f32, to[1] as f32); }
            ir::PathOp::Close => { content.close_path(); }
        }
    }
}

impl Writer<'_> {
    fn emit(&mut self, content: &mut Content, items: &[ir::Item]) {
        for item in items {
            match item {
                ir::Item::Group { x, y, transform, clip, items } => {
                    content.save_state();
                    content.transform([1.0, 0.0, 0.0, 1.0, *x as f32, *y as f32]);
                    if *transform != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] { content.transform(transform.map(|v| v as f32)); }
                    if let Some(ops) = clip { path_ops(content, ops); content.clip_nonzero(); content.end_path(); }
                    self.emit(content, items);
                    content.restore_state();
                }
                ir::Item::Text { x, y, font, size, fill, glyphs, .. } => self.text(content, *x, *y, *font, *size, fill, glyphs),
                ir::Item::Shape { x, y, geometry, fill, stroke } => {
                    content.save_state();
                    content.transform([1.0, 0.0, 0.0, 1.0, *x as f32, *y as f32]);
                    if let Some(fill) = fill { let (r, g, b) = rgb(fill); content.set_fill_rgb(r, g, b); }
                    if let Some(stroke) = stroke {
                        let (r, g, b) = rgb(&stroke.paint);
                        content.set_stroke_rgb(r, g, b);
                        content.set_line_width(stroke.thickness as f32);
                        content.set_line_cap(match stroke.cap.as_str() { "round" => LineCapStyle::RoundCap, "square" => LineCapStyle::ProjectingSquareCap, _ => LineCapStyle::ButtCap });
                        content.set_line_join(match stroke.join.as_str() { "round" => LineJoinStyle::RoundJoin, "bevel" => LineJoinStyle::BevelJoin, _ => LineJoinStyle::MiterJoin });
                        content.set_miter_limit(stroke.miter_limit as f32);
                        if let Some(dash) = &stroke.dash { content.set_dash_pattern(dash.array.iter().map(|v| *v as f32), dash.phase as f32); }
                    }
                    match geometry {
                        ir::Geometry::Line { to } => { content.move_to(0.0, 0.0); content.line_to(to[0] as f32, to[1] as f32); }
                        ir::Geometry::Rect { width, height } => { content.rect(0.0, 0.0, *width as f32, *height as f32); }
                        ir::Geometry::Path { ops } => path_ops(content, ops),
                    }
                    match (fill.is_some(), stroke.is_some()) {
                        (true, true) => { content.fill_nonzero_and_stroke(); }
                        (true, false) => { content.fill_nonzero(); }
                        (false, true) => { content.stroke(); }
                        (false, false) => { content.end_path(); }
                    }
                    content.restore_state();
                }
                ir::Item::Image { .. } => {
                    if !self.warned_images { eprintln!("warning: images are not drawn yet"); self.warned_images = true; }
                }
            }
        }
    }

    /// A text run. The page CTM flips y, so the text matrix flips it back to keep glyphs upright.
    /// TJ adjustments (thousandths of text space, positive = move left) make the pen follow the exported
    /// advances instead of the font's, and apply per-glyph x offsets.
    fn text(&mut self, content: &mut Content, x: f64, y: f64, font: usize, size: f64, fill: &ir::Color, glyphs: &[ir::Glyph]) {
        let loaded = &self.fonts[font];
        let (r, g, b) = rgb(fill);
        content.set_fill_rgb(r, g, b);
        content.begin_text();
        content.set_font(Name(format!("F{font}").as_bytes()), size as f32);
        content.set_text_matrix([1.0, 0.0, 0.0, -1.0, x as f32, y as f32]);
        let mut positioned = content.show_positioned();
        let mut items = positioned.items();
        let mut pending = 0.0f64; // pt the pen must still move right before the next glyph
        for glyph in glyphs {
            if glyph.y_offset != 0.0 { eprintln!("warning: vertical glyph offsets are ignored"); }
            let shift = pending + glyph.x_offset;
            if shift.abs() > 1e-6 { items.adjust((-shift * 1000.0 / size) as f32); }
            let subset_id = self.remaps[font].get(&glyph.id).copied().unwrap_or(0);
            items.show(Str(&subset_id.to_be_bytes()));
            let natural = loaded.advance(glyph.id) * size;
            pending = glyph.x_advance - glyph.x_offset - natural;
        }
        items.finish();
        positioned.finish();
        content.end_text();
    }
}

fn write_pdf(doc: &ir::Document, fonts: &[LoadedFont], pages: &[Composed]) -> Result<Vec<u8>> {
    let mut pdf = Pdf::new();
    let mut next = 1;
    let mut alloc = || { let r = Ref::new(next); next += 1; r };
    let catalog = alloc();
    let pages_id = alloc();
    let info = alloc();
    let font_refs: Vec<Ref> = (0..fonts.len()).map(|_| alloc()).collect();
    let page_ids: Vec<Ref> = (0..pages.len()).map(|_| alloc()).collect();

    pdf.catalog(catalog).pages(pages_id);
    pdf.pages(pages_id).kids(page_ids.iter().copied()).count(pages.len() as i32);
    if let Some(title) = &doc.title { pdf.document_info(info).title(TextStr(title)); }

    // Glyphs actually used, per font: the embedded font programs are subset to them and remapped.
    let mut used: Vec<BTreeSet<u16>> = vec![BTreeSet::new(); fonts.len()];
    for page in pages {
        collect_glyphs(&page.items, &mut used);
        for fill in &page.fills { collect_glyphs(std::slice::from_ref(&fill.item), &mut used); }
    }
    let mut remaps: Vec<HashMap<u16, u16>> = Vec::new();

    for (i, font) in fonts.iter().enumerate() {
        let cid = alloc();
        let descriptor = alloc();
        let file = alloc();
        let name = format!("PARAMD+{}", doc.fonts[i].file.replace(|c: char| !c.is_ascii_alphanumeric(), ""));
        let gids: Vec<u16> = used[i].iter().copied().collect();
        let remapper = GlyphRemapper::new_from_glyphs(&gids);
        let subset = subsetter::subset(font.data, doc.fonts[i].index, &remapper).map_err(|e| anyhow!("subsetting {}: {e:?}", doc.fonts[i].file))?;
        // The subsetter returns a bare CFF table for CFF-flavoured fonts and a TrueType file otherwise.
        let (truetype, file_subtype) = match subset.get(..4) {
            Some(b"OTTO") => (false, Some("OpenType")),
            Some([0, 1, 0, 0]) | Some(b"true") => (true, None),
            _ => (false, Some("CIDFontType0C")),
        };
        let mut widths = vec![0f32; remapper.num_gids() as usize];
        let mut map = HashMap::new();
        for old in &gids {
            let new = remapper.get(*old).ok_or_else(|| anyhow!("glyph {old} missing from the subset"))?;
            map.insert(*old, new);
            widths[new as usize] = (font.advance(*old) * 1000.0) as f32;
        }
        widths[0] = (font.advance(0) * 1000.0) as f32;
        remaps.push(map);

        pdf.type0_font(font_refs[i]).base_font(Name(name.as_bytes())).encoding_predefined(Name(b"Identity-H")).descendant_font(cid);
        let scale = 1000.0 / font.units_per_em;
        let mut cid_font = pdf.cid_font(cid);
        cid_font.subtype(if truetype { CidFontType::Type2 } else { CidFontType::Type0 })
            .base_font(Name(name.as_bytes()))
            .system_info(SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 })
            .font_descriptor(descriptor)
            .default_width(0.0);
        if truetype { cid_font.cid_to_gid_map_predefined(Name(b"Identity")); }
        cid_font.widths().consecutive(0, widths.iter().copied());
        cid_font.finish();
        let bbox = font.face.global_bounding_box();
        let mut flags = FontFlags::SERIF | FontFlags::NON_SYMBOLIC;
        if font.face.is_italic() { flags |= FontFlags::ITALIC; }
        let mut desc = pdf.font_descriptor(descriptor);
        desc.name(Name(name.as_bytes())).flags(flags)
            .bbox(Rect::new(bbox.x_min as f32 * scale as f32, bbox.y_min as f32 * scale as f32, bbox.x_max as f32 * scale as f32, bbox.y_max as f32 * scale as f32))
            .italic_angle(font.face.italic_angle())
            .ascent(font.face.ascender() as f32 * scale as f32)
            .descent(font.face.descender() as f32 * scale as f32)
            .cap_height(font.face.capital_height().unwrap_or(font.face.ascender()) as f32 * scale as f32)
            .stem_v(80.0);
        if truetype { desc.font_file2(file); } else { desc.font_file3(file); }
        desc.finish();
        let compressed = deflate(&subset);
        let mut stream = pdf.stream(file, &compressed);
        stream.filter(Filter::FlateDecode);
        match file_subtype {
            Some(subtype) => { stream.pair(Name(b"Subtype"), Name(subtype.as_bytes())); }
            None => { stream.pair(Name(b"Length1"), subset.len() as i32); }
        }
        stream.finish();
    }

    let mut writer = Writer { fonts, remaps: &remaps, warned_images: false };
    for (index, page) in pages.iter().enumerate() {
        let content_id = alloc();
        let mut content = Content::new();
        content.transform([1.0, 0.0, 0.0, -1.0, 0.0, page.height as f32]);
        writer.emit(&mut content, &page.items);
        // Slot text is clipped to its box, exactly as Typst clips the box in the baseline document.
        for fill in &page.fills {
            content.save_state();
            content.rect(fill.slot.x as f32, fill.slot.y as f32, fill.slot.width as f32, fill.slot.height as f32);
            content.clip_nonzero();
            content.end_path();
            writer.emit(&mut content, std::slice::from_ref(&fill.item));
            content.restore_state();
        }
        let bytes = content.finish();
        pdf.stream(content_id, &deflate(&bytes)).filter(Filter::FlateDecode);
        let mut page_obj = pdf.page(page_ids[index]);
        page_obj.parent(pages_id).media_box(Rect::new(0.0, 0.0, page.width as f32, page.height as f32)).contents(content_id);
        let mut resources = page_obj.resources();
        let mut font_dict = resources.fonts();
        for (i, font_ref) in font_refs.iter().enumerate() { font_dict.pair(Name(format!("F{i}").as_bytes()), *font_ref); }
        font_dict.finish();
        resources.finish();
        page_obj.finish();
    }
    Ok(pdf.finish())
}

// ---------------------------------------------------------------------------------------------------------
// CLI

struct Args { dir: PathBuf, data: PathBuf, out: PathBuf, expect: Option<PathBuf> }

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-runtime <doc-dir> --data data.json --out out.pdf [--expect reference.json]"))?);
    let mut parsed = Args { data: dir.join("data.json"), out: dir.join("runtime.pdf"), expect: None, dir };
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => parsed.data = value.into(),
            "--out" => parsed.out = value.into(),
            "--expect" => parsed.expect = Some(value.into()),
            other => bail!("unknown flag {other}"),
        }
    }
    Ok(parsed)
}

fn compare(trace: &[ReferenceSlot], reference: &[ReferenceSlot]) -> Vec<String> {
    let mut problems = Vec::new();
    let by_name: BTreeMap<&str, &ReferenceSlot> = reference.iter().map(|s| (s.name.as_str(), s)).collect();
    for slot in trace {
        let Some(expected) = by_name.get(slot.name.as_str()) else { problems.push(format!("{}: not in the reference", slot.name)); continue };
        if (slot.baseline - expected.baseline).abs() > 1e-3 { problems.push(format!("{}: baseline {:.3} vs Typst {:.3}", slot.name, slot.baseline, expected.baseline)); }
        if (slot.size - expected.size).abs() > 1e-3 { problems.push(format!("{}: size {:.3} vs Typst {:.3}", slot.name, slot.size, expected.size)); }
        let ours: Vec<u16> = slot.glyphs.iter().map(|g| g.id).collect();
        let theirs: Vec<u16> = expected.glyphs.iter().map(|g| g.id).collect();
        if ours != theirs { problems.push(format!("{}: glyphs {ours:?} vs Typst {theirs:?}", slot.name)); continue; }
        for (i, (a, b)) in slot.glyphs.iter().zip(&expected.glyphs).enumerate() {
            if (a.x - b.x).abs() > 1e-3 { problems.push(format!("{}: glyph {i} (id {}) at x {:.4} vs Typst {:.4}", slot.name, a.id, a.x, b.x)); break; }
        }
    }
    for expected in reference {
        if !trace.iter().any(|s| s.name == expected.name) { problems.push(format!("{}: in the reference but not drawn", expected.name)); }
    }
    problems
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let started = std::time::Instant::now();
    let doc: ir::Document = serde_json::from_slice(&fs::read(args.dir.join("doc.json")).context("reading doc.json")?)?;
    if doc.version != ir::VERSION { bail!("doc.json is IR version {}, this runtime reads {}", doc.version, ir::VERSION); }
    let data: serde_json::Value = serde_json::from_slice(&fs::read(&args.data).with_context(|| format!("reading {}", args.data.display()))?)?;
    let mut storage = Vec::new();
    let fonts = load_fonts(&doc, &args.dir, &mut storage)?;
    let loaded_in = started.elapsed();

    let composed_at = std::time::Instant::now();
    let pages = match &doc.flow {
        Some(flow) => compose_flow(flow, &data, &fonts)?,
        None => compose_fixed(&doc, &data, &fonts)?,
    };
    let composed_in = composed_at.elapsed();
    let pdf = write_pdf(&doc, &fonts, &pages)?;
    let total = started.elapsed();
    fs::write(&args.out, &pdf)?;
    let trace = FillTrace { slots: pages.iter().flat_map(|p| p.fills.iter().map(|f| f.trace.clone())).collect() };
    fs::write(args.out.with_extension("trace.json"), serde_json::to_string_pretty(&trace)?)?;
    println!("filled {} slot(s) on {} page(s) and wrote {} bytes to {} in {total:.1?} (fonts {loaded_in:.1?}, compose {composed_in:.1?})",
        trace.slots.len(), pages.len(), pdf.len(), args.out.display());

    if let Some(expect) = &args.expect {
        let reference: Vec<ReferenceSlot> = serde_json::from_slice(&fs::read(expect).with_context(|| format!("reading {}", expect.display()))?)?;
        let problems = compare(&trace.slots, &reference);
        if problems.is_empty() {
            println!("reference: every slot's glyphs and positions match Typst's own layout of this data");
        } else {
            for p in &problems { println!("reference mismatch: {p}"); }
            std::process::exit(1);
        }
    }
    Ok(())
}
