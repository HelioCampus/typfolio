# @typfolio/paramdoc

## 0.0.1

### Patch Changes

- First release, experimental: fills a parametric document with data and writes a tagged PDF/UA-1 without a compiler, in a few hundred microseconds per document. The document is a Typst template in the paramdoc slot dialect that `@typfolio/paramdoc-export` laid out once with Typst. The runtime's output equals Typst's own layout of the same data, glyph for glyph, or the data is refused with a message that names the slot, the reason and the fix.

  - `createRuntime({ document, fonts, images? })` parses the document once and compresses its fonts; `runtime.fill(data)` returns the PDF and its page count; `runtime.names` lists the names the data binds to (slots, bars, image slots, bands).
  - `createWorkerClient({ document, workerCount?, queueLimit?, timeoutMs?, workerName?, workerFactory? })` runs fills on a pool of Web Workers (`@typfolio/paramdoc/worker`), in the shape of `@typfolio/workers`' client without Effect; `fillBatch` and `collectBatch` fill many documents with at most `workerCount` in flight. Cancelling a waiting fill removes it from the queue; cancelling a running one rejects it at once and keeps its worker; a timeout terminates the worker it ran on.
  - `ParamdocError` with the codes `document`, `fill`, `worker`, `timeout`, `queue-full`, `aborted` and `disposed`.
  - Supported in slots: Latin with the extended blocks, Greek and Cyrillic, precomposed; one font, size and colour per slot; single lines with the error, clip, shrink and ellipsis policies; wrapping slots that break as Typst's simple breaker does, ragged or justified, with web addresses, soft hyphens and middle dots; integers, booleans and strings as values; bars, PNG and JPEG image slots, link slots, repeating bands with variants. The inventory of what is not supported and why is `experiments/paramdoc/GAPS.md` in the repository.
  - No dependencies; 39 kB minified, 15 kB gzipped on the calling thread, 41 kB and 16 kB as a worker; browsers, Web Workers and Node 22 or later. The document format is unstable until 0.1: a document is read by the runtime version that matches the exporter that wrote it.
