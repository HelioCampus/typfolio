---
'@typfolio/dev-tools': minor
---

A new entry, `@typfolio/dev-tools/validate`, validates a PDF against PDF/UA or PDF/A with veraPDF compiled to WebAssembly: `validatePdf(bytes, { flavour })` and `createPdfValidator({ wasm? })` return which rules failed and how often, with veraPDF's topics for each rule and, for each failed check, what was wrong (with the values found) and where, and `formatValidationReport` prints a report as text. A new command, `typfolio-validate`, does the same for files from a shell or a CI step and exits with 0, 1 or 2. The tags panel takes a `validator` and then shows a "veraPDF" row: a standard to pick, a "Validate" button, and the verdict with each failed rule, which opens to its failed checks; once used, every new PDF is validated too. The validator is `@typfolio/verapdf-wasm`, a new optional peer dependency that is loaded only by the new entry; it is a package of its own because its binary carries Oracle's GraalVM Free Terms, and it is not published yet.
