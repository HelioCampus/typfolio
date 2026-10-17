# Contributing to Typfolio

Thanks for helping. This file covers what you need to build, test and submit a change. For what the packages do, start with the [README](./README.md).

## Prerequisites

- Node.js 22.18 or newer and npm. The scripts in `tools/` are TypeScript that Node runs directly (type stripping, on by default from 22.18 and 23.6), so there is no build step for them.
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
- A changeset when the change affects a published package (see [Versioning and changesets](#versioning-and-changesets)).
- A short description of what changed and why, and of anything unsupported or deliberately left out.

## Versioning and changesets

Releases are driven by [Changesets](https://github.com/changesets/changesets). A changeset is a small Markdown file in `.changeset/` that names the packages a pull request changes, the kind of bump and the release note.

Add one with `npm run changeset` and commit the generated file with your change. You need one whenever a change affects what a published package ships or does: behaviour, public API or types, options, a bumped compiler pin, or a package README. You do not need one for tests, examples, `docs/`, tools, CI or the root README. Pick `patch` for fixes, `minor` for new features, and `major` for breaking changes.

Versioning is hybrid. `@typfolio/wasm` versions on its own, because it changes only when the compiler changes; `@typfolio/core` depends on it with an exact version so that the bindings always match the binary, and Changesets bumps that pin and releases `core` when `wasm` is released. `@typfolio/core`, `@typfolio/dev-tools`, `@typfolio/workers` and `@typfolio/react` are a linked group: packages released together share the highest version in the group, and a package without changes is not republished (its dependency range is raised only when a new `core` version leaves the range).

## Publishing

Maintainers only. Publishing runs in GitHub Actions ([`release.yml`](./.github/workflows/release.yml)) with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) and provenance; there is no npm token in the workflow. The only exception was the one-time first publish described below.

On every push to `main` the workflow rebuilds the compiler from the pinned source, runs `npm test` and `npm run test:packed` as a gate, and then runs `changesets/action`:

1. While changesets are pending, it opens or updates a pull request called **Version Packages**, which applies `changeset version` (new versions, `CHANGELOG.md` files, updated internal ranges and lockfile).
2. Merging that pull request lands the new versions on `main`. The next run finds no pending changesets and publishes every package whose version is not on npm yet, tags it and creates a GitHub release.

Notes for the Version Packages pull request:

- The action commits with the `GITHUB_TOKEN`, and GitHub does not start workflows for pull requests it creates. The required checks therefore stay pending until a maintainer closes and reopens the pull request (or pushes to its branch). The action's commit carries a `Signed-off-by: github-actions[bot]` trailer (set through `commit-message` in `release.yml`) so that the `dco` check passes once it runs.
- The repository setting Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" must be enabled.

### Trusted publishing facts (checked against the npm docs)

- Requirements: npm CLI 11.5.1 or newer and Node 22.14 or newer ([trusted publishers](https://docs.npmjs.com/trusted-publishers)). The workflow installs a pinned npm 11 because the npm bundled with Node 22 is older. A cloud-hosted GitHub runner and `id-token: write` are required.
- Provenance is generated automatically when publishing through trusted publishing from a public repository ([generating provenance](https://docs.npmjs.com/generating-provenance-statements)), and `repository.url` in each `package.json` must match this GitHub repository.
- A trusted publisher is configured per package on npmjs.com (package > Settings > Trusted publishing: owner `HelioCampus`, repository `typfolio`, workflow filename `release.yml`, no environment), or with `npm trust github <package> --file release.yml --repo HelioCampus/typfolio --allow-publish` ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust); npm 11.15 or newer, account-level 2FA, write access). npm does not validate the configuration when it is saved, so a mistake shows up only when publishing.
- **The package must already exist on the registry before a trusted publisher can be configured** ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust): "The package you're configuring must already exist on the npm registry"). The first version of each new package therefore cannot be published through OIDC.
- A new trusted publisher configuration must complete its first successful publish within 2 days, otherwise it expires and cannot be used or edited.

### First publish (one-time, done locally)

npm cannot attach a trusted publisher to a package that does not exist yet, so `0.1.0` of the five packages was published once by a maintainer from a local checkout of `main`, logged in to npm with 2FA. That version has no provenance attestation; every later version is published by the workflow and has one. The compiler binary in it is the build whose hashes are pinned in `compiler-source.json` (`node tools/check-package.ts` verifies this before publishing).

The steps, for the record or for a future new package:

1. On `main` with the versions already applied: `npm ci`, `npm run build`, `node tools/check-package.ts`, `npm test`, `npm run test:packed`.
2. `npm login` (account with 2FA and publish rights in the `@typfolio` organisation).
3. `npx changeset publish`. It publishes every package whose version is not on npm yet, in dependency order, asks for the 2FA code, and creates git tags such as `@typfolio/core@0.1.0`.
4. `git push --follow-tags`.
5. Configure the trusted publisher for each package (above), then cut a small follow-up release (a `patch` changeset) through the workflow within 2 days to validate them. If a configuration expires, delete and recreate it.
6. Optionally, once trusted publishing works, disallow token-based publishing in each package's publishing-access settings on npmjs.com.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
