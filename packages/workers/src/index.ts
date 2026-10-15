import type { PdfRequest, PdfResult } from '@typfolio/core';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { decodeRuntimeMessage, protocolVersion, type HostMessage } from './protocol.js';
import { snapshotRequest } from './snapshot.js';
import {
  TypfolioWorkerError,
  type CreateWorkerClientOptions,
  type PdfWorkerClient,
  type SerializedCompilerOptions,
  type WorkerCompileOptions,
  type WorkerCompilerOptions,
  type WorkerFontSource,
  type WorkerWasmSource,
} from './types.js';

export {
  TypfolioWorkerError,
  type CreateWorkerClientOptions,
  type PdfWorkerClient,
  type WorkerCompileOptions,
  type WorkerCompilerOptions,
  type WorkerErrorCode,
  type WorkerFontSource,
  type WorkerWasmSource,
  type PdfBatchJob,
  type PdfBatchOptions,
  type PdfBatchOutcome,
  type PdfBatchProgress,
} from './types.js';
export { collectBatch, compileBatch } from './batch.js';

interface Job {
  readonly id: number;
  readonly request: PdfRequest<unknown>;
  readonly resume: (effect: Effect.Effect<PdfResult, TypfolioWorkerError>) => void;
  settled: boolean;
}

interface WorkerSlot {
  readonly worker: Worker;
  readonly index: number;
  ready: boolean;
  active?: Job;
}

const maximumTimer = 2_147_483_647;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new RangeError(`${name} must be a positive integer`);
  return result;
}

function timeout(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > maximumTimer) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximumTimer}`);
  }
  return value;
}

function snapshotWasm(value: WorkerWasmSource): WorkerWasmSource {
  if (typeof value === 'string' || value instanceof WebAssembly.Module) return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError('compiler.wasm must be a URL string, ArrayBuffer, Uint8Array, or WebAssembly.Module');
}

/** Bytes are copied; a URL becomes its `href`; a string is resolved here, because in a worker it would resolve against the worker script. */
function snapshotFont(font: unknown, index: number): Uint8Array | string {
  const at = `compiler.fonts[${index}]`;
  if (font instanceof Uint8Array) {
    if (!font.length) throw new TypeError(`${at} must not be empty`);
    return new Uint8Array(font);
  }
  if (font instanceof URL) return font.href;
  if (typeof font !== 'string' || !font.trim()) throw new TypeError(`${at} must be a Uint8Array, a URL, or a non-empty URL string`);
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return (base === undefined ? new URL(font) : new URL(font, base)).href;
  } catch (cause) {
    throw new TypeError(`${at} cannot be resolved to a URL${base === undefined ? ' without a page URL; use an absolute URL' : ''}: ${JSON.stringify(font)}`, { cause });
  }
}

function snapshotCompiler(value: WorkerCompilerOptions): SerializedCompilerOptions {
  if (!value || !Array.isArray(value.fonts) || !value.fonts.length) {
    throw new TypeError('compiler.fonts must contain at least one Uint8Array, URL, or URL string');
  }
  return { wasm: snapshotWasm(value.wasm), fonts: value.fonts.map(snapshotFont) };
}


function workerError(message: string, cause?: unknown): TypfolioWorkerError {
  return new TypfolioWorkerError('WORKER', message, [], cause === undefined ? undefined : { cause });
}

function defaultWorkerFactory(name: string): (index: number) => Worker {
  return index => new Worker(new URL('./runtime.js', import.meta.url), { type: 'module', name: `${name}-${index + 1}` });
}

export function createWorkerClient(options: CreateWorkerClientOptions): PdfWorkerClient {
  const compiler = snapshotCompiler(options.compiler);
  const workerCount = positiveInteger(options.workerCount, 1, 'workerCount');
  const queueLimit = positiveInteger(options.queueLimit, 32, 'queueLimit');
  const defaultTimeout = timeout(options.timeoutMs, 'timeoutMs');
  const createWorker = options.workerFactory ?? defaultWorkerFactory(options.workerName ?? 'typfolio-pdf');
  const queue: Job[] = [];
  const slots = new Array<WorkerSlot | undefined>(workerCount);
  let nextId = 1;
  let poolDisposed = false;
  let clientDisposed = false;
  let disposal: Promise<void> | undefined;

  function settle(job: Job, result: Effect.Effect<PdfResult, TypfolioWorkerError>): void {
    if (job.settled) return;
    job.settled = true;
    job.resume(result);
  }

  function terminateWorker(current: WorkerSlot | undefined): void {
    if (!current) return;
    if (slots[current.index] === current) slots[current.index] = undefined;
    current.worker.terminate();
  }

  function dispatchSoon(): void {
    queueMicrotask(dispatch);
  }

  function failActive(error: TypfolioWorkerError, current: WorkerSlot): void {
    if (slots[current.index] !== current) return;
    const job = current.active;
    current.active = undefined;
    terminateWorker(current);
    const failed = job ?? queue.shift();
    if (failed) settle(failed, Effect.fail(error));
    dispatchSoon();
  }

  function handleMessage(current: WorkerSlot, value: unknown): void {
    if (poolDisposed || slots[current.index] !== current) return;
    let message;
    try {
      message = decodeRuntimeMessage(value);
    } catch (cause) {
      failActive(workerError('Typfolio worker returned an invalid message', cause), current);
      return;
    }
    if (message.type === 'ready') {
      if (current.ready) {
        failActive(workerError('Typfolio worker initialized more than once'), current);
        return;
      }
      current.ready = true;
      dispatch();
      return;
    }
    if (message.type === 'failure' && message.id === undefined) {
      const error = new TypfolioWorkerError(message.error.code, message.error.message, message.error.diagnostics);
      failActive(error, current);
      return;
    }
    const job = current.active;
    if (!job || message.id !== job.id) return;
    current.active = undefined;
    if (message.type === 'result') {
      settle(job, Effect.succeed(message.result));
    } else {
      settle(job, Effect.fail(new TypfolioWorkerError(
        message.error.code,
        message.error.message,
        message.error.diagnostics,
      )));
    }
    dispatch();
  }

  function createSlot(index: number): boolean {
    let worker: Worker;
    try {
      worker = createWorker(index);
    } catch (cause) {
      const job = queue.shift();
      if (job) settle(job, Effect.fail(workerError('Could not create Typfolio worker', cause)));
      dispatchSoon();
      return false;
    }
    const current: WorkerSlot = { worker, index, ready: false };
    slots[index] = current;
    worker.addEventListener('message', event => handleMessage(current, event.data));
    worker.addEventListener('error', event => {
      failActive(workerError(event.message || 'Typfolio worker failed'), current);
    });
    worker.addEventListener('messageerror', () => {
      failActive(workerError('Typfolio worker returned an unreadable message'), current);
    });
    const message: HostMessage = { protocol: protocolVersion, type: 'initialize', compiler };
    try {
      worker.postMessage(message);
    } catch (cause) {
      failActive(workerError('Could not initialize Typfolio worker', cause), current);
    }
    return true;
  }

  function ensureCapacity(): void {
    if (poolDisposed || !queue.length) return;
    const activeCount = slots.reduce((count, current) => count + (current?.active ? 1 : 0), 0);
    const target = Math.min(workerCount, activeCount + queue.length);
    let existing = slots.reduce((count, current) => count + (current ? 1 : 0), 0);
    for (let index = 0; index < slots.length && existing < target; index += 1) {
      if (!slots[index]) {
        if (!createSlot(index)) break;
        existing += 1;
      }
    }
  }

  function dispatch(): void {
    if (poolDisposed || !queue.length) return;
    ensureCapacity();
    for (const current of slots) {
      if (!current?.ready || current.active) continue;
      const job = queue.shift();
      if (!job) return;
      current.active = job;
      const message: HostMessage = { protocol: protocolVersion, type: 'compile', id: job.id, request: job.request };
      try {
        current.worker.postMessage(message);
      } catch (cause) {
        failActive(workerError('Could not send work to Typfolio worker', cause), current);
      }
    }
  }

  function interruptJob(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    const current = slots.find(candidate => candidate?.active === job);
    if (current) {
      current.active = undefined;
      terminateWorker(current);
      dispatchSoon();
      return;
    }
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
  }

  const compileJob = Effect.fnUntraced(function*(
    request: PdfRequest<unknown>,
  ): Effect.fn.Return<PdfResult, TypfolioWorkerError> {
    return yield* Effect.callback<PdfResult, TypfolioWorkerError>(resume => {
      if (poolDisposed) {
        resume(Effect.fail(new TypfolioWorkerError('DISPOSED', 'The worker client is disposed')));
        return;
      }
      if (queue.length >= queueLimit) {
        resume(Effect.fail(new TypfolioWorkerError('QUEUE_FULL', `The worker queue limit of ${queueLimit} was reached`)));
        return;
      }
      const job: Job = { id: nextId++, request, resume, settled: false };
      queue.push(job);
      dispatch();
      return Effect.sync(() => interruptJob(job));
    });
  });

  function waitForAbort(signal: AbortSignal): Effect.Effect<never, TypfolioWorkerError> {
    return Effect.callback<never, TypfolioWorkerError>(resume => {
      const abort = (): void => resume(Effect.fail(new TypfolioWorkerError(
        'ABORTED',
        'Compilation was cancelled',
        [],
        { cause: signal.reason },
      )));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      return Effect.sync(() => signal.removeEventListener('abort', abort));
    });
  }

  const disposePool: Effect.Effect<void> = Effect.sync(() => {
    if (poolDisposed) return;
    poolDisposed = true;
    const error = new TypfolioWorkerError('DISPOSED', 'The worker client is disposed');
    for (const current of slots) {
      if (current?.active) {
        const job = current.active;
        current.active = undefined;
        settle(job, Effect.fail(error));
      }
    }
    for (const job of queue.splice(0)) settle(job, Effect.fail(error));
    for (const current of slots) terminateWorker(current);
  });

  const runtime = ManagedRuntime.make(Layer.effectDiscard(
    Effect.acquireRelease(Effect.void, () => disposePool),
  ));

  return {
    workerCount,
    compile(request: PdfRequest<unknown>, compileOptions: WorkerCompileOptions = {}): Promise<PdfResult> {
      if (clientDisposed) return Promise.reject(new TypfolioWorkerError('DISPOSED', 'The worker client is disposed'));
      if (compileOptions.signal?.aborted) {
        return Promise.reject(new TypfolioWorkerError('ABORTED', 'Compilation was cancelled', [], { cause: compileOptions.signal.reason }));
      }
      let captured: PdfRequest<unknown>;
      let duration: number | undefined;
      try {
        captured = snapshotRequest(request);
        duration = timeout(compileOptions.timeoutMs, 'compile timeoutMs') ?? defaultTimeout;
      } catch (error) {
        return Promise.reject(error);
      }
      let program = compileJob(captured);
      if (duration !== undefined) {
        program = Effect.timeoutOrElse(program, {
          duration,
          orElse: () => Effect.fail(new TypfolioWorkerError(
            'TIMEOUT',
            `Compilation exceeded its ${duration} ms timeout`,
          )),
        });
      }
      if (compileOptions.signal) {
        program = Effect.raceFirst(program, waitForAbort(compileOptions.signal));
      }
      return runtime.runPromise(program);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      clientDisposed = true;
      return disposal = Effect.runPromise(disposePool).then(() => runtime.dispose());
    },
  };
}
