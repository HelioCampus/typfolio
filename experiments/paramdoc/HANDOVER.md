# Handover: the paramdoc experiment

For the agent or person who picks this up from the commit bundle. `PLAN.md` is the detailed log (design, every
milestone's findings, all numbers); this file is the short version: what exists, how to prove it still works,
what is open, and what to watch out for.

## What this is

An experiment inside the Typfolio repository, under `experiments/paramdoc/`, on the question: can a document
be typeset once by Typst at build time and finished in the browser by a runtime with no typesetter, so that the
24 MB compiler is not shipped? The answer, demonstrated and measured, is yes for documents made of fixed slots
and fixed-height repeating rows (forms, certificates, statements, transcripts, record tables), and no for
flowing narrative documents. The boundary is precise and enforced by a build-time check.

It is an experiment: nothing here is wired into the Typfolio packages, no API is public, and `AGENTS.md`'s rule
that the compiler contract lives in `README.md` is untouched. The packages are unchanged. The one place outside
this folder that knows about it is the performance demo page in `examples/pretext-hybrid`, whose engine switch
imports the TypeScript runtime and the exported report from here (see "The demo page" below).

## The branch

`feat/paramdoc`. The work arrived as a commit bundle from a cloud session (branch `claude/laughing-ptolemy-nnntum`,
eight commits on top of `6567590`, never pushed: that session had no GitHub access to `HelioCampus/typfolio`).
On 2026-10-24 the bundle was fetched and rebased, unchanged, onto `main` after PR #11 (`8499599`); the rebase
is trivial because every commit only adds files under `experiments/paramdoc/`. Each commit is signed off (DCO,
`tools/check-dco.sh origin/main..HEAD`) and authored `Claude <noreply@anthropic.com>`.

Commits, oldest first:

1. `Add paramdoc experiment: Typst frame exporter and layout-isolation check` (M1)
2. `paramdoc: runtime that fills slots and writes the PDF without Typst` (M2)
3. `paramdoc: flow documents with bands, pagination and page counters` (M3)
4. `paramdoc: runtime as a library with a C ABI; size and timing figures`
5. `paramdoc: tagged output with a structure tree, and the 1000-document benchmark` (M4)
6. `paramdoc: TypeScript runtime, checked against Typst and the Rust runtime` (M5)
7. `paramdoc: export-time font subsetting; runtimes parse no fonts` (M6)
8. this handover
9. `paramdoc: PDF/UA-1 validated with veraPDF; check.sh runs the whole proof` (see the status log in `PLAN.md`)
10. `paramdoc: engine switch on the performance demo page; 1000 reports without the compiler`

## Layout of the folder

| Path | What |
|---|---|
| `PLAN.md` | Principle, architecture, milestones, findings, measurements, re-evaluations. Read it first. |
| `GAPS.md` | The one inventory of what paramdoc cannot do yet, for application developers: status (refused at export, refused at fill, silent, missing, rule), workaround, fix and cost. Add every new gap there; the open-items list below is only the order. |
| `check.sh` | The whole proof below as one script: build, exports with fuzzing, checked-in documents against a fresh export, both runtimes against Typst and each other, pixels, text, structure, veraPDF, and with `DEMO_URL` set the demo page. 157 checks, a few minutes. |
| `export-documents.sh` | Exports a fixture and copies what a browser runtime needs, `doc.json` and the subset fonts, into `documents/<fixture>/`. |
| `documents/report/` | The report fixture exported, checked in (152 kB) because the demo page cannot run the exporter at build time. Regenerate after changing the fixture, the dialect or the exporter. |
| `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml` | Rust workspace; build output goes to `../../.build/paramdoc-target` (gitignored), never in-tree. |
| `ir/` | The parametric document format (`doc.json`), serde types, version 8 (links and link-slot geometry since 2026-10-26), plus `geometry`: the ports of Typst's rounded rectangle and image placement both the exporter and the runtimes use. |
| `export/` | `paramdoc-export`: links Typst 0.15.1 as a library (crates.io), compiles a fixture with sample data, walks the frames, exports the document, subsets fonts, dumps Typst's layout as a reference, fuzzes the data and diffs the contract. |
| `runtime/` | `paramdoc-runtime`: Rust library + CLI (`fill`, `bench`) + C ABI (`paramdoc_open/render/close`, `paramdoc_fill`) for the wasm32 cdylib build. Depends on pdf-writer, flate2, serde_json, sha2 only. |
| `ts/runtime.ts`, `ts/cli.ts` | The same runtime in dependency-free erasable TypeScript; Node 22 runs it with `--experimental-strip-types`; Vite bundles it with the demo's worker into 37 kB minified, 14 kB gzipped (16 kB before images, bars and links). |
| `fixtures/*/` | Templates in the slot dialect, each with `paramdoc.typ` (the dialect helper, identical copies), `main.typ`, `data.json`: `certificate` (fixed page), `policies` (overflow policies), `leak` (deliberately broken, must fail the check), `transcript` (flow: table bands, 42-row `data-long.json`), `report` (the worker-batch benchmark's report in the dialect), `wrap` and `wrapfuzz` (wrapping slots, one data case per breaking rule, random texts), `justify` (the `wrap` template with every wrapping slot justified, the same data cases), `figures` (image slots), `links` (static links and link slots, 40-row `data-long.json`), `charset` (a declared Turkish, Greek and Cyrillic repertoire under `lang: "tr"`, random texts), and the ones that must fail the export: `linkbad` (an internal link), `charsetbad` (an Arabic letter in a charset), `stylebad` (a show rule recolouring part of a slot), `rotatedlink`, `smooth` (`scaling: "smooth"`), `leading` (too little leading for a clipping slot). |
| `notes/wasm-size-report.md` | Where the 24 MB compiler's bytes go (crate by crate, data blobs, dependency paths). |
| `notes/bench/` | Scripts: `gen-inputs.mjs` (1000 inputs from the repo's `data.ts`), `bench-wasm.mjs` (Rust wasm in Node), `bench-browser.mjs` (drives the repo's `/performance` page headlessly), `bench-ts.html` + `bench-ts-browser.mjs` (TypeScript runtime in Chromium), `inspect.mjs` (structure via the repo's `inspectPdf`), `ppmdiff.mjs` (pixel diff of two PPMs, used by `check.sh`), `write-all.mjs` (every benchmark input as a PDF, for veraPDF over the set). |

## How to prove it still works (do this first after any change)

```sh
cd experiments/paramdoc && ./check.sh      # 157 checks, a few minutes after the first build; FUZZ=20 ./check.sh is quicker
DEMO_URL=http://127.0.0.1:4190 ./check.sh  # also drives the performance page of a running pretext-hybrid dev server
```

It builds, exports every fixture with fuzzing and a Typst reference, runs both runtimes against Typst and
against each other, rasterises and compares pixels, compares text extraction, inspects the structure and
validates every runtime PDF with veraPDF as PDF/UA-1; it also fails when `documents/<fixture>` no longer equals a
fresh export (the export is byte-deterministic, so this is a plain comparison). Every fixture gets a Typst
reference for `data.json` and for each other `data-*.json` case (the `wrap` cases, web addresses included, the transcript without
honours, the figures with other images), and `fixtures/wrapfuzz` references for 40 random samples (the exporter's `--fuzz-references`); both
runtimes are checked against every one of them, glyph for glyph and pixel for pixel. Tools it cannot find (poppler,
veraPDF, the dev-tools build, Playwright) are reported as SKIP; anything else that fails fails the script.

Prerequisites: Rust stable (1.97 on Linux and 1.99 on macOS have been used; crates pin Typst 0.15.1 which needs
1.92+), Node 22.18+, `npm ci` and `npm run build` at the repo root (for the TypeScript tools
and `inspectPdf`), `pdftoppm`/`pdftotext` (poppler) for the pixel and text checks, `verapdf` on PATH
(`brew install verapdf`). The first `cargo build` compiles Typst and takes a few minutes (47 s on an M-series
Mac). The steps by hand, for running one of them alone:

```sh
cd experiments/paramdoc
# 1. Export + isolation check + Typst reference, per fixture (exit 0 = no leaks)
cargo run -p paramdoc-export -- fixtures/certificate --fuzz 200 --reference fixtures/certificate/data.json
cargo run -p paramdoc-export -- fixtures/transcript  --fuzz 100 --reference fixtures/transcript/data.json
cargo run -p paramdoc-export -- fixtures/report      --fuzz 100 --reference fixtures/report/data.json
cargo run -p paramdoc-export -- fixtures/leak --fuzz 20        # must exit 1: the auto-width slot leaks
# 2. Rust runtime against Typst's layout of the same data (glyph ids and positions, 1e-3 pt)
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/report --data fixtures/report/data.json \
  --out ../../.build/paramdoc/report/runtime.pdf --expect ../../.build/paramdoc/report/reference.json
# 3. TypeScript runtime against Typst and against the Rust trace
node --experimental-strip-types ts/cli.ts ../../.build/paramdoc/report --data fixtures/report/data.json \
  --out ../../.build/paramdoc/report/runtime-ts.pdf --expect ../../.build/paramdoc/report/reference.json \
  --expect-rust ../../.build/paramdoc/report/runtime.trace.json
# 4. Pixels: rasterise runtime.pdf / runtime-ts.pdf / reference.pdf at 150 dpi and compare (0 px differ, 1 px on the report)
pdftoppm -r 150 -singlefile ../../.build/paramdoc/report/runtime.pdf   /tmp/a
pdftoppm -r 150 -singlefile ../../.build/paramdoc/report/reference.pdf /tmp/b   # then diff the PPMs pixel by pixel
# 5. Multi-page and structure
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/transcript --data fixtures/transcript/data-long.json --out ../../.build/paramdoc/transcript/long.pdf
node notes/bench/inspect.mjs ../../.build/paramdoc/transcript/long.pdf      # tagged, Table/TR/TH/TD, lang, title, pdfUa 1
pdftotext -layout ../../.build/paramdoc/report/runtime.pdf -                  # text extracts, ligatures included
```

Expected state: every command above passes; the certificate, policies and transcript render pixel-identical
to Typst, the report differs by one pixel by one level; the TypeScript trace is identical to the Rust trace on
every fixture; wasm and native Rust outputs are byte-identical; veraPDF 1.30 reports PDF/UA-1 PASS (106 rules,
1904 checks) on every runtime PDF and on all 1000 synthetic reports of the benchmark set.

Benchmarks (see `PLAN.md` for the tables): `cargo run --release -p paramdoc-runtime -- bench <doc-dir> --inputs
inputs.json`, `node --experimental-strip-types ts/cli.ts bench ...`, and the scripts in `notes/bench/`. The
1000 inputs come from `node --experimental-strip-types notes/bench/gen-inputs.mjs 1000 <out.json>` (it imports
the repo's `examples/pretext-hybrid/src/batch/data.ts`).

## The contract in one paragraph

A **slot** is a fixed-size clipped box with a pinned baseline (`box(baseline: bottom)` shifted by a descent),
kerning, ligatures, contextual alternates and punctuation overhang off, text aligned to its bottom. A **wrapping
slot** (`lines: n`, since 2026-10-25) is the same box made exactly `n` lines tall, the paragraph aligned to its top,
justification and hyphenation off, so Typst breaks it with its simple breaker and the runtimes reproduce the
breaks from advance widths; the first baseline is one line height below the box top. A **band** is a clipped block;
instances of one name are the rows of a repeat region; `repeat-on-break: true` marks a header band. `paged`
records the margins; `overlay` marks per-page content with `page-number`/`page-count` counter slots. A band may
declare **variants** (since 2026-10-25): `repeat(..., variants: n, select: ...)` or a `choice` block; the exporter
compiles the fixture once more per variant with `sys.inputs.paramdoc-variant = "<band>=<k>"`, which forces every
instance of the band to variant k, and the runtime picks per instance by `("parity",)`, `("flag", key)` or
`("lines", slot)` (a `lines: auto` slot). In the sample compile `variant(name, natural)` is what the data says, so
the sample is the runtime's output for the sample data and stays the oracle. A **bar** (since 2026-10-25) is a
clipped box whose own fill is a static track and whose content is one filled rectangle, `value / max` of the box
width, which the runtime regenerates with Typst's own rounded-rectangle construction (`ir::geometry::rounded_rect`,
checked against Typst on every compile); it is tagged as content of the cell it sits in. An **image slot** is a
clipped box one `image` fills, placed as Typst's `layout_image` places it (`ir::geometry::fit_image`, also checked
on every compile) and tagged Figure with the data's alternative text; images arrive in the data as data URLs,
which the exporter turns into files for Typst. Static raster images are shipped as `images/*` next to the fonts.
A **link slot** (since 2026-10-26) is a slot whose value is `(text: …, href: …)`: the text is shown as a `link`
and the runtime adds one link annotation per drawn line, each line's box extended above and below the baseline
by what Typst's link rectangle adds (the text's edges plus half the leading), measured from the sample and
checked against every compile. Static links in the template are exported as `Link` records (Typst's rectangles,
URL, Link node) and written as annotations too; web addresses in wrapping-slot text break where Typst's
`linebreak_link` breaks them. Only URL destinations; no links in artifacts.
Everything outside holes must lay out identically for every valid input; the exporter proves it by fuzzing.
Holes bind to data by name (hole name = data key; rows bind to the array named after the band). The runtime only
does geometry Typst's source was ported for, or picks among things Typst already produced. Bands must use `table`, not `grid`, to get table
semantics in the structure tree. Slot text may only contain characters in the slot's repertoire (`charset:` or
the default Latin set); the exporter subsets fonts to exactly that plus the static glyphs. **Refusals** (since
2026-10-26, M12): the runtimes never lay anything out differently from Typst; what they cannot reproduce stops
with a message, at export when the template declares it, at fill when the data brings it. Supported in slots:
Latin (Extended included), Greek and Cyrillic, precomposed, left to right, one font, size and colour per slot,
no hyphenation (`hyphenate: false` pinned; soft hyphens refused until the dash is ported), no middle dot (CJK
punctuation to Typst), no stroked text, no colour or variable fonts, integers and strings as values. A declared
`charset` must stay inside that whitelist, and whatever it declares is proven on every export: the exporter
fills each slot with its whole repertoire through the real template (the repertoire proof) and checks every
glyph of every compile against the font's character map and advances, so a feature, language or style rule that
would change a glyph is refused, not approximated. Inside slots the dialect also pins `dir`, `tracking`,
`spacing`, `stroke` and `cjk-latin-spacing`. A **justified slot** (since 2026-10-26, M11) is a wrapping slot
with `justify: true`: the same breaks, and every line but the last and lines before a hard break stretch their
kept spaces as Typst's `commit` does (by up to half a space each, then an equal share of what is left; an
overfull line shrinks them by up to a third, justified or not); a line without a space keeps its width and the
slot's alignment, and an ellipsized line is never stretched.

## The demo page

The performance page of `examples/pretext-hybrid` (`/performance`, "1000 PDFs in the browser, on workers") has an
**Engine** switch since 2026-10-24: *Typst compiler* is the page as it was, *paramdoc runtime (experimental)* renders
the same synthetic batch through this experiment. `?engine=paramdoc&count=1000&autostart` starts it from the URL.

- `examples/pretext-hybrid/src/batch/paramdoc.ts` downloads `documents/report/doc.json` and its fonts once per page
  (`?url` imports and an `import.meta.glob` over the fonts folder, so Vite bundles them; the static build and
  `tools/check-static-demo.ts` pass), maps the page's `ReportInput` to the slot names the way `notes/bench/gen-inputs.mjs`
  does, and wraps one Web Worker per runtime.
- `examples/pretext-hybrid/src/batch/paramdoc.worker.ts` imports `ts/runtime.ts` from this folder by relative path,
  creates the runtime on `init` and transfers one PDF back per `fill`.
- `examples/pretext-hybrid/src/batch/batch.ts` runs the pool like the compiler pool: each worker takes the next
  document until none is left, a worker's first job is its cold one, the PDF/UA-1 box is forced on (the runtime always
  tags), and the runs panel shows one engine's runs at a time because the rates are an order of magnitude apart.

Measured under the same conditions, headless Chromium through `notes/bench/bench-browser.mjs` with the tab visible,
1000 reports on a 10-core M-series Mac (the compiler's time includes its 23 MB download on the first run):

| Workers | Typst compiler | paramdoc runtime | ratio |
|---:|---:|---:|---:|
| 1 | 3.6 s, 281 PDFs/s | 0.4 s, 2312 PDFs/s | 8.2× |
| 4 | 1.2–1.3 s, 778–839 PDFs/s | 0.2 s, 4350–4396 PDFs/s | 5.3× |
| 10 | 1.0 s, 1048 PDFs/s | 0.3 s, 3973 PDFs/s | 3.8× |

Per report the compiler needs about 5 ms on a warm worker (the same template compiles incrementally), the runtime
0.2 ms plus the message round trip; the runtime stops scaling past 4 workers because 1000 documents are over in
0.2 s, which is mostly worker start. A hidden tab throttles both: the first measurement of the compiler, made in a
hidden pane, gave 12.8 s, ten times its real figure, so never compare runs from a hidden tab. All 1000 synthetic
reports from the same data path, written by the TypeScript runtime (`notes/bench/write-all.mjs`), pass veraPDF
PDF/UA-1. The exported report is the slot dialect's version of the page's template, so the PDFs differ from the
compiler's: a static title and a tutor comment of at most three ragged-right lines; the page says so next to the
switch. The row stripes and the score bars are back since 2026-10-25 (two band variants picked by row parity; a
`bar` hole per row over a static track). The compiler's PDFs are 26 kB, the runtime's 66 kB (the two repertoire subsets embedded whole).

## Open items, in the order I would do them

`GAPS.md` is the full inventory (G1–G51 as of 2026-10-26) and the place to record a new gap; this section only
says what to build next and why.

veraPDF, the first item at handover, is done (2026-10-24, veraPDF 1.30.0): every runtime PDF passes PDF/UA-1
with no change to either runtime. The expected gaps did not apply: `/Tabs` is only required on pages with
annotations, and the fixtures have no lists and no links. Under the PDF/UA-2 and WTPDF 1.0 accessibility
profiles (1724 rules) only the PDF 2.0 rules fail: file version 2.0, `pdfuaid:part` 2 with `pdfuaid:rev` 2024
(or the WTPDF declaration), and the PDF 2.0 namespace on the Document element. Every tagged-PDF containment
rule passes, so UA-2 is a metadata change away if it is ever wanted. Typst's own PDFs of the same fixtures fail
UA-1 on two rules (no `DisplayDocTitle`, no `pdfuaid:part`), as expected for a plain export.

Wrapping text (M7 in `PLAN.md`), variants (M8) and bars and image slots (M9) are done (2026-10-25): multi-line
slots break lines exactly as Typst does, checked on every data case of `fixtures/wrap` and on 300 random texts of
`fixtures/wrapfuzz`; rows grow with their wrapping slot, blocks appear by a flag and rows stripe by parity, each a
Typst layout the runtime picks, checked on the transcript and the report; the report's score bars are Typst's
rounded rectangles regenerated from the data, and `fixtures/figures` fills PNG and JPEG image slots (a canvas chart
with transparency, a photograph, a keyed icon) and draws a static logo, pixel-identical to Typst. Both runtimes,
glyph positions, shapes and pixels. See the status log in `PLAN.md` and `docs/2026-10-25-*.md` at the repository root.

Web addresses and clickable links are done (2026-10-26): wrapping slots break addresses as Typst does (its
`link_prefix` and `linebreak_link`, checked on the `wrap` links case and on random texts), and links come out of
both runtimes as PDF/UA link annotations inside Link elements, static ones from the template and data-driven ones
through link slots (`slot(name, (text:, href:))`), with rectangles equal to typst-pdf's. See
`docs/2026-10-26-addresses-and-links.md`. Refusals are done too (M12, 2026-10-26, item 6 below and
`docs/2026-10-26-refusals.md`), and so are justified wrapping slots (M11, 2026-10-26, item 4 below and
`docs/2026-10-26-justified-slots.md`).

1. **A Worker wrapper** for the TypeScript runtime as something reusable: the demo page has one (`paramdoc.worker.ts`
   and the pool in `batch.ts`), written for that page; moving it under `ts/` with a small API would let other pages
   use it. A compact binary form of `doc.json` if its 87 kB raw (6.5 kB gzip) ever matters.
2. **Export as a Vite plugin** fed by `defineTemplate`, with the schema's `maxLength` and `pattern` sizing
   slots and setting repertoires. This is where the experiment would meet the real packages; design it with the
   repository's maintainers before writing it.
3. The Rust runtime still deflates every stream per document, which is why it is slower than the TypeScript
   one; writing small streams uncompressed and caching the font streams would even them out.
4. **Justified wrapping slots**: done (M11, 2026-10-26). `slot(..., justify: true)`; the breaks do not move
   (the simple breaker and `hyphenate: false` stay pinned), the runtimes port the space-stretching step of
   Typst's `commit`. Web quality, not book quality: the optimized breaker (G3) and hyphenation (G2, off by
   decision) are what a justified paragraph outside a slot still has over a slot. Looked at on 2026-10-25: the
   JavaScript library `@chenglou/pretext` does not help (a greedy wrapper, no justification API, canvas
   measurement).
5. **SVG images**, the rest of the images-and-links item (links are done, 2026-10-26: still refused are internal
   destinations, links in overlays and repeated headers, and rotated link text gets a bounding box).
   SVG images are refused by the exporter (the runtimes have no SVG renderer; the shared header of
   `examples/vite-react` uses an SVG logo, so a template from there needs the logo rasterized to PNG, or an SVG
   port of krilla-svg's output). Also unsupported, each with a message: 16-bit, interlaced and sub-8-bit PNGs,
   CMYK and lossless JPEGs, EXIF orientation, `scaling: "smooth"`; and the wasm C ABI has no parameter for the
   image files yet.
6. **Refuse what the runtimes cannot reproduce**: done (M12, 2026-10-26). The runtimes will not grow to cover
   what would make the TypeScript one heavy (a shaper, bidi, hyphenation patterns, SVG); unsupported input stops
   with a message. What is left of it, both small and listed in `GAPS.md`: the soft-hyphen dash (G44, the cheap
   half of hyphenation: the data producer hyphenates, the runtime draws Typst's `-`) and the middle dot's CJK
   shrinkability (G51). The decision on hyphenation itself (G2) stands: off, unless it comes without tables.

## Things that will bite you

- **The shaping check runs on every compile** (sample, references, the repertoire proof, the fuzz). A template
  setting that changes a glyph or an advance inside a slot (`tnum`, `smcp`, stylistic sets, a `show` rule, a
  font with `locl` rules under the template's `lang`) is refused at export with the glyph ids; the fix is in the
  template, never in the runtime. A space is allowed any advance up to the font's: Typst trims trailing spaces to
  zero width and shrinks spaces on overfull lines, both ported. Wider than the font's advance is refused (no
  stretch until M11 lands, and then only what M11 ports).
- **The repertoire proof needs a data value per slot.** A slot the data gives no value to (`page-number`,
  `page-count`, a slot sharing a number with a bar) is checked on its sample only; the export says which.
- **Whitelist, then proof.** A `charset` character outside the whitelist (`unsupported_reason` in the exporter)
  is refused before any compile; one inside it is proven by the repertoire proof and the fuzz. To widen the
  whitelist, add the range, add its UAX #14 classes to `lb_class` and `lbClass` if they are not `AL`, and fuzz
  a fixture that declares it (`fixtures/charset` is the pattern).
- **Numbers.** A float as a slot value is refused at fill; format it as a string in the application. Integers
  and booleans render as Typst's `str()` does.

- **Typst 0.15 API.** `FileId::new(RootedPath)`, `Library::default()` via `LibraryExt`, `PagedDocument` in
  `typst_layout`, settable fields need `.get(StyleChain::default())`, `Transform` has no point-mapping method
  (`apply()` in the exporter), `Font::ttf()` is not public (parse with ttf-parser). Frame walking assumes
  Start/End tags appear in document order within the depth-first walk; floats and `place` are not handled.
- **The fuzz check compares subset glyph ids.** Fuzz samples are remapped with the baseline's glyph maps; if you
  change subsetting, keep that or every ligature will look like a leak.
- **Slot membership is by frame hierarchy, not geometry.** A run starting exactly at a slot's edge is not slot
  content. Do not reintroduce geometric hit-testing.
- **`CompressionStream` in browsers costs milliseconds per call**; the TypeScript runtime compresses only the
  font programs, once per runtime.
- **Contextual alternates.** `ligatures: false` does not stop Libertinus from swapping in a short f before i
  (the `calt` feature); slots set `features: (calt: 0)` as well, since 2026-10-25. Before that, no fixture
  sample happened to contain "fi". A font feature that changes glyph choice shows up as a glyph id the
  subset does not have, in the Typst reference.
- **Typst 0.15's line breaking is not plain Unicode 15.1.** icu4x's default segmenter, checked against Typst on
  300 random texts: LB15a and LB15b apply (no break after an opening quote plus spaces, none before a closing
  quote that is followed by space or punctuation), LB15c and LB20a do not, and LB25 is the pair-table form (no
  break between a slash and a digit, or between a currency sign and an opening bracket, whatever follows). Both
  runtimes encode exactly that, rule by rule, in `breakpoints`; `fixtures/wrapfuzz` is the check that keeps them
  honest when Typst or icu4x move.
- **Two line-layout details without which wrapped text is a few points off.** A line of nothing but whitespace
  has no height in Typst (all its glyphs are trimmed), so the line after it sits one leading, not one pitch,
  below the box top. And a line that does not fit has its spaces shrunk by up to a third of their width before
  it overflows, ragged or justified (`par.justification-limits`). Trailing spaces are glyphs: at a normal break
  they are drawn at zero advance at the line end; before a hard newline and at the end of the text they keep
  their advance. The traces include them, so the comparison with Typst sees all of this.
- **Variants compile the fixture once per variant**, forcing every instance of the band to that variant; the
  sample page must still fit on one page with every row at its tallest, so keep sample rows few. The forced
  document must equal the sample everywhere outside the bands (the exporter diffs them and says where not); a
  variant that moves anything else is refused. Fonts are numbered by first use, so fragments from a forced
  compile are re-pointed at the sample's font table (`adopt_fonts`).
- **`lines: auto` needs its band.** The band publishes itself through `state("paramdoc-band")` so the slot can
  read the forced variant and the cap; the slot is laid out through `layout` to learn its width, which makes it
  block-level: fine as the only content of a cell, not inline in a sentence. In a closure passed to `repeat` or
  `choice`, do not name the variant parameter `v`: it shadows `v()`.
- **The runtime's selector and the dialect's `natural-variant` must agree** (parity, `== true` for flags, the
  measured line count for lines); a disagreement shows as the runtime differing from the sample reference.
- **A hole tagged as an artifact can empty its table cell.** Shapes are artifacts unless inside a Figure; a bar
  tagged that way left its cell with no content, the cell was dropped from the structure, and veraPDF failed the
  table-regularity rule (7.2-43: rows with fewer cells than the header). Bars are content of the node they sit in
  (`Bar.node`). Keep that in mind for any new hole kind.
- **A box's fill sits outside its clip group** (`layout_box` clips first, then prepends the fill), which is why a
  bar's track is static and its inner `rect` is the hole content; `rect(width: 45%)` inside `place` inside the box
  resolves against the box width. The exporter compares Typst's curve with `rounded_rect` on every compile, so a
  Typst change to `styled_rect` would show up as an export error, not as a wrong PDF.
- **Image slot metadata carries the template's `alt` only.** The data's `alt` goes to `image(alt:)` so Typst's
  own PDF has it, and the runtime sets it on the Figure at fill time. Putting the data's `alt` in the metadata
  makes every fuzz sample a "leak" (the node's `alt` changes).
- **Images in data are data URLs** (`data:image/png;base64,…`, or `(src:, alt:)`); the exporter rewrites them to
  `/paramdoc-images/<n>.<ext>` files for Typst (`virtualize_images`) and the runtime decodes them. The TypeScript
  runtime also takes a `Uint8Array`. Image slots need a fixed width and height.
- **Erasable TypeScript only** in `ts/runtime.ts`: no parameter properties, enums or namespaces; Node's
  `--experimental-strip-types` refuses them. Type-check with `npx tsc --noEmit --strict --target es2022 --module
  esnext --moduleResolution bundler --lib es2022,dom --skipLibCheck --noUncheckedIndexedAccess --erasableSyntaxOnly
  --allowImportingTsExtensions experiments/paramdoc/ts/runtime.ts experiments/paramdoc/ts/cli.ts` from the root.
- **Typst's web-address breaking is positional**, not a pattern over the text: `breakpoints()` looks for `://`
  before and `www.` after the previous break opportunity, so `http://127.0.0.1` (no opportunity between `/` and a
  digit) is not a link to it and breaks by UAX #14. The runtimes port the loop (`link_prefix`, `linebreak_link`);
  the fuzz puts random addresses into one string in four to keep it honest.
- **Link slots are strict both ways.** A slot whose sample value has an `href` needs one in every input and a
  plain slot refuses one, because `show link` rules style the two differently and the exporter only knows the
  sample's style. The slot's text belongs to the Link node (re-pointed when the link item arrives, after the
  metadata tag), whose `alt` is reset to the data's at fill time.
- **Typst's link rectangle is the line's text frame plus half the leading above and below**, one per line;
  typst-pdf joins a link's rectangles into one annotation with quad points for PDF/UA. The exporter measures the
  two extents from the sample and checks every compile; the runtimes' rectangles equal typst-pdf's.
- **Typst inlines frames of at most five items and nests larger ones**, so an item like a link can turn a slot's
  paragraph frame into a nested (empty, once the hole consumed its text) group depending on the text. The
  exporter drops empty unclipped groups; without that every such sample was a fake leak.
- **The fixture images are generated**, by `notes/make-figure-images.mjs` from the repository root (Chromium via
  Playwright for the canvas chart, sharp for the JPEG and the tall PNG, hand-written PNGs for the palette logo and
  the keyed icon). Re-run it rather than editing the data files' base64 by hand.
- **Running the repo's dev server regenerates `examples/pretext-hybrid/src/routeTree.gen.ts`**; revert it
  before committing.
- **`pkill -f` with a pattern that appears in your own shell command kills the shell.** Track server PIDs.
- **The compiler build on Linux did not reproduce the pinned hash** (+78 kB, see `notes/wasm-size-report.md`).
  Out of scope here, but the maintainers should know.
- **`inspectPdf` counts structure roles per page.** pdf.js hands out one structure tree per page, each with its
  ancestors, and the dev-tools inspector sums them: the two-page transcript reports `Document: 2, Table: 2,
  TR: 86` where the file has one Document, one Table and 43 rows. veraPDF sees one of each. That is a
  limitation of the inspector in `packages/dev-tools`, not of the runtimes.
- Commit sign-off: every commit needs `Signed-off-by` (`git commit -s`), checked by `tools/check-dco.sh`.
