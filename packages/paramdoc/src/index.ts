// @typfolio/paramdoc: fills a parametric document (exported from a Typst template in the slot dialect by
// @typfolio/paramdoc-export) with data and writes a tagged PDF/UA-1, without a compiler. The runtime only does
// what Typst's own layout was ported and proven for; anything else is refused with a message, so that its
// output is the compiler's, never an approximation of it. No dependencies; runs in browsers, workers and Node.
//
// `createRuntime` fills on the calling thread; `createWorkerClient` runs a pool of Web Workers, one runtime
// each, with `fillBatch` for many documents at once.
export { IR_VERSION, type Document } from './runtime.js';
export { ParamdocError, type ParamdocErrorCode } from './errors.js';
export { createRuntime, type DocumentInput, type FillResult, type ParamdocRuntime } from './runtime-api.js';
export { createWorkerClient, type CreateWorkerClientOptions, type FillOptions, type ParamdocWorkerClient } from './client.js';
export { collectBatch, fillBatch, type FillBatchOptions, type FillJob, type FillOutcome, type FillProgress } from './batch.js';
