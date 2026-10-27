# @typfolio/paramdoc

**Experimental.** Fills a *parametric document* with data and writes a tagged PDF/UA-1, without a compiler, in a
few hundred microseconds per document. The document is a Typst template in the paramdoc slot dialect that
`@typfolio/paramdoc-export` laid out once with Typst: static content as it was typeset, and holes (text slots,
wrapping slots, bars, image slots, link slots, repeating bands with variants) that this runtime fills from the
data by the names the template gave them.

The one rule: the runtime's output equals Typst's own layout of the same data, glyph for glyph, or the runtime
refuses the data with a message that names the slot, the reason and the fix. It only does what was ported from
Typst and proven against it (`experiments/paramdoc` in the repository: a Rust twin of this runtime, Typst
references, random data, pixels, veraPDF); everything else is refused at export time, before a document exists,
or here at fill time. Supported in slots: Latin with the extended blocks, Greek and Cyrillic, precomposed, one
font, size and colour per slot; single lines with the error, clip, shrink and ellipsis policies; wrapping slots
that break as Typst's simple breaker does, ragged or justified, web addresses, soft hyphens and middle dots
included; integers, booleans and strings as values; PNG and JPEG images. The inventory of what is not supported
and why is `experiments/paramdoc/GAPS.md`.

No dependencies, 39 kB minified, 15 kB gzipped; browsers, Web Workers and Node 22 or later. The document format
is unstable until 0.1: a document is read by the runtime version that matches the exporter that wrote it.

## API

```ts
import { createRuntime, ParamdocError } from '@typfolio/paramdoc';

// Once per document (in a worker, once per worker): parses it and compresses the fonts.
const runtime = await createRuntime({ document: docJsonBytes, fonts: [regularBytes, boldBytes] });
runtime.names;                     // the names the data binds to: slots, bars, image slots, bands
const { pdf, pages } = await runtime.fill({ name: 'Ada Lovelace', score: 97, courses: [...] });
```

`createRuntime` throws `ParamdocError` with `code: 'document'` when the document, its fonts or its images cannot
be used (a format version this runtime does not read, a font whose hash is not the document's); `fill` throws it
with `code: 'fill'` when the data cannot be laid out as Typst would lay it out. The document and its fonts come
from the exporter's output directory: `doc.json` and `fonts/*` in the order `doc.json` lists them.

`@typfolio/paramdoc/internal` exposes the runtime as the experiment's proof uses it (the `Runtime` class with its
slot trace, `compare` against a reference layout, the document's types); it is not part of the public API and
changes with the document format.

## Numbers

One thread, the benchmark report (a page with a table of up to eight rows, score bars and a three-line comment),
M-series Mac: about 3,250 documents per second in Node, median 0.29 ms per document, 69 kB per PDF (the two
subset fonts are embedded in every file). In the browser, in Web Workers, the demo in the repository renders
the same batch at several thousand documents per second across four workers.
