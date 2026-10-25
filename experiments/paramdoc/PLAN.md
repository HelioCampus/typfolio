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
- `runtime/`: composes IR with data and writes PDF (Rust; also the wasm32 build with a C ABI).
- `ts/`: the same runtime in dependency-free TypeScript, for browsers; the Rust runtime is its oracle.
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
4. **Tagging.** Structure tree assembly; checked with the repo's `inspectPdf` and, since 2026-10-24, with veraPDF: PDF/UA-1 passes on every runtime PDF. ✅
5. **TypeScript port** of the runtime against the Rust implementation as oracle. ✅
6. **Export-time font subsetting.** Fonts subset to the static glyphs plus a declared slot repertoire; runtimes parse no fonts. ✅
7. **Wrapping text.** Multi-line slots that break lines the way Typst does. Exit: the report's tutor comment
   as a three-line slot and a `wrap` fixture match Typst glyph for glyph on every data file, pixels included. ✅
   (2026-10-25; also 300 random texts, both runtimes.)
8. **Variants.** Bands and blocks laid out once per variant at export time, picked by the runtime: variable-height
   rows, optional blocks, row stripes. Exit: a transcript with one-to-three-line titles paginates and matches Typst per variant. ✅
   (2026-10-25; the report stripes and the transcript's optional block too.)
9. **Parametric geometry and image slots.** A bar whose length is a value; a box the data fills with an image.
   Exit: the report's score bars are back and match Typst; an image fixture passes veraPDF's Figure rules.

Re-evaluate after each milestone; stop and discuss on critical findings.

## Expressiveness plan (M7–M9)

Written 2026-10-25 from the ranked list of unknowns. The three items below are the ones that decide whether the
approach covers real documents; everything after them is known work. What the repository's own templates ask
for, counted before planning (`examples/pretext-hybrid/src/batch/report`, `examples/vite-react/src/{outcomes,report,common}`):
wrapping paragraphs from data in every template, all justified; images (a logo; charts the application renders
to PNG at 480 × 160 px with `render()` and passes as data, in `outcomes`); a bulleted list; document titles from
data; one repeat of variable-height sections; a score bar and alternating row fill; values computed in the
template. No conditionals. So charts already arrive as images in this repository, and the first cut of wrapping
text is ragged right: justification needs Typst's optimized breaker, which is a later milestone if ragged slots
are not acceptable.

### M7: wrapping text

Result (2026-10-25): built as designed below, with three corrections the oracle forced; see the status log. The
rule set icu4x applies is not the one planned here, the line heights of whitespace-only lines and the shrinking
of spaces on overlong lines had to be copied too, and `calt` had to be switched off along with ligatures.

What Typst does, read from `typst-layout 0.15.1` (`inline/linebreak.rs`, `line.rs`, `shaping.rs`, `flow/collect.rs`):

- `par.linebreaks: auto` resolves to the simple breaker when `justify` is off. The simple breaker is greedy
  first fit: for each break opportunity it measures the line from the current start, with trailing whitespace
  and default-ignorables excluded from the width; when the line no longer fits (`Abs::fits`, an epsilon of slack)
  and an earlier opportunity fitted, that one becomes the line and measuring restarts after it; a mandatory
  break (`\n`, end of text) or a line that does not fit even as the first candidate is committed as it is. An
  overlong word is therefore placed uncut and overflows.
- Break opportunities come from icu4x's UAX #14 segmenter, plus hyphenation candidates when `hyphenate` is on
  (`auto` means on only when justified), plus special breaking inside text that contains `://` or starts with
  `www.`.
- Trailing whitespace glyphs are shaped and emitted with zero advance and offset at the end of the line
  (`Glyphs::trim`, `ShapedText::build`), so they are in the frame and in the PDF for copy and paste.
- Lines are frames of height top-edge + bottom-edge metric (cap height with the dialect's edges), stacked with
  `par.leading` between them; each line is aligned inside the paragraph width by `align`.

Design:

- Dialect: `slot(..., lines: n)`. `lines: 1` is today's bottom-pinned single line. `lines: n > 1` makes a box of
  height `n · lh + (n − 1) · leading + descent`, with the paragraph aligned to the top and these rules inside:
  `par(justify: false, linebreaks: "simple", first-line-indent: 0pt, hanging-indent: 0pt)`,
  `text(hyphenate: false, kerning: false, ligatures: false, overhang: false, bottom-edge: "baseline")`. The
  metadata carries `lines` and `pitch` (`lh + leading`), both measured in Typst with `measure` and `par.leading`.
- IR v5: `Slot.lines`, `Slot.pitch`; for a multi-line slot `baseline` is the first line's. Reference glyphs
  carry `y` (their line's baseline) and the comparison checks it.
- Exporter: records the sample's lines (one baseline per line, glyph x and y), checks the baselines sit at
  `first + k · pitch`, and rejects `overflow: "shrink"` on multi-line slots. `--reference` becomes repeatable so
  one export checks several data files (`reference.json` for the first, `reference-<stem>.json` after).
- Runtime: break opportunities for the repertoire: mandatory after `\n`; a UAX #14 pair table for the classes
  the Latin repertoires contain (space, hyphen, dashes, slash, quotes, brackets, punctuation, digits, letters,
  zero-width space); text containing `://` or `www.` is refused in multi-line slots until link breaking is
  ported. Greedy first fit as above, trailing spaces at zero advance, per-line alignment on the trimmed width.
  Over `lines`: `error`, `clip` (drop the rest), `ellipsis` (truncate the last line). The structure node is one
  P or TD as today; marked content covers all lines.
- Both runtimes; TypeScript first because the design may still move, Rust once it holds.

Exit: `fixtures/wrap` (left, centre and right slots; data files with a newline, a hyphen, an en dash, a long
word, double and trailing spaces, an empty value, exactly `lines` lines, one line too many under each overflow
policy) and the report's three-line tutor comment match Typst's layout of every data file glyph for glyph and
pixel for pixel; fuzz 0 leaks; the two runtimes agree; veraPDF PDF/UA-1 still passes.

### M8: variants

Result (2026-10-25): built as designed, with `make(row, v)` handing the variant to the row closure and a Typst
`state` telling a `lines: auto` slot its band; see the status log and `docs/2026-10-25-variants.md`.

A band or static block declared with variants is laid out once per variant at export time; the runtime only
picks. The exporter compiles the fixture once per variant value with `sys.inputs` carrying
`paramdoc-variant=<block>=<k>`; the dialect's `variant(block, default: 1)` reads it, so a template writes
`slot("title", row.title, lines: variant("courses"))` or `fill: if calc.even(variant("courses")) {...}`. The IR
band holds one fragment per variant value plus a selector: `lines(slot)` (the runtime measures how many lines
the slot's text needs and picks that variant), `parity` (row index), `flag(path)` (a boolean in the data; an
absent block is a zero-height variant). The fuzz-and-diff runs per variant; pagination already measures per
instance. Exit: transcript rows with one-to-three-line titles, report rows with stripes, an optional block in the
certificate, each matching Typst for its variant's sample; long data paginates; veraPDF passes.

### M9: parametric geometry and image slots

- `bar(name, value, max: 100, width, height, fill, track, radius)`: a slot whose content is a track rectangle and
  a bar rectangle; the exporter records both and that the bar's width is `value / max` of the track's; the
  runtime draws them. The report gets its score bars back.
- `image-slot(name, width, height, alt)`: a fixed box the data fills with a PNG or JPEG (bytes or a data URL),
  tagged Figure with the alt text; charts arrive this way, as `examples/vite-react` already does. This is the
  first half of the images-and-links item.
- Real charts drawn by the runtime are out: that is a chart engine, and the application already has one.

Exit: the report with bars matches Typst for the sample; an outcomes-like fixture with image slots passes veraPDF;
fuzz 0 leaks.

## Running

```sh
cd experiments/paramdoc
./check.sh                                                           # the whole proof: 42 checks, under a minute
cargo run -p paramdoc-export -- fixtures/certificate --fuzz 200      # exit 0: no leaks; writes doc.json and fonts/*.subset.*
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

The benchmark scripts (`gen-inputs.mjs`, `bench-wasm.mjs`, `bench-browser.mjs`, `bench-ts.html`, `bench-ts-browser.mjs`,
`inspect.mjs`) are in `notes/bench/`.

TypeScript runtime (Node 22, no build step):

```sh
node --experimental-strip-types ts/cli.ts ../../.build/paramdoc/report --data fixtures/report/data.json \
  --out ../../.build/paramdoc/report/runtime-ts.pdf --expect ../../.build/paramdoc/report/reference.json \
  --expect-rust ../../.build/paramdoc/report/runtime.trace.json
node --experimental-strip-types ts/cli.ts bench ../../.build/paramdoc/report --inputs ../../.build/paramdoc/bench/inputs.json
npx esbuild ts/runtime.ts --bundle --format=esm --minify --outfile=<dir>/runtime.js   # then notes/bench/bench-ts.html next to doc.json, fonts/, inputs.json
```

Defaults: fonts from `../../fixtures/fonts`, output under `../../.build/paramdoc/<fixture>/` (`doc.json`, `baseline.pdf`,
`fonts/`, and `fuzz-0.{json,pdf}` for the first fuzzed sample).

## Status log

- **M8 variants (2026-10-25).** A band declares `variants: n` and a selector; the exporter compiles the fixture
  once more per variant with `sys.inputs.paramdoc-variant = "<band>=<k>"` (every instance forced to k), checks the
  forced document equals the sample outside the bands, re-points the forced fragment's fonts at the sample's
  table, checks each sample instance is one of the variants, and stores the n fragments on the band (IR v6:
  `Band.fragments`, `Band.select`, a `choice` block, `Slot.auto_lines`). `repeat(..., variants:, select:)` calls
  `make(row, v)`; `choice(name, natural, make, select:)` is a single block; `variant(name, natural)` is the data's
  value in the sample compile and the forced one otherwise, so the sample stays the oracle. `slot(lines: auto)`
  takes the lines its text needs (measured in Typst through `layout` and `measure`, capped by the band's variant
  count), reading its band from `state("paramdoc-band")`. Runtimes pick by parity, by `== true` in the data, or
  by the line count computed as the dialect computes it. Report rows stripe again (two variants by parity);
  transcript rows are one to three lines tall by their title and the transcript ends with an optional honours
  block (`choice`, by flag). Checked: report, transcript and transcript-without-honours match Typst glyph for
  glyph and pixel for pixel in both runtimes (report: its known 1 pixel); the long transcript (42 rows, nine long
  titles) paginates on 2 pages with identical Rust and TypeScript traces and no honours line; fuzz 0 leaks with
  every variant laid out per sample; veraPDF PDF/UA-1 passes; `check.sh`, rewritten around per-case references,
  runs 81 checks. Open: one selector per band (no stripes × heights), no nested repeats, no `index` selector; a
  `lines: auto` text whose first line is only whitespace sits near a rounding tie between Typst's and the
  runtime's line count (not seen in the fuzz). Justification: `@chenglou/pretext` looked at and ruled out (greedy
  only, no justification API, its Knuth–Plass is demo code with a cost unlike Typst's); the way is a port of
  Typst's `linebreak_optimized` and `commit` arithmetic.
- **M7 wrapping text (2026-10-25).** The dialect's `slot` takes `lines: n`; the box is exactly `n` lines tall
  (`n · line-height + (n − 1) · leading + descent`, measured in Typst), the paragraph is top-aligned with
  `justify: false, linebreaks: "simple", hyphenate: false`, and the metadata carries `lines`, `line-height` and
  `pitch`. IR v5 adds `lines` and `pitch` to slots; the first baseline is the box top plus the line height.
  Reference glyphs carry `y`; `--reference` is repeatable; `--fuzz-references K` writes K fuzz samples with
  Typst's layout of them, so the runtimes are checked on random data too. Both runtimes break lines with Typst's
  simple breaker over UAX #14 opportunities (greedy first fit; trailing whitespace outside the width, drawn at
  zero advance; an overlong word placed uncut), place lines as Typst stacks them, and apply `error`, `clip` and
  `ellipsis` to lines that do not fit (`shrink` is refused). The report's tutor comment is a three-line slot;
  `documents/report` is re-exported.
  Checked: `fixtures/wrap` (left, centre, right and a table-cell slot; cases for newlines, punctuation, spaces,
  an overlong word, empty values, exactly full slots) and the report match Typst glyph for glyph and pixel for
  pixel in both runtimes; `fixtures/wrapfuzz` (all slots `clip`, so random text compares cleanly): 300 of 300
  random texts drawn from letters, digits, spaces and the repertoire's punctuation match Typst in both runtimes,
  glyph positions and pixels; the TypeScript trace equals the Rust trace on all of them; veraPDF PDF/UA-1 passes
  on the new PDFs; `check.sh` runs 74 checks. The answer to the unknown: yes, ragged wrapped text keeps the
  exactness guarantee, but only after copying four things the plan did not have. (1) Libertinus substitutes a
  short f before i through `calt`, which `ligatures: false` leaves on; slots now set `features: (calt: 0)`.
  (2) icu4x's default segmenter in Typst 0.15 applies LB15a/LB15b but neither LB15c nor LB20a, and LB25 in the
  pair-table form; each rule was found by a diverging random sample, fixed, and re-checked. (3) A whitespace-only
  line has zero height, so the following line sits one leading below the box top. (4) A line that does not fit
  has its spaces shrunk by a third before it overflows. Not covered: justified text, hyphenation, links (refused),
  East Asian and Hebrew rules, digits outside ASCII (letters to the breaker in both runtimes).
- **Demo page (2026-10-24).** The performance page of `examples/pretext-hybrid` has an engine switch: the
  TypeScript runtime runs in a pool of Web Workers (one runtime each, `src/batch/paramdoc.worker.ts`), fed by
  the page's own synthetic inputs mapped to the slot names, from `documents/report/` (the report fixture exported
  and checked in, 152 kB). Same machine, same page, same conditions (headless Chromium through
  `notes/bench/bench-browser.mjs`, tab visible), 1000 reports, 10-core M-series Mac:

  | Engine | workers | total | PDFs/s | PDF |
  |---|---:|---:|---:|---:|
  | Typst compiler in workers | 1 | 3.6 s | 281 | 26 kB |
  | Typst compiler in workers | 4 | 1.2–1.3 s | 778–839 | 26 kB |
  | Typst compiler in workers | 10 | 1.0 s | 1048 | 26 kB |
  | paramdoc runtime in workers | 1 | 0.4 s | 2312 | 61 kB |
  | paramdoc runtime in workers | 4 | 0.2 s | 4350–4396 | 61 kB |
  | paramdoc runtime in workers | 10 | 0.3 s | 3973 | 61 kB |
  | paramdoc runtime in Node, one thread | 1 | 0.23 s | 4327 | 62 kB |

  So 8× the compiler on one worker and 5× on four: a far smaller gap than the container's 17×, because the
  compiler is fast here (about 5 ms per report on a warm worker, the same template compiling incrementally) and
  the runtime's 1000 documents are over in 0.2 s, mostly worker start, so it stops scaling past 4 workers. The
  first measurement, made in a hidden browser pane, had the compiler at 12.8 s and 78 PDFs/s: a hidden tab
  throttles it tenfold, so that comparison was wrong and is withdrawn. All 1000 synthetic reports written by the
  TypeScript runtime (`notes/bench/write-all.mjs`) pass veraPDF PDF/UA-1, 6 s for the directory. The runtime's
  PDFs are larger than the compiler's because each embeds the two repertoire subsets (35 kB compressed) instead
  of a per-document subset, the M6 trade-off. The static build of the demo bundles the worker, `doc.json` and
  the fonts, and `tools/check-static-demo.ts` passes. `check.sh` now also fails when `documents/<fixture>` differs
  from a fresh export (the export is byte-deterministic) and, with `DEMO_URL` set, drives the demo page: 42
  checks. Finding: running `vite build` while the dev server is up makes both regenerate `routeTree.gen.ts` and
  the page reloads in a loop until the build ends.

- **veraPDF done (2026-10-24, on a Mac, from the bundle).** veraPDF 1.30.0 validates every runtime PDF of every
  fixture (Rust and TypeScript, single and multi-page, ten files) as PDF/UA-1: 106 rules, 1904 checks, no
  failures, with no change to either runtime. The gaps M4 expected did not apply: `/Tabs` is only required on
  pages with annotations, and the fixtures have no lists and no links. Under the PDF/UA-2 and WTPDF 1.0
  accessibility profiles (1724 rules) the only failures are the PDF 2.0 ones: file version 2.0, `pdfuaid:part`
  2 with `pdfuaid:rev` 2024 (or the WTPDF declaration), and the PDF 2.0 namespace on the Document element;
  every tagged-PDF containment rule passes. Typst's own PDFs of the same fixtures fail UA-1 on `DisplayDocTitle`
  and `pdfuaid:part` only. `check.sh` now runs the whole proof (build, exports with fuzzing, both runtimes
  against Typst and each other, pixels, text, structure, veraPDF) in about 30 s, and `notes/bench/ppmdiff.mjs`
  replaces the ad-hoc pixel comparison. All earlier results reproduce on this machine (Rust 1.99, Node 24):
  zero leaks, identical glyphs, identical pixels except the report's one pixel, identical text extraction.
  Finding: `inspectPdf` sums pdf.js's per-page structure trees, so the two-page transcript reports two Documents
  and two Tables where there is one of each; a limitation of the inspector, not of the output.

- **M6 done.** The exporter now subsets every font (`subsetter` crate, at export time) to the glyphs the static
  items use plus the glyphs of each slot's repertoire: the slot's `charset:` if declared, otherwise a default
  of printable ASCII, Latin-1 and common typography (dashes, quotes, bullet, ellipsis, euro). It rewrites the
  document's glyph ids to the subset and records in each font record what the runtimes used to parse from the
  file: program kind (bare CFF, OpenType-CFF or TrueType), units per em, ascender, descender, cap height,
  bbox, italic angle and flag, the advance of every glyph, and a character → glyph map covering the
  repertoire and the static text (for ToUnicode). IR v4. Typst's reference glyph ids are translated through
  the same maps, and fuzz samples are remapped with the baseline's maps before the diff (the subset keeps low
  ids by coincidence, so only the ligature glyphs had exposed the mismatch).
  Both runtimes now parse no font at all. The Rust runtime lost ttf-parser and the subsetter, the TypeScript
  runtime lost its OpenType reader; a character outside the repertoire fails with "declare it with
  `charset:`". All oracles still pass on every fixture: Typst's layout, the Rust trace, pixels, text extraction,
  structure roles; the wasm and native PDFs are byte-identical.
  Trade-offs: the Rust runtime's PDFs grew from 24 kB (per-document subsets) to 49 kB (the repertoire subset),
  the TypeScript runtime's shrank from 529 kB to 62 kB; `doc.json` grew from 22 kB to 87 kB raw with the
  advances and the map, which is 6.5 kB gzipped. Subsetting takes about 100–150 ms per export.

### Payload and performance with export-time subsetting (M6 checkpoint)

| Browser payload for the benchmark report | raw | gzip |
|---|---:|---:|
| Typst compiler wasm (existing path) | 24.4 MB | 8.95 MB |
| Rust runtime wasm32 | 509 kB | 178 kB |
| TypeScript runtime bundle | 16.2 kB | 6.7 kB |
| `doc.json` | 87 kB | 6.5 kB |
| two subset fonts | 62 kB | 35 kB |
| **TypeScript runtime + document + fonts** | **165 kB** | **48 kB** |

| Runtime, 1000 reports, same machine | documents/s | median per document | PDF |
|---|---:|---:|---:|
| Typst compiler in Chromium, 4 workers | 50.4 | — | — |
| Typst compiler in Chromium, 1 worker | 25.5 | — | — |
| TypeScript runtime in Chromium, main thread | 490–768 | 1.0–1.1 ms | 62 kB |
| TypeScript runtime in Node | 829–830 | 0.96 ms | 62 kB |
| Rust runtime as wasm32 in Node | 438–475 | 2.0 ms | 49 kB |
| Rust runtime native | 583–594 | 1.6 ms | 49 kB |

The TypeScript runtime is now the faster of the two because it writes the small streams uncompressed and
embeds pre-compressed fonts, while the Rust runtime still deflates every stream per document.

- **M5 done.** `ts/runtime.ts` (about 600 lines, no dependencies, erasable TypeScript so Node 22 runs it with
  `--experimental-strip-types` and esbuild bundles it unchanged) ports the Rust runtime: an OpenType reader for
  `head`, `hhea`, `hmtx`, `maxp`, `cmap` (formats 4 and 12), `OS/2`, `post` and the CFF flag; slot filling
  with the same alignment and overflow policies; fixed and flow composition with page breaks, header
  repetition and counters; structure assembly with the same table merging; marked content, parent tree,
  MarkInfo, language, XMP and ToUnicode; a small PDF writer with an xref table. `ts/cli.ts` mirrors the Rust
  CLI, including `bench`, and adds `--expect-rust` to compare against the Rust runtime's slot trace.
  Oracles, all three fixtures and the 42-row transcript: Typst's reference layout (identical), the Rust
  runtime's trace (identical slot for slot), rasterised pages (0 or 1 pixel of 2.2 million), `pdftotext`
  output (identical to the Rust PDFs) and `inspectPdf` structure roles (identical). Bundle: 18.0 kB minified,
  7.5 kB gzipped, plus `doc.json` and the fonts.
  Deliberate difference: fonts are embedded whole, compressed once per runtime, because a CFF subsetter in
  TypeScript is out of this step's scope; the report PDFs are 529 kB instead of 24 kB. The browser payload is
  unaffected (the fonts ship either way), the download of each generated PDF is. The small per-document streams
  are written uncompressed: CompressionStream costs milliseconds per call in Chromium, and the change doubled
  throughput (Node 240 → 500 documents/s, Chromium 110 → 290–387) for about 14 kB per PDF.
  Not done: subsetting (export-time subsetting to a declared repertoire, or a TrueType-only path with CFF fonts
  converted at build time, are the two options), a Web Worker wrapper, images.

### Performance, all runtimes (M5 checkpoint)

Same machine and the same 1000 synthetic reports as the M4 table.

| | documents/s | median per document |
|---|---:|---:|
| Typst compiler (WASM) in Chromium, 4 workers | 50.4 | — |
| Typst compiler (WASM) in Chromium, 1 worker | 25.5 | — |
| TypeScript runtime in Chromium, main thread, 1 thread | 290–387 | 1.7–2.0 ms (p95 8–11 ms, GC pauses) |
| TypeScript runtime in Node, 1 thread | 500–508 | 1.6–1.7 ms |
| Rust runtime as wasm32 in Node, 1 thread | 420–445 | 2.0 ms |
| Rust runtime native, 1 thread | 490–650 | 1.4 ms |

| Browser payload | raw | gzip |
|---|---:|---:|
| Typst compiler wasm | 24.4 MB | 8.95 MB |
| Rust runtime wasm32 | 1.12 MB | 403 kB |
| TypeScript runtime bundle | 18.0 kB | 7.5 kB |

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
a tutor comment of up to three lines, no score bars and no alternating row fill (the dialect cannot express those), with
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

### Re-evaluation after M6

All six milestones are built and verified; subsetting at export time was the right place, and it made the
runtimes simpler, not more complex. What remains is productisation, not research (veraPDF conformance, listed
here at the time, has since been validated; see the status log): images and links, variable-height rows
through variants, a Worker wrapper, a compact binary form of `doc.json` if its size ever matters, and the export step as a Vite plugin fed by
`defineTemplate` with the schema's `maxLength` and `pattern` feeding slot sizes and repertoires.

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
