# typfolio-compiler

Typfolio's Typst compiler for WebAssembly, the Rust side of [`@typfolio/wasm`](../../packages/wasm). It binds the
[Typst](https://github.com/typst/typst) crates directly: an in-memory world (`world.rs`), PDF export with the options
`@typfolio/core` offers (`options.rs`), diagnostics as data (`diagnostics.rs`), and a wasm-bindgen surface of two
classes, `Compiler` and `Compiled` (`lib.rs`). Nothing in it reaches out of the module: no file system, network, clock
or JavaScript callbacks, so a page can load it under a Content Security Policy that allows only `'wasm-unsafe-eval'`.

The surface exists for `packages/core/src/engine.ts` and is not a public API. The build, the pins and the
reproducibility rules are in [docs/compiler-build.md](../../docs/compiler-build.md); `compiler-source.json` at the
repository root pins the Typst version, the toolchain and the expected output hashes.

The crate shares the workspace's `Cargo.lock` with the paramdoc exporter (`experiments/paramdoc/export`), so both
compile with the same Typst and lay out the same document the same way.
