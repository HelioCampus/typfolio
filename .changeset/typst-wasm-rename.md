---
'@typfolio/typst-wasm': minor
'@typfolio/core': minor
---

`@typfolio/wasm` is renamed to `@typfolio/typst-wasm`, now that `@typfolio/verapdf-wasm` exists beside it: each package says which engine it carries, and Typst's compiler is no longer presented as Typfolio's own "wasm". The binary and the bindings are the same as in `@typfolio/wasm` 0.3.0. Applications change the import of the binary: `@typfolio/wasm/compiler.wasm` becomes `@typfolio/typst-wasm/compiler.wasm` (and `@typfolio/wasm/provenance` becomes `@typfolio/typst-wasm/provenance`). `@typfolio/core` depends on the new name, so installing it no longer brings `@typfolio/wasm`, which gets no further versions.
