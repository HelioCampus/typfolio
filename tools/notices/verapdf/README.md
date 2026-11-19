# Licence texts for the veraPDF WebAssembly package

Licence texts that `tools/build-verapdf.ts` copies into `packages/verapdf-wasm/generated/licenses/` and that are not
inside the pinned jars:

- `LICENSE.MPL`: the Mozilla Public License 2.0 as veraPDF ships it, from
  `https://github.com/veraPDF/veraPDF-library/blob/v1.30.3/LICENSE.MPL` (the copy in `veraPDF-parser` at the same tag
  is identical). veraPDF is dual-licensed GPLv3+ / MPLv2+; the package uses it under the MPL.
- `xmp-core-LICENSE.txt`: the licence file of veraPDF's `xmp-core` module, from
  `https://github.com/veraPDF/veraPDF-library/blob/v1.30.3/xmp-core/LICENSE.txt`. The module is derived from Adobe's
  XMP Toolkit, and its source files carry an Adobe Systems copyright header.

Take fresh copies from the new tag when the veraPDF version in `verapdf-source.json` changes.
