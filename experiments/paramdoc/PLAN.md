# Paramdoc: parametric documents from Typst frames

An experiment, not a Typfolio package. Question: what is the smallest runtime that can finish a document
Typst has already laid out, so that the browser no longer needs the 24 MB compiler for documents whose
data only fills declared holes?

## Principle

The runtime only does trivial geometry or selects among variants the exporter already validated.
Translation, stacking, page breaking, picking variant two of three. Never a layout decision Typst did not make.

## Architecture

```
 build time (native Rust, links typst as a library)        runtime (Rust first, TypeScript later)
 ┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │ template + sample data ─▶ typst::compile      │  IR      │ IR + data ─▶ fill slots ─▶ PDF bytes  │
 │ PagedDocument frames ─▶ exporter:             │ ───────▶ │ text→glyphs (cmap + advances)        │
 │   static items, slot table, fonts, (bands)    │  JSON    │ pdf-writer, no typst, no shaping     │
 │ fuzz the data, diff the frames ─▶ leak check  │          └──────────────────────────────────────┘
 └──────────────────────────────────────────────┘
```

- `ir/`: the parametric document format shared by both sides (serde).
- `export/`: in-memory `World`, compile, frame walk, slot detection, fuzz-and-diff isolation check, baseline PDF via typst-pdf.
- `runtime/`: composes IR with data and writes PDF. Milestone 2 onwards.
- `fixtures/`: templates written in the slot dialect (`paramdoc.typ`).

The dialect is plain Typst from a helper file, no Rust patches: a `slot` is a fixed-size clipped `box` carrying a
labelled `metadata`; the exporter finds it through the frame's tags and the enclosing clipped group.

## Milestones and exit criteria

1. **Exporter and isolation check.** Dump frames and slot geometry for the certificate fixture; fuzz the data
   N times and prove nothing outside the slots moves. Exit: `doc.json` with correct slot rects, zero leaks on
   the fixture, and a deliberate leak (an `auto`-width slot) detected. ✅
2. **Runtime, static pages and text slots.** ✅ Latin only, no tagging. Exit: for the same data, glyph positions
   from the runtime equal Typst's own frames (kerning and ligatures off inside slots), and the PDF opens.
3. **Bands and pagination.** Repeating rows, header repetition, page numbers. ✅
4. **Tagging.** Structure tree assembly; checked with the repo's `inspectPdf`, veraPDF not reachable from this container. ✅
5. **TypeScript port** of the runtime against the Rust implementation as oracle. ⟵ next

Re-evaluate after each milestone; stop and discuss on critical findings.

## Running

```sh
cd experiments/paramdoc
cargo run -p paramdoc-export -- fixtures/certificate --fuzz 200      # exit 0: no leaks
cargo run -p paramdoc-export -- fixtures/leak --fuzz 20              # exit 1: the auto-width slot leaks
cargo run -p paramdoc-export -- fixtures/certificate --reference fixtures/certificate/data.json   # + reference.{json,pdf}
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/certificate --data fixtures/certificate/data.json \
  --out ../../.build/paramdoc/certificate/runtime.pdf --expect ../../.build/paramdoc/certificate/reference.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/policies --data fixtures/policies/data-long.json --out ../../.build/paramdoc/policies/long.pdf
# flow document: 3 sample rows checked against Typst, then 42 rows paginated by the runtime
cargo run -p paramdoc-export -- fixtures/transcript --fuzz 100 --reference fixtures/transcript/data.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/transcript --data fixtures/transcript/data.json \
  --out ../../.build/paramdoc/transcript/runtime.pdf --expect ../../.build/paramdoc/transcript/reference.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/transcript --data fixtures/transcript/data-long.json --out ../../.build/paramdoc/transcript/long.pdf
# benchmark fixture (the worker-batch report) and the 1000-document benchmark, native and as wasm in Node
cargo run -p paramdoc-export -- fixtures/report --fuzz 100 --reference fixtures/report/data.json
node --experimental-strip-types <scratch>/gen-inputs.mjs 1000 ../../.build/paramdoc/bench/inputs.json   # from examples/pretext-hybrid/src/batch/data.ts
cargo run --release -p paramdoc-runtime -- bench ../../.build/paramdoc/report --inputs ../../.build/paramdoc/bench/inputs.json
cargo rustc --release -p paramdoc-runtime --lib --crate-type cdylib --target wasm32-unknown-unknown
node <scratch>/bench-wasm.mjs ../../.build/paramdoc-target/wasm32-unknown-unknown/release/paramdoc_runtime.wasm ../../.build/paramdoc/report ../../.build/paramdoc/bench/inputs.json
```

The benchmark scripts (`gen-inputs.mjs`, `bench-wasm.mjs`, `bench-browser.mjs`, `inspect.mjs`) are in `notes/bench/`.

Defaults: fonts from `../../fixtures/fonts`, output under `../../.build/paramdoc/<fixture>/` (`doc.json`, `baseline.pdf`,
`fonts/`, and `fuzz-0.{json,pdf}` for the first fuzzed sample).

## Status log

- **M4 done.** The exporter follows Typst's element tags through the frame walk with a stack, as typst-pdf does:
  headings (H1–H6 from the resolved level), paragraphs, `table` → Table with TR rows synthesised from the cells'
  row index, TH (with scope) or TD from the cell kind, figures and images with alt text, lists; `pdf.artifact`
  (which Typst puts around page headers and footers), hidden content and repeated table headers are artifacts;
  everything else is transparent. Every text, shape and image item and every slot now carries its node; shapes
  are artifacts unless inside a figure. Each page or fragment carries its node list, localised so parents come
  before children. The runtime instantiates a fragment's nodes under the Document root when it places it, merges
  the one-row tables of a repeat region's bands into one Table (first header row as TH, repeats and overlays as
  artifacts), emits marked content with MCIDs (closed around q/Q), writes the structure tree, parent tree,
  MarkInfo, language, DisplayDocTitle, XMP with `pdfuaid:part 1` and ToUnicode CMaps (ligatures mapped from the
  glyph's characters). IR v3. Fixtures: all three still match Typst glyph for glyph and pixel for pixel.
  `inspectPdf` on the benchmark report: tagged, Document/H1/H2×2/P×3/Table/TR×6/TH×4/TD×20, title, lang `en`,
  pdfUa 1, headings with text; `pdftotext` extracts the text including ligatures. Typst's own PDF of the same
  sample has six one-row tables, the runtime's has one: the merged table is the better structure.
  Not done: veraPDF conformance (software.verapdf.org and GitHub releases are blocked by the proxy, and the
  Maven Central listings for the CLI module returned nothing), links and annotations, figures with real images,
  Lbl/LBody for list numbers, `/Tabs`, reading-order checks. "Tagged and labelled PDF/UA" here means the
  structure was built and inspected, not that a validator passed.
  Findings: the transcript's `grid` bands had no structure at all (grid is layout, not semantics); bands must use
  `table`. ToUnicode entries came out of a hash map in random order and made the wasm and native PDFs differ
  in bytes; sorted, the two outputs are byte-identical.

### Performance against the worker-batch benchmark (M4 checkpoint)

Same machine for every row: this 4-core container. The Typst rows are the repo's own `/performance` page
(`examples/pretext-hybrid`, Vite dev server, headless Chromium through Playwright, `?workers=N&count=1000&autostart`),
whose elapsed time includes the compiler download, module compilation and worker start, as the page states.
The paramdoc rows render the same 1000 synthetic inputs (generated by the benchmark's own `data.ts`) through
`fixtures/report`, which is that report in the slot dialect: the same text, boxes and table, but a static title,
a one-line tutor comment, no score bars and no alternating row fill (the dialect cannot express those), with
tagged output. So the documents are close, not identical.

| | documents/s | per document | notes |
|---|---:|---:|---|
| Typst compiler (WASM) in Chromium, 4 workers | 50.4 | 19.9 s / 1000 | repo benchmark, 1000 PDFs |
| Typst compiler (WASM) in Chromium, 1 worker | 25.5 | 39.2 s / 1000 | repo benchmark, 1000 PDFs |
| paramdoc runtime, wasm32 in Node (V8), 1 thread | 420–445 | median 2.0 ms, p95 3.2 ms | three runs; fonts parsed once (27–41 ms) |
| paramdoc runtime, native release, 1 thread | 490–650 | median 1.4 ms, p95 2.3 ms | three runs; setup 6 ms |

Payloads: compiler 24.4 MB (8.95 MB gzip) against runtime 1.12 MB (403 kB gzip) plus `doc.json` and fonts.
Output: 23.9 kB per tagged report. On one thread the runtime is about 17x the single-worker compiler and
about 8.5x the four-worker pool, before any size or speed work on the runtime.

- **M3 done.** Dialect: `paged(margin:, footer:)` records the flow area in the page foreground, `band(name, body,
  repeat-on-break:)` is a clipped block, `repeat(name, rows, make)` emits one band per sample row, `overlay(body)`
  marks per-page content with `page-number` / `page-count` counter slots. Exporter: flattens the single sample
  page into atoms (unclipped translation-only groups are inlined, clipped or transformed groups stay whole),
  classifies atoms as band, overlay or static by their tag, sorts by y and segments into static blocks (items
  relative to the block top, height = distance to the next region), repeat regions (header band, row band, row
  gap, header gap) and overlays; checks that all row instances have one size and gap. IR v2 adds `flow`.
  Runtime: stacks blocks, breaks a page when a row or block does not fit, repeats the header band, fills
  overlays with counters in a second pass.
  Transcript fixture: with the 3 sample rows the runtime equals Typst glyph for glyph and pixel for pixel at
  150 dpi; with 42 rows it writes 2 pages (17.8 kB) with the header repeated and "Page 2 of 2"; composition
  takes 0.5–5 ms, the rest of the ~50 ms is font parsing in a debug build. Fuzz with 1–6 rows and random
  strings: 0 leaks in 100 samples. Certificate and leak fixtures unchanged.
  Findings that changed the design:
  - Typst's optical margin alignment (`text.overhang`) lets trailing punctuation hang into the margin even in
    unjustified text, so a centred "A-" sat 1 pt right of the runtime's position. Slots set `overhang: false`.
    Found by the reference comparison.
  - Slots bind to data by name, so a slot's name must equal its data key (`total_credits`).
  - Static blocks must take slots from a half-plane starting at x = 0, not from a sentinel rectangle, or slot
    x positions pick up the sentinel.

### Size and speed of the runtime (release profile: opt-level s, fat LTO, panic abort, stripped)

The runtime is now a library (`paramdoc_runtime::fill(doc_json, fonts, data_json)`) with a C ABI
(`paramdoc_fill` / `paramdoc_alloc` / `paramdoc_free`) and a thin CLI. Built as a wasm32 cdylib through that
ABI, with nothing yet done to shrink it:

| | raw | gzip -9 |
|---|---:|---:|
| paramdoc runtime, wasm32 | 1,059,023 B | 382,344 B |
| Typfolio's Typst compiler, wasm32 (for comparison) | 24,404,191 B | 8,951,728 B |

About 23x smaller before any size work; the heavy parts are the CFF subsetter, ttf-parser and serde_json.
Native release timings for a complete fill, fonts parsed and subset included: certificate 9 ms, 42-row
transcript 8 ms. (An earlier 77 kB figure from building the CLI binary for wasm32 was wrong: `std::env::args`
is empty on that target, so the optimiser removed the entire runtime as dead code.)

### Re-evaluation after M4

The remaining Typst-less gap is validation, not construction: the structure is there and inspectable, but
PDF/UA conformance needs veraPDF, which this container cannot download. The TypeScript port (M5) is now a
transcription job with three oracles: the Rust runtime's bytes (deterministic), Typst's layout and the pixel
diff. The runtime's wasm size doubled with pdf-writer's structure code and the ToUnicode maps and is still
under 1.2 MB; serde_json, the CFF subsetter and ttf-parser are the places to look if it has to shrink.

### Re-evaluation after M3

Demonstrated: for documents made of fixed slots and fixed-height repeating rows, a runtime with no typesetter
reproduces Typst's output exactly, paginates, and is small (see the size figures below). The exporter's
fuzz-and-diff check is the safety net that makes the dialect honest; it found three real leaks so far.
Not demonstrated, in order of risk: tagged PDF and PDF/UA (M4), complex scripts (the runtime has no shaper),
variable-height rows (needs variants), images and links (recorded, not drawn), font subsetting at export time
for the browser payload, and the TypeScript port (M5).

### M4 design (tagging)

Typst frames carry `Tag::Start`/`Tag::End` items for every element, so the exporter can emit per fragment a
structure skeleton: a tree of element kinds (heading level, paragraph, table, row, cell, figure with alt text)
whose leaves reference the items they cover. The runtime assigns marked-content ids per page while emitting,
wraps covered items in `BDC`/`EMC`, builds the structure tree, parent tree, `MarkInfo`, language, title and
ToUnicode CMaps (needed for text extraction anyway), and for repeat regions assembles `Table` → `TR` → `TH`/`TD`
from the header and row fragments. Check: `inspectPdf` from `@typfolio/dev-tools` on the runtime's PDFs
against Typst's, then veraPDF for conformance (not installed in this container).

- **M2 done.** `runtime/` reads `doc.json` and the fonts, maps slot text to glyphs through the font's cmap and
  advances it with `hmtx`, applies alignment and the overflow policy (`error`, `clip`, `shrink`, `ellipsis`),
  validates `max-length` before layout, and writes the PDF with pdf-writer: static items as exported, slot
  text clipped to its box, fonts subset to the glyphs used (subsetter) and streams Flate-compressed.
  For the certificate data the runtime's glyph ids and positions equal Typst's own layout of the same data
  (`--expect reference.json`, tolerance 1e-3 pt) and the two PDFs rasterise to **identical pixels at 150 dpi**.
  Sizes: runtime PDF 15.0 kB, Typst's 17.8 kB. Fill time ~70 ms in a debug build, almost all of it font
  parsing; the PDF itself is written in a few ms.
  Findings that changed the design:
  - The first pixel diff showed Typst clipping the descenders of slot text: the box ended at the baseline. Slots
    now keep a `descent` (default 0.25em of the slot's text size) below the baseline, carried in the metadata,
    and the runtime clips to the box exactly as Typst does. The exporter's contract is
    `baseline = box bottom - descent`.
  - `em` lengths in the dialect are now relative to the slot's own text size, so an 18 pt slot in an 11 pt
    paragraph gets an 18 pt descent allowance.
  - What ships to a browser for this document today: `doc.json` 22 kB plus the three full font files (1 MB).
    The exporter should subset fonts to a declared slot repertoire; not done yet.

### M3 design (bands and pagination)

The fixed-page model becomes a flow of blocks. The dialect adds `band(name, body)`, a clipped block the
exporter extracts as a fragment with its own slots (positions relative to the band), `repeat(name, rows, row =>
band(...))` for the sample rows, `overlay(body)` for per-page content such as a footer with `page-number` and
`page-count` slots, and `pages(margin: ...)` metadata so the runtime knows the flow area. The exporter segments
the sample document by y into static blocks, repeat regions and overlays; everything after a repeat region is
stored relative to the region's end. The runtime stacks blocks, breaks pages when a row does not fit, repeats
a band flagged `repeat-on-break` (table headers) and fills page counters in a second pass. Row heights are fixed
in M3; height variants come later. Fuzz check extended: the row count is fuzzed too, and the leak check compares
the fragments and the per-block offsets instead of absolute pages.

- **M1 done.** Exporter walks the frames, finds slots through their `metadata` tag and the enclosing clipped
  group, exports static items, fonts and slot geometry; `baseline.pdf` from typst-pdf; fuzz-and-diff check.
  Certificate fixture: 0 leaks in 700 samples (two seeds); `fixtures/leak` (one `width: auto` slot): 20/20
  samples flagged, naming the slot's width and every item that shifted after it. One compile is ~40 ms, so a
  500-sample check takes ~10 s.
  Findings that changed the design:
  - A box's baseline follows its content by default, so a wrapped sample moved every line below the slot by
    1.6 pt. The dialect now pins it with `box(baseline: bottom)` (Typst 0.15 feature). The check found this.
  - Slot membership must come from the frame hierarchy, not geometry: a run that starts exactly at a slot's
    right edge is otherwise mistaken for slot content.
  - The slot's baseline is defined by geometry (box bottom), not by the sample; the sample only supplies the
    style and is checked against the contract (a wrapped sample triggers a warning).
  - An empty sample shows no style and references no font, so the contract view resolves font indices to font
    identities and the font table is excluded from the comparison.
