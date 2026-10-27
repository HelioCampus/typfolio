//! paramdoc-runtime: fills a parametric document with data and writes a PDF. No Typst, no shaper: static
//! items are drawn as exported, slot text is mapped to glyphs through the font's cmap and advanced by its
//! horizontal metrics (the dialect turns kerning and ligatures off inside slots, so this matches Typst for
//! simple scripts). A flow document is composed page by page: blocks are stacked, rows break to new pages,
//! header bands repeat, overlays are drawn on every page with the page counters filled.
//!
//! Library entry point: [`fill`]. The binary in `main.rs` is a thin CLI around it, and `paramdoc_fill` is a
//! C ABI for a wasm32 build without any binding generator.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::rc::Rc;

use anyhow::{Context, Result, anyhow, bail};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use pdf_writer::types::{ActionType, AnnotationFlags, AnnotationType, CidFontType, FontFlags, LineCapStyle, LineJoinStyle, StructRole, SystemInfo, TabOrder, TableHeaderScope};
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
pub struct ReferenceGlyph { pub id: u16, pub x: f64, #[serde(default)] pub y: f64 }

/// For a text slot, its glyphs; for a bar (`<name>#bar`), the absolute path drawn (`ops`) and its box (`rect`);
/// for an image slot (`<name>#image`), the rectangle the image was placed in (`rect`).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReferenceSlot {
    pub name: String, pub baseline: f64, pub size: f64, pub glyphs: Vec<ReferenceGlyph>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub ops: Option<Vec<ir::PathOp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub rect: Option<[f64; 4]>,
    /// A link slot's clickable rectangles, one per drawn line (`<slot>#link`).
    #[serde(default, skip_serializing_if = "Option::is_none")] pub rects: Option<Vec<[f64; 4]>>,
}

/// The glyph of a character in the slot's repertoire, or the refusal naming it.
/// A soft hyphen: no glyph of its own (Typst removes default ignorables when shaping), a break opportunity after
/// it, and the font's hyphen drawn where a line ends on one (typst-layout 0.15.1 `line.rs`: `full.ends_with(SHY)`,
/// `ShapedText::hyphen`). The exporter maps it to the hyphen glyph in the character map when a repertoire admits it.
const SHY: char = '\u{ad}';
/// The middle dot is CJK centre-aligned punctuation to Typst (`shaping.rs`, `is_cjk_center_aligned_punctuation`):
/// on an overfull line it shrinks by a quarter of its advance on each side, and it counts as justifiable.
fn is_middle_dot(c: char) -> bool { c == '\u{b7}' }

fn glyph_or_refuse(font: &LoadedFont, c: char, trace_name: &str) -> Result<u16> {
    font.glyph(c).ok_or_else(|| anyhow!("slot `{trace_name}`: {c:?} (U+{:04X}) is not in the slot's repertoire; declare it with `charset:` in the template", c as u32))
}

fn text_of(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::String(s) => s.clone(),
        // Typst's `str()` and this formatting agree on integers, not on every float (`1e21`, `1e-7`).
        serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        serde_json::Value::Number(n) => bail!("{n} is not an integer; format numbers with a fraction as strings in the application"),
        serde_json::Value::Bool(b) => b.to_string(),
        // A link slot's value: `{ text, href }`.
        serde_json::Value::Object(map) if map.contains_key("text") => text_of(&map["text"])?,
        other => bail!("cannot render {other} as text"),
    })
}

/// A filled hole: the items to draw, clipped to `rect` (the hole's box), and what was drawn, for the reference
/// check. An image slot carries the image's bytes under the key its item refers to, and its alternative text.
struct Filled { rect: [f64; 4], items: Vec<ir::Item>, trace: ReferenceSlot, node: Option<usize>, image: Option<(String, Vec<u8>)>, alt: Option<String>, link: Option<LinkFill> }

/// A link slot's clickable area: one rectangle per drawn line, the destination and its description.
struct LinkFill { rects: Vec<[f64; 4]>, url: String, alt: Option<String> }

/// A destination the data gives a slot: the `href` of a `{ text, href, alt? }` value.
type Href = Option<(String, Option<String>)>;

/// The clickable rectangles of a link slot: each drawn line's box (x, baseline, width) extended above and below
/// the baseline as Typst extends a link's text frame. A link slot needs an `href`, a plain slot refuses one, so
/// the runtime never renders a value Typst would have styled differently (`show link` rules).
/// `scale` is the text's size relative to the slot's (the `shrink` policy), which the rectangle's height follows.
fn link_fill(slot: &ir::Slot, href: Href, lines: &[(f64, f64, f64)], scale: f64, trace_name: &str) -> Result<Option<LinkFill>> {
    match (href, slot.link) {
        (None, None) => Ok(None),
        (None, Some(_)) => bail!("slot `{trace_name}` is a link slot (its sample value had an `href`) but the data gives none"),
        (Some(_), None) => bail!("slot `{trace_name}`: the data gives an `href` but the slot was exported without a link; give its sample value an `href` too"),
        (Some((url, alt)), Some(g)) => Ok(Some(LinkFill { rects: lines.iter().map(|&(x, y, w)| [x, y - g.above * scale, w, (g.above + g.below) * scale]).collect(), url, alt })),
    }
}

/// Lays out one line of slot text: glyphs from the cmap, advances from hmtx, alignment from the slot,
/// and the slot's overflow policy when the line is wider than the box. `slot` is in absolute coordinates.
fn fill_slot(slot: &ir::Slot, text: &str, href: Href, font: &LoadedFont, trace_name: String) -> Result<Filled> {
    if let Some(max) = slot.max_length && text.chars().count() > max as usize {
        bail!("slot `{trace_name}`: {text:?} has {} characters, max-length is {max}", text.chars().count());
    }
    // A link's text must not end on a soft hyphen: Typst appends the hyphen outside the link's tag range and
    // typst-pdf 0.15.1 cannot write that PDF (G52), so there is no compiler fallback for such data.
    if href.is_some() && text.ends_with(SHY) { bail!("slot `{trace_name}`: a link's text must not end on a soft hyphen (U+00AD); Typst cannot export it (the hyphen falls outside the link), strip it"); }
    if slot.lines > 1 { return fill_lines(slot, text, href, font, trace_name); }
    let shape = |text: &str, size: f64| -> Result<(Vec<ir::Glyph>, f64)> {
        let mut glyphs = Vec::new();
        let mut width = 0.0;
        let mut push = |id: u16| { let advance = font.advance(id) * size; glyphs.push(ir::Glyph { id, x_advance: advance, x_offset: 0.0, y_offset: 0.0, chars: None }); width += advance; };
        // A soft hyphen draws nothing; a text ending on one ends with the font's hyphen, as Typst's line does.
        for c in text.chars().filter(|&c| c != SHY) { push(glyph_or_refuse(font, c, &trace_name)?); }
        if text.ends_with(SHY) { push(glyph_or_refuse(font, SHY, &trace_name)?); }
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
    let trace_glyphs = glyphs.iter().map(|g| { let at = pen; pen += g.x_advance; ReferenceGlyph { id: g.id, x: at, y: slot.baseline } }).collect();
    // A link slot: Typst's hyphen is a text run of its own, with its own link rectangle.
    let mut runs = vec![(x, slot.baseline, width)];
    if shown.ends_with(SHY) && let Some(h) = glyphs.last() { runs[0].2 -= h.x_advance; runs.push((x + runs[0].2, slot.baseline, h.x_advance)); }
    let link = link_fill(slot, href, &runs, size / slot.size, &trace_name)?;
    Ok(Filled {
        rect: [slot.x, slot.y, slot.width, slot.height], image: None, alt: None, link,
        items: vec![ir::Item::Text { x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs, node: None }],
        trace: ReferenceSlot { name: trace_name, baseline: slot.baseline, size, glyphs: trace_glyphs, ops: None, rect: None, rects: None },
        node: None,
    })
}

// ---------------------------------------------------------------------------------------------------------
// Wrapping slots: Typst's simple line breaker (typst-layout 0.15, inline/linebreak.rs) over UAX #14 break
// opportunities, for the character classes a Latin repertoire contains, plus Typst's own opportunities inside
// web addresses. The dialect switches hyphenation and justification off inside wrapping slots, so greedy first
// fit over advance widths reproduces Typst's lines.
// ts/runtime.ts has the same code and the notes on which rules icu4x applies; keep the two in step.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lb { Al, Nu, Sp, Ba, Bb, B2, Hy, Cl, Cp, Op, Qu, Ex, Is, Sy, Pr, Po, In, Gl, Zw, Wj, Bk, Cm, Ns }

fn lb_class(c: char) -> Lb {
    use Lb::*;
    match c {
        '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{85}' | '\u{2028}' | '\u{2029}' => Bk,
        ' ' => Sp,
        '\t' | '|' | '\u{ad}' | '\u{2000}'..='\u{2006}' | '\u{2008}'..='\u{200a}' | '\u{2010}' | '\u{2012}' | '\u{2013}' => Ba,
        '!' | '?' => Ex,
        '\u{37e}' => Is,
        '\u{2024}' | '\u{2025}' => In,
        '\u{2027}' => Ba,
        '\u{2030}' | '\u{2031}' | '\u{20a7}' | '\u{20b6}' | '\u{20bb}' | '\u{20be}' => Po,
        '\u{20a0}'..='\u{20c0}' => Pr,
        '"' | '\'' | '«' | '»' | '\u{2018}' | '\u{2019}' | '\u{201b}' | '\u{201c}' | '\u{201d}' | '\u{201f}' | '\u{2039}' | '\u{203a}' => Qu,
        '$' | '+' | '\\' | '£' | '¤' | '¥' | '±' | '\u{2212}' => Pr,
        '%' | '¢' | '°' | '\u{2032}' | '\u{2033}' => Po,
        '(' | '[' | '{' | '¡' | '¿' | '\u{201a}' | '\u{201e}' => Op,
        ')' | ']' => Cp,
        '}' => Cl,
        ',' | '.' | ':' | ';' | '\u{2044}' => Is,
        '-' => Hy,
        '/' => Sy,
        '\u{a0}' | '\u{2007}' | '\u{2011}' | '\u{202f}' => Gl,
        '\u{200b}' => Zw,
        '\u{2060}' => Wj,
        '\u{2014}' => B2,
        '´' => Bb,
        '\u{2026}' => In,
        '0'..='9' => Nu,
        '\u{300}'..='\u{36f}' | '\u{1ab0}'..='\u{1aff}' | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}' => Cm,
        _ => Al,
    }
}

fn is_initial_quote(c: char) -> bool { matches!(c, '«' | '\u{2018}' | '\u{201c}' | '\u{2039}' | '\u{201b}' | '\u{201f}') }
fn is_final_quote(c: char) -> bool { matches!(c, '»' | '\u{2019}' | '\u{201d}' | '\u{203a}') }
fn is_mandatory_break(c: char) -> bool { lb_class(c) == Lb::Bk }
fn is_space_glyph(c: char) -> bool { matches!(c, ' ' | '\u{a0}' | '\u{3000}') }
/// Unicode Default_Ignorable_Code_Point, which Typst trims at a line end as it trims spaces.
fn is_default_ignorable(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{34f}' | '\u{61c}' | '\u{115f}' | '\u{1160}' | '\u{17b4}' | '\u{17b5}' | '\u{180b}'..='\u{180f}' | '\u{200b}'..='\u{200f}'
        | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{3164}' | '\u{fe00}'..='\u{fe0f}' | '\u{feff}' | '\u{ffa0}' | '\u{fff0}'..='\u{fff8}'
        | '\u{1bca0}'..='\u{1bca3}' | '\u{1d173}'..='\u{1d17a}' | '\u{e0000}'..='\u{e0fff}')
}

/// UAX #14 break opportunities as Typst 0.15 gets them from icu4x's default line segmenter: the Unicode 15.1
/// rules with LB15a and LB15b, but without LB15c and LB20a and with the pair-table form of LB25 (each checked
/// against Typst on random data), East Asian and Hebrew cases left out. Each entry is where the next line would
/// start and whether the break is mandatory (after a hard break and at the end).
fn breakpoints(chars: &[char]) -> Vec<(usize, bool)> {
    use Lb::*;
    let n = chars.len();
    if n == 0 { return vec![(0, true)]; }
    let raw: Vec<Lb> = chars.iter().map(|&c| lb_class(c)).collect();
    // LB9, LB10: a combining mark takes its base's class and never separates from it; after a space, a break
    // or at the start it is a letter.
    let mut eff: Vec<Lb> = Vec::with_capacity(n);
    let mut attached = vec![false; n];
    for i in 0..n {
        if raw[i] == Cm && i > 0 && !matches!(eff[i - 1], Bk | Sp | Zw) { eff.push(eff[i - 1]); attached[i] = true; }
        else { eff.push(if raw[i] == Cm { Al } else { raw[i] }); }
    }
    let is = |k: isize, classes: &[Lb]| k >= 0 && (k as usize) < n && classes.contains(&eff[k as usize]);
    let allow = |i: usize| -> bool {
        let (b, a) = (eff[i - 1], eff[i]);
        let at = i as isize;
        if attached[i] { return false; }                                                             // LB9
        if b == Bk { return !(chars[i - 1] == '\r' && chars[i] == '\n'); }                            // LB4, LB5
        if matches!(a, Bk | Sp | Zw) { return false; }                                               // LB6, LB7
        let mut p = at - 1;
        while p >= 0 && eff[p as usize] == Sp { p -= 1; }                                            // the last non-space before i
        if is(p, &[Zw]) { return true; }                                                             // LB8
        if a == Wj || b == Wj || b == Gl { return false; }                                           // LB11, LB12
        if a == Gl && !matches!(b, Sp | Ba | Hy) { return false; }                                   // LB12a
        if matches!(a, Cl | Cp | Ex | Is | Sy) { return false; }                                     // LB13
        if is(p, &[Op]) { return false; }                                                            // LB14
        if is(p, &[Qu]) && is_initial_quote(chars[p as usize]) && (p == 0 || is(p - 1, &[Bk, Op, Qu, Gl, Sp, Zw])) { return false; } // LB15a
        if a == Qu && is_final_quote(chars[i]) && (i + 1 == n || is(at + 1, &[Sp, Gl, Wj, Cl, Qu, Cp, Ex, Is, Sy, Bk])) { return false; } // LB15b
        if is(p, &[Cl, Cp]) && a == Ns { return false; }                                             // LB16
        if is(p, &[B2]) && a == B2 { return false; }                                                 // LB17
        if b == Sp { return true; }                                                                  // LB18
        if a == Qu || b == Qu { return false; }                                                      // LB19, LB19a without East Asian text
        if matches!(a, Ba | Hy | Ns) || b == Bb { return false; }                                    // LB21
        if a == In { return false; }                                                                 // LB22
        if (b == Al && a == Nu) || (b == Nu && a == Al) { return false; }                            // LB23
        if (matches!(b, Pr | Po) && a == Al) || (b == Al && matches!(a, Pr | Po)) { return false; }  // LB24
        if matches!(b, Cl | Cp | Nu) && matches!(a, Po | Pr) { return false; }                       // LB25, pair-table form
        if matches!(b, Po | Pr) && matches!(a, Op | Nu) { return false; }
        if matches!(b, Hy | Is | Nu | Sy) && a == Nu { return false; }
        if b == Al && a == Al { return false; }                                                      // LB28
        if b == Is && a == Al { return false; }                                                      // LB29
        if matches!(b, Al | Nu) && a == Op { return false; }                                         // LB30
        if b == Cp && matches!(a, Al | Nu) { return false; }
        true                                                                                         // LB31
    };
    // Typst walks the segmenter's opportunities with `last`, the previous one, and at each step first looks for a
    // web address at `last` (UAX #14 breaks one badly): after `://` or before `www.`, the address's own
    // opportunities (`linebreak_link`) replace the segmenter's inside it. The trigger is positional: a `://`
    // with no opportunity right after it starts no address.
    let mut out: Vec<(usize, bool)> = Vec::new();
    let (mut last, mut next) = (0usize, 1usize);
    loop {
        if (last >= 3 && chars[last - 3..last] == [':', '/', '/']) || chars[last..].starts_with(&['w', 'w', 'w', '.']) {
            let len = link_prefix(&chars[last..]);
            linebreak_link(&chars[last..last + len], &mut |k| out.push((last + k, false)));
            last += len;
            next = next.max(last);
        }
        while next < n && !allow(next) { next += 1; } // the next UAX #14 opportunity; the end of the text is one
        if next > n { break; }
        let point = next;
        next += 1;
        out.push((point, point == n || raw[point - 1] == Bk));
        last = point;
    }
    out
}

/// How much of `tail` is a web address, as typst-syntax's `link_prefix` eats it: ASCII letters, digits and URL
/// punctuation, brackets while they balance, minus trailing punctuation that is more likely prose.
fn link_prefix(tail: &[char]) -> usize {
    let mut brackets: Vec<char> = Vec::new();
    let mut len = 0;
    for &c in tail {
        let eat = match c {
            '0'..='9' | 'a'..='z' | 'A'..='Z' | '!' | '#' | '$' | '%' | '&' | '*' | '+' | ',' | '-' | '.' | '/' | ':' | ';' | '=' | '?' | '@' | '_' | '~' | '\'' => true,
            '[' | '(' => { brackets.push(c); true }
            ']' => brackets.pop() == Some('['),
            ')' => brackets.pop() == Some('('),
            _ => false,
        };
        if !eat { break; }
        len += 1;
    }
    while len > 0 && matches!(tail[len - 1], '!' | ',' | '.' | ':' | ';' | '?' | '\'') { len -= 1; }
    len
}

/// Typst's break opportunities inside a web address (`linebreak_link`): where the character class changes
/// between letters, digits and the rest, or between two punctuation marks, never right after `(` or `[`; a run
/// of 16 or more characters since the last opportunity (a hash) may break after every character. The address
/// is ASCII (`link_prefix` eats nothing else), so Typst's byte offsets are character offsets.
fn linebreak_link(link: &[char], f: &mut dyn FnMut(usize)) {
    #[derive(PartialEq, Clone, Copy)]
    enum Class { Alphabetic, Digit, Open, Other }
    let class_of = |c: char| if c.is_alphabetic() { Class::Alphabetic } else if c.is_numeric() { Class::Digit } else if matches!(c, '(' | '[') { Class::Open } else { Class::Other };
    let (mut offset, mut prev) = (0usize, Class::Other);
    for (end, &c) in link.iter().enumerate() {
        let class = class_of(c);
        if end > 0 && prev != Class::Open && if class == Class::Other { prev == Class::Other } else { class != prev } {
            let piece = end - offset;
            if piece < 16 { offset = end; f(offset); } else { for _ in 0..piece { offset += 1; f(offset); } }
        }
        prev = class;
    }
}

/// A glyph of a shaped text as Typst's `calculate_adjustability` (typst-layout 0.15.1 `shaping.rs`) leaves it:
/// `advance` and `offset` after the adjustment of consecutive punctuation, `shrink` what `commit` may still take
/// from each side, `c` the glyph's character to Typst (the soft hyphen for the glyph after soft hyphens that open
/// the text), `at` the index of its character in the slot's text (`base` plus its index in the text shaped).
#[derive(Clone, Copy)]
struct Shaped { id: u16, advance: f64, offset: f64, shrink: (f64, f64), c: char, at: usize }

/// Shapes a text as Typst shapes a paragraph's (or a reshaped line's) text: one glyph per character but soft
/// hyphens and hard breaks, the character map's glyph at the font's advance; the glyph after soft hyphens that
/// open the text takes their cluster (rustybuzz merges a leading default ignorable forward), so to Typst its
/// character is the soft hyphen and it has no adjustability. Then `base_adjustability` with the default
/// `par.justification-limits`: a space may shrink by a third of its advance (min(a / 3, 0.75 a)) on its right, a
/// middle dot (CJK centre-aligned punctuation to Typst) by a quarter on each side; nothing else adjusts. Then
/// consecutive CJK punctuation is pulled together (Chinese Layout Requirements 3.1.6.1): where two dots meet and
/// their facing shrinkabilities reach half the first one's advance, the first gives up to a quarter on its right
/// and the second the rest on its left (its glyph moving left), in text order, each pair seeing the state the
/// previous one left.
fn shape_text(cs: &[char], base: usize, font: &LoadedFont, size: f64, trace_name: &str) -> Result<Vec<Shaped>> {
    let leading = cs.iter().take_while(|&&c| c == SHY).count();
    let mut out: Vec<Shaped> = Vec::with_capacity(cs.len());
    for (i, &c) in cs.iter().enumerate() {
        if c == SHY || is_mandatory_break(c) { continue; }
        let id = glyph_or_refuse(font, c, trace_name)?;
        let a = font.advance(id) * size;
        let c = if i == leading && leading > 0 { SHY } else { c };
        let shrink = if is_space_glyph(c) { (0.0, (a / 3.0).min(a * 0.75)) } else if is_middle_dot(c) { (a / 4.0, a / 4.0) } else { (0.0, 0.0) };
        out.push(Shaped { id, advance: a, offset: 0.0, shrink, c, at: base + i });
    }
    for k in 0..out.len().saturating_sub(1) {
        if !(is_middle_dot(out[k].c) && is_middle_dot(out[k + 1].c)) { continue; }
        let delta = out[k].advance / 2.0;
        if out[k].shrink.1 + out[k + 1].shrink.0 >= delta {
            let left_delta = out[k].shrink.1.min(delta);
            out[k].advance -= left_delta;
            out[k].shrink.1 -= left_delta;
            let amount = delta - left_delta;
            out[k + 1].offset -= amount;
            out[k + 1].advance -= amount;
            out[k + 1].shrink.0 -= amount;
        }
    }
    Ok(out)
}

/// The shaping of a slot's whole text, which Typst does once; a line is a slice of it, except that a line
/// starting on a soft hyphen inside the text is shaped again by Typst (no glyph starts at the hyphen, so the
/// slice is not safe to break) and so gets its own adjustments.
/// `before[i]` is the number of glyphs before character `i`, so the glyphs of `from..to` are a slice of `whole`;
/// `prefix` sums their advances, so a line's natural width is one subtraction (the breaker measures many).
struct Shaping<'a> { chars: &'a [char], whole: Vec<Shaped>, before: Vec<usize>, prefix: Vec<f64>, font: &'a LoadedFont<'a>, size: f64, trace_name: &'a str }

impl<'a> Shaping<'a> {
    fn new(chars: &'a [char], font: &'a LoadedFont<'a>, size: f64, trace_name: &'a str) -> Result<Self> {
        let whole = shape_text(chars, 0, font, size, trace_name)?;
        let mut before = Vec::with_capacity(chars.len() + 1);
        let mut k = 0;
        for i in 0..=chars.len() { before.push(k); if k < whole.len() && whole[k].at == i { k += 1; } }
        let mut prefix = Vec::with_capacity(whole.len() + 1);
        let mut sum = 0.0;
        prefix.push(0.0);
        for g in &whole { sum += g.advance; prefix.push(sum); }
        Ok(Self { chars, whole, before, prefix, font, size, trace_name })
    }
    fn reshaped(&self, from: usize) -> bool { from > 0 && from < self.chars.len() && self.chars[from] == SHY }
    /// The glyphs of the line `from..to`.
    fn line(&self, from: usize, to: usize) -> Result<Vec<Shaped>> {
        if self.reshaped(from) { return shape_text(&self.chars[from..to], from, self.font, self.size, self.trace_name); }
        Ok(self.whole[self.before[from]..self.before[to]].to_vec())
    }
    /// The natural width of `from..to`, as the breaker measures a line.
    fn width_of(&self, from: usize, to: usize) -> f64 {
        if self.reshaped(from) { return self.line(from, to).map(|gs| gs.iter().map(|g| g.advance).sum()).unwrap_or(0.0); }
        self.prefix[self.before[to]] - self.prefix[self.before[from]]
    }
}

/// A line of a wrapping slot: `layout_end` excludes the trailing whitespace and soft hyphens that do not count for
/// the width; `shaping_end` includes them (Typst draws the whitespace glyphs at zero advance).
/// `mandatory`: the line ends at a hard break or at the end of the text, so it is never justified.
/// `hyphen`: the line's full text ends on a soft hyphen, so the font's hyphen is drawn after it (its width counted).
struct BrokenLine { start: usize, layout_end: usize, shaping_end: usize, width: f64, mandatory: bool, hyphen: bool }
/// A line as drawn: `kept` glyphs count for the width (the hyphen among them), the rest are trimmed trailing
/// whitespace; `hyphen_width` is the drawn hyphen's advance, 0 without one.
struct LineRun { ids: Vec<u16>, advances: Vec<f64>, offsets: Vec<f64>, text: String, width: f64, kept: usize, hyphen_width: f64 }

/// Typst's simple breaker: greedy first fit, a mandatory break or a line that does not fit even on its own
/// committed as it is (an overlong word overflows, as in Typst).
fn break_lines(chars: &[char], width_of: &dyn Fn(usize, usize) -> f64, fits: &dyn Fn(f64) -> bool, hyphen_width: f64) -> Vec<BrokenLine> {
    let line = |start: usize, end: usize, mandatory: bool| -> BrokenLine {
        let (mut shaping_end, mut layout_end) = (end, end);
        if mandatory {
            while shaping_end > start && is_mandatory_break(chars[shaping_end - 1]) { shaping_end -= 1; }
            layout_end = shaping_end;
        } else {
            while layout_end > start && (chars[layout_end - 1].is_whitespace() || is_default_ignorable(chars[layout_end - 1])) { layout_end -= 1; }
        }
        // Typst appends the font's hyphen when the line's full text ends on a soft hyphen (`line.rs`, `Dash::Soft`), at
        // the end of the text too; its width counts for the fit.
        let hyphen = end > start && chars[end - 1] == SHY;
        BrokenLine { start, layout_end, shaping_end, width: width_of(start, layout_end) + if hyphen { hyphen_width } else { 0.0 }, mandatory, hyphen }
    };
    let mut lines = Vec::new();
    let mut start = 0;
    let mut last: Option<(BrokenLine, usize)> = None;
    for (end, mandatory) in breakpoints(chars) {
        let mut attempt = line(start, end, mandatory);
        if !fits(attempt.width) && let Some((last_line, last_end)) = last.take() {
            lines.push(last_line);
            start = last_end;
            attempt = line(start, end, mandatory);
        }
        if mandatory || !fits(attempt.width) { lines.push(attempt); start = end; last = None; } else { last = Some((attempt, end)); }
    }
    if let Some((line, _)) = last { lines.push(line); }
    lines
}

fn fill_lines(slot: &ir::Slot, text: &str, href: Href, font: &LoadedFont, trace_name: String) -> Result<Filled> {
    let (lines, pitch, size) = (slot.lines, slot.pitch, slot.size);
    if !(pitch > 0.0) { bail!("slot `{trace_name}`: a wrapping slot without a line pitch; export the document again"); }
    if slot.overflow == "shrink" { bail!("slot `{trace_name}`: `shrink` is not an overflow policy for a wrapping slot"); }
    let chars: Vec<char> = text.chars().collect();
    let shaping = Shaping::new(&chars, font, size, &trace_name)?;
    // A line ending on a soft hyphen gets the font's hyphen, whose width counts for the break.
    let hyphen = if chars.contains(&SHY) { let id = glyph_or_refuse(font, SHY, &trace_name)?; Some((id, font.advance(id) * size)) } else { None };
    let width_of = |from: usize, to: usize| -> f64 { shaping.width_of(from, to) };
    let fits = |width: f64| slot.width + 1e-4 >= width; // Typst's `Abs::fits`
    // Typst's `commit` (typst-layout 0.15.1 `line.rs`) over the shaped glyphs (`shape_text`): `remaining < 0`: the
    // line does not fit and its glyphs shrink (ragged lines too), each by `ratio` of what it may still give on
    // each side, down to -1, the glyph moving left by its left share. Otherwise a justified line stretches its
    // spaces by `ratio` of their stretchability (half a space each), up to 1, and shares what is still left
    // equally among the justifiable glyphs (`extra`: spaces and middle dots); a line without one keeps its width
    // and is aligned as the slot says. Trimmed trailing whitespace has no advance and no adjustability; the
    // hyphen neither.
    // `kept_end`: the characters before it count for the width, the rest is trimmed trailing whitespace.
    let run = |glyphs: Vec<Shaped>, kept_end: usize, justify: bool, hyphenated: bool, text: String| -> LineRun {
        let n = glyphs.len() + usize::from(hyphenated && hyphen.is_some());
        let (mut ids, mut advances, mut offsets, mut shrink, mut chars_of, mut is_kept) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for g in &glyphs {
            let k = g.at < kept_end;
            ids.push(g.id); advances.push(if k { g.advance } else { 0.0 }); offsets.push(if k { g.offset } else { 0.0 }); shrink.push(if k { g.shrink } else { (0.0, 0.0) }); chars_of.push(g.c); is_kept.push(k);
        }
        let mut hyphen_width = 0.0;
        if hyphenated && let Some((id, w)) = hyphen { ids.push(id); advances.push(w); offsets.push(0.0); shrink.push((0.0, 0.0)); chars_of.push('-'); is_kept.push(true); hyphen_width = w; }
        let justifiable: Vec<bool> = (0..n).map(|i| is_kept[i] && (is_space_glyph(chars_of[i]) || is_middle_dot(chars_of[i]))).collect();
        let mut width: f64 = advances.iter().sum();
        let remaining = slot.width - width;
        let shrinkability: f64 = shrink.iter().map(|(l, r)| l + r).sum();
        if remaining < 0.0 && shrinkability > 0.0 {
            let ratio = (remaining / shrinkability).max(-1.0);
            for i in 0..n { let (l, r) = shrink[i]; offsets[i] += l * ratio; advances[i] += (l + r) * ratio; }
            width = advances.iter().sum();
        } else if justify {
            let stretch: Vec<f64> = (0..n).map(|i| if is_kept[i] && is_space_glyph(chars_of[i]) { advances[i] * 0.5 } else { 0.0 }).collect();
            let stretchability: f64 = stretch.iter().sum();
            let (mut ratio, mut left) = (0.0, remaining);
            if stretchability > 0.0 { ratio = (remaining / stretchability).min(1.0); left = (remaining - stretchability).max(0.0); }
            // Typst's `Line::justifiables`: a middle dot that ends the line is not counted (it still takes the share).
            let mut justifiables = justifiable.iter().filter(|&&j| j).count();
            if (0..n).rev().find(|&i| is_kept[i]).is_some_and(|i| is_middle_dot(chars_of[i])) { justifiables -= 1; }
            let extra = if justifiables > 0 && left > 0.0 { left / justifiables as f64 } else { 0.0 };
            for i in 0..n { advances[i] += ratio * stretch[i] + if justifiable[i] { extra } else { 0.0 }; }
            width = advances.iter().sum();
        }
        LineRun { ids, advances, offsets, text, width, kept: is_kept.iter().filter(|&&k| k).count(), hyphen_width }
    };
    // Every line but the last and lines before a hard break are justified (`line.rs`: `config.justify &&
    // breakpoint != Mandatory`; the end of the text is a mandatory break too).
    let render = |l: &BrokenLine| -> Result<LineRun> { Ok(run(shaping.line(l.start, l.shaping_end)?, l.layout_end, slot.justify && !l.mandatory, l.hyphen, chars[l.start..l.shaping_end].iter().collect())) };
    let ellipsize = |l: &BrokenLine| -> Result<LineRun> {
        let ellipsis: Vec<char> = if font.glyph('…').is_some() { vec!['…'] } else { vec!['.', '.', '.'] };
        let mut kept: Vec<char> = chars[l.start..l.layout_end].to_vec();
        let trim = |kept: &mut Vec<char>| while kept.last().is_some_and(|&c| c.is_whitespace() || c == SHY) { kept.pop(); };
        // The ellipsized line is the runtime's own and the last one shown: never stretched, never hyphenated.
        let shape = |kept: &[char]| -> Result<LineRun> { let cs: Vec<char> = kept.iter().chain(&ellipsis).copied().collect(); Ok(run(shape_text(&cs, 0, font, size, &trace_name)?, cs.len(), false, false, cs.iter().collect())) };
        trim(&mut kept);
        let mut shown = shape(&kept)?;
        while !fits(shown.width) && !kept.is_empty() { kept.pop(); trim(&mut kept); shown = shape(&kept)?; }
        Ok(shown)
    };

    let broken = break_lines(&chars, &width_of, &fits, hyphen.map_or(0.0, |h| h.1));
    let mut runs: Vec<LineRun> = broken.iter().map(render).collect::<Result<_>>()?;
    // Lines stack as Typst stacks them: a line is as tall as the line height, except that a line of nothing but
    // trimmed whitespace (no kept glyph, no hyphen) has no height; `leading` separates lines. The first baseline is
    // the slot's.
    let line_height = slot.baseline - slot.y;
    let leading = pitch - line_height;
    let baselines = |rs: &[LineRun]| -> Vec<f64> {
        let mut y = slot.y;
        rs.iter().enumerate().map(|(k, r)| { let h = if !r.ids.is_empty() && r.kept == 0 { 0.0 } else { line_height }; if k > 0 { y += leading; } y += h; y }).collect()
    };
    let bottom = slot.y + slot.height + 1e-6;
    let visible = baselines(&runs).iter().filter(|&&b| b <= bottom).count();
    let overlong = runs.iter().position(|r| !fits(r.width));
    if overlong.is_some() || visible < runs.len() {
        match slot.overflow.as_str() {
            "error" => {
                if let Some(k) = overlong { bail!("slot `{trace_name}`: {:?} is {:.2} pt wide but the slot is {:.2} pt; declare an overflow policy or a smaller max-length", runs[k].text, runs[k].width, slot.width); }
                bail!("slot `{trace_name}`: {text:?} needs {} lines but the slot holds {lines}; declare an overflow policy or a smaller max-length", runs.len());
            }
            // Every line is drawn and the box clips, as in Typst: a line whose baseline is below the box may still
            // show its top (after a whitespace-only line, which has no height, the lines sit one line height up).
            "clip" => {}
            "ellipsis" => {
                let cut = overlong.unwrap_or(visible - 1).min(visible - 1);
                runs.truncate(cut + 1);
                runs[cut] = ellipsize(&broken[cut])?;
            }
            other => bail!("slot `{trace_name}`: unknown overflow policy {other:?}"),
        }
    }

    let ys = baselines(&runs);
    let mut items = Vec::new();
    let mut trace_glyphs = Vec::new();
    let mut drawn = Vec::new();
    for (k, line) in runs.iter().enumerate() {
        let y = ys[k];
        let x = match slot.align.as_str() {
            "left" => slot.x,
            "center" => slot.x + (slot.width - line.width) / 2.0,
            "right" => slot.x + slot.width - line.width,
            other => bail!("slot `{trace_name}`: unknown alignment {other:?}"),
        };
        let mut pen = x;
        let glyphs: Vec<ir::Glyph> = (0..line.ids.len()).map(|i| {
            let (id, advance, offset) = (line.ids[i], line.advances[i], line.offsets[i]);
            trace_glyphs.push(ReferenceGlyph { id, x: pen + offset, y });
            pen += advance;
            ir::Glyph { id, x_advance: advance, x_offset: offset, y_offset: 0.0, chars: None }
        }).collect();
        if !glyphs.is_empty() {
            items.push(ir::Item::Text { x, y, font: slot.font, size, fill: slot.fill, text: line.text.clone(), glyphs, node: None });
            // A link slot: Typst's hyphen is a text run of its own, with its own link rectangle.
            let text_width = line.width - line.hyphen_width;
            drawn.push((x, y, text_width));
            if line.hyphen_width > 0.0 { drawn.push((x + text_width, y, line.hyphen_width)); }
        }
    }
    // The trace reports the first line's baseline as Typst's frame has it: at the box top when that line is whitespace.
    let baseline = ys.first().copied().unwrap_or(slot.baseline);
    let link = link_fill(slot, href, &drawn, 1.0, &trace_name)?;
    Ok(Filled { rect: [slot.x, slot.y, slot.width, slot.height], items, trace: ReferenceSlot { name: trace_name, baseline, size, glyphs: trace_glyphs, ops: None, rect: None, rects: None }, node: None, image: None, alt: None, link })
}

// ---------------------------------------------------------------------------------------------------------
// Bars and image slots

/// A bar: the value's share of `max` (clamped to 0..1) of the hole's width, as Typst's rounded rectangle.
fn fill_bar(bar: &ir::Bar, value: f64, trace_name: String) -> Filled {
    let width = (value / bar.max).clamp(0.0, 1.0) * bar.width;
    let geometry = ir::geometry::rounded_rect(width, bar.height, bar.radius);
    let ops = ir::geometry::ops_of(&geometry, bar.x, bar.y);
    Filled {
        rect: [bar.x, bar.y, bar.width, bar.height],
        items: vec![ir::Item::Shape { x: bar.x, y: bar.y, geometry, fill: Some(bar.fill), stroke: None, node: None }],
        trace: ReferenceSlot { name: format!("{trace_name}#bar"), baseline: 0.0, size: 0.0, glyphs: Vec::new(), ops: Some(ops), rect: Some([bar.x, bar.y, width, bar.height]), rects: None },
        node: None, image: None, alt: None, link: None,
    }
}

/// An image slot: the data's PNG or JPEG, placed as Typst's `image` places it. Only the header is read here;
/// decoding happens when the PDF is written, once per distinct image.
fn fill_image(slot: &ir::ImageSlot, bytes: Vec<u8>, alt: Option<String>, trace_name: String) -> Result<Filled> {
    let (px_w, px_h, format) = image_size(&bytes).with_context(|| format!("image slot `{trace_name}`"))?;
    let [dx, dy, w, h] = ir::geometry::fit_image(&slot.fit, slot.width, slot.height, px_w as f64, px_h as f64).map_err(|e| anyhow!("image slot `{trace_name}`: {e}"))?;
    let key = format!("data:{:x}", Sha256::digest(&bytes));
    let alt = alt.or_else(|| slot.alt.clone());
    if alt.as_deref().is_none_or(str::is_empty) { bail!("image slot `{trace_name}`: no alternative text; PDF/UA needs one: give the value as (src, alt) or the template an `alt:`"); }
    Ok(Filled {
        rect: [slot.x, slot.y, slot.width, slot.height],
        items: vec![ir::Item::Image { x: slot.x + dx, y: slot.y + dy, width: w, height: h, format: format.to_string(), sha256: key.clone(), node: None }],
        trace: ReferenceSlot { name: format!("{trace_name}#image"), baseline: 0.0, size: 0.0, glyphs: Vec::new(), ops: None, rect: Some([slot.x + dx, slot.y + dy, w, h]), rects: None },
        node: None, image: Some((key, bytes)), alt, link: None,
    })
}

/// The bytes and alternative text of an image the data supplies: a `data:image/…;base64,…` URL, or
/// `{ "src": <that>, "alt": "…" }`.
fn image_value(value: &serde_json::Value, name: &str) -> Result<(Vec<u8>, Option<String>)> {
    let (src, alt) = match value {
        serde_json::Value::String(s) => (s.as_str(), None),
        serde_json::Value::Object(map) => (
            map.get("src").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("image slot `{name}`: the value has no `src` string"))?,
            map.get("alt").and_then(|v| v.as_str()).map(str::to_string),
        ),
        other => bail!("image slot `{name}`: cannot read an image from {other}"),
    };
    let payload = src.strip_prefix("data:").and_then(|r| r.split_once(',')).filter(|(h, _)| h.starts_with("image/") && h.ends_with(";base64")).map(|(_, p)| p)
        .ok_or_else(|| anyhow!("image slot `{name}`: the image must be a base64 data URL (data:image/png;base64,…), not {:?}", src.chars().take(40).collect::<String>()))?;
    Ok((base64_decode(payload).with_context(|| format!("image slot `{name}`"))?, alt))
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

// ---------------------------------------------------------------------------------------------------------
// Images: PNG and JPEG, decoded as far as a PDF needs. Typst's PDF writer (krilla) embeds them the same way:
// 8-bit grey or RGB samples deflated, the alpha channel as a soft mask when any pixel is not opaque, JPEG data
// as it is. So an image placed by the runtime renders as Typst's does.

/// An image ready for an image XObject: `data` is the stream (deflated samples, or the JPEG file), `smask` the
/// deflated 8-bit alpha when the image has transparency.
struct Decoded { width: u32, height: u32, gray: bool, dct: bool, data: Vec<u8>, smask: Option<Vec<u8>> }

/// The image files a document ships (by hash) and a cache of decoded images by key, so that an image used in
/// many documents is decoded once per runtime.
struct Images<'a> { files: HashMap<String, &'a [u8]>, cache: RefCell<HashMap<String, Rc<Decoded>>> }

impl Images<'_> {
    /// `bytes` are the image's own bytes for a data-supplied image; a static image is looked up by its hash.
    fn decoded(&self, key: &str, bytes: Option<&[u8]>) -> Result<Rc<Decoded>> {
        if let Some(d) = self.cache.borrow().get(key) { return Ok(d.clone()); }
        let bytes = match bytes {
            Some(b) => b,
            None => *self.files.get(key).ok_or_else(|| anyhow!("the document draws image {key}, which was not supplied; pass the files under images/"))?,
        };
        let decoded = Rc::new(decode_image(bytes).with_context(|| format!("decoding image {}", &key[..key.len().min(24)]))?);
        let mut cache = self.cache.borrow_mut();
        if cache.len() >= 256 { cache.clear(); }
        cache.insert(key.to_string(), decoded.clone());
        Ok(decoded)
    }
}

fn be32(b: &[u8], at: usize) -> u32 { u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) }

/// Pixel size and format ("png" or "jpg") from the header: enough to lay the image out before decoding it.
fn image_size(bytes: &[u8]) -> Result<(u32, u32, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        let ihdr = png_chunks(bytes)?.into_iter().find(|(kind, _)| kind == b"IHDR").map(|(_, d)| d).ok_or_else(|| anyhow!("PNG without IHDR"))?;
        if ihdr.len() < 13 { bail!("PNG IHDR is too short"); }
        Ok((be32(ihdr, 0), be32(ihdr, 4), "png"))
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        let (width, height, _) = jpeg_header(bytes)?;
        Ok((width, height, "jpg"))
    } else {
        bail!("not a PNG or JPEG (the file starts with {:02x?})", &bytes[..bytes.len().min(4)])
    }
}

fn decode_image(bytes: &[u8]) -> Result<Decoded> {
    if image_size(bytes)?.2 == "png" { decode_png(bytes) } else { decode_jpeg(bytes) }
}

fn png_chunks(bytes: &[u8]) -> Result<Vec<([u8; 4], &[u8])>> {
    let mut chunks = Vec::new();
    let mut at = 8;
    while at + 8 <= bytes.len() {
        let len = be32(bytes, at) as usize;
        let kind = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
        let (start, end) = (at + 8, at + 8 + len);
        if end + 4 > bytes.len() { bail!("truncated PNG chunk {}", String::from_utf8_lossy(&kind)); }
        chunks.push((kind, &bytes[start..end]));
        if &kind == b"IEND" { break; }
        at = end + 4;
    }
    Ok(chunks)
}

/// 8-bit, non-interlaced PNGs of every colour type; palettes are expanded, a tRNS chunk becomes alpha.
fn decode_png(bytes: &[u8]) -> Result<Decoded> {
    let chunks = png_chunks(bytes)?;
    let ihdr = chunks.iter().find(|(k, _)| k == b"IHDR").map(|(_, d)| *d).ok_or_else(|| anyhow!("PNG without IHDR"))?;
    if ihdr.len() < 13 { bail!("PNG IHDR is too short"); }
    let (width, height, depth, color_type, interlace) = (be32(ihdr, 0), be32(ihdr, 4), ihdr[8], ihdr[9], ihdr[12]);
    if depth != 8 { bail!("PNG with {depth}-bit samples is not supported (8-bit only); re-encode it"); }
    if interlace != 0 { bail!("interlaced PNG is not supported; re-encode it without interlacing"); }
    let channels = match color_type { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, other => bail!("PNG colour type {other} is not supported") };
    let palette = chunks.iter().find(|(k, _)| k == b"PLTE").map(|(_, d)| *d);
    let trns = chunks.iter().find(|(k, _)| k == b"tRNS").map(|(_, d)| *d);
    let mut idat = Vec::new();
    for (k, d) in &chunks { if k == b"IDAT" { idat.extend_from_slice(d); } }
    let mut raw = Vec::new();
    ZlibDecoder::new(idat.as_slice()).read_to_end(&mut raw).context("inflating PNG image data")?;
    let stride = width as usize * channels;
    if raw.len() != (stride + 1) * height as usize { bail!("PNG image data is {} bytes, expected {}", raw.len(), (stride + 1) * height as usize); }
    // Undo the per-row filters (filter method 0: none, sub, up, average, Paeth).
    let mut pixels = vec![0u8; stride * height as usize];
    for y in 0..height as usize {
        let filter = raw[y * (stride + 1)];
        let row = &raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        let (before, current) = pixels.split_at_mut(y * stride);
        let prev: &[u8] = if y == 0 { &[] } else { &before[(y - 1) * stride..] };
        let out = &mut current[..stride];
        for i in 0..stride {
            let a = if i >= channels { out[i - channels] } else { 0 };
            let b = if y > 0 { prev[i] } else { 0 };
            let c = if y > 0 && i >= channels { prev[i - channels] } else { 0 };
            let x = row[i];
            out[i] = match filter {
                0 => x,
                1 => x.wrapping_add(a),
                2 => x.wrapping_add(b),
                3 => x.wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => {
                    let p = a as i16 + b as i16 - c as i16;
                    let (pa, pb, pc) = ((p - a as i16).abs(), (p - b as i16).abs(), (p - c as i16).abs());
                    x.wrapping_add(if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c })
                }
                other => bail!("PNG row {y} uses unknown filter {other}"),
            };
        }
    }
    let (mut color, mut alpha): (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
    let gray = match color_type {
        0 => {
            color = pixels;
            if let Some(t) = trns && t.len() >= 2 { let key = t[1]; alpha = color.iter().map(|&g| if g == key { 0 } else { 255 }).collect(); }
            true
        }
        2 => {
            color = pixels;
            if let Some(t) = trns && t.len() >= 6 { let key = [t[1], t[3], t[5]]; alpha = color.chunks_exact(3).map(|p| if p == key { 0 } else { 255 }).collect(); }
            false
        }
        3 => {
            let palette = palette.ok_or_else(|| anyhow!("palette PNG without PLTE"))?;
            for &i in &pixels { let i = i as usize * 3; color.extend_from_slice(palette.get(i..i + 3).ok_or_else(|| anyhow!("PNG palette index out of range"))?); }
            if let Some(t) = trns { alpha = pixels.iter().map(|&i| t.get(i as usize).copied().unwrap_or(255)).collect(); }
            false
        }
        4 => { for p in pixels.chunks_exact(2) { color.push(p[0]); alpha.push(p[1]); } true }
        _ => { for p in pixels.chunks_exact(4) { color.extend_from_slice(&p[..3]); alpha.push(p[3]); } false }
    };
    let smask = if alpha.iter().any(|&a| a != 255) { Some(deflate(&alpha)) } else { None };
    Ok(Decoded { width, height, gray, dct: false, data: deflate(&color), smask })
}

/// Width, height and component count from a JPEG's frame header.
fn jpeg_header(bytes: &[u8]) -> Result<(u32, u32, u8)> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF { bail!("malformed JPEG: expected a marker at byte {at}"); }
        let code = bytes[at + 1];
        if code == 0xFF { at += 1; continue; }
        if code == 0xD8 || code == 0x01 || (0xD0..=0xD7).contains(&code) { at += 2; continue; }
        let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        match code {
            0xC0 | 0xC1 | 0xC2 => {
                if at + 10 > bytes.len() { bail!("truncated JPEG frame header"); }
                if bytes[at + 4] != 8 { bail!("JPEG with {}-bit samples is not supported", bytes[at + 4]); }
                let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]) as u32;
                let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]) as u32;
                return Ok((width, height, bytes[at + 9]));
            }
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => bail!("JPEG frame type {code:#x} (lossless, hierarchical or arithmetic coding) is not supported"),
            // Typst rotates a photo by its EXIF orientation; the runtimes draw it as stored, so they refuse it.
            0xE1 if bytes.get(at + 4..at + 10) == Some(b"Exif\0\0") => {
                if let Some(o) = exif_orientation(&bytes[at + 10..(at + 2 + len).min(bytes.len())]) && o != 1 {
                    bail!("JPEG with EXIF orientation {o}: rotate the image before sending it (Typst would rotate it, the runtimes draw it as stored)");
                }
            }
            0xD9 | 0xDA => break,
            _ => {}
        }
        at += 2 + len;
    }
    bail!("JPEG without a frame header")
}

/// The EXIF orientation tag (0x0112 in IFD0) of a TIFF-structured EXIF block, if present.
fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    let big = match tiff.get(..2)? { b"MM" => true, b"II" => false, _ => return None };
    let u16_at = |at: usize| -> Option<u16> { let b = tiff.get(at..at + 2)?; Some(if big { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) }) };
    let u32_at = |at: usize| -> Option<u32> { let b = tiff.get(at..at + 4)?; Some(if big { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) }) };
    if u16_at(2)? != 42 { return None; }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    (0..count).map(|i| ifd + 2 + 12 * i).find(|&e| u16_at(e) == Some(0x0112)).and_then(|e| u16_at(e + 8))
}

/// Baseline and progressive JPEGs pass through as DCT-encoded data, as in Typst's PDFs.
fn decode_jpeg(bytes: &[u8]) -> Result<Decoded> {
    let (width, height, components) = jpeg_header(bytes)?;
    let gray = match components { 1 => true, 3 => false, other => bail!("JPEG with {other} components (CMYK?) is not supported") };
    Ok(Decoded { width, height, gray, dct: true, data: bytes.to_vec(), smask: None })
}

// ---------------------------------------------------------------------------------------------------------
// Structure

/// A structure element of the output document. Node 0 is the Document root.
struct GNode { role: String, parent: Option<usize>, alt: Option<String>, scope: Option<String>, kids: Vec<Kid> }

enum Kid { Node(usize), Content { page: usize, mcid: i32 }, Annot { page: usize, index: usize } }

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
            alive[i] = self.nodes[i].kids.iter().any(|k| match k { Kid::Content { .. } | Kid::Annot { .. } => true, Kid::Node(n) => alive[*n] });
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

/// One output page: static items in absolute coordinates (nodes already global), the slots filled on it and
/// its link annotations.
struct Composed { width: f64, height: f64, items: Vec<ir::Item>, fills: Vec<Filled>, annots: Vec<Annot> }

/// A link annotation: rectangles in page coordinates (y down), the URL, the `/Contents` description and the
/// Link node it belongs to.
struct Annot { rects: Vec<[f64; 4]>, url: String, contents: String, node: Option<usize> }

/// Adds a filled slot's link, if any, to the page; the Link node takes the data's description.
fn add_slot_link(filled: &Filled, page: &mut Composed, structure: &mut Structure) {
    if let Some(link) = &filled.link {
        let contents = link.alt.clone().unwrap_or_else(|| link.url.clone());
        if let Some(n) = filled.node { structure.nodes[n].alt = Some(contents.clone()); }
        page.annots.push(Annot { rects: link.rects.clone(), url: link.url.clone(), contents, node: filled.node });
    }
}

/// Values a slot can be filled from: a data object plus, on overlays, the page counters.
struct Scope<'a> { data: &'a serde_json::Value, counters: Option<(usize, usize)> }

impl Scope<'_> {
    fn value(&self, name: &str) -> Result<&serde_json::Value> { self.data.get(name).ok_or_else(|| anyhow!("data has no value for slot `{name}`")) }

    fn number(&self, name: &str) -> Result<f64> {
        match self.value(name)? {
            serde_json::Value::Number(n) => n.as_f64().ok_or_else(|| anyhow!("bar `{name}`: {n} is not a number")),
            other => bail!("bar `{name}`: {other} is not a number"),
        }
    }

    fn image(&self, name: &str) -> Result<(Vec<u8>, Option<String>)> { image_value(self.value(name)?, name) }

    /// The `href` (and `alt`) of a `{ text, href, alt? }` value; `None` for any other value.
    fn href(&self, name: &str) -> Result<Href> {
        let Some(serde_json::Value::Object(map)) = self.data.get(name) else { return Ok(None) };
        match map.get("href") {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(url)) if !url.is_empty() => Ok(Some((url.clone(), match map.get("alt") { Some(serde_json::Value::String(a)) => Some(a.clone()), _ => None }))),
            Some(other) => bail!("slot `{name}`: `href` {other} is not a non-empty string"),
        }
    }

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
        let mut filled = fill_slot(&absolute, &text, scope.href(&slot.name)?, &fonts[slot.font], format!("{prefix}{}", slot.name))?;
        filled.node = slot.node.and_then(|n| map.get(n).copied().flatten());
        add_slot_link(&filled, page, structure);
        page.fills.push(filled);
    }
    for link in &fragment.links {
        let node = link.node.and_then(|n| map.get(n).copied().flatten());
        if node.is_none() { bail!("a link to {} in {prefix} would be placed as an artifact (a repeated table header or an overlay); PDF/UA forbids links there", link.url); }
        page.annots.push(Annot { rects: link.rects.iter().map(|r| [r[0] + fragment.x, r[1] + top, r[2], r[3]]).collect(), url: link.url.clone(), contents: link.alt.clone().unwrap_or_else(|| link.url.clone()), node });
    }
    for bar in &fragment.bars {
        let mut absolute = bar.clone();
        absolute.x += fragment.x; absolute.y += top;
        let mut filled = fill_bar(&absolute, scope.number(&bar.name)?, format!("{prefix}{}", bar.name));
        filled.node = bar.node.and_then(|n| map.get(n).copied().flatten());
        page.fills.push(filled);
    }
    for image in &fragment.images {
        let mut absolute = image.clone();
        absolute.x += fragment.x; absolute.y += top;
        let (bytes, alt) = scope.image(&image.name)?;
        let mut filled = fill_image(&absolute, bytes, alt, format!("{prefix}{}", image.name))?;
        filled.node = image.node.and_then(|n| map.get(n).copied().flatten());
        if let (Some(n), Some(alt)) = (filled.node, &filled.alt) { structure.nodes[n].alt = Some(alt.clone()); }
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
        let mut composed = Composed { width: page.width, height: page.height, items, fills: Vec::new(), annots: Vec::new() };
        for slot in doc.slots.iter().filter(|s| s.page == index) {
            let mut filled = fill_slot(slot, &scope.text(&slot.name)?, scope.href(&slot.name)?, &fonts[slot.font], slot.name.clone())?;
            filled.node = slot.node.and_then(|n| map.get(n).copied().flatten());
            add_slot_link(&filled, &mut composed, structure);
            composed.fills.push(filled);
        }
        for link in doc.links.iter().filter(|l| l.page == index) {
            let node = link.node.and_then(|n| map.get(n).copied().flatten());
            composed.annots.push(Annot { rects: link.rects.clone(), url: link.url.clone(), contents: link.alt.clone().unwrap_or_else(|| link.url.clone()), node });
        }
        for bar in doc.bars.iter().filter(|b| b.page == index) {
            let mut filled = fill_bar(bar, scope.number(&bar.name)?, bar.name.clone());
            filled.node = bar.node.and_then(|n| map.get(n).copied().flatten());
            composed.fills.push(filled);
        }
        for image in doc.images.iter().filter(|i| i.page == index) {
            let (bytes, alt) = scope.image(&image.name)?;
            let mut filled = fill_image(image, bytes, alt, image.name.clone())?;
            filled.node = image.node.and_then(|n| map.get(n).copied().flatten());
            if let (Some(n), Some(alt)) = (filled.node, &filled.alt) { structure.nodes[n].alt = Some(alt.clone()); }
            composed.fills.push(filled);
        }
        pages.push(composed);
    }
    Ok(pages)
}

/// How many lines a wrapping slot would give `text`, measured as the dialect's `lines: auto` measures it in
/// Typst: from the stacked height of the broken lines, so a line of nothing but whitespace counts for nothing.
fn needed_lines(slot: &ir::Slot, text: &str, font: &LoadedFont, trace_name: &str) -> Result<usize> {
    let (pitch, size) = (slot.pitch, slot.size);
    if !(pitch > 0.0) { bail!("slot `{trace_name}`: a wrapping slot without a line pitch; export the document again"); }
    let chars: Vec<char> = text.chars().collect();
    let shaping = Shaping::new(&chars, font, size, trace_name)?;
    let hyphen_width = if chars.contains(&SHY) { font.advance(glyph_or_refuse(font, SHY, trace_name)?) * size } else { 0.0 };
    let width_of = |from: usize, to: usize| -> f64 { shaping.width_of(from, to) };
    let fits = |width: f64| slot.width + 1e-4 >= width;
    let broken = break_lines(&chars, &width_of, &fits, hyphen_width);
    let line_height = slot.baseline - slot.y;
    let leading = pitch - line_height;
    let mut y = 0.0;
    for (k, l) in broken.iter().enumerate() {
        let h = if l.shaping_end > l.start && l.layout_end == l.start && !l.hyphen { 0.0 } else { line_height };
        if k > 0 { y += leading; }
        y += h;
    }
    Ok(((y - line_height) / pitch).round().max(0.0) as usize + 1)
}

/// The variant of a band for one instance: `data` is the row (or the document for a choice block), `index` the
/// row number.
fn pick<'a>(band: &'a ir::Band, data: &serde_json::Value, index: usize, fonts: &[LoadedFont]) -> Result<&'a ir::Fragment> {
    let n = band.fragments.len();
    let k = match &band.select {
        _ if n <= 1 => 0,
        None => 0,
        Some(ir::Select::Parity) => index % 2,
        Some(ir::Select::Flag { path }) => if data.get(path) == Some(&serde_json::Value::Bool(true)) { 0 } else { 1 },
        Some(ir::Select::Lines { slot }) => {
            // A wrapping variant carries the line metrics; the slot has the same width in every variant.
            let measure = band.fragments[1].slots.iter().find(|s| &s.name == slot).ok_or_else(|| anyhow!("band `{}`: no slot `{slot}` to pick the variant by", band.name))?;
            let text = Scope { data, counters: None }.text(slot)?;
            needed_lines(measure, &text, &fonts[measure.font], &format!("{}.{slot}", band.name))? - 1
        }
    };
    Ok(&band.fragments[k.min(n - 1)])
}

fn compose_flow(flow: &ir::Flow, data: &serde_json::Value, fonts: &[LoadedFont], structure: &mut Structure) -> Result<Vec<Composed>> {
    const EPS: f64 = 1e-6;
    let area = flow.area;
    let bottom = area.y + area.height;
    let band = |name: &str| flow.bands.iter().find(|b| b.name == name).ok_or_else(|| anyhow!("unknown band `{name}`"));
    let new_page = || Composed { width: flow.page_width, height: flow.page_height, items: Vec::new(), fills: Vec::new(), annots: Vec::new() };
    let scope = Scope { data, counters: None };

    let mut pages = vec![new_page()];
    let mut cursor = area.y;
    for block in &flow.blocks {
        match block {
            ir::Block::Static { .. } | ir::Block::Choice { .. } => {
                let (fragment, prefix, clip) = match block {
                    ir::Block::Choice { band: name } => { let b = band(name)?; (pick(b, data, 0, fonts)?, format!("{name}."), true) }
                    ir::Block::Static { fragment } => (fragment, String::new(), false),
                    _ => unreachable!(),
                };
                if cursor + fragment.height > bottom + EPS && cursor > area.y + EPS { pages.push(new_page()); cursor = area.y; }
                place(fragment, cursor, &scope, fonts, &prefix, clip, pages.last_mut().unwrap(), structure, Attach::Document)?;
                cursor += fragment.height;
            }
            ir::Block::Repeat { band: name, header, header_gap, gap, .. } => {
                let rows = data.get(name).and_then(|v| v.as_array()).ok_or_else(|| anyhow!("data has no array `{name}` for the repeat region"))?;
                let row_band = band(name)?;
                let header_band = header.as_deref().map(band).transpose()?;
                let header_fragment = header_band.map(|h| &h.fragments[0]);
                let fragments: Vec<&ir::Fragment> = rows.iter().enumerate().map(|(i, row)| pick(row_band, row, i, fonts)).collect::<Result<_>>()?;
                let header_height = header_fragment.map(|h| h.height + header_gap).unwrap_or(0.0);
                let first_row = fragments.first().map(|f| f.height).unwrap_or(0.0);
                if cursor + header_height + first_row > bottom + EPS && cursor > area.y + EPS { pages.push(new_page()); cursor = area.y; }
                // One table for the whole region; the first header is its header row, repeats are artifacts.
                let table = structure.add("Table", 0, None, None);
                if let (Some(h), Some(hf)) = (header_band, header_fragment) {
                    place(hf, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap(), structure, Attach::Table(table))?;
                    cursor += header_height;
                }
                for (i, row) in rows.iter().enumerate() {
                    let fragment = fragments[i];
                    if cursor + fragment.height > bottom + EPS {
                        pages.push(new_page());
                        cursor = area.y;
                        if let (Some(h), Some(hf)) = (header_band, header_fragment) {
                            place(hf, cursor, &scope, fonts, &format!("{}.", h.name), true, pages.last_mut().unwrap(), structure, Attach::Artifact)?;
                            cursor += header_height;
                        }
                    }
                    let row_scope = Scope { data: row, counters: None };
                    place(fragment, cursor, &row_scope, fonts, &format!("{name}[{i}]."), true, pages.last_mut().unwrap(), structure, Attach::Table(table))?;
                    cursor += fragment.height;
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
    /// Image XObject resource name per image key.
    image_names: &'a HashMap<String, String>,
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
                ir::Item::Image { x, y, width, height, sha256, node, .. } => {
                    self.ensure(content, *node);
                    let name = self.image_names.get(sha256).expect("every image was registered before the pages were written");
                    // The page CTM flips y; this matrix flips the unit square back so the first row is at the top.
                    content.save_state();
                    content.transform([*width as f32, 0.0, 0.0, -(*height as f32), *x as f32, (*y + *height) as f32]);
                    content.x_object(Name(name.as_bytes()));
                    content.restore_state();
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

fn image_keys(items: &[ir::Item], out: &mut Vec<String>) {
    for item in items {
        match item {
            ir::Item::Group { items, .. } => image_keys(items, out),
            ir::Item::Image { sha256, .. } => out.push(sha256.clone()),
            _ => {}
        }
    }
}

fn write_pdf(doc: &ir::Document, fonts: &[LoadedFont], images: &Images, pages: &[Composed], structure: &mut Structure) -> Result<Vec<u8>> {
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
        for fill in &page.fills { collect_glyphs(&fill.items, &mut used, &mut multi); }
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

    // Image XObjects: the static images by file, the images the data supplied by content; each written once.
    let mut image_names: HashMap<String, String> = HashMap::new();
    let mut image_refs: Vec<(String, Ref)> = Vec::new();
    let mut wanted: Vec<(String, Option<&[u8]>)> = Vec::new();
    for page in pages {
        let mut keys = Vec::new();
        image_keys(&page.items, &mut keys);
        wanted.extend(keys.into_iter().map(|k| (k, None)));
        for fill in &page.fills { if let Some((key, bytes)) = &fill.image { wanted.push((key.clone(), Some(bytes.as_slice()))); } }
    }
    for (key, bytes) in wanted {
        if image_names.contains_key(&key) { continue; }
        let decoded = images.decoded(&key, bytes)?;
        let id = alloc();
        let mask = decoded.smask.as_ref().map(|_| alloc());
        if let (Some(mask), Some(data)) = (mask, &decoded.smask) {
            let mut m = pdf.image_xobject(mask, data);
            m.filter(Filter::FlateDecode);
            m.width(decoded.width as i32).height(decoded.height as i32).bits_per_component(8);
            m.color_space().device_gray();
            m.finish();
        }
        let mut x = pdf.image_xobject(id, &decoded.data);
        x.filter(if decoded.dct { Filter::DctDecode } else { Filter::FlateDecode });
        x.width(decoded.width as i32).height(decoded.height as i32).bits_per_component(8);
        if decoded.gray { x.color_space().device_gray(); } else { x.color_space().device_rgb(); }
        if let Some(mask) = mask { x.s_mask(mask); }
        x.finish();
        let name = format!("Im{}", image_refs.len());
        image_refs.push((name.clone(), id));
        image_names.insert(key, name);
    }

    // Link annotations: one object per link (several rectangles become quad points, as typst-pdf writes them for
    // PDF/UA), listed in the page's /Annots, keyed into the parent tree after the pages and referenced from
    // their Link structure element through an OBJR.
    let annot_refs: Vec<Vec<Ref>> = pages.iter().map(|p| p.annots.iter().map(|_| alloc()).collect()).collect();
    let mut annot_parents: Vec<(i32, usize)> = Vec::new();
    let mut next_key = pages.len() as i32;
    for (index, page) in pages.iter().enumerate() {
        for (i, a) in page.annots.iter().enumerate() {
            let h = page.height;
            let boxes: Vec<[f64; 4]> = a.rects.iter().map(|r| [r[0], h - r[1] - r[3], r[0] + r[2], h - r[1]]).collect(); // left, bottom, right, top
            let (l, b) = (boxes.iter().map(|r| r[0]).fold(f64::INFINITY, f64::min), boxes.iter().map(|r| r[1]).fold(f64::INFINITY, f64::min));
            let (r, t) = (boxes.iter().map(|r| r[2]).fold(f64::NEG_INFINITY, f64::max), boxes.iter().map(|r| r[3]).fold(f64::NEG_INFINITY, f64::max));
            let mut annot = pdf.annotation(annot_refs[index][i]);
            annot.subtype(AnnotationType::Link).rect(Rect::new(l as f32, b as f32, r as f32, t as f32)).page(page_ids[index]);
            if boxes.len() > 1 { annot.quad_points(boxes.iter().flat_map(|&[l, b, r, t]| [l, t, r, t, l, b, r, b]).map(|v| v as f32)); }
            annot.border(0.0, 0.0, 0.0, None).flags(AnnotationFlags::PRINT).contents(TextStr(&a.contents));
            annot.action().action_type(ActionType::Uri).uri(Str(a.url.as_bytes()));
            if let Some(n) = a.node { annot.struct_parent(next_key); annot_parents.push((next_key, n)); next_key += 1; }
            annot.finish();
        }
    }

    let mut writer = Writer { fonts, image_names: &image_names, structure, page: 0, parents: Vec::new(), open: None };
    let mut page_parents: Vec<Vec<usize>> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        writer.page = index;
        writer.parents = Vec::new();
        let content_id = alloc();
        let mut content = Content::new();
        content.transform([1.0, 0.0, 0.0, -1.0, 0.0, page.height as f32]);
        writer.emit(&mut content, &page.items);
        writer.close(&mut content);
        // A hole's content is clipped to its box, exactly as Typst clips the box in the baseline document.
        for fill in &page.fills {
            content.save_state();
            let [x, y, w, h] = fill.rect;
            content.rect(x as f32, y as f32, w as f32, h as f32);
            content.clip_nonzero();
            content.end_path();
            let mut items = fill.items.clone();
            for item in &mut items {
                match item { ir::Item::Text { node, .. } | ir::Item::Shape { node, .. } | ir::Item::Image { node, .. } => *node = fill.node, ir::Item::Group { .. } => {} }
            }
            writer.emit(&mut content, &items);
            writer.close(&mut content);
            content.restore_state();
        }
        page_parents.push(std::mem::take(&mut writer.parents));
        let bytes = content.finish();
        pdf.stream(content_id, &deflate(&bytes)).filter(Filter::FlateDecode);
        let mut page_obj = pdf.page(page_ids[index]);
        page_obj.parent(pages_id).media_box(Rect::new(0.0, 0.0, page.width as f32, page.height as f32)).contents(content_id).struct_parents(index as i32);
        if !annot_refs[index].is_empty() { page_obj.annotations(annot_refs[index].iter().copied()).tab_order(TabOrder::StructureOrder); }
        let mut resources = page_obj.resources();
        let mut font_dict = resources.fonts();
        for (i, font_ref) in font_refs.iter().enumerate() { font_dict.pair(Name(format!("F{i}").as_bytes()), *font_ref); }
        font_dict.finish();
        if !image_refs.is_empty() {
            let mut xobjects = resources.x_objects();
            for (name, id) in &image_refs { xobjects.pair(Name(name.as_bytes()), *id); }
            xobjects.finish();
        }
        resources.finish();
        page_obj.finish();
    }

    // The structure tree: only nodes with content below them are written. Annotations are kids of their Link node.
    for (index, page) in pages.iter().enumerate() {
        for (i, a) in page.annots.iter().enumerate() { if let Some(n) = a.node { writer.structure.nodes[n].kids.push(Kid::Annot { page: index, index: i }); } }
    }
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
        for (key, n) in &annot_parents { nums.insert(*key, node_refs[*n].expect("annotation nodes are alive")); }
        nums.finish();
        tree.finish();
        root.pair(Name(b"ParentTreeNextKey"), next_key);
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
                Kid::Annot { page, index } => { children.object_ref().page(page_ids[*page]).object(annot_refs[*page][*index]); }
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

/// A parsed document with its fonts and image files, ready to be filled many times.
pub struct Runtime<'a> { doc: ir::Document, fonts: Vec<LoadedFont<'a>>, images: Images<'a> }

impl<'a> Runtime<'a> {
    /// `fonts` are the font files in the document's order; `images` the document's image files (any order,
    /// matched by hash), needed only when the static content draws images.
    pub fn new(doc_json: &[u8], fonts: &[&'a [u8]], images: &[&'a [u8]]) -> Result<Self> {
        let doc: ir::Document = serde_json::from_slice(doc_json).context("parsing the document")?;
        if doc.version != ir::VERSION { bail!("the document is IR version {}, this runtime reads {}", doc.version, ir::VERSION); }
        let fonts = load_fonts(&doc, fonts)?;
        let by_hash: HashMap<String, &'a [u8]> = images.iter().map(|bytes| (format!("{:x}", Sha256::digest(bytes)), *bytes)).collect();
        let mut files = HashMap::new();
        for file in &doc.image_files {
            let bytes = by_hash.get(&file.sha256).ok_or_else(|| anyhow!("the document needs image file {} (sha256 {}), which was not supplied", file.file, file.sha256))?;
            files.insert(file.sha256.clone(), *bytes);
        }
        Ok(Self { doc, fonts, images: Images { files, cache: RefCell::new(HashMap::new()) } })
    }

    pub fn document(&self) -> &ir::Document { &self.doc }

    pub fn fill(&self, data_json: &[u8]) -> Result<Output> {
        let data: serde_json::Value = serde_json::from_slice(data_json).context("parsing the data")?;
        let mut structure = Structure::new();
        let pages = match &self.doc.flow {
            Some(flow) => compose_flow(flow, &data, &self.fonts, &mut structure)?,
            None => compose_fixed(&self.doc, &data, &self.fonts, &mut structure)?,
        };
        let pdf = write_pdf(&self.doc, &self.fonts, &self.images, &pages, &mut structure)?;
        let trace = pages.iter().flat_map(|p| p.fills.iter().flat_map(|f| {
            let mut out = vec![f.trace.clone()];
            if let Some(link) = &f.link { out.push(ReferenceSlot { name: format!("{}#link", f.trace.name), baseline: 0.0, size: 0.0, glyphs: Vec::new(), ops: None, rect: None, rects: Some(link.rects.clone()) }); }
            out
        })).collect();
        Ok(Output { pdf, trace, pages: pages.len() })
    }
}

/// Fills `doc_json` (an exported document) with `data_json`; `fonts` are the font files in the document's order.
/// A document whose static content draws images needs [`Runtime::new`] with the image files.
pub fn fill(doc_json: &[u8], fonts: &[&[u8]], data_json: &[u8]) -> Result<Output> {
    Runtime::new(doc_json, fonts, &[])?.fill(data_json)
}

/// Differences between what the runtime drew and Typst's own layout of the same data.
pub fn compare(trace: &[ReferenceSlot], reference: &[ReferenceSlot]) -> Vec<String> {
    let mut problems = Vec::new();
    let by_name: BTreeMap<&str, &ReferenceSlot> = reference.iter().map(|s| (s.name.as_str(), s)).collect();
    for slot in trace {
        let Some(expected) = by_name.get(slot.name.as_str()) else { problems.push(format!("{}: not in the reference", slot.name)); continue };
        if (slot.baseline - expected.baseline).abs() > 1e-3 { problems.push(format!("{}: baseline {:.3} vs Typst {:.3}", slot.name, slot.baseline, expected.baseline)); }
        if !expected.glyphs.is_empty() && (slot.size - expected.size).abs() > 1e-3 { problems.push(format!("{}: size {:.3} vs Typst {:.3}", slot.name, slot.size, expected.size)); } // an empty value shows no size
        let ours: Vec<u16> = slot.glyphs.iter().map(|g| g.id).collect();
        let theirs: Vec<u16> = expected.glyphs.iter().map(|g| g.id).collect();
        if let Some(rect) = &expected.rect {
            match &slot.rect {
                Some(ours) if ours.iter().zip(rect).all(|(a, b)| (a - b).abs() <= 1e-3) => {}
                Some(ours) => problems.push(format!("{}: box {ours:?} vs Typst {rect:?}", slot.name)),
                None => problems.push(format!("{}: Typst has a box, the runtime drew none", slot.name)),
            }
        }
        if let Some(rects) = &expected.rects {
            match &slot.rects {
                Some(ours) if ours.len() == rects.len() && ours.iter().zip(rects).all(|(a, b)| a.iter().zip(b).all(|(p, q)| (p - q).abs() <= 1e-3)) => {}
                Some(ours) => problems.push(format!("{}: link rectangles {ours:?} vs Typst {rects:?}", slot.name)),
                None => problems.push(format!("{}: Typst has link rectangles, the runtime drew none", slot.name)),
            }
        }
        if let Some(ops) = &expected.ops && !slot.ops.as_deref().is_some_and(|ours| ir::geometry::same_ops(ours, ops, 1e-3)) {
            problems.push(format!("{}: shape {:?} vs Typst {ops:?}", slot.name, slot.ops));
        }
        if ours != theirs { problems.push(format!("{}: glyphs {ours:?} vs Typst {theirs:?}", slot.name)); continue; }
        for (i, (a, b)) in slot.glyphs.iter().zip(&expected.glyphs).enumerate() {
            if (a.x - b.x).abs() > 1e-3 { problems.push(format!("{}: glyph {i} (id {}) at x {:.4} vs Typst {:.4}", slot.name, a.id, a.x, b.x)); break; }
            if (a.y - b.y).abs() > 1e-3 { problems.push(format!("{}: glyph {i} (id {}) at y {:.4} vs Typst {:.4}", slot.name, a.id, a.y, b.y)); break; }
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
        match super::Runtime::new(doc, &slices, &[]) {
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
