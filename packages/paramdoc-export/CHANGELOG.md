# @typfolio/paramdoc-export

## 0.0.1

### Patch Changes

- First release, experimental: exports a Typst template written in the paramdoc slot dialect as a parametric document for `@typfolio/paramdoc`, with the proof that nothing outside the declared slots depends on the data. The exporter is the experiment's Rust crate with Typst 0.15.1 linked as a library, built to WebAssembly, so it runs in Node 22 or later with no Rust toolchain; its output is byte-identical to the native build's.

  - `createExporter(wasm)` instantiates the module from bytes, an `ArrayBuffer`, a `WebAssembly.Module` or a `Response`; `exporter.export({ template, data, fonts, images?, references?, fuzz?, plainPdf? })` returns the output files (`doc.json`, `fonts/*`, `images/*`, `baseline.pdf`, the references) and the log, or the refusal with its fix as `error`.
  - `@typfolio/paramdoc-export/node`: `loadWasm` reads the package's own binary, `exportDirectory(template, { data?, fonts, out, fuzz?, references? })` exports a template directory into an output directory as the command line does.
  - The command line `paramdoc-export <template> --fonts <dir> --out <dir> [--data f] [--fuzz N] [--reference f]... [--plain-pdf f]`, exit status 1 and the refusal on stderr.
  - `generated/provenance.json` records the crate, the commit, the Typst version, the Rust toolchain, the target, the release profile and the artifact's SHA-256; the wasm is 25.4 MB, 8.9 MB gzipped. The document format is unstable until 0.1.
