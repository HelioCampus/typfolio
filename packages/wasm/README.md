# @typfolio/wasm

Generated output only: the pinned Typst WASM compiler, its wasm-bindgen JavaScript bindings, the upstream license (`LICENSE.typst-ts`), and `provenance.json`. This package has no hand-written source and no build step of its own; the files in `generated/` are produced by `npm run build:wasm` at the repository root.

- `@typfolio/wasm` exports the bindings used by `@typfolio/core`.
- `@typfolio/wasm/compiler.wasm` is the WASM binary. Applications load it explicitly (bytes, module, or a hosted URL).
- `@typfolio/wasm/provenance` is the build provenance (source pin, tool versions, hashes).

See [docs/compiler-build.md](../../docs/compiler-build.md) for how the artifact is built and verified.

The package ships `LICENSE`, `NOTICE`, the upstream `LICENSE.typst-ts` (in `generated/`) and `THIRD_PARTY_NOTICES.md`, which lists the Rust crates compiled into the binary and their licences, and `THIRD_PARTY_LICENSES.md`, which reproduces those crates' own licence texts and copyright notices.
