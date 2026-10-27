# @typfolio/paramdoc-export

**Experimental.** Exports a Typst template written in the paramdoc slot dialect as a *parametric document*: Typst
lays the template out once, and what comes out (`doc.json`, subset fonts, images) is what the paramdoc runtime
fills with data at a few hundred documents per second, without a compiler. The export also runs the proof that
the runtime's output will equal Typst's: nothing outside the declared slots may depend on the data (random data
is compiled and compared), every character a slot may contain is shaped through the real template, and other
data files can be laid out as references for the runtimes to be checked against.

The exporter is the Rust crate in `experiments/paramdoc/export` built to WebAssembly, so it runs in Node 22 or
later and needs no Rust toolchain. Its output is byte-identical to the native build's (the package's tests and
the experiment's `check.sh` compare them). The document format is unstable until 0.1: a document is read by the
runtime version that matches the exporter that wrote it.

The dialect, the contract and what is refused are described in `experiments/paramdoc/HANDOVER.md` and
`GAPS.md` in the repository; the runtime that reads the documents is `@typfolio/paramdoc`.

## Command line

```sh
npx paramdoc-export my-template --fonts fonts --out out --fuzz 100 --reference my-template/data.json
```

`my-template/` holds `main.typ`, `paramdoc.typ` (the dialect helper) and any images; `--data` defaults to
`my-template/data.json`; `--fonts` is a directory of `.otf`/`.ttf` files; `--out` receives `doc.json`,
`fonts/`, `images/`, `baseline.pdf` (Typst's own PDF of the sample) and the references. `--fuzz N` compiles N
random data samples and refuses the template if the layout outside the slots moved; `--reference data.json`
(repeatable) writes Typst's layout of that data as `reference.json` and `reference.pdf` (`reference-<name>.*`
for the second one on). `--plain-pdf out.pdf` only compiles `main.typ` and writes typst-pdf's output, for
reproducing Typst's own behaviour. Exit status 1 and a message on stderr when the template is refused; the
message names the element, the reason and the fix.

## API

```ts
import { createExporter } from '@typfolio/paramdoc-export';
import { exportDirectory, loadWasm } from '@typfolio/paramdoc-export/node';

// Anywhere WebAssembly runs: files in, files out.
const exporter = await createExporter(await loadWasm());   // 25 MB wasm, instantiate once
const result = exporter.export({
  template: { 'main.typ': mainTyp, 'paramdoc.typ': dialect },
  data: { name: 'Ada Lovelace', score: 97 },
  fonts: { 'LibertinusSerif-Regular.otf': fontBytes },
  references: { 'data-long': otherData },
  fuzz: 100,
});
if (result.error) throw new Error(result.error);           // a refusal, with the fix
result.files.get('doc.json');                              // and 'fonts/<file>', 'images/<file>', 'reference.json', …
result.log;                                                // what the command line prints

// Node: directories in, a directory out, as the command line does it.
await exportDirectory('my-template', { fonts: 'fonts', out: 'out', fuzz: 100 });
```

`createExporter` takes bytes, an `ArrayBuffer`, a compiled `WebAssembly.Module` or a `Response`; `loadWasm`
reads the package's own `generated/paramdoc_export.wasm`. An exporter runs any number of exports in turn.

## Numbers

Measured on an M-series Mac, Node 24, one export after instantiation:

| | |
|---|---|
| wasm | 25.4 MB raw, 8.9 MB gzipped |
| instantiate | 18 ms |
| the `wrap` fixture, no fuzz | 62 ms |
| the `wrap` fixture, 100 fuzz samples and two references | 0.33 s |
| the benchmark report (a flow document with variants), 100 fuzz samples | 4.7 s |

## Provenance

`generated/provenance.json` records the crate, the commit, the Typst version (0.15.1), the Rust toolchain
(1.92.0), the target, the release profile and the artifact's SHA-256; `experiments/paramdoc/build-export-wasm.sh
--check` rebuilds and fails if the hash differs.
