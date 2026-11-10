# @typfolio/wasm

Typfolio's Typst compiler for WebAssembly: the binary built from [`crates/compiler`](../../crates/compiler) in the
repository, its wasm-bindgen JavaScript bindings, and `provenance.json`. This package has no hand-written source and no
build step of its own; the files in `generated/` are produced by `npm run build:wasm` at the repository root from the
pins in `compiler-source.json`.

- `@typfolio/wasm` exports the bindings used by `@typfolio/core` (`Compiler`, `Compiled`). They exist for core and are
  not a public API. `compile` takes Typst's in-development features by name (`features`: `a11y-extras`, `html`,
  `bundle`); `a11y-extras` is on when the field is absent.
- `@typfolio/wasm/compiler.wasm` is the WASM binary. Applications load it explicitly (bytes, module, or a hosted URL).
- `@typfolio/wasm/provenance` is the build provenance (crate, Typst version, tool versions, source and output hashes).

The compiler makes no JavaScript calls of its own: no file system, network, clock or callbacks, and the loader constructs
no code, so a page can load it under a Content Security Policy that allows `'wasm-unsafe-eval'` without `'unsafe-eval'`.

See [docs/compiler-build.md](../../docs/compiler-build.md) for how the artifact is built and verified.

The package ships `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, which lists the Rust crates compiled into the binary and
their licences, and `THIRD_PARTY_LICENSES.md`, which reproduces those crates' own licence texts and copyright notices.
