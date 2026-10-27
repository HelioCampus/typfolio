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

No dependencies; 39 kB minified, 15 kB gzipped on the calling thread, 41 kB and 16 kB as a worker with its
protocol; browsers, Web Workers and Node 22 or later. The document format is unstable until 0.1: a document is read
by the runtime version that matches the exporter that wrote it.

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

### In Web Workers

```ts
import { createWorkerClient, fillBatch } from '@typfolio/paramdoc';

// A pool of Web Workers, one runtime each, started lazily as fills arrive; the document and its fonts are copied
// into each worker as it starts.
const client = createWorkerClient({ document: { document: docJsonBytes, fonts }, workerCount: 4, timeoutMs: 60_000 });
const { pdf } = await client.fill(data, { signal });

// Many documents: at most workerCount fills in flight, outcomes as they settle, in completion order.
for await (const outcome of fillBatch(client, rows.map((data, id) => ({ id, data })), { signal })) {
  if (outcome.status === 'success') save(outcome.id, outcome.result.pdf);
  else if (outcome.status === 'error') console.error(outcome.id, outcome.error.code, outcome.error.message);
}
await client.dispose();
```

The client has the shape and the rules of `@typfolio/workers`' `createWorkerClient` and `compileBatch`, without
Effect. Fills are queued in order and run one per worker; `fill` copies its data synchronously, so the object can
be reused at once. Cancelling a waiting fill removes it from the queue; cancelling a running one rejects it at once
and lets its worker finish quietly, since a fill takes a fraction of a millisecond and a worker restart (the fonts
compressed again) takes far longer. A timeout, queue time included, terminates the worker it ran on and the next
fill gets a fresh one. `dispose` rejects every fill with `disposed` and terminates every worker. Every rejection is
a `ParamdocError`: the runtime's own `document` and `fill` codes, or `worker`, `timeout`, `queue-full`, `aborted`,
`disposed`; in a batch, a refused document is that job's `error` outcome and the rest go on. `collectBatch` gathers
the outcomes into input order. The worker itself is `@typfolio/paramdoc/worker`, started as
`new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, which Vite ships as its own file;
`workerFactory` makes the workers for other hosts (Node has no Web Worker: the package's tests drive the worker
side in-process through `workerFactory`).

`@typfolio/paramdoc/internal` exposes the runtime as the experiment's proof uses it (the `Runtime` class with its
slot trace, `compare` against a reference layout, the document's types); it is not part of the public API and
changes with the document format.

## Numbers

One thread, the benchmark report (a page with a table of up to eight rows, score bars and a three-line comment),
M-series Mac: about 3,250 documents per second in Node, median 0.29 ms per document, 69 kB per PDF (the two
subset fonts are embedded in every file). In the browser, through `createWorkerClient` and `fillBatch` on four
workers, the demo in the repository (`examples/pretext-hybrid`, the performance page's engine switch) renders
200 of these reports in 0.1 s: about 2,100 per second with the four cold starts of 20 ms included, 1 ms median
per fill.
