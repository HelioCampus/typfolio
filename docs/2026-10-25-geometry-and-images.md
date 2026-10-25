# Bars and image slots: parametric geometry and pictures without the compiler

Implementation notes for the third expressiveness milestone (M9) of the paramdoc experiment on `feat/paramdoc`,
written the same day as the wrapping-slot and variant notes (`2026-10-25-wrapping-slots.md`,
`2026-10-25-variants.md`). Same experiment: a browser runtime fills a document Typst laid out once, so the 24 MB
compiler is not shipped, and every runtime PDF must equal Typst's own layout of the same data.

## The problem

Two things the repository's own templates do were impossible. The demo report draws a score bar per course, a
filled rounded rectangle whose length is the score: geometry that depends on the data, which the runtime could
not produce because it may only do trivial geometry or pick among things Typst already produced. And the
outcomes template shows a chart per section that the application renders to a PNG and passes as data, plus a
logo: images, which the exporter recorded and neither runtime drew. Both are data-dependent content that is not
text, so the question was whether the "Typst lays out, the runtime fills" split holds for them with the same
guarantee as for text: the runtime's output equals Typst's, checked by compiling the same data.

## What was built

- **Dialect** (`fixtures/*/paramdoc.typ`): `bar(name, value, max:, width:, height:, fill:, track:, radius:)`
  is a clipped box whose own fill is the track and whose content is one `rect` of `value / max` (clamped to 0..1)
  of the box width, placed top-left. `image-slot(name, value, width:, height:, alt:, fit:)` is a clipped box with
  one `image` filling it; `value` is a data URL or `(src: …, alt: …)`, and the data's `alt` is what Typst shows.
  The metadata carries the template's `alt` only.
- **IR v7** (`ir/`): `Bar` and `ImageSlot` holes next to `Slot` on fragments and fixed pages; `ImageFile` entries
  for the raster images the static content draws, shipped next to the fonts; and a `geometry` module with the two
  ports the runtimes draw by: `rounded_rect` (Typst's `styled_rect` for a fill without stroke) and `fit_image`
  (Typst's `layout_image` with both sides forced).
- **Exporter** (`export/`): turns every `data:image/…;base64,…` string in the data into a virtual file for Typst,
  so one data file serves the sample compile and the runtime; records the shape inside a bar box and the image
  inside an image box as the hole's content, not as static items; checks on *every* compile (sample, references
  and fuzz samples) that Typst's bar shape equals `rounded_rect` of the metadata's value and that Typst placed the
  image where `fit_image` puts it, which tests both ports on hundreds of random widths and image sizes; writes
  static raster images to `images/`; refuses SVG (no renderer in the runtimes). The fuzz replaces image strings
  with random PNGs of random size and colour type, and keeps half the numbers in a bar's usual range.
- **Runtimes** (`runtime/src/lib.rs`, `ts/runtime.ts`): draw bars by regenerating Typst's rounded rectangle; place
  images by the fit port; decode PNG (8-bit, every colour type, palettes expanded, `tRNS` as alpha) and read JPEG
  headers; embed images as Typst's PDF writer does (deflated 8-bit grey or RGB samples, a soft mask only when some
  pixel is not opaque, JPEG data as it is), so the pages render identically; draw the static images too; cache
  decoded images per runtime; set the Figure's alternative text from the data and refuse an image without one.
  The traces carry a bar's absolute path and an image's placed rectangle, and `compare` checks them.
- **Fixtures**: the report's score bars are back (a `bar` per row, two variants striped); `figures`, an
  outcomes-style page with a palette-PNG logo (static), a chart drawn on a canvas in Chromium exactly as the demo
  application draws charts (8-bit RGBA, transparent background) in a `cover` slot, a JPEG in a `contain` slot and a
  grey PNG with a transparency key in a `stretch` slot; a second data file swaps in a tall PNG, the chart as JPEG
  and a one-pixel image. `notes/make-figure-images.mjs` makes the images and the data files.
- **Proof** (`check.sh`): the figures fixture joins the per-case references, pixel comparisons, text extraction,
  an image count with `pdfimages` and veraPDF.

## What had to be learned

- **Where Typst puts a box's fill.** `layout_box` wraps the content in the clip group first and prepends the fill
  shape outside it. So the bar's track is static content the exporter keeps, and only the inner rectangle is the
  hole's content. Nothing had to be invented for the track.
- **Typst's rounded rectangle.** For a fill without stroke, `styled_rect` draws a plain rectangle when the
  declared radius is zero and otherwise the fill curve of `segmented_rect`: the radius capped at half the shorter
  side, each corner an arc from `(0, r)` to `(r, 0)` around `(r, r)` rotated into place, each arc one cubic Bézier
  from `bezier_arc_control`. A zero-width bar with a declared radius is a degenerate path, not nothing. The port is
  forty lines, and the exporter compares it with Typst's own curve on every compile, within 1e-6 pt.
- **Typst's image placement.** With both sides forced, `cover` and `contain` scale by the aspect ratio
  (`wide == (fit == contain)` picks the axis), the image is centred by `frame.resize`, and `cover` adds a clip. The
  runtime draws into the box's clip anyway, so the nested clip changes nothing.
- **How krilla embeds raster images.** Everything becomes 8-bit grey or RGB plus an optional alpha channel; the
  soft mask is written only when some alpha differs from 255; JPEGs pass through. Matching that made the pages
  pixel-identical at 150 dpi, including the transparent chart and the colour-keyed icon.
- **A bar tagged as an artifact empties its table cell.** Shapes were artifacts unless inside a Figure, so the
  score-bar cells had no tagged content, were dropped from the structure, and veraPDF failed rule 7.2-43 (rows
  with fewer cells than the header). Bars are now content of the node they sit in; the cell keeps its kid.
- **Alternative text and the fuzz.** The first dialect copied the data's `alt` into the metadata, so every fuzz
  sample looked like a leak (the Figure node's `alt` changed). The metadata carries the template's default; the
  runtime sets the data's at fill time.
- **Images in data.** The runtime gets a data URL (or bytes, in TypeScript); Typst needs a file. The exporter
  rewrites the data for Typst and keeps the original for the runtime, so there is still one data file per case.
- **Erasable TypeScript** has no parameter properties; `DecompressionStream` inflates PNG data asynchronously,
  which is fine because `fill` was already asynchronous; the Rust runtime inflates with `flate2`, which it had for
  deflating.

## Verification

Both runtimes against Typst's layout of the same data: glyph ids and positions, bar paths and image rectangles
within 1e-3 pt, then pixels at 150 dpi, then the Rust trace against the TypeScript trace:

| Check | Result |
|---|---|
| report with score bars (five bars per sample, two striped variants) | bar paths identical to Typst's; 1 pixel differs (the report's known one) |
| figures, autumn data (RGBA chart with transparency, JPEG, keyed grey icon, palette logo) | pixel-identical to Typst, both runtimes |
| figures, spring data (tall PNG under `cover`, JPEG under `contain`, one pixel under `stretch`) | pixel-identical to Typst, both runtimes |
| bar port against Typst on every fuzz sample of the report | 0 differences on 30 random value sets |
| image port against Typst on every fuzz sample of figures | 0 differences on 40 random images per slot |
| fuzz, every fixture | 0 leaks |
| veraPDF PDF/UA-1 on the report and both figures cases, both runtimes | PASS |
| `check.sh` | 96 checks: 95 passed, 0 failed, 1 skipped (the demo step without a server) |
| demo page, paramdoc engine, 200 striped reports with bars on 4 workers | all rendered |
| Rust runtime as wasm32 (release profile), with PNG decoding on board | 648 kB raw, 230 kB gzip |

## Covered now, with examples

- The report's score bar per course, exactly Typst's rounded rectangle for scores from 0 to 100, over a static track.
- A chart the application drew on a canvas, dropped into the page as the data's PNG with its transparent background
  kept, cropped to the slot as `cover` crops it, with the alternative text the data supplied.
- A photograph as a JPEG letterboxed into a box of another aspect ratio (`contain`), a small icon stretched to a
  square, a one-pixel image, a tall gradient cropped top and bottom.
- A logo in the template as a palette PNG, drawn from the shipped image file.
- An image without alternative text is refused, as PDF/UA would refuse the document.

## Open

- **Hyperlinks** (Typst's link items are still dropped at export) and **SVG images** (the shared header of
  `examples/vite-react` uses an SVG logo; the exporter refuses SVG because the runtimes have no renderer). Both
  are the rest of the images-and-links item; rasterizing a logo to PNG is the workaround for now.
- **PNG and JPEG limits.** 16-bit, interlaced and sub-8-bit PNGs, CMYK and lossless or arithmetic JPEGs are
  refused with a message. A JPEG with an EXIF orientation is drawn as stored, where Typst would rotate it.
  `image(scaling: "smooth")` (`/Interpolate`) is not reproduced.
- **Bars** are left-aligned, filled, unstroked, with one uniform radius; a right-aligned or stroked bar, or one
  thinner than its track, would be more metadata and another check.
- **Image slots** need a fixed width and height; an `auto` side would leak the image size into the layout (the
  fuzz would say so).
- **The wasm C ABI** takes fonts but no image files yet, so a document with static images cannot be opened
  through `paramdoc_open`; the Rust and TypeScript APIs can.
- **Decoding cost.** A distinct PNG costs an inflate, an unfilter and two deflates per runtime (cached after
  that); for a chart per document this is a few milliseconds in TypeScript. If it matters, opaque PNGs could pass
  their compressed scanlines through with a PNG predictor instead.

## How to run it

```sh
cd experiments/paramdoc && ./check.sh             # the whole proof; FUZZ=20 ./check.sh is quicker
cargo run -p paramdoc-export -- fixtures/figures --fuzz 40 --reference fixtures/figures/data.json --reference fixtures/figures/data-tall.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/figures --data fixtures/figures/data.json --out /tmp/figures.pdf --expect ../../.build/paramdoc/figures/reference.json
node experiments/paramdoc/notes/make-figure-images.mjs    # from the repository root: remakes the fixture images and data files
```
