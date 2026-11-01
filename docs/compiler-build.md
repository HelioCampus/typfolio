# Compiler build

## What is implemented

- Typfolio's own Typst binding, [`crates/compiler`](../crates/compiler) (`typfolio-compiler`): the Typst crates bound directly, with an in-memory world, PDF export and diagnostics as data behind a small wasm-bindgen surface (`Compiler`, `Compiled`), built for `wasm32-unknown-unknown`.
- Matching wasm-bindgen JavaScript and TypeScript bindings, generated together with the WASM artifact.
- `@typfolio/wasm`: the generated artifact above, packaged on its own.
- `@typfolio/core`: explicit WASM/fonts, template files plus JSON input plus binary assets, PDF options, warnings/errors, isolation, cancellation checks, and disposal.
- Real compiler tests, synthetic document fixtures, structural PDF inspection, a browser/module-worker smoke test, and Vite application/library production builds.

The binding makes no JavaScript calls of its own: no file system, network, clock (the caller passes the time) or callbacks, and the generated loader constructs no code. A page can therefore load the compiler under a Content Security Policy that allows `'wasm-unsafe-eval'` without `'unsafe-eval'`; `tools/check-package.ts` fails if a build ever reintroduces `new Function` or `eval` into the loader (see the CSP row under [Compatibility and limits](#compatibility-and-limits) for what was checked by hand).

Until November 2026 the artifact was built from a pinned revision of [typst.ts](https://github.com/Myriad-Dreamin/typst.ts)'s compiler crate. The own binding replaced it for three reasons: one Typst for the compiler and the paramdoc exporter (they share the workspace's `Cargo.lock`, so what the exporter lays out is what the compiler lays out, by construction rather than by inspection), structured diagnostics instead of parsing Rust debug text, and the Content Security Policy above. The size was measured first and was not a reason: the binary is Typst's own dependency choices (see [Size](#size)).

## Source and tools

The source of truth is [`compiler-source.json`](../compiler-source.json):

| Item | Pin |
|---|---|
| Crate | `typfolio-compiler` in `crates/compiler`, a member of the workspace at the repository root |
| Typst | `0.15.1` (`typst`, `typst-pdf`, `typst-layout` from crates.io); the build fails if `Cargo.lock` resolves another version |
| Rust | `1.92.0` |
| wasm-bindgen | `0.2.118`, exactly matching the crate's dependency |
| Features | none |
| Build | `cargo rustc --locked --offline --release --crate-type cdylib`, then wasm-bindgen `--target web` |
| Release profile | `opt-level = "s"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = "symbols"`, set by the build script from `cargoProfile` in the pin (the workspace manifest's profile and caller `CARGO_PROFILE_*` variables are ignored) |
| Crate type | `cdylib` only (`crateType` in the pin) |
| Reproducibility | Remapped workspace, Cargo, Rustup, and Rust standard library source paths; no build time is embedded |
| Extra optimization | No wasm-opt pass |

The upstream checkout and its git fetch are gone: the crate is in the repository, and the build script first runs `cargo fetch --locked` for the crates the lockfile names (into Cargo's normal registry cache, which CI caches), then compiles offline, so the lockfile alone decides what goes into the binary. Cargo writes compiled output under this project's `.build/target`.

## Rebuild

Prerequisites: Node 22.18+, npm, Git, rustup, and platform Rust linker tools.

```sh
cd <repository root>
npm ci
npm run setup:wasm
npm run build:wasm
npm test
```

`setup:wasm` installs the pinned Rust toolchain/target and builds the exact wasm-bindgen CLI and the pinned `cargo-about` (`cargoAbout` in the pin) into `.build/tools/bin`. `WASM_BINDGEN=/absolute/path/to/wasm-bindgen` can select an existing matching binary; its version is checked.

`build:wasm` finishes by regenerating `packages/wasm/THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` with `cargo-about` (`npm run notices:wasm` does only that step, and `CARGO_ABOUT=/absolute/path/to/cargo-about` selects another binary, whose version is checked). The configuration is [`tools/about.toml`](../tools/about.toml): it targets `wasm32-unknown-unknown`, ignores build and dev dependencies, and lists the accepted licences, so a dependency under any other licence makes the step fail until someone reviews it. The graph includes proc-macro crates and their dependencies, which run on the host and are not linked into the binary. The generator refuses to run when the workspace's `Cargo.lock` hash differs from `provenance.json`.

The build script remaps the workspace, Cargo, and Rustup paths to stable virtual prefixes. It also maps the toolchain's `lib/rustlib/src/rust` directory back to `/rustc/<rustc commit>`: the precompiled standard library carries that virtual path in its panic locations, but when the `rust-src` component is installed rustc resolves it to the real toolchain directory, which would otherwise end up in the binary as `/rustup/toolchains/...`. With this mapping the output does not depend on whether `rust-src` is installed. It fails if a generated compiler or loader still contains an unremapped local path or a toolchain source path. Nothing in the toolchain embeds a build time, and the script unsets `SOURCE_DATE_EPOCH` so the caller's value cannot matter either.

The build uses `cargo rustc --crate-type cdylib` instead of `cargo build` on purpose. The crate declares both `rlib` (for native tests and tools) and `cdylib`, and Cargo does not run link-time optimization on such a unit, so `lto = "fat"` would silently have no effect with `cargo build`. A `cdylib`-only unit gets real LTO; `opt-level` and `codegen-units` apply either way. The generated loader numbers its glue functions per build, so the loader must always be shipped together with the binary it was generated with.

Reproducibility holds for the pinned toolchain, source, and wasm-bindgen on one platform; it was verified on macOS arm64 (a build over a warm target directory and a build from a deleted one gave the same `compiler_bg.wasm`, `compiler.js` and hashes), and the pinned hashes in `compiler-source.json` make every other platform (CI runs Linux) prove it or fail. The script also modifies one generated loader expression: the fallback `new URL(..., import.meta.url)` becomes an explicit-input error. That keeps the default WASM URL out of bundler asset discovery; applications supply bytes, a compiled module, a Response, or a hosted URL. The script fails if the expected generated expression changes.

### Pinned artifact hashes and changing the compiler

`compiler-source.json` also records the expected output of the build: `wasmSha256` (the WASM binary) and `loaderSha256` (the patched JavaScript loader). `tools/check-package.ts`, which `npm run pack:wasm` and the CI `compiler` job run, fails with "The build is not reproducing the pinned artifact" when the hashes in `provenance.json` differ from these pins. A build with the pinned source and tools must therefore produce the reviewed bytes; a difference means the toolchain, platform or dependency resolution changed, not that the pin should be silently refreshed.

`provenance.json` also records `sourceSha256`, a hash over everything the binary was built from: `Cargo.toml`, `Cargo.lock` and every file under `crates/compiler` (`tools/compiler-source.ts`). `check-package` recomputes it from the checkout and fails when they differ, so an artifact that predates a change to the crate is never packed or tested as if it were current. CI caches the artifact by the same set of files.

To change the compiler (the crate's code, a new `typst`, `rust`, `wasmBindgen`, `cargoProfile` or any build-script change that alters the output): make the change, run `npm run build:wasm` (and `npm run setup:wasm` first when a tool version changed), then copy `wasm.sha256` and `loaderSha256` from `packages/wasm/generated/provenance.json` into `wasmSha256` and `loaderSha256` in `compiler-source.json`, and commit the change, the pins, the regenerated `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` together, along with any size figures quoted in the documentation, so the repository never pins hashes its own build does not produce. A Typst upgrade is `typst`, `typst-pdf` and `typst-layout` in the workspace `Cargo.toml`, `cargo update -p typst -p typst-pdf -p typst-layout` for the lockfile, the same number in the pin, and a fresh copy of Typst's `NOTICE` from the new tag in `tools/notices/typst/` (the crates.io packages do not include it; the notices generator reproduces it for the Typst crates); the paramdoc exporter moves with it, since it depends on the same workspace entries.

CI builds the compiler from the pins on Linux (`.github/workflows/ci.yml`, job `compiler`, pinned to the `ubuntu-24.04` runner image so the build environment only changes deliberately) and does not use any developer's artifacts. The pinned hashes were first recorded from a macOS arm64 build; whether Linux reproduces them byte for byte is checked by that job. The finished artifact is cached by the content of the pins, the workspace manifest, the lockfile and the crate's files, so only a change to one of them triggers a rebuild on the runner; every other run restores the cached artifact, skips the Rust build, and still verifies the pinned hashes. The cache is written only after that check has passed.

Generated files live in `packages/wasm/generated/`, the only content of the `@typfolio/wasm` package (`@typfolio/core` depends on it for the bindings; the binary is exposed as `@typfolio/wasm/compiler.wasm` and the provenance as `@typfolio/wasm/provenance`). `npm run pack:wasm` verifies their hashes against `provenance.json` before packing. They include `provenance.json` with the crate, Typst and tool versions, the source and Cargo.lock hashes, the WASM hash and size, and the loader hash. Generated files, caches, and test outputs are ignored by Git. Rebuild them before packing; consumers of a packed package do not need Rust.

## The binding

`crates/compiler/src/lib.rs` is the whole surface. A `Compiler` holds fonts (`addFont`, every face of a file, in the order given). For a document the caller mounts files at absolute virtual paths (`mount`), names the Typst packages those mounts serve (`mountPackage`, for core the bundled `@local/typfolio:0.1.0` under `/@typfolio/packages/...`), and calls `compile(entrypoint, optionsJson)` with `sys.inputs`, the PDF options (`standard`, `tags`, `creationTimestamp`) and the clock (`now`: Unix seconds and the local offset, for the PDF date when the request sets none and for `datetime.today()`). `Compiled` gives the PDF bytes once (`takePdf`), the title and the diagnostics as a JSON array of `{ severity, message, hints?, path?, range?, package? }`, a trace entry being a `hint`. `reset` unmounts everything; a file mounted again with the same bytes keeps its parsed source, so the common case, the same template with new data, does not reparse the template. Memoized results older than ten compiles are evicted after each compile.

What the binding refuses is a malformed request (an entrypoint that is not mounted, an unknown PDF standard, a font file without a readable face), thrown as an error; a document that fails to compile or to export is a `Compiled` without PDF whose diagnostics say why. A Typst package that is not mounted fails with `Only @local/typfolio:0.1.0 is available; remote Typst packages are not supported (requested …)`; a file the request lacks with Typst's `file not found (searched at /the/path)`, which core turns into `file-not-found`.

## Test commands

```sh
npm test

# Structural checks of the compiled PDFs (tagging, title, language, headings, figure alt text, declared
# standards) are in packages/dev-tools/test/pdf.test.ts, which `npm test` runs. They report facts, not conformance.
node --test packages/dev-tools/test/pdf.test.ts

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

# The compiler's native unit tests (dates and timestamps); the real compiler tests are the suites above.
cargo +1.92.0 test -p typfolio-compiler
```

The browser smoke test uses the workers package through its Vite production output.

`npm run test:vite` builds the application and library examples. It checks that each output contains exactly one WASM file matching the generated provenance hash, rejects JavaScript containing an inlined WASM data URL or base64 signature, and rejects unexpectedly large JavaScript chunks.

## Size

The generated WASM is 24,136,677 bytes (8,834,473 bytes at gzip level 9, 6,421,860 bytes with Brotli quality 11 and a 16 MB window); the loader is 16 kB. `provenance.json` records the exact size and hashes. Measured on 2026-11-01 against the last typst.ts-based artifact (24,325,868 raw, 8,941,574 gzip, 6,481,591 Brotli; loader 54 kB): the own binding is 0.8% smaller raw, 1.2% smaller gzipped and 0.9% smaller with Brotli, with the same release profile. Its code section is 14.70 MB (14.86 MB before) and its data section 9.37 MB (9.40 MB before); `strip = "symbols"` matters, because without it wasm-bindgen leaves a 2.4 MB `name` section in the binary.

The size is Typst's, not the binding's. A size breakdown of the typst.ts artifact (`experiments/paramdoc/notes/wasm-size-report.md`) attributes the binary to Typst's own dependency choices: the bibliography stack with its CSL archive and collation data (about 5.6 MB raw), the hyphenation patterns for 48 languages (1.2 MB, incompressible), syntax highlighting grammars (1.25 MB), the plugin runtime (1 MB), and the code of Typst, krilla, the font and image stacks that PDF output needs. None of these is behind a feature flag in Typst 0.15, so the own binding changes the size only by what typst.ts's layers added. Reaching the larger levers would mean patching the Typst crates; the workspace's `[patch.crates-io]` is where that would go.

Speed is unchanged: the outcome-sets fixture with its title changed on each run compiles in about 3.5 ms either way in Node on a laptop (median of 30), an identical document in about 0.5 ms (served from the memoization caches), and module initialization is the same. `wasm-opt` is not used: it shrinks the raw size further but increases gzip and Brotli sizes.

## Compatibility and limits

| Capability | Current behavior |
|---|---|
| Single PDF standard | 1.4, 1.5, 1.6, 1.7, 2.0; A-1a/b, A-2a/b/u, A-3a/b/u, A-4/f/e; UA-1 |
| Multiple standards | Explicitly rejected; one standard per request |
| Tags and creation timestamp | Exposed and verified in PDF output; tags default to true. Without `creationTimestamp` the PDF's date is the time of the compile |
| Page ranges / experimental features | Explicitly unsupported |
| JSON | Each piece of data (the template's and each partial's) checked against the application's Standard Schema, then serialized as JSON at its `schemaPath`; core has no schema library of its own |
| Files | Nested virtual paths; collisions, dot segments, traversal, and reserved-path replacement rejected |
| Resource loading | Explicit fonts (bytes, or URLs fetched with `fetch` by the realm that creates the compiler: the page for core, each worker for the workers package) and request assets; no implicit font CDN, host file access, or remote Typst packages; the only importable package is the bundled `@local/typfolio:0.1.0` |
| Diagnostics | Structured compile and export diagnostics with Typst's ranges (zero-based `line:column-line:column`), hints and trace entries; export failures (a PDF standard's checks) have no source location |
| Runtime | Native ESM tested in Node 24; browser smoke pages (core on the page and in a module worker, workers package with hard cancellation, capture adapters, React direct and worker routes) pass in Chromium 156, Firefox 157 and WebKit 27.2 under Playwright on macOS arm64 (`npm run test:browsers`). Not tested: Windows/Linux builds of these engines, mobile browsers, real Safari, and visual rendering of the PDF preview |
| WASM initialization | One generated module instance per JS realm. Reuse the same `wasm` value when creating several compilers; separate workers have separate instances |
| Cancellation | Core checks before/after execution; workers hard-cancel active synchronous WASM by terminating only its slot and lazily replacing capacity |
| Disposal | Frees the compiler after accepted work; module memory/caches can remain until the realm/worker is destroyed |
| CSP | The loader constructs no code: `'wasm-unsafe-eval'` is enough, `'unsafe-eval'` is not needed. Checked by hand on 2026-11-01, not by a test: a page and a module worker served with `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` compiled the smoke document in Chromium 156, Firefox 157 and WebKit 27.2 with no policy violation, while the previous typst.ts build failed on the same pages with an `EvalError` in all three (its Rust code built JavaScript functions with `new Function`). The guard that stays is `tools/check-package.ts`, which rejects a loader containing `new Function` or `eval` |
| Bundlers | Vite 8 application and library production builds pass with separately emitted WASM; other bundlers and deployment base paths are not yet tested |
