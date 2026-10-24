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
that the compiler contract lives in `README.md` is untouched. The repository's own code is unchanged except for
nothing: every commit of this work only adds files under `experiments/paramdoc/`.

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

## Layout of the folder

| Path | What |
|---|---|
| `PLAN.md` | Principle, architecture, milestones, findings, measurements, re-evaluations. Read it first. |
| `check.sh` | The whole proof below as one script: build, exports with fuzzing, both runtimes against Typst and each other, pixels, text, structure, veraPDF. 40 checks, about 30 s. |
| `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml` | Rust workspace; build output goes to `../../.build/paramdoc-target` (gitignored), never in-tree. |
| `ir/` | The parametric document format (`doc.json`), serde types, version 4. |
| `export/` | `paramdoc-export`: links Typst 0.15.1 as a library (crates.io), compiles a fixture with sample data, walks the frames, exports the document, subsets fonts, dumps Typst's layout as a reference, fuzzes the data and diffs the contract. |
| `runtime/` | `paramdoc-runtime`: Rust library + CLI (`fill`, `bench`) + C ABI (`paramdoc_open/render/close`, `paramdoc_fill`) for the wasm32 cdylib build. Depends on pdf-writer, flate2, serde_json, sha2 only. |
| `ts/runtime.ts`, `ts/cli.ts` | The same runtime in dependency-free erasable TypeScript; Node 22 runs it with `--experimental-strip-types`; esbuild bundles it (16 kB). |
| `fixtures/*/` | Templates in the slot dialect, each with `paramdoc.typ` (the dialect helper, identical copies), `main.typ`, `data.json`: `certificate` (fixed page), `policies` (overflow policies), `leak` (deliberately broken, must fail the check), `transcript` (flow: table bands, 42-row `data-long.json`), `report` (the worker-batch benchmark's report in the dialect). |
| `notes/wasm-size-report.md` | Where the 24 MB compiler's bytes go (crate by crate, data blobs, dependency paths). |
| `notes/bench/` | Scripts: `gen-inputs.mjs` (1000 inputs from the repo's `data.ts`), `bench-wasm.mjs` (Rust wasm in Node), `bench-browser.mjs` (drives the repo's `/performance` page headlessly), `bench-ts.html` + `bench-ts-browser.mjs` (TypeScript runtime in Chromium), `inspect.mjs` (structure via the repo's `inspectPdf`), `ppmdiff.mjs` (pixel diff of two PPMs, used by `check.sh`). |

## How to prove it still works (do this first after any change)

```sh
cd experiments/paramdoc && ./check.sh      # 40 checks, about 30 s after the first build; FUZZ=20 ./check.sh is quicker
```

It builds, exports every fixture with fuzzing and a Typst reference, runs both runtimes against Typst and
against each other, rasterises and compares pixels, compares text extraction, inspects the structure and
validates every runtime PDF with veraPDF as PDF/UA-1. Tools it cannot find (poppler, veraPDF, the dev-tools
build) are reported as SKIP; anything else that fails fails the script.

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
1904 checks) on every runtime PDF.

Benchmarks (see `PLAN.md` for the tables): `cargo run --release -p paramdoc-runtime -- bench <doc-dir> --inputs
inputs.json`, `node --experimental-strip-types ts/cli.ts bench ...`, and the scripts in `notes/bench/`. The
1000 inputs come from `node --experimental-strip-types notes/bench/gen-inputs.mjs 1000 <out.json>` (it imports
the repo's `examples/pretext-hybrid/src/batch/data.ts`).

## The contract in one paragraph

A **slot** is a fixed-size clipped box with a pinned baseline (`box(baseline: bottom)` shifted by a descent),
kerning, ligatures and punctuation overhang off, text aligned to its bottom. A **band** is a clipped block;
instances of one name are the rows of a repeat region; `repeat-on-break: true` marks a header band. `paged`
records the margins; `overlay` marks per-page content with `page-number`/`page-count` counter slots. Everything
outside slots must lay out identically for every valid input; the exporter proves it by fuzzing. Slots bind to
data by name (slot name = data key; rows bind to the array named after the band). The runtime only does trivial
geometry or picks among things Typst already produced. Bands must use `table`, not `grid`, to get table
semantics in the structure tree. Slot text may only contain characters in the slot's repertoire (`charset:` or
the default Latin set); the exporter subsets fonts to exactly that plus the static glyphs.

## Open items, in the order I would do them

veraPDF, the first item at handover, is done (2026-10-24, veraPDF 1.30.0): every runtime PDF passes PDF/UA-1
with no change to either runtime. The expected gaps did not apply: `/Tabs` is only required on pages with
annotations, and the fixtures have no lists and no links. Under the PDF/UA-2 and WTPDF 1.0 accessibility
profiles (1724 rules) only the PDF 2.0 rules fail: file version 2.0, `pdfuaid:part` 2 with `pdfuaid:rev` 2024
(or the WTPDF declaration), and the PDF 2.0 namespace on the Document element. Every tagged-PDF containment
rule passes, so UA-2 is a metadata change away if it is ever wanted. Typst's own PDFs of the same fixtures fail
UA-1 on two rules (no `DisplayDocTitle`, no `pdfuaid:part`), as expected for a plain export.

1. **Images and links.** Both are recorded in the IR and skipped by the runtimes. When they land, run
   `./check.sh` again: the UA-1 pass covers what the fixtures contain today (headings, paragraphs, tables,
   artifacts), and links bring annotations, `/Tabs /S` and the Link structure rules with them.
2. **Variable-height rows.** Rows are one fixed height. The plan is variants laid out at export time (a band
   declared for 1..n lines) with the runtime measuring and picking.
3. **A Worker wrapper** for the TypeScript runtime, and a compact binary form of `doc.json` if its 87 kB raw
   (6.5 kB gzip) ever matters.
4. **Export as a Vite plugin** fed by `defineTemplate`, with the schema's `maxLength` and `pattern` sizing
   slots and setting repertoires. This is where the experiment would meet the real packages; design it with the
   repository's maintainers before writing it.
5. The Rust runtime still deflates every stream per document, which is why it is slower than the TypeScript
   one; writing small streams uncompressed and caching the font streams would even them out.

## Things that will bite you

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
