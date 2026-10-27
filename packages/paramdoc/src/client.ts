// A pool of Web Workers, one runtime each, behind one `fill`. The shape and the rules are those of
// `@typfolio/workers`' `createWorkerClient`, without Effect: fills are queued in order and run one per worker,
// workers start lazily, a timeout terminates the worker it ran on, `dispose` rejects everything and terminates
// every worker. One difference: cancelling a running fill rejects it and lets the worker finish quietly, since a
// fill takes a fraction of a millisecond and a worker restart (the fonts compressed again) takes far longer.
import { ParamdocError, messageOf } from './errors.js';
import { decodeWorkerMessage, protocolVersion, type HostMessage } from './protocol.js';
import type { DocumentInput, FillResult } from './runtime-api.js';

export interface FillOptions {
  /** Aborting a waiting fill removes it from the queue; aborting a running one rejects it at once. Either way
   *  the fill rejects with `code: 'aborted'`. */
  readonly signal?: AbortSignal;
  /** Queue time included. Overrides the client's `timeoutMs`. */
  readonly timeoutMs?: number;
}

export interface ParamdocWorkerClient {
  readonly workerCount: number;
  /** Fills the document in a worker. `data` is copied here, synchronously, so it can be reused at once. Rejects
   *  with `ParamdocError`: the runtime's own `document` and `fill` codes, or `worker`, `timeout`, `queue-full`,
   *  `aborted`, `disposed`. */
  fill(data: unknown, options?: FillOptions): Promise<FillResult>;
  /** Rejects every waiting and running fill with `disposed` and terminates every worker. Idempotent. */
  dispose(): Promise<void>;
}

export interface CreateWorkerClientOptions {
  /** Copied into every worker as it starts (a structured clone), so the caller keeps its bytes. */
  readonly document: DocumentInput;
  /** Fills running at once. Workers start lazily, one per concurrent fill. Defaults to one. */
  readonly workerCount?: number;
  /** Waiting fills, the running ones excluded; one more rejects with `queue-full`. Defaults to 1024. */
  readonly queueLimit?: number;
  /** Default per-fill timeout, queue time included. Omit for none. */
  readonly timeoutMs?: number;
  /** The name the built-in worker factory gives its workers, numbered from 1. */
  readonly workerName?: string;
  /** Makes the workers; the client owns and terminates them. For tests and custom hosts. */
  readonly workerFactory?: (index: number) => Worker;
}

interface Job {
  readonly id: number;
  readonly data: unknown;
  readonly resolve: (result: FillResult) => void;
  readonly reject: (error: ParamdocError) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

interface Slot {
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

function bytesList(value: unknown, name: string): Uint8Array[] {
  if (!Array.isArray(value) || value.some(item => !(item instanceof Uint8Array))) throw new TypeError(`${name} must be a list of Uint8Array`);
  return [...value] as Uint8Array[];
}

function defaultWorkerFactory(name: string): (index: number) => Worker {
  return index => new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: `${name}-${index + 1}` });
}

export function createWorkerClient(options: CreateWorkerClientOptions): ParamdocWorkerClient {
  const input = options.document;
  if (!input || (!(input.document instanceof Uint8Array) && typeof input.document !== 'string')) {
    throw new TypeError('document.document must be a Uint8Array or a string');
  }
  const open: HostMessage = {
    protocol: protocolVersion,
    type: 'open',
    document: input.document,
    fonts: bytesList(input.fonts, 'document.fonts'),
    images: input.images === undefined ? [] : bytesList(input.images, 'document.images'),
  };
  const workerCount = positiveInteger(options.workerCount, 1, 'workerCount');
  const queueLimit = positiveInteger(options.queueLimit, 1024, 'queueLimit');
  const defaultTimeout = timeout(options.timeoutMs, 'timeoutMs');
  const createWorker = options.workerFactory ?? defaultWorkerFactory(options.workerName ?? 'paramdoc');
  const queue: Job[] = [];
  const slots = new Array<Slot | undefined>(workerCount);
  let nextId = 1;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function settle(job: Job, outcome: { ok: FillResult } | { error: ParamdocError }): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.cleanup?.();
    if ('ok' in outcome) job.resolve(outcome.ok);
    else job.reject(outcome.error);
  }

  function terminate(slot: Slot): void {
    if (slots[slot.index] === slot) slots[slot.index] = undefined;
    slot.worker.terminate();
  }

  function dispatchSoon(): void {
    queueMicrotask(dispatch);
  }

  /** The worker is gone: its running fill fails with `error`, or the next waiting one if it had none. */
  function failSlot(slot: Slot, error: ParamdocError): void {
    if (slots[slot.index] !== slot) return;
    const job = slot.active;
    slot.active = undefined;
    terminate(slot);
    const failed = job ?? queue.shift();
    if (failed) settle(failed, { error });
    dispatchSoon();
  }

  function onMessage(slot: Slot, value: unknown): void {
    if (disposed || slots[slot.index] !== slot) return;
    let message;
    try {
      message = decodeWorkerMessage(value);
    } catch (cause) {
      failSlot(slot, new ParamdocError('worker', `The paramdoc worker sent a message the client does not read: ${messageOf(cause)}`, { cause }));
      return;
    }
    if (message.type === 'ready') {
      if (slot.ready) {
        failSlot(slot, new ParamdocError('worker', 'The paramdoc worker reported ready twice'));
        return;
      }
      slot.ready = true;
      dispatch();
      return;
    }
    if (message.type === 'failure' && message.id === undefined) {
      failSlot(slot, new ParamdocError(message.error.code, message.error.message));
      return;
    }
    const job = slot.active;
    if (!job || message.id !== job.id) return;
    slot.active = undefined;
    if (message.type === 'result') settle(job, { ok: { pdf: message.pdf, pages: message.pages } });
    else settle(job, { error: new ParamdocError(message.error.code, message.error.message) });
    dispatch();
  }

  function createSlot(index: number): boolean {
    let worker: Worker;
    try {
      worker = createWorker(index);
    } catch (cause) {
      const job = queue.shift();
      if (job) settle(job, { error: new ParamdocError('worker', `Could not create a paramdoc worker: ${messageOf(cause)}`, { cause }) });
      dispatchSoon();
      return false;
    }
    const slot: Slot = { worker, index, ready: false };
    slots[index] = slot;
    worker.addEventListener('message', event => onMessage(slot, event.data));
    worker.addEventListener('error', event => failSlot(slot, new ParamdocError('worker', event.message || 'The paramdoc worker failed')));
    worker.addEventListener('messageerror', () => failSlot(slot, new ParamdocError('worker', 'The paramdoc worker sent an unreadable message')));
    try {
      worker.postMessage(open);
    } catch (cause) {
      failSlot(slot, new ParamdocError('worker', `Could not send the document to the paramdoc worker: ${messageOf(cause)}`, { cause }));
    }
    return true;
  }

  function ensureCapacity(): void {
    if (disposed || !queue.length) return;
    const running = slots.reduce((count, slot) => count + (slot?.active ? 1 : 0), 0);
    const target = Math.min(workerCount, running + queue.length);
    let existing = slots.reduce((count, slot) => count + (slot ? 1 : 0), 0);
    for (let index = 0; index < slots.length && existing < target; index += 1) {
      if (!slots[index]) {
        if (!createSlot(index)) break;
        existing += 1;
      }
    }
  }

  function dispatch(): void {
    if (disposed || !queue.length) return;
    ensureCapacity();
    for (const slot of slots) {
      if (!slot?.ready || slot.active) continue;
      const job = queue.shift();
      if (!job) return;
      slot.active = job;
      const message: HostMessage = { protocol: protocolVersion, type: 'fill', id: job.id, data: job.data };
      try {
        slot.worker.postMessage(message);
      } catch (cause) {
        failSlot(slot, new ParamdocError('worker', `Could not send data to the paramdoc worker: ${messageOf(cause)}`, { cause }));
      }
    }
  }

  function unqueue(job: Job): void {
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
  }

  function expire(job: Job, duration: number): void {
    if (job.settled) return;
    const slot = slots.find(candidate => candidate?.active === job);
    if (slot) {
      slot.active = undefined;
      terminate(slot);
    } else {
      unqueue(job);
    }
    settle(job, { error: new ParamdocError('timeout', `The fill exceeded its ${duration} ms timeout`) });
    dispatchSoon();
  }

  function abort(job: Job, reason: unknown): void {
    if (job.settled) return;
    // A running fill stays with its worker, whose reply is then ignored; the slot frees itself when it arrives.
    unqueue(job);
    settle(job, { error: new ParamdocError('aborted', 'The fill was cancelled', { cause: reason }) });
  }

  function disposeAll(): void {
    if (disposed) return;
    disposed = true;
    const error = (): ParamdocError => new ParamdocError('disposed', 'The worker client is disposed');
    for (const slot of slots) {
      if (slot?.active) {
        const job = slot.active;
        slot.active = undefined;
        settle(job, { error: error() });
      }
    }
    for (const job of queue.splice(0)) settle(job, { error: error() });
    for (const slot of slots) if (slot) terminate(slot);
  }

  return {
    workerCount,
    fill(data: unknown, fillOptions: FillOptions = {}): Promise<FillResult> {
      if (disposed) return Promise.reject(new ParamdocError('disposed', 'The worker client is disposed'));
      const signal = fillOptions.signal;
      if (signal?.aborted) return Promise.reject(new ParamdocError('aborted', 'The fill was cancelled', { cause: signal.reason }));
      let duration: number | undefined;
      let copy: unknown;
      try {
        duration = timeout(fillOptions.timeoutMs, 'fill timeoutMs') ?? defaultTimeout;
        // The caller's object may change after this call; the worker gets what it was now.
        copy = structuredClone(data);
      } catch (cause) {
        return Promise.reject(cause instanceof RangeError ? cause : new ParamdocError('fill', `The data cannot be sent to a worker: ${messageOf(cause)}`, { cause }));
      }
      if (queue.length >= queueLimit) return Promise.reject(new ParamdocError('queue-full', `The worker queue limit of ${queueLimit} was reached`));
      return new Promise<FillResult>((resolve, reject) => {
        const job: Job = { id: nextId++, data: copy, resolve, reject, settled: false };
        if (duration !== undefined) job.timer = setTimeout(() => expire(job, duration), duration);
        if (signal) {
          const onAbort = (): void => abort(job, signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          job.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(job);
        dispatch();
      });
    },
    dispose(): Promise<void> {
      if (!disposal) {
        disposeAll();
        disposal = Promise.resolve();
      }
      return disposal;
    },
  };
}
