//! Parametric document IR: Typst frames with holes.
//!
//! Coordinates are PDF points with the origin at the page's top-left corner and y growing downwards, as in
//! Typst frames. Text items are positioned at their baseline origin. Glyph advances and offsets are already
//! scaled by the font size; `y_offset` is positive upwards, as in Typst.

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Document {
    pub version: u32,
    pub title: Option<String>,
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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Band {
    pub name: String,
    pub repeat_on_break: bool,
    pub fragment: Fragment,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Font {
    pub family: String,
    /// Face index inside the font file.
    pub index: u32,
    pub sha256: String,
    /// File name the runtime loads the bytes from, relative to the document.
    pub file: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    /// A nested frame: `transform` is a PDF-style matrix `[a b c d e f]` applied after moving to `(x, y)`.
    Group { x: f64, y: f64, transform: [f64; 6], clip: Option<Vec<PathOp>>, items: Vec<Item> },
    Text { x: f64, y: f64, font: usize, size: f64, fill: Color, text: String, glyphs: Vec<Glyph> },
    Shape { x: f64, y: f64, geometry: Geometry, fill: Option<Color>, stroke: Option<Stroke> },
    /// Recorded, not yet drawn by the runtime.
    Image { x: f64, y: f64, width: f64, height: f64, format: String, sha256: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Glyph {
    pub id: u16,
    pub x_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
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
    /// Absolute y of the text baseline: the box bottom minus `descent`.
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
}
