---
'@typfolio/wasm': minor
'@typfolio/core': minor
---

Typst's in-development `a11y-extras` feature is on by default: templates can use `pdf.header-cell`, `pdf.data-cell` and `pdf.table-summary`. `pdf: { a11yExtras: false }` turns it off, and `capabilities.a11yExtras` reports it. The WASM binding's `compile` takes a `features` list (`a11y-extras`, `html`, `bundle`), `["a11y-extras"]` when absent. The binary is rebuilt, so its hashes and size change.
