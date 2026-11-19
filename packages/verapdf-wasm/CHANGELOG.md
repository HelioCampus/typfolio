# @typfolio/verapdf-wasm

## 0.1.0

First release. veraPDF 1.30.3's greenfield validator, built to WebAssembly with Oracle GraalVM 25.5.5.0.3 Web Image, for Node 22+ and current browsers.

- `createValidator({ wasm })` starts a validator from the binary, `@typfolio/verapdf-wasm/verapdf.wasm`; there is no default location.
- `validate(bytes, { flavour, maxChecksPerRule? })` returns the verdict, the profile applied, each failed rule with its topics and failed checks (what was wrong, with the values found, and where), and what veraPDF logged while reading the file.
- `detectFlavours(bytes)` returns the standards a file declares, and `validateDeclared(bytes)` validates against each.
- Flavours: PDF/UA-1 and PDF/UA-2, PDF/A-1 to PDF/A-4, WTPDF 1.0 Accessibility and Reuse.
- The binary is not open source as a whole: veraPDF is used under the Mozilla Public License 2.0, and the runtime inside the binary is under Oracle's GraalVM Free Terms and Conditions. See `LICENSE`.
