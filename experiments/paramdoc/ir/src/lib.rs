//! Parametric document IR: Typst frames with holes.
//!
//! Coordinates are PDF points with the origin at the page's top-left corner and y growing downwards, as in
//! Typst frames. Text items are positioned at their baseline origin. Glyph advances and offsets are already
//! scaled by the font size; `y_offset` is positive upwards, as in Typst.

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 7;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Document {
    pub version: u32,
    pub title: Option<String>,
    /// Document language (BCP 47), from the first text run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub fonts: Vec<Font>,
    /// Raster images the static content draws, shipped next to the document like the fonts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_files: Vec<ImageFile>,
    /// Fixed pages (a document without bands); empty for a flow document.
    pub pages: Vec<Page>,
    /// Slots on the fixed pages, in absolute page coordinates.
    pub slots: Vec<Slot>,
    /// Bars and image slots on the fixed pages, likewise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bars: Vec<Bar>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageSlot>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bars: Vec<Bar>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageSlot>,
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
    /// A raster image: `sha256` names an entry of the document's `image_files`, or, in a filled image slot,
    /// the runtime's own key for the bytes the data supplied. Drawn into the box `(x, y, width, height)`.
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

/// A bar: a hole whose content is one filled rectangle, rounded by `radius`, as wide as the data value's share
/// of `max` times the hole's width (clamped to 0..1) and as tall as the hole; its track is static content behind
/// it. Coordinates as for `Slot`. The bar is content of the structure node it sits in (a table cell, say), so
/// that the cell is not empty; the value it shows is expected to be printed as text too.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Bar {
    pub name: String,
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub max: f64,
    pub fill: Color,
    /// Corner radius in points, before Typst caps it at half the shorter side.
    pub radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<usize>,
    /// The sample value the exporter saw; not part of the layout contract.
    pub sample: f64,
}

/// An image hole: a fixed box the data fills with a PNG or JPEG, placed as Typst's `image` with this `fit`
/// places it (see [`geometry::fit_image`]) and clipped to the box. `alt` is the template's alternative text;
/// the data may supply its own. Coordinates as for `Slot`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ImageSlot {
    pub name: String,
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// "cover", "contain" or "stretch".
    pub fit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// The Figure node the image belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<usize>,
    /// The sample's image source as the data named it; not part of the layout contract.
    pub sample: String,
}

/// A raster image file the static content draws, referenced by `Item::Image` through its hash.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ImageFile {
    pub sha256: String,
    /// File name relative to the document, under `images/`.
    pub file: String,
    /// "png" or "jpg".
    pub format: String,
    pub width: u32,
    pub height: u32,
}

/// Geometry the runtimes regenerate from data, ported from `typst-layout 0.15.1` so that what a runtime draws
/// equals Typst's own layout. The exporter checks these ports against Typst on every sample it compiles.
pub mod geometry {
    use super::{Geometry, PathOp};

    /// A filled rectangle with a uniform corner radius and no stroke, as `shapes.rs::styled_rect` builds it: a
    /// plain rectangle for radius 0 (`simple_rect`), otherwise the fill curve of `segmented_rect`, whose radius
    /// is capped at half the shorter side and whose arcs are the cubic Béziers of `bezier_arc_control`.
    pub fn rounded_rect(width: f64, height: f64, radius: f64) -> Geometry {
        if radius == 0.0 { return Geometry::Rect { width, height }; }
        let r = radius.min(width.abs().min(height.abs()) / 2.0);
        // `ControlPoints::rotate`: a top-left corner point moved to each corner; `Abs::signum` of 0 is 1.
        let (sx, sy) = (if width.is_sign_negative() { -1.0 } else { 1.0 }, if height.is_sign_negative() { -1.0 } else { 1.0 });
        let rotate = |corner: usize, px: f64, py: f64| -> [f64; 2] {
            match corner {
                0 => [sx * px, sy * py],
                1 => [width - sx * py, sy * px],
                2 => [width - sx * px, height - sy * py],
                _ => [sx * py, height - sy * px],
            }
        };
        let mut ops = Vec::with_capacity(9);
        for corner in 0..4 {
            let center = rotate(corner, r, r);
            if r > 0.0 {
                let (start, end) = (rotate(corner, 0.0, r), rotate(corner, r, 0.0));
                ops.push(if corner == 0 { PathOp::Move { to: start } } else { PathOp::Line { to: start } });
                let [c1, c2] = bezier_arc_control(start, center, end);
                ops.push(PathOp::Cubic { c1, c2, to: end });
            } else {
                ops.push(if corner == 0 { PathOp::Move { to: center } } else { PathOp::Line { to: center } });
            }
        }
        ops.push(PathOp::Close);
        Geometry::Path { ops }
    }

    /// Control points of a cubic Bézier approximating the circular arc from `start` to `end` around `center`.
    fn bezier_arc_control(start: [f64; 2], center: [f64; 2], end: [f64; 2]) -> [[f64; 2]; 2] {
        let a = [start[0] - center[0], start[1] - center[1]];
        let b = [end[0] - center[0], end[1] - center[1]];
        let q1 = a[0] * a[0] + a[1] * a[1];
        let q2 = q1 + a[0] * b[0] + a[1] * b[1];
        let k2 = (4.0 / 3.0) * ((2.0 * q1 * q2).sqrt() - q2) / (a[0] * b[1] - a[1] * b[0]);
        [
            [center[0] + a[0] - k2 * a[1], center[1] + a[1] + k2 * a[0]],
            [center[0] + b[0] + k2 * b[1], center[1] + b[1] - k2 * b[0]],
        ]
    }

    /// Whether two paths are the same within `eps` per coordinate.
    pub fn same_ops(a: &[PathOp], b: &[PathOp], eps: f64) -> bool {
        let close = |p: &[f64; 2], q: &[f64; 2]| (p[0] - q[0]).abs() <= eps && (p[1] - q[1]).abs() <= eps;
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| match (x, y) {
            (PathOp::Move { to: p }, PathOp::Move { to: q }) | (PathOp::Line { to: p }, PathOp::Line { to: q }) => close(p, q),
            (PathOp::Cubic { c1: a1, c2: a2, to: p }, PathOp::Cubic { c1: b1, c2: b2, to: q }) => close(a1, b1) && close(a2, b2) && close(p, q),
            (PathOp::Close, PathOp::Close) => true,
            _ => false,
        })
    }

    /// A geometry as absolute path operations, for comparing shapes: a rectangle becomes its four sides.
    pub fn ops_of(geometry: &Geometry, x: f64, y: f64) -> Vec<PathOp> {
        let shift = |p: &[f64; 2]| [p[0] + x, p[1] + y];
        match geometry {
            Geometry::Rect { width, height } => vec![
                PathOp::Move { to: [x, y] }, PathOp::Line { to: [x + width, y] }, PathOp::Line { to: [x + width, y + height] }, PathOp::Line { to: [x, y + height] }, PathOp::Close,
            ],
            Geometry::Line { to } => vec![PathOp::Move { to: [x, y] }, PathOp::Line { to: shift(to) }],
            Geometry::Path { ops } => ops.iter().map(|op| match op {
                PathOp::Move { to } => PathOp::Move { to: shift(to) },
                PathOp::Line { to } => PathOp::Line { to: shift(to) },
                PathOp::Cubic { c1, c2, to } => PathOp::Cubic { c1: shift(c1), c2: shift(c2), to: shift(to) },
                PathOp::Close => PathOp::Close,
            }).collect(),
        }
    }

    /// Where `image.rs::layout_image` puts an image of `px_w` × `px_h` pixels into a box of `width` × `height`
    /// with both sides forced: `[x, y, w, h]` relative to the box. `cover` and `contain` keep the pixel aspect
    /// ratio and centre the image; `stretch` fills the box.
    pub fn fit_image(fit: &str, width: f64, height: f64, px_w: f64, px_h: f64) -> Result<[f64; 4], String> {
        let px_ratio = px_w / px_h;
        let wide = px_ratio > width / height;
        let (w, h) = match fit {
            "cover" | "contain" => if wide == (fit == "contain") { (width, width / px_ratio) } else { (height * px_ratio, height) },
            "stretch" => (width, height),
            other => return Err(format!("unknown image fit {other:?} (cover, contain or stretch)")),
        };
        Ok([(width - w) / 2.0, (height - h) / 2.0, w, h])
    }
}
