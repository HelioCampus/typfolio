# Project context

Read `README.md` before changing the compiler contract.

The API separates Typst template files from JSON request input. Applications own business validation (for example Zod). Core has no React or Effect dependency. Workers and framework adapters are separate packages.

External repositories and checkouts are context, not files to change as part of this project. Keep proprietary templates, institutional data, and product assets out of this package's fixtures and distribution.

Project-internal notes live in the gitignored `.idea/` folder.

For compiler changes, read `docs/compiler-build.md`, preserve pinned source/tool versions, and run the real WASM tests. Report unsupported options explicitly. A tagged PDF or PDF/UA metadata alone does not establish accessibility conformance.

## Effect worker reference

For every worker-related change, read the local Effect guidance first and use `.repos/effect` as the required source reference for current Effect APIs, worker/concurrency patterns, scoped resource cleanup, interruption, queues, streams, and runtime boundaries. Start with `.repos/effect/ai-docs`, then inspect the relevant implementation and tests; worker-specific sources live under `.repos/effect/packages/effect/src/workers`, `.repos/effect/packages/effect/test/workers`, and `.repos/effect/packages/platform/browser`. The checkout comes from `https://github.com/Effect-TS/effect.git`, is gitignored, and is reference-only: never import from it. Application and package code must import Effect through declared package dependencies.
