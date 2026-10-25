//! Parametric document IR: Typst frames with holes.
//!
//! Coordinates are PDF points with the origin at the page's top-left corner and y growing downwards, as in
//! Typst frames. Text items are positioned at their baseline origin. Glyph advances and offsets are already
//! scaled by the font size; `y_offset` is positive upwards, as in Typst.

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 6;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Document {
    pub version: u32,
    pub title: Option<String>,
    /// Document language (BCP 47), from the first text run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub fonts: Vec<Font>,
    /// Fixed pages (a document without bands); empty for a flow document.
    pub pages: Vec<Page>,
    /// Slots on the fixed pages, in absolute page coordinates.
    pub slots: Vec<Slot>,
    /// A flow document: blocks the runtime stacks and breaks into pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<Flow>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Flow {
    pub page_width: f64,
    pub page_height: f64,
    /// The page minus its margins: where blocks are stacked.
    pub area: Area,
    pub blocks: Vec<Block>,
    pub bands: Vec<Band>,
    /// Per-page content at absolute positions, such as a footer.
    pub overlays: Vec<Fragment>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    /// Content between repeat regions; its height is the distance to the next region in the sample.
    Static { fragment: Fragment },
    /// One band instance per row of the data array named `band`; `header` names a band repeated at the top
    /// of each page the rows continue on. `gap` is the vertical space between rows, `header_gap` the space
    /// between the header and the first row. `sample_rows` is informative only.
    Repeat { band: String, header: Option<String>, header_gap: f64, gap: f64, sample_rows: usize },
    /// A single instance of a band, picked among its variants by the band's selector; its slots bind to the
    /// document's data.
    Choice { band: String },
}

/// A piece of layout with its own slots. Items and slots are relative to the fragment's top-left corner;
/// `x` is where the fragment sits horizontally on the page, `y` only matters for overlays.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Fragment {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
    pub slots: Vec<Slot>,
    #[serde(default)]
    pub nodes: Vec<Node>,
}

/// A band's layouts, one per variant (one for a plain band), and how the runtime picks among them.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Band {
    pub name: String,
    pub repeat_on_break: bool,
    /// Variant k is `fragments[k - 1]`; all were laid out by Typst at export time.
    pub fragments: Vec<Fragment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<Select>,
}

/// How the runtime picks a band's variant for an instance.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Select {
    /// Variant 1 for the first, third, fifth row, variant 2 for the others.
    Parity,
    /// Variant 1 when the data value at `path` is `true`, variant 2 otherwise.
    Flag { path: String },
    /// Variant k when the wrapping slot `slot` needs k lines for its text (capped at the variant count).
    Lines { slot: String },
}

/// A font as the runtime needs it: a subset program plus everything the runtime would otherwise parse from
/// it. Glyph ids in the document are ids in this subset.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Font {
    pub family: String,
    /// Face index inside the original font file.
    pub index: u32,
    /// Hash of the file the runtime loads (the subset).
    pub sha256: String,
    /// Hash of the original font file, the font's identity across exports.
    #[serde(default)]
    pub source_sha256: String,
    /// File name the runtime loads the bytes from, relative to the document.
    pub file: String,
    /// What the file is: "cff" (a bare CFF table), "opentype-cff" or "truetype".
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub units_per_em: f64,
    #[serde(default)]
    pub ascender: f64,
    #[serde(default)]
    pub descender: f64,
    #[serde(default)]
    pub cap_height: f64,
    #[serde(default)]
    pub bbox: [f64; 4],
    #[serde(default)]
    pub italic_angle: f64,
    #[serde(default)]
    pub italic: bool,
    /// Advance width per glyph id, in font units.
    #[serde(default)]
    pub advances: Vec<f64>,
    /// Character to glyph id, for every character a slot may contain (its repertoire) and every character of
    /// the static text; the runtime maps slot text through this and inverts it for ToUnicode.
    #[serde(default)]
    pub cmap: std::collections::BTreeMap<String, u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
    /// Structure nodes the page's items and slots refer to; parents come before children.
    #[serde(default)]
    pub nodes: Vec<Node>,
}

/// A structure element: a PDF tag such as P, H1, Table, TR, TH, TD or Figure. `parent` is `None` for a root
/// of its page or fragment; the runtime attaches roots to the document (or, for band rows, to the table).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Node {
    pub role: String,
    pub parent: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// Header scope for TH: "column", "row" or "both".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    /// A nested frame: `transform` is a PDF-style matrix `[a b c d e f]` applied after moving to `(x, y)`.
    Group { x: f64, y: f64, transform: [f64; 6], clip: Option<Vec<PathOp>>, items: Vec<Item> },
    /// `node` is the structure node the run belongs to; `None` marks an artifact.
    Text { x: f64, y: f64, font: usize, size: f64, fill: Color, text: String, glyphs: Vec<Glyph>, #[serde(default, skip_serializing_if = "Option::is_none")] node: Option<usize> },
    Shape { x: f64, y: f64, geometry: Geometry, fill: Option<Color>, stroke: Option<Stroke>, #[serde(default, skip_serializing_if = "Option::is_none")] node: Option<usize> },
    /// Recorded, not yet drawn by the runtime.
    Image { x: f64, y: f64, width: f64, height: f64, format: String, sha256: String, #[serde(default, skip_serializing_if = "Option::is_none")] node: Option<usize> },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Glyph {
    pub id: u16,
    pub x_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
    /// The characters this glyph stands for when that is not exactly one (ligatures); for ToUnicode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chars: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Geometry {
    Line { to: [f64; 2] },
    Rect { width: f64, height: f64 },
    Path { ops: Vec<PathOp> },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PathOp {
    Move { to: [f64; 2] },
    Line { to: [f64; 2] },
    Cubic { c1: [f64; 2], c2: [f64; 2], to: [f64; 2] },
    Close,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Stroke {
    pub paint: Color,
    pub thickness: f64,
    pub cap: String,
    pub join: String,
    pub dash: Option<Dash>,
    pub miter_limit: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Dash {
    pub array: Vec<f64>,
    pub phase: f64,
}

/// A hole: a fixed box whose text comes from data at runtime. On a fixed page the coordinates are absolute;
/// inside a fragment they are relative to the fragment and `page` is 0.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Slot {
    pub name: String,
    /// Zero-based page index.
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Absolute y of the text baseline: the box bottom minus `descent`. For a wrapping slot (`lines` > 1) the
    /// first line's baseline: the box top plus the line height; line `k` sits `k · pitch` lower.
    pub baseline: f64,
    /// Room kept below the baseline for descenders, in points.
    pub descent: f64,
    /// Absolute x where the sample text started; only meaningful for left alignment.
    pub pen_x: f64,
    pub font: usize,
    pub size: f64,
    pub fill: Color,
    pub align: String,
    pub overflow: String,
    pub max_length: Option<u32>,
    /// The sample value the exporter saw; not part of the layout contract.
    pub sample: String,
    /// The structure node the slot's text belongs to; `None` marks an artifact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<usize>,
    /// The characters this slot may contain, when the template declares them; otherwise the default repertoire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    /// How many ragged-right lines the slot holds; 1 is a single line pinned to the box bottom.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub lines: u32,
    /// Baseline-to-baseline distance of a wrapping slot's lines, in points; 0 for a single line.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pitch: f64,
    /// Set when the slot was declared `lines: auto`: the band's variant count, the most lines it can get.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_lines: Option<u32>,
}

fn one() -> u32 { 1 }
fn is_one(n: &u32) -> bool { *n == 1 }
fn is_zero(v: &f64) -> bool { *v == 0.0 }
