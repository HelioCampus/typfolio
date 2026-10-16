# Compiler build

## What is implemented

- A pinned upstream Rust compiler built for `wasm32-unknown-unknown` with `web,pdf`, without the SVG/incremental/AST feature bundle.
- Matching wasm-bindgen JavaScript and TypeScript bindings, generated together with the WASM artifact.
- `@typfolio/wasm`: the generated artifact above, packaged on its own.
- `@typfolio/core`: explicit WASM/fonts, template files plus JSON input plus binary assets, PDF options, warnings/errors, isolation, cancellation checks, and disposal.
- Real compiler tests, synthetic document fixtures, structural PDF inspection, a browser/module-worker smoke test, and Vite application/library production builds.

The WASM still includes transitive rendering dependencies. This build is a useful PDF API foundation; it does not yet prove that a dedicated minimal Rust binding would be smaller or faster.

## Source and tools

The source of truth is [`compiler-source.json`](../compiler-source.json):

| Item | Pin |
|---|---|
| Upstream | `https://github.com/Myriad-Dreamin/typst.ts.git` |
| Commit | `1189a2f17527467e2f41e78b04e9d7f58a122cdf` |
| Rust | `1.92.0` |
| wasm-bindgen | `0.2.118`, exactly matching Cargo.lock |
| Features | `web,pdf`, no default features |
| Build | `cargo rustc --locked --release --crate-type cdylib`, then wasm-bindgen `--target web` |
| Release profile | `opt-level = "s"`, `lto = "fat"`, `codegen-units = 1`, set by the build script from `cargoProfile` in the pin (caller `CARGO_PROFILE_*` variables are ignored) |
| Crate type | `cdylib` only (`crateType` in the pin) |
| Reproducibility | Pinned source timestamp plus remapped workspace, Cargo, Rustup, and Rust standard library source paths |
| Extra optimization | No wasm-opt pass |

The upstream manifest still says `0.8.0-rc3`; the revision identifies this newer source. Its patched Typst dependency is version `0.15.1`, Git revision `59b5999d…`, resolved in the locked dependency graph.

The upstream checkout is read-only. The build exports the pinned commit into `.build/upstream`, ignoring uncommitted files in a provided clone. Without a local source path, it fetches that commit into `.build/source.git`. Cargo downloads dependencies into its normal cache and writes compiled output under this project's `.build/target`.

## Rebuild

Prerequisites: Node 22+, npm, Git, tar, rustup, and platform Rust linker tools.

```sh
cd <repository root>
npm ci
npm run setup:wasm

# This fetches the pinned commit. TYPST_TS_SOURCE can select a local clone.
npm run build:wasm
npm test
```

`setup:wasm` installs the pinned Rust toolchain/target and builds the exact wasm-bindgen CLI and the pinned `cargo-about` (`cargoAbout` in the pin) into `.build/tools/bin`. `WASM_BINDGEN=/absolute/path/to/wasm-bindgen` can select an existing matching binary; its version is checked.

`build:wasm` finishes by regenerating `packages/wasm/THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` with `cargo-about` (`npm run notices:wasm` does only that step, against the existing `.build/upstream` checkout, and `CARGO_ABOUT=/absolute/path/to/cargo-about` selects another binary, whose version is checked). The configuration is [`tools/about.toml`](../tools/about.toml): it targets `wasm32-unknown-unknown`, ignores build and dev dependencies, and lists the accepted licences, so a dependency under any other licence makes the step fail until someone reviews it. The features come from the pin (`web,pdf`, no defaults). The graph includes proc-macro crates and their dependencies, which run on the host and are not linked into the binary. The generator refuses to run when the checkout's `Cargo.lock` hash differs from `provenance.json`.

The build script pins `SOURCE_DATE_EPOCH` to the upstream commit timestamp and remaps workspace, Cargo, and Rustup paths to stable virtual prefixes. It also maps the toolchain's `lib/rustlib/src/rust` directory back to `/rustc/<rustc commit>`: the precompiled standard library carries that virtual path in its panic locations, but when the `rust-src` component is installed rustc resolves it to the real toolchain directory, which would otherwise end up in the binary as `/rustup/toolchains/...`. With this mapping the output does not depend on whether `rust-src` is installed (verified: three clean builds, with and without `rust-src`, are byte-identical in WASM, loader, and provenance). It fails if a generated compiler or loader still contains an unremapped local path or a toolchain source path.

The build uses `cargo rustc --crate-type cdylib` instead of `cargo build` on purpose. The upstream crate declares both `rlib` and `cdylib`, and Cargo does not run link-time optimization on such a unit, so `lto = "fat"` would silently have no effect with `cargo build`. A `cdylib`-only unit gets real LTO; `opt-level` and `codegen-units` apply either way. The generated loader numbers its glue functions per build, so the loader must always be shipped together with the binary it was generated with.

Reproducibility holds for the pinned toolchain, source, and wasm-bindgen on one platform; it was verified on macOS arm64 only, and the pinned hashes in `compiler-source.json` make every other platform (CI runs Linux) prove it or fail. It also modifies one generated loader expression: the fallback `new URL(..., import.meta.url)` becomes an explicit-input error. That keeps the default WASM URL out of bundler asset discovery; applications supply bytes, a compiled module, a Response, or a hosted URL. The script fails if the expected generated expression changes. There are no Rust source patches in this build.

### Pinned artifact hashes and bumping the compiler

`compiler-source.json` also records the expected output of the build: `wasmSha256` (the WASM binary) and `loaderSha256` (the patched JavaScript loader). `tools/check-package.mjs`, which `npm run pack:wasm` and the CI `compiler` job run, fails with "The build is not reproducing the pinned artifact" when the hashes in `provenance.json` differ from these pins. A build with the pinned source and tools must therefore produce the reviewed bytes; a difference means the toolchain, platform or dependency resolution changed, not that the pin should be silently refreshed.

To change the compiler (a new `revision`, `rust`, `wasmBindgen`, `cargoProfile` or any build-script change that alters the output): edit the pins, run `npm run setup:wasm` and `npm run build:wasm`, then copy `wasm.sha256` and `loaderSha256` from `packages/wasm/generated/provenance.json` into `wasmSha256` and `loaderSha256` in `compiler-source.json`, and commit the pin change, the regenerated `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` together, along with any size figures quoted in the documentation, so the repository never pins hashes its own build does not produce.

CI builds the compiler from the pins on Linux (`.github/workflows/ci.yml`, job `compiler`) and does not use any developer's artifacts. The pinned hashes were first recorded from a macOS arm64 build; whether Linux reproduces them byte for byte is checked by that job.

Generated files live in `packages/wasm/generated/`, the only content of the `@typfolio/wasm` package (`@typfolio/core` depends on it for the bindings; the binary is exposed as `@typfolio/wasm/compiler.wasm` and the provenance as `@typfolio/wasm/provenance`). `npm run pack:wasm` verifies their hashes against `provenance.json` before packing. They include the upstream license and `provenance.json` with source/tool pins, Cargo.lock hash, WASM hash and size, and loader hash. Generated files, caches, and test outputs are ignored by Git. Rebuild them before packing; consumers of a packed package do not need Rust.

## Test commands

```sh
npm test

# Structural checks of the compiled PDFs (tagging, title, language, headings, figure alt text, declared
# standards) are in packages/dev-tools/test/pdf.test.mjs, which `npm test` runs. They report facts, not conformance.
node --test packages/dev-tools/test/pdf.test.mjs

# External validator, the conformance step; see https://docs.verapdf.org/cli/validation/
verapdf --format json --flavour ua1 .build/test-output/ua.pdf

# Visual review
pdftoppm -scale-to 1100 -singlefile -png \
  .build/test-output/ua.pdf .build/test-output/ua-preview

# Builds and serves the production worker example at http://127.0.0.1:4178.
npm run test:browser

npm run pack:core
npm run pack:workers
npm run test:packed
npm run test:vite
```

The browser smoke test uses the workers package through its Vite production output.

`npm run test:vite` builds the application and library examples. It checks that each output contains exactly one WASM file matching the generated provenance hash, rejects JavaScript containing an inlined WASM data URL or base64 signature, and rejects unexpectedly large JavaScript chunks.

## Size

The generated WASM is 24,325,868 bytes (8,941,574 bytes at gzip level 9, about 6.5 MB with Brotli quality 11). `provenance.json` records the exact size and hashes. The size profile (`opt-level = "s"`, fat LTO, one codegen unit) reduced the raw size by 24.6% compared with the previous `opt-level = 3` build (32,273,674 bytes raw, 10,700,990 gzip, 7,171,158 Brotli) with identical PDF output; compile speed was within measurement noise and module initialization about 20% faster, at the cost of a longer build (about 2 minutes on a 10-core machine with `-j10`). `wasm-opt` is not used: it shrinks the raw size further but increases gzip and Brotli sizes.

## Compatibility and limits

| Capability | Current behavior |
|---|---|
| Single PDF standard | 1.4, 1.5, 1.6, 1.7, 2.0; A-1a/b, A-2a/b/u, A-3a/b/u, A-4/f/e; UA-1 |
| Multiple standards | Explicitly rejected; upstream binding accepts one string |
| Tags and creation timestamp | Exposed and verified in PDF output; tags default to true |
| Page ranges / experimental features | Explicitly unsupported; upstream binding needs extensions |
| JSON | Plain JSON values serialized to reserved `/input.json`; no business schemas |
| Files | Nested virtual paths; collisions, dot segments, traversal, and reserved-path replacement rejected |
| Resource loading | Explicit fonts (bytes, or URLs fetched with `fetch` by the realm that creates the compiler: the page for core, each worker for the workers package) and request assets; no implicit font CDN, host file access, or remote Typst packages; the only importable package is the bundled `@local/typfolio:0.1.0` |
| Diagnostics | Structured compile diagnostics with upstream ranges; export failures retain upstream text/cause but may lack source locations |
| Runtime | Native ESM tested in Node 24; browser smoke pages (core on the page and in a module worker, workers package with hard cancellation, capture adapters, React direct and worker routes) pass in Chromium 156, Firefox 157 and WebKit 27.2 under Playwright on macOS arm64 (`npm run test:browsers`). Not tested: Windows/Linux builds of these engines, mobile browsers, real Safari, and visual rendering of the PDF preview |
| WASM initialization | One generated module instance per JS realm. Reuse the same `wasm` value when creating several compilers; separate workers have separate instances |
| Cancellation | Core checks before/after execution; workers hard-cancel active synchronous WASM by terminating only its slot and lazily replacing capacity |
| Disposal | Frees the compiler after accepted work; module memory/caches can remain until the realm/worker is destroyed |
| CSP | Upstream builder constructs functions dynamically; strict CSP without `unsafe-eval` is not supported by this upstream build |
| Bundlers | Vite 8.3.1 application and library production builds pass with separately emitted WASM; other bundlers and deployment base paths are not yet tested |
