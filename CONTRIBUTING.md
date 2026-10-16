# Contributing to Typfolio

Thanks for helping. This file covers what you need to build, test and submit a change. For what the packages do, start with the [README](./README.md).

## Prerequisites

- Node.js 22 or newer and npm.
- Git, tar, and [rustup](https://rustup.rs) with the platform's linker tools. Rust is only needed to build the Wasm compiler; the toolchain version is pinned in [`compiler-source.json`](./compiler-source.json) and installed for you by `npm run setup:wasm`.

## Setup

```sh
npm ci
npm run setup:wasm   # pinned Rust toolchain, wasm-bindgen-cli and cargo-about, into .build/tools
npm run build:wasm   # fetches the pinned compiler source and builds packages/wasm/generated/
```

The compiler build takes minutes and is only needed once, and again when the pins change. [docs/compiler-build.md](./docs/compiler-build.md) explains every step, the reproducibility rules and how to bump the compiler. The generated files are not committed; CI builds them from the pinned source and does not use anyone's local artifacts.

## Tests

| Command | What it covers |
|---|---|
| `npm test` | Builds all packages, then runs the core, dev-tools, workers and React suites against the real compiler |
| `npm run test:vite` | Production Vite builds of the examples; checks that the Wasm stays a separate asset with the provenance hash |
| `npm run test:packed` | Packs every package, installs the tarballs in a clean consumer and verifies the packed boundaries and the pinned compiler hashes |
| `npm run test:browsers` | Playwright: the smoke pages and the React example in Chromium, Firefox and WebKit (run `npx playwright install --with-deps` once) |

CI runs all of these. Run the first three before opening a pull request; run the browsers when you touch workers, capture or the examples.

## Project rules

- Templates and input are separate: Typst template files describe the document, JSON is the request input. Do not merge them into one concept.
- Applications own business validation (for example with Zod). Core does not validate business data.
- `@typfolio/core` has no runtime dependency other than `@typfolio/wasm`, and no React or Effect dependency. Workers and framework adapters are separate packages.
- Report unsupported options explicitly (an error or a documented limit), never silently ignore them.
- Do not claim accessibility conformance. A tagged PDF or PDF/UA metadata is not proof; say what was checked and by what.
- Keep proprietary templates, institutional data and product assets out of fixtures and the published packages.
- Compiler changes keep the source and tool versions pinned and update the pinned artifact hashes in `compiler-source.json` in the same commit.

## Developer Certificate of Origin

Typfolio uses the [Developer Certificate of Origin](https://developercertificate.org) (DCO 1.1) instead of a contributor licence agreement. By signing off a commit you certify that you wrote the change or otherwise have the right to submit it under the project's licence (Apache-2.0). There is nothing to sign separately.

Sign off every commit with `-s`, which adds a trailer using your Git name and email:

```sh
git commit -s -m "Describe the change"
```

```text
Signed-off-by: Your Name <you@example.com>
```

To add it to commits you already made, run `git rebase --signoff main` and force-push your branch. The `dco` check in CI fails a pull request when any of its commits lacks the trailer; you can run the same check locally with `tools/check-dco.sh origin/main..HEAD`.

## What a pull request needs

- Tests for the behaviour you add or change, passing locally (see above). Prefer the real compiler over mocks.
- Documentation updated where behaviour, options or limits change: the package README, `docs/`, the root README.
- Every commit signed off.
- A changeset once the release tooling lands.
- A short description of what changed and why, and of anything unsupported or deliberately left out.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
