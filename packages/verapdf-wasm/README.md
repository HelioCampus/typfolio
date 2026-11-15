# @typfolio/verapdf-wasm

[veraPDF](https://verapdf.org/)'s PDF/A and PDF/UA validator as WebAssembly, for Node and browsers. **Not published
yet**: the package is private while the licence files are being finished. It is built locally, not in CI.

The files in `generated/` are produced by `npm run build:verapdf` at the repository root from the pins in
`verapdf-source.json`; see [docs/verapdf-build.md](../../docs/verapdf-build.md).

- `java/` is the source compiled into the image next to the veraPDF jars: the entry (`Validate`, `WasmMain`) and two
  classes that shadow ones in the jars (`com.sun.xml.bind.Util`, `org.verapdf.cos.filters.COSFilterFlateDecode`).
- `java-test/` is a JVM-only test that compares the replacement inflater with `java.util.zip.Inflater`.
- `native-image/` is the checked-in list of what the image may reach by reflection or load as a resource.
- `generated/verapdf.wasm` is the binary and `generated/verapdf.js` the loader made from GraalVM's launcher.
- `src/index.ts` is the API.

```ts
import { createValidator } from '@typfolio/verapdf-wasm';

const validator = await createValidator({ wasm });          // the bytes of verapdf.wasm, or a WebAssembly.Module
const report = validator.validate(pdfBytes, { flavour: 'ua1' });
// { flavour, compliant, totalAssertions, failedRules: [{ specification, clause, test, failedChecks, message, context }] }
```

`@typfolio/verapdf-wasm/verapdf.wasm` is the binary (about 31 MB, 10 MB gzipped); there is no default location, so
load it explicitly. `validate` is synchronous: in a browser, call it from a worker. Flavours are veraPDF's ids:
`ua1`, `ua2`, `1a` to `4f`, `wt1a`, `wt1r` (exported as `flavours`). Wrong input throws a `VerapdfError` with a
`code`: `INVALID_REQUEST`, `INITIALIZATION` or `VALIDATION` (veraPDF could not read the file).

A veraPDF pass is a machine check of the rules veraPDF implements. It does not establish that a document is
accessible.

## Licence

The package is not under one licence, and its binary is not open source as a whole. [`LICENSE`](./LICENSE) says which
terms apply to which part:

- the code written for this package is Apache-2.0;
- veraPDF is used under the Mozilla Public License 2.0, and the one veraPDF file that is modified stays under it;
- the runtime that GraalVM Native Image compiles into the binary stays under Oracle's
  [GraalVM Free Terms and Conditions](https://www.oracle.com/downloads/licenses/graal-free-license.html): free to
  use, also inside a company, and to redistribute unmodified, but not as part of something a fee is charged for.

`generated/THIRD_PARTY_NOTICES.md` lists every library and the font data in the binary with its licence, and
`generated/licenses/` has the texts. Both are written by the build from the jars and the GraalVM it used.
