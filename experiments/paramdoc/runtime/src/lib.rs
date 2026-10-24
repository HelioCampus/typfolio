//! paramdoc-runtime: fills a parametric document with data and writes a PDF. No Typst, no shaper: static
//! items are drawn as exported, slot text is mapped to glyphs through the font's cmap and advanced by its
//! horizontal metrics (the dialect turns kerning and ligatures off inside slots, so this matches Typst for
//! simple scripts). A flow document is composed page by page: blocks are stacked, rows break to new pages,
//! header bands repeat, overlays are drawn on every page with the page counters filled.
//!
//! Library entry point: [`fill`]. The binary in `main.rs` is a thin CLI around it, and `paramdoc_fill` is a
//! C ABI for a wasm32 build without any binding generator.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;

use anyhow::{Context, Result, anyhow, bail};
use flate2::{Compression, write::ZlibEncoder};
use pdf_writer::types::{CidFontType, FontFlags, LineCapStyle, LineJoinStyle, StructRole, SystemInfo, TableHeaderScope};
use pdf_writer::writers::StructTreeRoot;
use pdf_writer::types::UnicodeCmap;
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use paramdoc_ir as ir;

// ---------------------------------------------------------------------------------------------------------
// Fonts

/// A font as exported: the subset program's bytes plus the metrics, advances and character map from the
/// document. Nothing is parsed from the font file.
struct LoadedFont<'a> {
    data: &'a [u8],
    name: String,
    program: String,
    units_per_em: f64,
    ascender: f64,
    descender: f64,
    cap_height: f64,
    bbox: [f64; 4],
    italic_angle: f64,
    italic: bool,
    advances: Vec<f64>,
    cmap: HashMap<char, u16>,
    /// Glyph id to the characters it stands for, for the ToUnicode map.
    reverse: HashMap<u16, String>,
}

impl LoadedFont<'_> {
    /// Advance of a glyph in em.
    fn advance(&self, glyph: u16) -> f64 { self.advances.get(glyph as usize).copied().unwrap_or(0.0) / self.units_per_em }
    /// Glyph for a character, or `None` when it is not in the exported repertoire.
    fn glyph(&self, c: char) -> Option<u16> { self.cmap.get(&c).copied() }
}

/// Takes the font files in the order the document lists them, checking their hashes.
fn load_fonts<'a>(doc: &ir::Document, data: &[&'a [u8]]) -> Result<Vec<LoadedFont<'a>>> {
    if data.len() != doc.fonts.len() { bail!("the document lists {} font(s) but {} were supplied", doc.fonts.len(), data.len()); }
    let mut fonts = Vec::new();
    for (font, bytes) in doc.fonts.iter().zip(data) {
        let sha = format!("{:x}", Sha256::digest(bytes));
        if sha != font.sha256 { bail!("{}: sha256 {sha} does not match the document's {}", font.file, font.sha256); }
        if font.advances.is_empty() || font.units_per_em <= 0.0 { bail!("{}: the document carries no font metrics; export it again", font.file); }
        let mut cmap = HashMap::new();
        let mut reverse: HashMap<u16, String> = HashMap::new();
        for (text, gid) in &font.cmap {
            if let Some(c) = text.chars().next() { cmap.insert(c, *gid); }
            reverse.entry(*gid).or_insert_with(|| text.clone());
        }
        fonts.push(LoadedFont {
            data: bytes, name: format!("PARAMD+{}", font.file.replace(|c: char| !c.is_ascii_alphanumeric(), "")), program: font.program.clone(),
            units_per_em: font.units_per_em, ascender: font.ascender, descender: font.descender, cap_height: font.cap_height,
            bbox: font.bbox, italic_angle: font.italic_angle, italic: font.italic, advances: font.advances.clone(), cmap, reverse,
        });
    }
    Ok(fonts)
}

// ---------------------------------------------------------------------------------------------------------
// Slot filling

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReferenceGlyph { pub id: u16, pub x: f64 }

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReferenceSlot { pub name: String, pub baseline: f64, pub size: f64, pub glyphs: Vec<ReferenceGlyph> }

fn text_of(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => bail!("cannot render {other} as text"),
    })
}

/// A filled slot: the text item to draw (clipped to the slot's box) and what was drawn, for the reference check.
struct Filled { slot: ir::Slot, item: ir::Item, trace: ReferenceSlot, node: Option<usize> }

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
            let id = font.glyph(c).ok_or_else(|| anyhow!("slot `{trace_name}`: {c:?} (U+{:04X}) is not in the slot's repertoire; declare it with `charset:` in the template", c as u32))?;
            let advance = font.advance(id) * size;
            glyphs.push(ir::Glyph { id, x_advance: advance, x_offset: 0.0, y_offset: 0.0, chars: None });
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
        item: ir::Item::Text { x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs, node: None },
        trace: ReferenceSlot { name: trace_name, baseline: slot.baseline, size, glyphs: trace_glyphs },
        node: None,
    })
}

// ---------------------------------------------------------------------------------------------------------
// Structure

/// A structure element of the output document. Node 0 is the Document root.
struct GNode { role: String, parent: Option<usize>, alt: Option<String>, scope: Option<String>, kids: Vec<Kid> }

enum Kid { Node(usize), Content { page: usize, mcid: i32 } }

struct Structure { nodes: Vec<GNode> }

impl Structure {
    fn new() -> Self {
        Self { nodes: vec![GNode { role: "Document".into(), parent: None, alt: None, scope: None, kids: Vec::new() }] }
    }

    fn add(&mut self, role: &str, parent: usize, alt: Option<String>, scope: Option<String>) -> usize {
        self.nodes.push(GNode { role: role.to_string(), parent: Some(parent), alt, scope, kids: Vec::new() });
        let id = self.nodes.len() - 1;
        self.nodes[parent].kids.push(Kid::Node(id));
        id
    }

    /// Instantiates a fragment's local nodes under `attach` and returns local → global. With `unwrap_tables`,
    /// Table/THead/TBody wrappers at the top of the fragment are skipped so that a band's rows join the
    /// region's one table.
    fn instantiate(&mut self, local: &[ir::Node], attach: usize, unwrap_tables: bool) -> Vec<Option<usize>> {
        let mut map: Vec<Option<usize>> = Vec::with_capacity(local.len());
        let mut effective: Vec<usize> = Vec::with_capacity(local.len());
        for node in local {
            let parent_global = match node.parent { None => attach, Some(p) => effective[p] };
            let at_top = node.parent.is_none_or(|p| map[p].is_none());
            if unwrap_tables && at_top && matches!(node.role.as_str(), "Table" | "THead" | "TBody") {
                map.push(None);
                effective.push(parent_global);
            } else {
                let id = self.add(&node.role, parent_global, node.alt.clone(), node.scope.clone());
                map.push(Some(id));
                effective.push(id);
            }
        }
        map
    }

    /// Nodes that contain content somewhere below them; the rest are not written.
    fn alive(&self) -> Vec<bool> {
        let mut alive = vec![false; self.nodes.len()];
        for i in (0..self.nodes.len()).rev() {
            alive[i] = self.nodes[i].kids.iter().any(|k| match k { Kid::Content { .. } => true, Kid::Node(n) => alive[*n] });
        }
        alive[0] = true;
        alive
    }
}

fn remap(items: &mut [ir::Item], map: &[Option<usize>]) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => remap(items, map),
            ir::Item::Text { node, .. } | ir::Item::Shape { node, .. } | ir::Item::Image { node, .. } => { *node = node.and_then(|n| map.get(n).copied().flatten()); }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Composition

/// One output page: static items in absolute coordinates (nodes already global) and the slots filled on it.
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

/// Where a placed fragment's structure goes.
#[derive(Clone, Copy)]
enum Attach { Document, Artifact, Table(usize) }

fn clip_ops(width: f64, height: f64) -> Vec<ir::PathOp> {
    vec![ir::PathOp::Move { to: [0.0, 0.0] }, ir::PathOp::Line { to: [width, 0.0] }, ir::PathOp::Line { to: [width, height] }, ir::PathOp::Line { to: [0.0, height] }, ir::PathOp::Close]
}

/// Draws a fragment with its top at `top`, fills its slots from `scope`, and instantiates its structure.
fn place(fragment: &ir::Fragment, top: f64, scope: &Scope, fonts: &[LoadedFont], prefix: &str, clip: bool, page: &mut Composed, structure: &mut Structure, attach: Attach) -> Result<()> {
    let map = match attach {
        Attach::Artifact => vec![None; fragment.nodes.len()],
        Attach::Document => structure.instantiate(&fragment.nodes, 0, false),
        Attach::Table(table) => structure.instantiate(&fragment.nodes, table, true),
    };
    let mut items = fragment.items.clone();
    remap(&mut items, &map);
    page.items.push(ir::Item::Group {
        x: fragment.x, y: top, transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        clip: clip.then(|| clip_ops(fragment.width, fragment.height)), items,
    });
    for slot in &fragment.slots {
        let mut absolute = slot.clone();
        absolute.x += fragment.x; absolute.pen_x += fragment.x;
        absolute.y += top; absolute.baseline += top;
        let text = scope.text(&slot.name)?;
        let mut filled = fill_slot(&absolute, &text, &fonts[slot.font], format!("{prefix}{}", slot.name))?;
        filled.node = slot.node.and_then(|n| map.get(n).copied().flatten());
        page.fills.push(filled);
    }
    Ok(())
}

fn compose_fixed(doc: &ir::Document, data: &serde_json::Value, fonts: &[LoadedFont], structure: &mut Structure) -> Result<Vec<Composed>> {
    let scope = Scope { data, counters: None };
    let mut pages = Vec::new();
    for (index, page) in doc.pages.iter().enumerate() {
        let map = structure.instantiate(&page.nodes, 0, false);
        let mut items = page.items.clone();
        remap(&mut items, &map);
        let mut composed = Composed { width: page.width, height: page.height, items, fills: Vec::new() };
        for slot in doc.slots.iter().filter(|s| s.page == index) {
            let mut filled = fill_slot(slot, &scope.text(&slot.name)?, &fonts[slot.font], slot.name.clone())?;
            filled.node = slot.node.and_then(|n| map.get(n).copied().flatten());
            composed.fills.push(filled);
        }
        pages.push(composed);
    }
    Ok(pages)
}

fn compose_flow(flow: &ir::Flow, data: &serde_json::Value, fonts: &[LoadedFont], structure: &mut Structure) -> Result<Vec<Composed>> {
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
                place(fragment, cursor, &scope, fonts, "", false, pages.last_mut().unwrap(), structure, Attach::Document)?;
                cursor += fragment.height;
            }
            ir::Block::Repeat { band: name, header, header_gap, gap, .. } => {
                let rows = data.get(name).and_then(|v| v.as_array()).ok_or_else(|| anyhow!("data has no array `{name}` for the repeat region"))?;
                let row_band = band(name)?;
                let header_band = header.as_deref().map(band).transpose()?;
                let header_height = header_band.map(|h| h.fragment.height + header_gap).unwrap_or(0.0);
                let first_row = if rows.is_empty() { 0.0 } else { row_band.fragment.height };
                if cursor + header_height + first_row > bottom + EPS && cursor > area.y + EPS { pages.push(new_page()); cursor = area.y; }
                // One table for the whole region; the first header is its header row, repeats are artifacts.
                let table = structure.add("Table", 0, None, None);
                if let Some(h) = header_band {
                    place(&h.fragment, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap(), structure, Attach::Table(table))?;
                    cursor += header_height;
                }
                for (i, row) in rows.iter().enumerate() {
                    if cursor + row_band.fragment.height > bottom + EPS {
                        pages.push(new_page());
                        cursor = area.y;
                        if let Some(h) = header_band {
                            place(&h.fragment, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap(), structure, Attach::Artifact)?;
                            cursor += header_height;
                        }
                    }
                    let row_scope = Scope { data: row, counters: None };
                    place(&row_band.fragment, cursor, &row_scope, fonts, &format!("{name}[{i}]."), true, pages.last_mut().unwrap(), structure, Attach::Table(table))?;
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
            place(overlay, overlay.y, &scope, fonts, &format!("page[{index}]."), true, page, structure, Attach::Artifact)?;
        }
    }
    Ok(pages)
}

// ---------------------------------------------------------------------------------------------------------
// PDF writing

struct Writer<'a> {
    fonts: &'a [LoadedFont<'a>],
    warned_images: bool,
    structure: &'a mut Structure,
    /// The page being written and, per marked-content id on it, the node it belongs to (the parent tree).
    page: usize,
    parents: Vec<usize>,
    /// The marked-content sequence currently open: `Some(None)` is an artifact.
    open: Option<Option<usize>>,
}

fn struct_role(role: &str) -> Option<StructRole> {
    Some(match role {
        "Document" => StructRole::Document, "Part" => StructRole::Part, "Sect" => StructRole::Sect, "Div" => StructRole::Div,
        "P" => StructRole::P, "H1" => StructRole::H1, "H2" => StructRole::H2, "H3" => StructRole::H3, "H4" => StructRole::H4,
        "H5" => StructRole::H5, "H6" => StructRole::H6, "L" => StructRole::L, "LI" => StructRole::LI, "Lbl" => StructRole::Lbl,
        "LBody" => StructRole::LBody, "Table" => StructRole::Table, "TR" => StructRole::TR, "TH" => StructRole::TH, "TD" => StructRole::TD,
        "THead" => StructRole::THead, "TBody" => StructRole::TBody, "Span" => StructRole::Span, "Link" => StructRole::Link,
        "Figure" => StructRole::Figure, "Caption" => StructRole::Caption, "NonStruct" => StructRole::NonStruct,
        _ => return None,
    })
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("in-memory write");
    encoder.finish().expect("in-memory finish")
}

fn collect_glyphs(items: &[ir::Item], used: &mut [BTreeSet<u16>], multi: &mut HashMap<(usize, u16), String>) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => collect_glyphs(items, used, multi),
            ir::Item::Text { font, glyphs, .. } => {
                for g in glyphs {
                    used[*font].insert(g.id);
                    if let Some(chars) = &g.chars { multi.entry((*font, g.id)).or_insert_with(|| chars.clone()); }
                }
            }
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
    /// Opens the marked-content sequence for `node` unless it is already open: a tagged sequence with a new
    /// MCID that the structure remembers, or an artifact.
    fn ensure(&mut self, content: &mut Content, node: Option<usize>) {
        if self.open == Some(node) { return; }
        self.close(content);
        match node {
            Some(g) => {
                let mcid = self.parents.len() as i32;
                self.parents.push(g);
                let role = self.structure.nodes[g].role.clone();
                content.begin_marked_content_with_properties(Name(role.as_bytes())).properties().identify(mcid);
                self.structure.nodes[g].kids.push(Kid::Content { page: self.page, mcid });
            }
            None => { content.begin_marked_content(Name(b"Artifact")); }
        }
        self.open = Some(node);
    }

    fn close(&mut self, content: &mut Content) {
        if self.open.take().is_some() { content.end_marked_content(); }
    }

    fn emit(&mut self, content: &mut Content, items: &[ir::Item]) {
        for item in items {
            match item {
                ir::Item::Group { x, y, transform, clip, items } => {
                    // Marked content must nest with q/Q: close around the group.
                    self.close(content);
                    content.save_state();
                    content.transform([1.0, 0.0, 0.0, 1.0, *x as f32, *y as f32]);
                    if *transform != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] { content.transform(transform.map(|v| v as f32)); }
                    if let Some(ops) = clip { path_ops(content, ops); content.clip_nonzero(); content.end_path(); }
                    self.emit(content, items);
                    self.close(content);
                    content.restore_state();
                }
                ir::Item::Text { x, y, font, size, fill, glyphs, node, .. } => { self.ensure(content, *node); self.text(content, *x, *y, *font, *size, fill, glyphs) }
                ir::Item::Shape { x, y, geometry, fill, stroke, node } => {
                    self.ensure(content, *node);
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
            items.show(Str(&glyph.id.to_be_bytes()));
            let natural = loaded.advance(glyph.id) * size;
            pending = glyph.x_advance - glyph.x_offset - natural;
        }
        items.finish();
        positioned.finish();
        content.end_text();
    }
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn xmp(title: Option<&str>) -> String {
    let title = title.map(xml_escape).unwrap_or_default();
    format!(concat!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n",
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
        "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\" ",
        "xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\">",
        "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>",
        "<pdf:Producer>paramdoc</pdf:Producer><pdfuaid:part>1</pdfuaid:part>",
        "</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"), title)
}

fn write_pdf(doc: &ir::Document, fonts: &[LoadedFont], pages: &[Composed], structure: &mut Structure) -> Result<Vec<u8>> {
    let mut pdf = Pdf::new();
    pdf.set_version(1, 7);
    let mut next = 1;
    let mut alloc = || { let r = Ref::new(next); next += 1; r };
    let catalog = alloc();
    let pages_id = alloc();
    let info = alloc();
    let metadata = alloc();
    let struct_root = alloc();
    let font_refs: Vec<Ref> = (0..fonts.len()).map(|_| alloc()).collect();
    let page_ids: Vec<Ref> = (0..pages.len()).map(|_| alloc()).collect();

    {
        let mut cat = pdf.catalog(catalog);
        cat.pages(pages_id).metadata(metadata);
        cat.pair(Name(b"StructTreeRoot"), struct_root);
        cat.mark_info().marked(true);
        cat.lang(TextStr(doc.lang.as_deref().unwrap_or("en")));
        cat.viewer_preferences().display_doc_title(true);
    }
    pdf.pages(pages_id).kids(page_ids.iter().copied()).count(pages.len() as i32);
    let mut info_dict = pdf.document_info(info);
    info_dict.title(TextStr(doc.title.as_deref().unwrap_or("Document"))).producer(TextStr("paramdoc"));
    info_dict.finish();
    let packet = xmp(doc.title.as_deref());
    let mut meta = pdf.stream(metadata, packet.as_bytes());
    meta.pair(Name(b"Type"), Name(b"Metadata"));
    meta.pair(Name(b"Subtype"), Name(b"XML"));
    meta.finish();

    // Glyphs actually used, per font, for the ToUnicode maps.
    let mut used: Vec<BTreeSet<u16>> = vec![BTreeSet::new(); fonts.len()];
    let mut multi: HashMap<(usize, u16), String> = HashMap::new();
    for page in pages {
        collect_glyphs(&page.items, &mut used, &mut multi);
        for fill in &page.fills { collect_glyphs(std::slice::from_ref(&fill.item), &mut used, &mut multi); }
    }

    for (i, font) in fonts.iter().enumerate() {
        let cid = alloc();
        let descriptor = alloc();
        let file = alloc();
        let to_unicode = alloc();
        let name = font.name.as_str();
        let truetype = font.program == "truetype";
        pdf.type0_font(font_refs[i]).base_font(Name(name.as_bytes())).encoding_predefined(Name(b"Identity-H")).descendant_font(cid).to_unicode(to_unicode);
        let mut cmap = UnicodeCmap::new(Name(b"Custom"), SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"UCS"), supplement: 0 });
        for gid in &used[i] {
            if let Some(chars) = multi.get(&(i, *gid)) { cmap.pair_with_multiple(*gid, chars.chars()); }
            else if let Some(chars) = font.reverse.get(gid) { cmap.pair_with_multiple(*gid, chars.chars()); }
        }
        let cmap_bytes = cmap.finish();
        pdf.stream(to_unicode, &deflate(&cmap_bytes)).filter(Filter::FlateDecode);
        let scale = 1000.0 / font.units_per_em;
        let mut cid_font = pdf.cid_font(cid);
        cid_font.subtype(if truetype { CidFontType::Type2 } else { CidFontType::Type0 })
            .base_font(Name(name.as_bytes()))
            .system_info(SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 })
            .font_descriptor(descriptor)
            .default_width(0.0);
        if truetype { cid_font.cid_to_gid_map_predefined(Name(b"Identity")); }
        cid_font.widths().consecutive(0, font.advances.iter().map(|a| (a * scale) as f32));
        cid_font.finish();
        let mut flags = FontFlags::SERIF | FontFlags::NON_SYMBOLIC;
        if font.italic { flags |= FontFlags::ITALIC; }
        let mut desc = pdf.font_descriptor(descriptor);
        desc.name(Name(name.as_bytes())).flags(flags)
            .bbox(Rect::new((font.bbox[0] * scale) as f32, (font.bbox[1] * scale) as f32, (font.bbox[2] * scale) as f32, (font.bbox[3] * scale) as f32))
            .italic_angle(font.italic_angle as f32)
            .ascent((font.ascender * scale) as f32)
            .descent((font.descender * scale) as f32)
            .cap_height((font.cap_height * scale) as f32)
            .stem_v(80.0);
        if truetype { desc.font_file2(file); } else { desc.font_file3(file); }
        desc.finish();
        let compressed = deflate(font.data);
        let mut stream = pdf.stream(file, &compressed);
        stream.filter(Filter::FlateDecode);
        match font.program.as_str() {
            "truetype" => { stream.pair(Name(b"Length1"), font.data.len() as i32); }
            "opentype-cff" => { stream.pair(Name(b"Subtype"), Name(b"OpenType")); }
            _ => { stream.pair(Name(b"Subtype"), Name(b"CIDFontType0C")); }
        }
        stream.finish();
    }

    let mut writer = Writer { fonts, warned_images: false, structure, page: 0, parents: Vec::new(), open: None };
    let mut page_parents: Vec<Vec<usize>> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        writer.page = index;
        writer.parents = Vec::new();
        let content_id = alloc();
        let mut content = Content::new();
        content.transform([1.0, 0.0, 0.0, -1.0, 0.0, page.height as f32]);
        writer.emit(&mut content, &page.items);
        writer.close(&mut content);
        // Slot text is clipped to its box, exactly as Typst clips the box in the baseline document.
        for fill in &page.fills {
            content.save_state();
            content.rect(fill.slot.x as f32, fill.slot.y as f32, fill.slot.width as f32, fill.slot.height as f32);
            content.clip_nonzero();
            content.end_path();
            let mut item = fill.item.clone();
            if let ir::Item::Text { node, .. } = &mut item { *node = fill.node; }
            writer.emit(&mut content, std::slice::from_ref(&item));
            writer.close(&mut content);
            content.restore_state();
        }
        page_parents.push(std::mem::take(&mut writer.parents));
        let bytes = content.finish();
        pdf.stream(content_id, &deflate(&bytes)).filter(Filter::FlateDecode);
        let mut page_obj = pdf.page(page_ids[index]);
        page_obj.parent(pages_id).media_box(Rect::new(0.0, 0.0, page.width as f32, page.height as f32)).contents(content_id).struct_parents(index as i32);
        let mut resources = page_obj.resources();
        let mut font_dict = resources.fonts();
        for (i, font_ref) in font_refs.iter().enumerate() { font_dict.pair(Name(format!("F{i}").as_bytes()), *font_ref); }
        font_dict.finish();
        resources.finish();
        page_obj.finish();
    }

    // The structure tree: only nodes with content below them are written.
    let structure = &*writer.structure;
    let alive = structure.alive();
    let node_refs: Vec<Option<Ref>> = alive.iter().map(|&a| if a { Some(alloc()) } else { None }).collect();
    let parent_arrays: Vec<Ref> = (0..pages.len()).map(|_| alloc()).collect();
    {
        let mut root = pdf.indirect(struct_root).start::<StructTreeRoot>();
        root.children().item(node_refs[0].expect("document root"));
        let mut tree = root.parent_tree();
        let mut nums = tree.nums();
        for (index, array) in parent_arrays.iter().enumerate() { nums.insert(index as i32, *array); }
        nums.finish();
        tree.finish();
        root.pair(Name(b"ParentTreeNextKey"), pages.len() as i32);
        root.finish();
    }
    for (index, parents) in page_parents.iter().enumerate() {
        pdf.indirect(parent_arrays[index]).array().items(parents.iter().map(|&g| node_refs[g].expect("content nodes are alive")));
    }
    for (id, node) in structure.nodes.iter().enumerate() {
        let Some(reference) = node_refs[id] else { continue };
        let mut element = pdf.struct_element(reference);
        match struct_role(&node.role) { Some(role) => { element.kind(role); } None => { element.custom_kind(Name(node.role.as_bytes())); } }
        element.parent(match node.parent { Some(p) => node_refs[p].expect("parent alive"), None => struct_root });
        if let Some(alt) = &node.alt { element.alt(TextStr(alt)); }
        if node.role == "TH" {
            let scope = match node.scope.as_deref() { Some("row") => TableHeaderScope::Row, Some("both") => TableHeaderScope::Both, _ => TableHeaderScope::Column };
            element.attributes().push().table().scope(scope);
        }
        let mut children = element.children();
        for kid in &node.kids {
            match kid {
                Kid::Node(n) => { if let Some(r) = node_refs[*n] { children.struct_element(r); } }
                Kid::Content { page, mcid } => { children.marked_content_ref().page(page_ids[*page]).marked_content_id(*mcid); }
            }
        }
        children.finish();
        element.finish();
    }
    Ok(pdf.finish())
}

// ---------------------------------------------------------------------------------------------------------
// Entry points

/// A filled document: the PDF, what was drawn into every slot (for the reference check), the page count.
pub struct Output { pub pdf: Vec<u8>, pub trace: Vec<ReferenceSlot>, pub pages: usize }

/// A parsed document with its fonts, ready to be filled many times.
pub struct Runtime<'a> { doc: ir::Document, fonts: Vec<LoadedFont<'a>> }

impl<'a> Runtime<'a> {
    /// `fonts` are the font files in the document's order.
    pub fn new(doc_json: &[u8], fonts: &[&'a [u8]]) -> Result<Self> {
        let doc: ir::Document = serde_json::from_slice(doc_json).context("parsing the document")?;
        if doc.version != ir::VERSION { bail!("the document is IR version {}, this runtime reads {}", doc.version, ir::VERSION); }
        let fonts = load_fonts(&doc, fonts)?;
        Ok(Self { doc, fonts })
    }

    pub fn document(&self) -> &ir::Document { &self.doc }

    pub fn fill(&self, data_json: &[u8]) -> Result<Output> {
        let data: serde_json::Value = serde_json::from_slice(data_json).context("parsing the data")?;
        let mut structure = Structure::new();
        let pages = match &self.doc.flow {
            Some(flow) => compose_flow(flow, &data, &self.fonts, &mut structure)?,
            None => compose_fixed(&self.doc, &data, &self.fonts, &mut structure)?,
        };
        let pdf = write_pdf(&self.doc, &self.fonts, &pages, &mut structure)?;
        let trace = pages.iter().flat_map(|p| p.fills.iter().map(|f| f.trace.clone())).collect();
        Ok(Output { pdf, trace, pages: pages.len() })
    }
}

/// Fills `doc_json` (an exported document) with `data_json`; `fonts` are the font files in the document's order.
pub fn fill(doc_json: &[u8], fonts: &[&[u8]], data_json: &[u8]) -> Result<Output> {
    Runtime::new(doc_json, fonts)?.fill(data_json)
}

/// Differences between what the runtime drew and Typst's own layout of the same data.
pub fn compare(trace: &[ReferenceSlot], reference: &[ReferenceSlot]) -> Vec<String> {
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


/// C ABI for hosts without a binding generator (the wasm32 size measurement, later a JavaScript shim).
/// `paramdoc_open` parses a document and its fonts once; `paramdoc_render` fills it; `paramdoc_close` frees it.
/// `fonts` points at `font_count` pairs of `(pointer, length)` as `u32`. On success `*status` is 0 and the
/// returned buffer is the PDF; otherwise `*status` is 1 and the buffer is a UTF-8 message. Free it with
/// `paramdoc_free`.
pub mod ffi {
    /// A runtime that owns its font bytes. The faces borrow the vectors' heap buffers, which never move or
    /// change while the runtime lives; `runtime` is declared first so it is dropped before the buffers.
    pub struct Opened { runtime: super::Runtime<'static>, _fonts: Vec<Vec<u8>> }

    fn into_buffer(mut bytes: Vec<u8>, out_len: *mut usize) -> *mut u8 {
        bytes.shrink_to_fit();
        unsafe { *out_len = bytes.len(); }
        let pointer = bytes.as_mut_ptr();
        std::mem::forget(bytes);
        pointer
    }

    unsafe fn font_slices<'a>(fonts: *const u32, font_count: usize) -> Vec<&'a [u8]> {
        (0..font_count).map(|i| unsafe {
            let pointer = *fonts.add(2 * i) as usize as *const u8;
            let len = *fonts.add(2 * i + 1) as usize;
            std::slice::from_raw_parts(pointer, len)
        }).collect()
    }

    /// # Safety
    /// Every pointer must be valid for its length for the duration of the call. Returns null on error and
    /// writes the message into `*err` (length in `*err_len`), to be freed with `paramdoc_free`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn paramdoc_open(doc: *const u8, doc_len: usize, fonts: *const u32, font_count: usize, err: *mut *mut u8, err_len: *mut usize) -> *mut Opened {
        let doc = unsafe { std::slice::from_raw_parts(doc, doc_len) };
        let owned: Vec<Vec<u8>> = unsafe { font_slices(fonts, font_count) }.into_iter().map(|f| f.to_vec()).collect();
        let slices: Vec<&'static [u8]> = owned.iter().map(|f| unsafe { std::slice::from_raw_parts(f.as_ptr(), f.len()) }).collect();
        match super::Runtime::new(doc, &slices) {
            Ok(runtime) => Box::into_raw(Box::new(Opened { runtime, _fonts: owned })),
            Err(error) => { unsafe { *err = into_buffer(format!("{error:#}").into_bytes(), err_len); } std::ptr::null_mut() }
        }
    }

    /// # Safety
    /// `opened` must come from `paramdoc_open` and not have been closed; `data` must be valid for `data_len`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn paramdoc_render(opened: *const Opened, data: *const u8, data_len: usize, out_len: *mut usize, status: *mut u32) -> *mut u8 {
        let opened = unsafe { &*opened };
        let data = unsafe { std::slice::from_raw_parts(data, data_len) };
        let (bytes, code) = match opened.runtime.fill(data) {
            Ok(output) => (output.pdf, 0),
            Err(error) => (format!("{error:#}").into_bytes(), 1),
        };
        unsafe { *status = code; }
        into_buffer(bytes, out_len)
    }

    /// # Safety
    /// `opened` must come from `paramdoc_open` and is freed; do not use it afterwards.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn paramdoc_close(opened: *mut Opened) {
        if !opened.is_null() { unsafe { drop(Box::from_raw(opened)); } }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn paramdoc_alloc(len: usize) -> *mut u8 {
        let mut buffer = Vec::<u8>::with_capacity(len.max(1));
        let pointer = buffer.as_mut_ptr();
        std::mem::forget(buffer);
        pointer
    }

    /// # Safety
    /// `pointer` must come from `paramdoc_alloc` or `paramdoc_fill` with this `len`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn paramdoc_free(pointer: *mut u8, len: usize) {
        unsafe { drop(Vec::from_raw_parts(pointer, 0, len.max(1))); }
    }

    /// # Safety
    /// Every pointer must be valid for its length for the duration of the call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn paramdoc_fill(
        doc: *const u8, doc_len: usize, data: *const u8, data_len: usize,
        fonts: *const u32, font_count: usize, out_len: *mut usize, status: *mut u32,
    ) -> *mut u8 {
        let doc = unsafe { std::slice::from_raw_parts(doc, doc_len) };
        let data = unsafe { std::slice::from_raw_parts(data, data_len) };
        let fonts = unsafe { font_slices(fonts, font_count) };
        let (bytes, code) = match super::fill(doc, &fonts, data) {
            Ok(output) => (output.pdf, 0),
            Err(error) => (format!("{error:#}").into_bytes(), 1),
        };
        unsafe { *status = code; }
        into_buffer(bytes, out_len)
    }
}
