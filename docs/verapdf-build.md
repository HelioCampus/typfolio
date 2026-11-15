# veraPDF WebAssembly build

## What is implemented

- `packages/verapdf-wasm`: [veraPDF](https://verapdf.org/)'s greenfield validator compiled ahead of time to WebAssembly with GraalVM Web Image, an ES module loader made from GraalVM's JavaScript launcher, and a small typed API (`createValidator`, `validate`). One build runs in Node and in a browser Web Worker.
- A pinned, scripted build (`tools/setup-verapdf.ts`, `tools/build-verapdf.ts`), checked-in reflection metadata (`tools/trace-verapdf.ts` regenerates it) and a parity check against unmodified veraPDF on the JVM (`tools/check-verapdf-parity.ts`).

`@typfolio/dev-tools/validate`, the `typfolio-validate` command and the tags panel's "veraPDF" row use it as an optional peer dependency ([packages/dev-tools/README.md](../packages/dev-tools/README.md#validation-with-verapdf)); nothing in dev-tools contains it.

Not implemented yet: third-party notices and publishing; the package is `private`. The validator is built and checked on a developer's machine only. CI does not build it, and the tests that need the binary are skipped where it is absent.

A veraPDF pass is a machine check of the rules veraPDF implements. It does not establish that a document is accessible.

## Source and tools

The source of truth is [`verapdf-source.json`](../verapdf-source.json):

| Item | Pin |
|---|---|
| veraPDF | `1.30.3`: `core`, `parser`, `pdf-model`, `validation-model`, `verapdf-xmp-core`, `metadata-fixer`, `feature-reporting` from Maven Central |
| Other jars | Rhino `1.7.15.1`, `jaxb-api` `2.3.1`, `jaxb-impl` `2.3.2`, `jaxb-core` `2.3.0.1`, `javax.activation-api` `1.2.0` |
| Jar integrity | SHA-256 of every jar, checked by setup and again by every build |
| GraalVM | Oracle GraalVM `25.5.5.0.3` (Java `25.0.5.0.3`); the archive hash is pinned for macOS arm64 only |
| Binaryen | `133` (`wasm-as`) |
| Our sources | `packages/verapdf-wasm/java` and `packages/verapdf-wasm/native-image` |
| Build | `javac -parameters`, then `native-image --tool:svm-wasm` |

veraPDF's dependencies that validation does not use are left out: Saxon, Jackson and stax-utils (reports, policy checks) and the command-line and GUI applications.

The distribution is part of the pin. The Community Edition binary of the same version has no WebAssembly backend (`native-image --tool:svm-wasm` fails with "Unknown name in option specification"); the backend's source is public in `oracle/graal`, but building it from source was not tried. Web Image is experimental, and its options and output may change between GraalVM releases.

## Rebuild

Prerequisites: Node 22.18+, and Binaryen 133's `wasm-as` on `PATH` (macOS: `brew install binaryen`; `WASM_AS=/absolute/path/to/wasm-as` selects another binary, whose version is checked).

```sh
npm run setup:verapdf
npm run build:verapdf
npm run check:verapdf
```

`setup:verapdf` downloads the pinned jars and Oracle GraalVM into `.build/verapdf` and checks every file against its pinned SHA-256. Downloading Oracle GraalVM means accepting the [GraalVM Free Terms and Conditions](https://www.oracle.com/downloads/licenses/graal-free-license.html). `GRAALVM_HOME` selects an existing installation instead; the build checks that its `release` file names Oracle GraalVM at the pinned version. There is no pinned archive hash for Linux yet, so on Linux setup stops until one is added or `GRAALVM_HOME` is set.

`build:verapdf` compiles the Java sources against the jars, builds the image, and writes `packages/verapdf-wasm/generated/`: `verapdf.wasm`, `verapdf.js` with its `verapdf.d.ts` (the loader, see below) and `provenance.json`. A build takes about 45 seconds on an Apple M-series machine and fails if the binary or the loader contains the repository's or GraalVM's local path.

Nothing is fetched or built twice. `setup:verapdf` keeps every jar and the GraalVM archive that is already in `.build/verapdf` with the pinned hash, and an unpacked GraalVM of the pinned version. `build:verapdf` does nothing when `generated/` was already built from the same inputs: the same `sourceSha256` (the pin, the Java sources, the metadata), the same GraalVM, platform and Binaryen, and files that still match the hashes in `provenance.json`. `npm run build:verapdf -- --force` builds anyway. Since two builds do not give the same bytes, keeping a build is also what keeps the binary you tested the binary you use.

`npm run build` then compiles the package's own `src/index.ts` to `dist/`; `npm test` runs `packages/verapdf-wasm/test`, which is skipped when the binary has not been built.

`check:verapdf` verifies the generated files against `provenance.json` and the pins (`tools/check-verapdf-package.ts`), compares the inflater with `java.util.zip.Inflater` (`tools/check-verapdf-inflater.ts`) and runs the parity check below. It takes about a minute.

Generated files and everything under `.build/` are ignored by Git.

## What had to change to make veraPDF run

Four things in veraPDF or its libraries do not work in an ahead-of-time WebAssembly image. Each fix is small and none changes a jar.

1. **JAXB's logger.** `com.sun.xml.bind.Util.getClassLogger()` names its logger after `new Exception().getStackTrace()[1]`. A Web Image build has no Java stack frames, so every JAXB class initialiser threw `ArrayIndexOutOfBoundsException` and no validation profile could be read. `java/com/sun/xml/bind/Util.java` shadows the class with the same API and a fallback name.
2. **Rhino's compiler.** veraPDF runs each rule test as JavaScript in Rhino and asks for optimisation level 9, which compiles scripts to JVM bytecode and loads it at run time. Rhino finds its compiler by reflection and falls back to its interpreter when the lookup fails, so the compiler is left out of the reflection metadata. Rule tests are then interpreted.
3. **Flate decoding.** `java.util.zip.Inflater` is backed by native zlib, which the image does not have. `java/org/verapdf/cos/filters/COSFilterFlateDecode.java` is veraPDF Parser 1.30.3's file with that one class replaced by `PureInflater`, a plain Java inflater in the same package. See [The inflater](#the-inflater).
4. **Reflection and resources.** Rule tests call model getters through Rhino by reflection, and CMaps, font metrics and profiles are loaded by name. The image only contains what the metadata lists.

The shadowed classes work because the build puts our compiled classes before the jars on the class path. Two SAX helper classes are also initialised at build time (`initializeAtBuildTime` in the pin), because JAXB keeps instances of them in static fields that end up in the image heap.

### Reflection metadata

`packages/verapdf-wasm/native-image/META-INF/native-image/reachability-metadata.json` is checked in, and the build never traces. `npm run trace:verapdf` regenerates it: it runs the validator on the JVM under GraalVM's tracing agent for every PDF in `.build/test-output` (written by `npm test`; another directory can be passed) under 15 flavours, and then makes the result independent of the samples:

- Rhino's compiler (`org.mozilla.javascript.optimizer`) is removed.
- Every class under `org.verapdf.model` and `org.verapdf.gf.model` in the jars is registered with all its methods and fields. Tracing alone was not enough: with metadata traced from 12 runs, 67 of 264 parity runs failed with a missing reflection registration.
- The JDK collection classes that model getters return (`ArrayList`, the `Collections` and `ImmutableCollections` wrappers and so on) are registered with their public methods, because rule tests call `list.contains(...)` and the like the same way. Without this, the WTPDF reuse profile failed in the image with "Cannot find function contains", on a list class that no traced run had touched.
- `font/`, `font/cmap/`, `font/stdmetrics/`, the validation profiles, the release properties and Rhino's message bundle are included whole.

Entries are sorted, so a re-trace only shows real changes. Run it after changing the veraPDF version or the Java sources, review the diff and commit it. What tracing still decides is the JAXB side (which annotated classes and proxies are needed to read a profile); a profile that none of the 15 flavours loads would be missing its part. The WCAG flavours are such a case, and are not offered: their profiles need veraPDF's optional `wcag-validation` jar, which is not among the pinned jars.

## The inflater

What veraPDF's Flate filter does with a damaged stream depends on exactly when the inflater reports an error, how much it has written by then and how much input it has taken: on an error the filter resets the inflater, starts again from where the failed call began and reads one byte at a time until the error comes back. A replacement that decodes correct streams correctly is therefore not enough. `PureInflater` follows zlib's `inflate()` state by state:

- it keeps decoding after the output is full until it has to write, so an error in the next symbol is reported by the call before;
- a distance that reaches back before the start of the data is only detected when the match is about to be copied;
- an incomplete Huffman code is accepted only when its longest code is one bit, and a code without codes behaves like zlib's table of invalid entries;
- bytes written by a call that ends in an error are not reported, an error stays until `reset()`, and `getRemaining()` counts whole bytes not taken.

`tools/check-verapdf-inflater.ts` checks this on the JVM, where both inflaters exist, with `java-test/org/verapdf/cos/filters/InflaterFuzz.java`:

1. Both are driven with the same calls over generated zlib streams: varied data at four levels and three strategies, left intact or damaged (bit flips, truncation, overwritten and inserted bytes, trailing bytes, a preset-dictionary flag, raw deflate, random bytes behind a valid header), fed in chunks of 1 byte to 1 MB, read 1 to 70,000 bytes at a time, with resets at arbitrary points. Every result, exception, written byte and remaining-input count must be the same.
2. The same streams are decoded through `COSFilterFlateDecode`, with veraPDF's own class and with the shadowed one, including a reset after a few reads. What comes out must be the same.

Measured: 8,000 cases identical in both modes (about 5,600 of them end in a data error). The harness was checked against planted bugs: a missing checksum comparison, no decoding past a full output, a wrong rule for incomplete codes, and a `reset()` that left a half-read symbol behind were each reported. That last one was a real bug, found by the damaged-file parity run before the harness could see it; the harness then got resets that start again from the beginning of the stream.

This is evidence for the cases generated, not a proof. The JVM runs the Java source; the image runs the same source compiled by GraalVM, which the damaged-file parity run covers for 88 files.

## Parity

`tools/check-verapdf-parity.ts` validates every PDF in `.build/test-output` under 15 flavours (`ua1`, `ua2`, `1a`, `1b`, `2a`, `2b`, `2u`, `3a`, `3b`, `3u`, `4`, `4e`, `4f`, `wt1a`, `wt1r`) with the WebAssembly build and with veraPDF on the JVM, and fails unless the verdict, the number of assertions and the failed rules with their failed-check counts are the same. The JVM side puts the jars before our classes, so it runs veraPDF's own Flate filter and JAXB's own `Util`. The order of failed rules is not compared.

It then does the same for damaged copies: four per file, each with one to three bytes inside stream data overwritten (a fixed pseudo-random sequence, so the copies are the same on every run), under `ua1` and `2b`. Here the two sides must agree on whatever comes out, an error included.

Measured on macOS arm64, Node 24: 330 of 330 runs on intact files match (22 files × 15 flavours), and 176 of 176 on damaged ones (88 files × 2 flavours). The files are Typfolio's own test outputs: no encrypted files and no embedded files with unusual filters. ### Browsers

`tests/browser/verapdf.spec.ts` (part of `npm run test:browsers`) starts the validator in a module worker in Chromium, Firefox and WebKit, validates two PDFs compiled by the test under `ua1`, `ua2`, `2b` and `wt1r`, and requires each report to equal the one the same build gives in Node. The page and the worker are served with `Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'` (`tools/serve-smoke.ts`), and the test checks that the policy is in force (`new Function` is refused in the page and in the worker), that nothing else violates it, that the worker gains no globals and that errors arrive with their codes. All three engines pass. Measured there: 160 to 410 ms until the validator is ready, 250 to 340 ms for the first validation, 10 to 30 ms after that.

## Compatibility and limits

| Topic | State |
|---|---|
| Malformed Flate streams | Same as veraPDF on the JVM for everything tested (see [The inflater](#the-inflater)); not proven beyond that. |
| Log output | veraPDF's warnings (an unreadable font program, for example) go to the console through `java.util.logging`. They are not part of the report and cannot be turned off yet. |
| Other stream filters | LZW, ASCII85, ASCIIHex, RunLength and DCT/JPX handling are veraPDF's own Java and were not changed; only the well-formed sample files exercise them. |
| Speed | About 0.2 s to start, about 0.3 s for the first validation, then 7 to 30 ms per sample file in Node. Rule tests are interpreted, and `PureInflater` reads Huffman codes one bit at a time. |
| Size | About 30.8 MB, 9.6 MB with gzip -9. The exact size varies between builds. |
| Runtime | Needs WebAssembly garbage collection, exception handling and typed function references: Node 22 with `--experimental-wasm-exnref`, Node 24+ without, and current browsers. |
| Input size | The PDF crosses into the image as a string with one UTF-16 code unit per byte, so a file briefly takes about three times its size (the bytes, the string, the Java copy). Not measured on large files. |
| Flavours | The 15 above, by veraPDF's ids. No WCAG flavours. Flavour detection from the file's metadata is not wired up. |
| Unreadable input | Bytes that veraPDF cannot parse as a PDF throw a `VerapdfError` with code `VALIDATION`; the instance stays usable. |

## The loader and the API

GraalVM's launcher is a classic script: it starts the VM as soon as it is loaded, looks for `<its own file name>.wasm` next to itself, and what the Java side exports ends up in globals. `tools/build-verapdf.ts` turns it into an ES module with one export, `instantiate(wasm)`:

- the trailing block that reads the command line and starts the VM is dropped;
- the binary comes from the caller, as bytes or a compiled `WebAssembly.Module`, and there is no default location, so a bundler does not discover and inline a 30 MB asset;
- the launcher's body runs inside the function, so every call starts a VM of its own and nothing is added to `globalThis`. The Java entry hands its function to a variable of that function (`typfolioVerapdfExport`, see `java/WasmMain.java`).

Each patch names the exact text it replaces and the build fails when that text is not there exactly once, so a GraalVM update that changes the launcher is noticed. The loader constructs no code (`new Function`, `eval`); the build, `check-verapdf-package` and the package's tests check that, so a page can load it under a Content Security Policy that allows `'wasm-unsafe-eval'` without `'unsafe-eval'`. The browser test runs under such a policy.

The Web Image API cannot turn a JavaScript typed array into a Java `byte[]`: `JSObject.as(byte[].class)` throws `ClassCastException` for `Uint8Array`, `Int8Array` and `ArrayBuffer` (checked with GraalVM 25.5), and a proxied array costs one call per byte. Strings cross in one piece. So `validate` takes a `Uint8Array` and the package turns it into a string with one code unit per byte, which the Java entry maps back with ISO-8859-1.

`packages/verapdf-wasm/src/index.ts` is the public API on top: `createValidator({ wasm })` and `validator.validate(bytes, { flavour })`, which returns `{ flavour, compliant, totalAssertions, failedRules }` or throws a `VerapdfError` (`INVALID_REQUEST`, `INITIALIZATION`, `VALIDATION`). It is synchronous and has no worker of its own. Two details are deliberate:

- The Java entry looks the flavour up with `PDFAFlavour.byFlavourId`, not `fromString`. `fromString("wt1a")` returns PDF/A-1a, on the JVM as well, so the WTPDF accessibility flavour would silently have been validated as something else.
- The report carries the flavour the image actually used, and `validate` throws if it is not the one asked for.
- `failedRules` is sorted by specification, clause (numbers as numbers) and test. veraPDF keeps failed rules in a hash map, and for the same file and build their order differed between Node and the browsers.

## Reproducibility

The build is **not** byte-for-byte reproducible. Three builds of the same inputs on one machine gave three different binaries (30,605,099, 30,625,115 and 30,668,817 bytes); GraalVM's launcher was identical each time. `--parallelism=1` did not change that. The cause was not investigated.

For that reason `wasmSha256` and `launcherSha256` in the pin are `null`, and nothing compares a build with a reviewed artifact, unlike the compiler build. What is checked instead:

- the inputs: every jar and the GraalVM archive by SHA-256, GraalVM's and Binaryen's versions, and `sourceSha256` in `provenance.json`, a hash over the pin (without the output hashes), the Java sources and the metadata;
- the behaviour: the parity check.

If a later GraalVM makes the output stable, set the two hashes in the pin; `tools/check-verapdf-package.ts` already compares them when they are not `null`.

## Licences

The binary is not open source as a whole, which is why it is a package of its own and nothing else in the repository may bundle it:

- veraPDF is dual-licensed GPLv3+ / MPLv2+ and is used under the MPL 2.0. The replacement `COSFilterFlateDecode.java` is a modified veraPDF file and stays under the MPL 2.0.
- Rhino is MPL 2.0. The JAXB runtime is CDDL 1.1 or GPLv2 with the Classpath exception. These were not read file by file; that belongs to generating the third-party notices.
- The runtime that Native Image compiles into the binary comes from Oracle GraalVM and stays under the GraalVM Free Terms and Conditions: it may be used, including inside a company, and redistributed unmodified free of charge "under the terms of this License", but not as part of a product or service that a fee is charged for.

This is a reading of the licence texts, not legal advice.
