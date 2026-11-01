---
'@typfolio/wasm': minor
'@typfolio/core': minor
---

The compiler is Typfolio's own binding of Typst.

- `@typfolio/wasm` is now built from `crates/compiler` in the repository, which binds the Typst crates directly (Typst 0.15.1, unchanged) instead of typst.ts's compiler crate. The JavaScript surface is two classes, `Compiler` and `Compiled`, made for `@typfolio/core`; `compiler-source.json` pins the crate, the Typst version, the toolchain and the expected output hashes, and `provenance.json` records the source hash the binary was built from. `LICENSE.typst-ts` is gone from the package; the third-party notices cover the Typst crates.
- The compiler makes no JavaScript calls of its own and the loader constructs no code, so a page can load it under a Content Security Policy that allows `'wasm-unsafe-eval'` without `'unsafe-eval'` (checked in Chromium, Firefox and WebKit, where the previous build failed with an `EvalError`).
- `@typfolio/core`: diagnostics come from the compiler as data. A diagnostic's hints follow its message, one per `hint:` line (compile diagnostics used to carry them as `, hints: …`); a trace entry is a diagnostic of severity `hint`. A missing file is reported by Typst as `file not found (searched at /the/path)` and still becomes `file-not-found` with `file` and `path`. The PDF's creation date defaults to the time of the compile when `creationTimestamp` is not set, as before, and `datetime.today()` uses the page's local date.
