# Typst's NOTICE file

`NOTICE` is the file of that name at the root of the Typst repository at the tag of the pinned Typst version
(`typst` in `compiler-source.json`): https://github.com/typst/typst/blob/v0.15.1/NOTICE. It lists the third-party
components inside Typst and their licences. The crates.io packages of the Typst crates do not include it, and
Apache-2.0 (section 4(d)) requires it to travel with a distribution of the work, so
`tools/generate-third-party-notices.ts` reproduces it in `packages/wasm/THIRD_PARTY_LICENSES.md` for every Typst
crate in the compiler's dependency graph that ships no NOTICE of its own.

When the pinned Typst version changes, replace this file with the one at the new tag and update the link above.
