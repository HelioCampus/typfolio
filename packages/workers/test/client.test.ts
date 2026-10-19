import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { definePartial, defineTemplate } from '@typfolio/core';
import type { AnyTemplate, Assets, PdfResult, StandardSchemaV1 } from '@typfolio/core';
import type { RuntimeMessage } from '../dist/protocol.js';
import { transferableBuffers } from '../dist/snapshot.js';
import {
  collectBatch,
  compileBatch,
  createWorkerClient,
  TypfolioWorkerError,
} from '../dist/index.js';
import type {
  CreateWorkerClientOptions,
  PdfBatchOutcome,
  PdfBatchProgress,
  WorkerErrorCode,
  WorkerFontSource,
} from '../dist/index.js';
import type { SerializedCompilerOptions } from '../dist/types.js';
import { installWorkerRuntime } from '../dist/worker-runtime.js';

type RuntimeFailure = Extract<RuntimeMessage, { type: 'failure' }>;
type MessageListener = (event: MessageEvent<unknown>) => void;

/**
 * A message as a worker receives it from the client. The protocol's union is flattened: the tests check `type`
 * (with an assertion the compiler cannot follow) before they read the fields of one variant.
 */
interface ReceivedMessage {
  protocol: 1;
  type: 'initialize' | 'compile';
  id: number;
  compiler: SerializedCompilerOptions;
  request: ReceivedRequest;
}

/** A resolved request as the tests read it: every piece of data in these tests has a title. */
interface ReceivedRequest {
  entrypoint: string;
  files: Record<string, string>;
  documents: Record<string, { title: string }>;
  assets: Record<string, Uint8Array>;
}

type WorkerEventType = 'message' | 'error' | 'messageerror';

// A template whose data is mounted at input.json and read there directly, without a schema.
const titledTemplate = defineTemplate({ files: { 'main.typ': '#json("/input.json").title' }, schemaPath: 'input.json' });
const request = (title: string) => titledTemplate({ title });
// The title of a request built by `request`, as the worker received it.
const titleOf = (message: ReceivedMessage) => message.request.documents['input.json'].title;

const result = (title: string): PdfResult => ({
  bytes: new Uint8Array([37, 80, 68, 70, 45]),
  diagnostics: [],
  metadata: { title },
});

class FakeWorker {
  listeners: Record<WorkerEventType, ((event: unknown) => void)[]> = { message: [], error: [], messageerror: [] };
  messages: ReceivedMessage[] = []; // what the worker receives: a structured clone, with transferred buffers moved
  posted: ReceivedMessage[] = []; // the objects the client handed to postMessage, whose transferred buffers are now detached
  transfers: Transferable[][] = [];
  terminated = false;
  handle: ((message: ReceivedMessage, worker: FakeWorker) => void) | undefined;

  constructor(handle?: (message: ReceivedMessage, worker: FakeWorker) => void) { this.handle = handle; }

  addEventListener(type: WorkerEventType, listener: (event: unknown) => void) { this.listeners[type].push(listener); }

  // Like a real Worker: the receiver gets a clone, and every buffer in the transfer list is detached here.
  postMessage(message: ReceivedMessage, transfer: Transferable[] = []) {
    const received = structuredClone(message, { transfer });
    this.posted.push(message);
    this.transfers.push(transfer);
    this.messages.push(received);
    this.handle?.(received, this);
  }

  emit(type: WorkerEventType, value: unknown) {
    const event = type === 'message' ? { data: value } : value;
    for (const listener of this.listeners[type]) listener(event);
  }

  terminate() { this.terminated = true; }
}

// FakeWorker has the part of the Worker interface that the client uses, and nothing else.
const asWorkerFactory = (factory: () => FakeWorker) => factory as unknown as NonNullable<CreateWorkerClientOptions['workerFactory']>;

function ready(worker: FakeWorker) {
  worker.emit('message', { protocol: 1, type: 'ready' });
}

function success(worker: FakeWorker, id: number, title: string) {
  worker.emit('message', { protocol: 1, type: 'result', id, result: result(title) });
}

function options(workerFactory: () => FakeWorker, extra: Partial<CreateWorkerClientOptions> = {}): CreateWorkerClientOptions {
  return {
    compiler: { wasm: 'https://example.test/compiler.wasm', fonts: [new Uint8Array([1])] },
    workerFactory: asWorkerFactory(workerFactory),
    ...extra,
  };
}

function assertCode(error: unknown, code: WorkerErrorCode) {
  assert.ok(error instanceof TypfolioWorkerError);
  assert.equal(error.code, code);
  return true;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for worker state');
}

test('queues work in order, keeps one worker warm, and snapshots requests', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const firstData = { title: 'First' };
  const first = client.compile(titledTemplate(firstData));
  const second = client.compile(request('Second'));
  firstData.title = 'Mutated';

  ready(worker);
  const firstMessage = worker.messages.at(-1)!;
  assert.equal(firstMessage.type, 'compile');
  assert.deepEqual(firstMessage.request, {
    entrypoint: 'main.typ',
    files: { 'main.typ': '#json("/input.json").title' },
    documents: { 'input.json': { title: 'First' } },
  });
  assert.equal(worker.messages.filter(message => message.type === 'compile').length, 1);

  success(worker, firstMessage.id, 'First');
  const secondMessage = worker.messages.at(-1)!;
  assert.equal(secondMessage.type, 'compile');
  assert.equal(titleOf(secondMessage), 'Second');
  success(worker, secondMessage.id, 'Second');

  assert.equal((await first).metadata.title, 'First');
  assert.equal((await second).metadata.title, 'Second');
  assert.equal(worker.terminated, false);
  await client.dispose();
  assert.equal(worker.terminated, true);
});

test('a template without data crosses the worker boundary as its files alone', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const plain = defineTemplate({ entrypoint: 'doc.typ', files: { 'doc.typ': 'Plain', 'part.typ': 'Part' } });
  const pending = client.compile(plain(), { pdf: { tags: true } });
  ready(worker);
  const message = worker.messages.at(-1)!;
  assert.equal(message.type, 'compile');
  assert.deepEqual(message.request, {
    entrypoint: 'doc.typ',
    files: { 'doc.typ': 'Plain', 'part.typ': 'Part' },
    documents: {},
    pdf: { tags: true },
  });
  success(worker, message.id, 'Plain');
  assert.equal((await pending).metadata.title, 'Plain');
  await client.dispose();
});

test('cancels a queued job without disturbing active work', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const active = client.compile(request('Active'));
  ready(worker);
  const activeMessage = worker.messages.at(-1)!;
  const controller = new AbortController();
  const queued = client.compile(request('Queued'), { signal: controller.signal });
  controller.abort('not needed');

  await assert.rejects(queued, error => assertCode(error, 'ABORTED'));
  assert.equal(worker.terminated, false);
  success(worker, activeMessage.id, 'Active');
  assert.equal((await active).metadata.title, 'Active');
  await client.dispose();
});

test('hard-cancels active work, replaces the worker, and preserves queued jobs', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }));
  const controller = new AbortController();
  const cancelled = client.compile(request('Cancel'), { signal: controller.signal });
  ready(workers[0]);
  const waiting = client.compile(request('Keep'));
  controller.abort();

  await assert.rejects(cancelled, error => assertCode(error, 'ABORTED'));
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  ready(workers[1]);
  const message = workers[1].messages.at(-1)!;
  success(workers[1], message.id, 'Keep');
  assert.equal((await waiting).metadata.title, 'Keep');
  await client.dispose();
});

test('enforces active timeouts by terminating and replacing the worker', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { timeoutMs: 10 }));
  const timedOut = client.compile(request('Slow'));
  ready(workers[0]);
  const waiting = client.compile(request('Next'), { timeoutMs: 100 });

  await assert.rejects(timedOut, error => assertCode(error, 'TIMEOUT'));
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(workers[0].terminated, true);
  ready(workers[1]);
  const message = workers[1].messages.at(-1)!;
  success(workers[1], message.id, 'Next');
  assert.equal((await waiting).metadata.title, 'Next');
  await client.dispose();
});

test('replaces a crashed worker and settles its active job', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }));
  const failed = client.compile(request('Crash'));
  ready(workers[0]);
  const waiting = client.compile(request('Recover'));
  workers[0].emit('error', { message: 'worker crashed' });

  await assert.rejects(failed, error => assertCode(error, 'WORKER'));
  await waitFor(() => workers.length === 2);
  ready(workers[1]);
  const message = workers[1].messages.at(-1)!;
  success(workers[1], message.id, 'Recover');
  assert.equal((await waiting).metadata.title, 'Recover');
  await client.dispose();
});

test('bounds the waiting queue', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker, { queueLimit: 1 }));
  const first = client.compile(request('First'));
  await assert.rejects(client.compile(request('Overflow')), error => assertCode(error, 'QUEUE_FULL'));
  ready(worker);
  const message = worker.messages.at(-1)!;
  success(worker, message.id, 'First');
  await first;
  await client.dispose();
});

test('disposal settles all work, terminates once, and rejects future calls', async () => {
  const worker = new FakeWorker();
  let terminations = 0;
  worker.terminate = () => { terminations += 1; worker.terminated = true; };
  const client = createWorkerClient(options(() => worker));
  const active = client.compile(request('Active'));
  ready(worker);
  const queued = client.compile(request('Queued'));

  await Promise.all([client.dispose(), client.dispose()]);
  await assert.rejects(active, error => assertCode(error, 'DISPOSED'));
  await assert.rejects(queued, error => assertCode(error, 'DISPOSED'));
  await assert.rejects(client.compile(request('Later')), error => assertCode(error, 'DISPOSED'));
  assert.equal(terminations, 1);
});

test('transports compile failures without replacing a healthy worker', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const failed = client.compile(request('Invalid'));
  ready(worker);
  const failedMessage = worker.messages.at(-1)!;
  worker.emit('message', {
    protocol: 1,
    type: 'failure',
    id: failedMessage.id,
    error: { code: 'COMPILATION', message: 'bad Typst', diagnostics: [{ severity: 'error', message: 'bad Typst' }] },
  });
  await assert.rejects(failed, error => assertCode(error, 'COMPILATION'));

  const next = client.compile(request('Valid'));
  const nextMessage = worker.messages.at(-1)!;
  success(worker, nextMessage.id, 'Valid');
  assert.equal((await next).metadata.title, 'Valid');
  assert.equal(worker.terminated, false);
  await client.dispose();
});

test('runs on a bounded pool and hard cancellation preserves unrelated active work', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { workerCount: 2 }));
  const controller = new AbortController();
  const first = client.compile(request('First'), { signal: controller.signal });
  const second = client.compile(request('Second'));

  assert.equal(client.workerCount, 2);
  assert.equal(workers.length, 2);
  ready(workers[0]);
  ready(workers[1]);
  const firstMessage = workers[0].messages.at(-1)!;
  const secondMessage = workers[1].messages.at(-1)!;
  controller.abort();

  await assert.rejects(first, error => assertCode(error, 'ABORTED'));
  success(workers[1], secondMessage.id, 'Second');
  assert.equal((await second).metadata.title, 'Second');
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, false);
  assert.equal(firstMessage.type, 'compile');
  await client.dispose();
});

test('rejects uncloneable accessors without invoking them or creating a worker', async () => {
  let accessed = false;
  let workers = 0;
  const input = {};
  Object.defineProperty(input, 'title', {
    enumerable: true,
    get() { accessed = true; return 'hidden'; },
  });
  const client = createWorkerClient(options(() => {
    workers += 1;
    return new FakeWorker();
  }));

  await assert.rejects(client.compile(titledTemplate(input)), error => assertCode(error, 'INVALID_REQUEST'));
  assert.equal(accessed, false);
  assert.equal(workers, 0);
  await client.dispose();
});

function automaticWorker(delays: Record<string, number> = {}) {
  return new FakeWorker((message, worker) => {
    if (message.type === 'initialize') {
      queueMicrotask(() => ready(worker));
      return;
    }
    // The request carries its data in documents by path, the template's own data first.
    const title = Object.values(message.request.documents)[0].title;
    setTimeout(() => {
      if (title === 'Error') {
        worker.emit('message', {
          protocol: 1,
          type: 'failure',
          id: message.id,
          error: { code: 'COMPILATION', message: 'invalid document', diagnostics: [] },
        });
      } else {
        success(worker, message.id, title);
      }
    }, delays[title] ?? 0);
  });
}

test('streams batch outcomes in completion order and reports progress', async () => {
  const progress: PdfBatchProgress<string>[] = [];
  const client = createWorkerClient(options(
    () => automaticWorker({ First: 15, Second: 1, Third: 1 }),
    { workerCount: 2 },
  ));
  const jobs = ['First', 'Second', 'Third', 'Error'].map(title => ({ id: title, document: request(title) }));
  const outcomes: PdfBatchOutcome<string>[] = [];
  for await (const outcome of compileBatch(client, jobs, {
    onProgress: value => progress.push(value),
  })) outcomes.push(outcome);

  assert.deepEqual(outcomes.map(outcome => outcome.id), ['Second', 'Third', 'Error', 'First']);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['success', 'success', 'error', 'success']);
  assert.deepEqual(progress.at(0), { total: 4, completed: 0, succeeded: 0, failed: 0, cancelled: 0 });
  assert.deepEqual(progress.at(-1), {
    total: 4,
    completed: 4,
    succeeded: 3,
    failed: 1,
    cancelled: 0,
    latestJobId: 'First',
  });
  await client.dispose();
});

test('collects batch outcomes in input order', async () => {
  const client = createWorkerClient(options(
    () => automaticWorker({ First: 10, Second: 1 }),
    { workerCount: 2 },
  ));
  const outcomes = await collectBatch(client, ['First', 'Second'].map(title => ({ id: title, document: request(title) })));
  assert.deepEqual(outcomes.map(outcome => outcome.id), ['First', 'Second']);
  assert.ok(outcomes.every(outcome => outcome.status === 'success'));
  await client.dispose();
});

test('stopping batch iteration interrupts remaining Effect work', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { workerCount: 2 }));
  const iterator = compileBatch(client, [
    { id: 'first', document: request('First') },
    { id: 'second', document: request('Second') },
  ])[Symbol.asyncIterator]();
  const firstOutcome = iterator.next();

  await waitFor(() => workers.length === 2);
  ready(workers[0]);
  ready(workers[1]);
  const firstMessage = workers[0].messages.at(-1)!;
  success(workers[0], firstMessage.id, 'First');

  assert.equal((await firstOutcome).value.id, 'first');
  await iterator.return!();
  await waitFor(() => workers[1].terminated);
  assert.equal(workers[0].terminated, false);
  await client.dispose();
});

test('batch cancellation cancels only its jobs on a shared client', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { workerCount: 2 }));
  const unrelated = client.compile(request('Unrelated'));
  ready(workers[0]);

  const controller = new AbortController();
  const stream = compileBatch(client, [
    { id: 'batch-1', document: request('Batch 1') },
    { id: 'batch-2', document: request('Batch 2') },
  ], { signal: controller.signal });
  const collecting = (async () => {
    const values: PdfBatchOutcome<string>[] = [];
    for await (const value of stream) values.push(value);
    return values;
  })();
  await waitFor(() => workers.length === 2);
  ready(workers[1]);
  controller.abort();

  const outcomes = await collecting;
  assert.ok(outcomes.every(outcome => outcome.status === 'cancelled'));
  assert.equal(workers[0].terminated, false);
  const unrelatedMessage = workers[0].messages.find(message => message.type === 'compile')!;
  success(workers[0], unrelatedMessage.id, 'Unrelated');
  assert.equal((await unrelated).metadata.title, 'Unrelated');
  await client.dispose();
});

function compileMessages(worker: FakeWorker) {
  return worker.messages.filter(message => message.type === 'compile');
}

test('transfers the snapshot buffers, leaves the caller buffers intact, and the worker gets every byte', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const big = Uint8Array.from({ length: 1 << 20 }, (_, index) => index % 251);
  const small = new Uint8Array([9, 8, 7]);
  const expected = [Uint8Array.from(big), Uint8Array.from(small)];
  const shared = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const callerAssets = {
    'big.bin': big,
    'small.bin': small,
    'head.bin': shared.subarray(0, 3), // two views of one buffer: one entry in the transfer list
    'tail.bin': shared.subarray(3),
  };
  const document = request('Assets');
  const pending = client.compile(document, { assets: callerAssets });
  ready(worker);

  const [message] = compileMessages(worker);
  const [posted] = worker.posted.filter(candidate => candidate.type === 'compile');
  const transfer = worker.transfers.at(-1)!;
  assert.equal(transfer.length, 3, 'one transfer entry per distinct buffer');
  assert.equal(new Set(transfer).size, 3);

  // The worker received the full bytes.
  assert.deepEqual(message.request.assets['big.bin'], expected[0]);
  assert.deepEqual(message.request.assets['small.bin'], expected[1]);
  assert.deepEqual([...message.request.assets['head.bin']], [1, 2, 3]);
  assert.deepEqual([...message.request.assets['tail.bin']], [4, 5, 6]);

  // The snapshot the client posted is detached; the caller's assets never were involved.
  for (const bytes of Object.values(posted.request.assets)) {
    assert.equal(bytes.buffer.byteLength, 0);
    assert.equal(bytes.byteLength, 0);
  }
  assert.notEqual(posted.request.assets, callerAssets);
  assert.equal(callerAssets['big.bin'], big);
  assert.equal(big.byteLength, 1 << 20);
  assert.deepEqual(big, expected[0]);
  assert.deepEqual(small, expected[1]);
  assert.deepEqual([...shared], [1, 2, 3, 4, 5, 6]);

  success(worker, message.id, 'Assets');
  await pending;
  // The caller can submit the same document and buffers again.
  const again = client.compile(document, { assets: callerAssets });
  const next = compileMessages(worker).at(-1)!;
  assert.deepEqual(next.request.assets['big.bin'], expected[0]);
  success(worker, next.id, 'Assets');
  await again;
  await client.dispose();
});

test('a SharedArrayBuffer asset is not transferred and still arrives intact', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const sharedBuffer = new SharedArrayBuffer(4);
  const view = new Uint8Array(sharedBuffer);
  view.set([5, 6, 7, 8]);
  const ordinary = new Uint8Array([1, 2, 3]);
  const pending = client.compile(request('Shared'), { assets: { 'shared.bin': view, 'ordinary.bin': ordinary } });
  ready(worker);

  const [message] = compileMessages(worker);
  assert.deepEqual([...message.request.assets['shared.bin']], [5, 6, 7, 8]);
  assert.deepEqual([...message.request.assets['ordinary.bin']], [1, 2, 3]);
  assert.equal(worker.transfers.at(-1)!.length, 1);
  assert.ok(worker.transfers.at(-1)!.every(buffer => buffer instanceof ArrayBuffer));
  assert.deepEqual([...view], [5, 6, 7, 8]);
  assert.deepEqual([...ordinary], [1, 2, 3]);
  success(worker, message.id, 'Shared');
  await pending;
  await client.dispose();
});

test('transferableBuffers lists distinct transferable buffers only', () => {
  const buffer = new ArrayBuffer(8);
  const detached = new ArrayBuffer(4);
  const detachedView = new Uint8Array(detached);
  detached.transfer();
  const buffers = transferableBuffers({
    entrypoint: 'main.typ',
    files: { 'main.typ': 'x' },
    documents: {},
    assets: {
      a: new Uint8Array(buffer, 0, 4),
      b: new Uint8Array(buffer, 4, 4),
      shared: new Uint8Array(new SharedArrayBuffer(2)),
      detached: detachedView,
      // @ts-expect-error not bytes: the helper skips it
      notBytes: null,
      // @ts-expect-error not bytes either
      alsoNotBytes: 3,
    },
  });
  assert.deepEqual(buffers, [buffer]);
  assert.deepEqual(transferableBuffers({ entrypoint: 'main.typ', files: { 'main.typ': 'x' }, documents: {} }), []);
});

test('a malformed asset value does not break posting; the worker side rejects it', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  // @ts-expect-error a malformed asset value must still reach the worker, which rejects it
  const pending = client.compile(request('Odd'), { assets: { 'odd.bin': null } });
  ready(worker);
  const [message] = compileMessages(worker);
  assert.equal(message.request.assets['odd.bin'], null);
  assert.equal(worker.transfers.at(-1)!.length, 0);
  success(worker, message.id, 'Odd');
  await pending;
  await client.dispose();
});

test('a request is posted once: cancelled, timed-out and crashed jobs are rejected, not re-posted', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { timeoutMs: 20 }));
  const bytes = () => ({ 'a.bin': new Uint8Array(1024).fill(3) });
  const controller = new AbortController();
  const cancelled = client.compile(request('Cancel'), { assets: bytes(), signal: controller.signal });
  ready(workers[0]);
  controller.abort();
  await assert.rejects(cancelled, error => assertCode(error, 'ABORTED'));

  const timedOut = client.compile(request('Timeout'), { assets: bytes() });
  assert.equal(workers.length, 2);
  ready(workers[1]);
  await assert.rejects(timedOut, error => assertCode(error, 'TIMEOUT'));

  const crashed = client.compile(request('Crash'), { assets: bytes(), timeoutMs: 5_000 });
  assert.equal(workers.length, 3);
  ready(workers[2]);
  workers[2].emit('error', { message: 'worker crashed' });
  await assert.rejects(crashed, error => assertCode(error, 'WORKER'));

  await new Promise(resolve => setTimeout(resolve, 30));
  const posts = workers.flatMap(worker => compileMessages(worker));
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map(titleOf).sort(), ['Cancel', 'Crash', 'Timeout']);
  assert.equal(new Set(posts.map(message => message.id)).size, 3);
  await client.dispose();
});

test('assets are copied once on the client, for compile and for each batch job', async () => {
  // The assets of each resolved request the client cloned (a worker message has no `documents` of its own).
  const clonedAssets: unknown[] = [];
  const original = globalThis.structuredClone;
  const spy = (value: unknown, ...rest: [StructuredSerializeOptions?]) => {
    const resolved = value as { documents?: unknown; assets?: unknown } | null | undefined;
    if (resolved?.documents !== undefined) clonedAssets.push(resolved.assets);
    return original(value, ...rest);
  };
  const assertSame = (actual: unknown[], expected: unknown[], message?: string) => {
    assert.equal(actual.length, expected.length, message);
    actual.forEach((value, index) => assert.equal(value, expected[index], message));
  };
  globalThis.structuredClone = spy as typeof structuredClone;
  try {
    const worker = automaticWorker();
    const client = createWorkerClient(options(() => worker));
    const make = (title: string) => ({ document: request(title), assets: { 'a.bin': new Uint8Array(64).fill(7) } });

    const single = make('Single');
    await client.compile(single.document, { assets: single.assets });
    assertSame(clonedAssets, [single.assets]);

    // The same document and assets submitted twice are snapshotted each time, and stay usable.
    clonedAssets.length = 0;
    await Promise.all([
      client.compile(single.document, { assets: single.assets }),
      client.compile(single.document, { assets: single.assets }),
    ]);
    assertSame(clonedAssets, [single.assets, single.assets]);
    assert.deepEqual([...single.assets['a.bin']], new Array(64).fill(7));

    clonedAssets.length = 0;
    const jobs = ['One', 'Two', 'Three'].map(title => ({ id: title, ...make(title) }));
    const outcomes = await collectBatch(client, jobs);
    assert.ok(outcomes.every(outcome => outcome.status === 'success'));
    assertSame(clonedAssets, jobs.map(job => job.assets), 'one clone per job, taken from the caller assets');
    for (const job of jobs) assert.deepEqual([...job.assets['a.bin']], new Array(64).fill(7));
    const batchPosts = compileMessages(worker).slice(-3);
    for (const message of batchPosts) assert.deepEqual([...message.request.assets['a.bin']], new Array(64).fill(7));
    await client.dispose();
  } finally {
    globalThis.structuredClone = original;
  }
});

async function withLocation<Result>(href: string, run: () => Result | Promise<Result>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { href }, configurable: true, writable: true });
  try { return await run(); } finally {
    if (original) Object.defineProperty(globalThis, 'location', original); else Reflect.deleteProperty(globalThis, 'location');
  }
}

test('font URLs travel as strings: bytes are copied, a URL becomes its href, a string resolves against the page', async () => {
  const worker = new FakeWorker();
  const bytes = new Uint8Array([1, 2, 3]);
  const client = await withLocation('https://page.test/app/index.html', () => {
    const created = createWorkerClient({
      compiler: {
        wasm: 'https://example.test/compiler.wasm',
        fonts: [bytes, new URL('https://fonts.test/a.otf'), 'https://fonts.test/b.otf', 'fonts/c.otf', '/d.otf'],
      },
      workerFactory: asWorkerFactory(() => worker),
    });
    assert.ok(!(created instanceof Promise), 'creating a worker client stays synchronous');
    return created;
  });
  assert.equal(worker.messages.length, 0, 'workers stay lazy');
  const pending = client.compile(request('Fonts'));
  const initialize = worker.messages[0];
  assert.equal(initialize.type, 'initialize');
  const fonts = initialize.compiler.fonts;
  assert.deepEqual(fonts.slice(1), [
    'https://fonts.test/a.otf',
    'https://fonts.test/b.otf',
    'https://page.test/app/fonts/c.otf',
    'https://page.test/d.otf',
  ]);
  assert.ok(fonts[0] instanceof Uint8Array);
  assert.notEqual(fonts[0], bytes);
  assert.deepEqual([...fonts[0]], [1, 2, 3]);
  assert.doesNotThrow(() => structuredClone(initialize), 'the message is structured-cloneable');
  ready(worker);
  success(worker, worker.messages.at(-1)!.id, 'Fonts');
  await pending;
  await client.dispose();
});

test('a font string that cannot be resolved fails synchronously, before any worker exists', () => {
  assert.equal(globalThis.location, undefined);
  let created = 0;
  // The values include fonts the types do not allow; each must be rejected at run time.
  const attempt = (fonts: unknown[]) => () => createWorkerClient({
    compiler: { wasm: 'https://example.test/compiler.wasm', fonts: fonts as WorkerFontSource[] },
    workerFactory: asWorkerFactory(() => { created += 1; return new FakeWorker(); }),
  });
  assert.throws(attempt(['fonts/relative.otf']), TypeError);
  assert.throws(attempt(['']), TypeError);
  assert.throws(attempt([]), TypeError);
  assert.throws(attempt([new Uint8Array()]), TypeError);
  assert.throws(attempt([42]), TypeError);
  assert.doesNotThrow(attempt(['https://fonts.test/absolute.otf']));
  assert.equal(created, 0);
});

test('an INITIALIZATION failure reported by the worker rejects the job with that code and message', async () => {
  const workers: FakeWorker[] = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }));
  const failed = client.compile(request('Fonts'));
  const message = 'Could not load font https://fonts.test/missing.otf: HTTP 404 Not Found';
  workers[0].emit('message', {
    protocol: 1,
    type: 'failure',
    error: { code: 'INITIALIZATION', message, diagnostics: [] },
  });
  await assert.rejects(failed, (error: TypfolioWorkerError) => {
    assertCode(error, 'INITIALIZATION');
    assert.equal(error.message, message);
    return true;
  });
  assert.equal(workers[0].terminated, true);
  await client.dispose();
});

// A Standard Schema without a schema library: data without a title is rejected.
function titled(async = false): StandardSchemaV1<{ title: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => {
        const result = (value as { title?: string }).title ? { value: value as { title: string } } : { issues: [{ message: 'title is empty', path: ['title'] }] };
        return async ? Promise.resolve(result) : result;
      },
    },
  };
}

const header = definePartial({
  files: { 'common/header.typ': '#let header = none' },
  schema: titled(),
  schemaPath: 'common/header.schema.json',
});
const defined = (async = false) => defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': '#import "../common/header.typ": header' },
  schema: titled(async),
  schemaPath: 'report/input.schema.json',
  partials: { header },
});

test('a defined template crosses the boundary as its files and the data at each schema path', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const pending = client.compile(defined()({ title: 'Report' }, { header: { title: 'Header' } }));
  ready(worker);
  const message = worker.messages.at(-1)!;
  assert.equal(message.type, 'compile');
  assert.deepEqual(message.request, {
    entrypoint: 'report/main.typ',
    files: { 'report/main.typ': '#import "../common/header.typ": header', 'common/header.typ': '#let header = none' },
    documents: { 'report/input.schema.json': { title: 'Report' }, 'common/header.schema.json': { title: 'Header' } },
  });
  success(worker, message.id, 'Report');
  assert.equal((await pending).metadata.title, 'Report');
  await client.dispose();
});

test('data that fails its schema is rejected with INVALID_INPUT on the calling thread, before any worker exists', async () => {
  let workers = 0;
  const client = createWorkerClient(options(() => { workers += 1; return new FakeWorker(); }));
  await assert.rejects(
    client.compile(defined()({ title: 'Report' }, { header: { title: '' } })),
    error => assertCode(error, 'INVALID_INPUT') && /The data of partial "header" does not match its schema/.test((error as Error).message),
  );
  // The header's data is missing: the types reject this call, and so does the client at run time.
  await assert.rejects(client.compile((defined() as AnyTemplate)({ title: 'Report' })), error => assertCode(error, 'INVALID_REQUEST'));
  await assert.rejects(client.compile({ title: 'Not a document' } as never), error => assertCode(error, 'INVALID_REQUEST'));
  assert.equal(workers, 0);
  await client.dispose();
});

test('a schema that validates asynchronously is awaited before the job is posted', async () => {
  const worker = new FakeWorker((message, self) => {
    if (message.type === 'initialize') queueMicrotask(() => ready(self));
  });
  const client = createWorkerClient(options(() => worker));
  await assert.rejects(
    client.compile(defined(true)({ title: '' }, { header: { title: 'Header' } })),
    error => assertCode(error, 'INVALID_INPUT'),
  );
  assert.equal(worker.messages.filter(message => message.type === 'compile').length, 0);
  const pending = client.compile(defined(true)({ title: 'Report' }, { header: { title: 'Header' } }));
  await waitFor(() => worker.messages.some(message => message.type === 'compile'));
  success(worker, worker.messages.at(-1)!.id, 'Report');
  assert.equal((await pending).metadata.title, 'Report');
  await client.dispose();
});

test('in a batch, a job whose data fails its schema is that job\'s error and the rest still compile', async () => {
  const client = createWorkerClient(options(() => automaticWorker(), { workerCount: 2 }));
  const job = (id: string, title: string, async = false) => ({
    id,
    document: defined(async)({ title }, { header: { title: 'Header' } }),
  });
  const outcomes = await collectBatch(client, [job('ok', 'First'), job('sync', ''), job('async', '', true), job('later', 'Second', true)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['success', 'error', 'error', 'success']);
  for (const outcome of outcomes.filter(outcome => outcome.status === 'error')) assertCode(outcome.error, 'INVALID_INPUT');
  await client.dispose();
});

test('validate: false posts data its schema would reject, from compile and from a batch job', async () => {
  const client = createWorkerClient(options(() => automaticWorker(), { workerCount: 2 }));
  assert.ok((await client.compile(defined()({ title: '' }, { header: { title: '' } }), { validate: false })).bytes.length > 0);
  const outcomes = await collectBatch(client, [
    { id: 'sync', document: defined()({ title: '' }, { header: { title: 'Header' } }), validate: false },
    { id: 'async', document: defined(true)({ title: '' }, { header: { title: 'Header' } }), validate: false },
    { id: 'checked', document: defined()({ title: '' }, { header: { title: 'Header' } }) },
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['success', 'success', 'error']);
  await client.dispose();
});

// A realm accepts one WASM source value, so the runtime tests share one buffer.
let wasmBytes: Buffer | undefined;
const loadWasm = async (root: URL) => wasmBytes ??= await readFile(new URL('packages/wasm/generated/compiler_bg.wasm', root));

test('the worker runtime hands font URLs to core, which fetches them inside the worker', async () => {
  const root = new URL('../../../', import.meta.url);
  const font = await readFile(new URL('fixtures/fonts/LibertinusSerif-Regular.otf', root));
  const wasm = await loadWasm(root);
  const requested: (string | undefined)[] = [];
  const server = createServer((incoming, response) => {
    requested.push(incoming.url);
    if (incoming.url === '/font.otf') response.writeHead(200).end(font);
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const run = (fonts: string[]) => new Promise<RuntimeMessage>(resolve => {
      let listener = undefined as MessageListener | undefined;
      installWorkerRuntime({
        addEventListener: (_type, handler) => { listener = handler; },
        postMessage: resolve,
      });
      // The runtime reads only `data` from the event.
      listener!({ data: { protocol: 1, type: 'initialize', compiler: { wasm, fonts } } } as MessageEvent<unknown>);
    });
    const failure = await run([`${origin}/missing.otf`]) as RuntimeFailure;
    assert.equal(failure.type, 'failure');
    assert.equal(failure.error.code, 'INITIALIZATION');
    assert.ok(failure.error.message.includes(`${origin}/missing.otf`));
    assert.match(failure.error.message, /404/);
    assert.deepEqual((await run([`${origin}/font.otf`])).type, 'ready');
    assert.deepEqual(requested, ['/missing.otf', '/font.otf']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the worker runtime compiles transferred assets, mounting them without a second copy', async () => {
  const root = new URL('../../../', import.meta.url);
  const wasm = await loadWasm(root);
  const font = await readFile(new URL('fixtures/fonts/LibertinusSerif-Regular.otf', root));
  const svg = new Uint8Array(await readFile(new URL('fixtures/basic/chart.svg', root)));
  const messages: RuntimeMessage[] = [];
  let listener = undefined as MessageListener | undefined;
  // `ready` has no id; every other message names the job it belongs to, or none for a failure of the worker itself.
  const idOf = (message: RuntimeMessage) => (message as { id?: number }).id;
  const settled = <Type extends RuntimeMessage['type']>(type: Type, id: number | undefined) => new Promise<Extract<RuntimeMessage, { type: Type }>>((resolve, reject) => {
    const poll = () => {
      const found = messages.find(message => message.type === type && idOf(message) === id);
      const failed = messages.find(message => message.type === 'failure' && message.id === undefined) as RuntimeFailure | undefined;
      if (found) resolve(found as Extract<RuntimeMessage, { type: Type }>); else if (failed) reject(new Error(failed.error.message)); else setTimeout(poll, 5);
    };
    poll();
  });
  installWorkerRuntime({
    addEventListener: (_type, handler) => { listener = handler; },
    postMessage: message => messages.push(message),
  });
  // The runtime reads only `data` from the event.
  const dispatch = (data: unknown) => listener!({ data } as MessageEvent<unknown>);
  dispatch({ protocol: 1, type: 'initialize', compiler: { wasm, fonts: [new Uint8Array(font)] } });
  await settled('ready', undefined);

  // A request as the client posts it: resolved on the page's thread, its data at the schema path.
  const main = [
    '#import "@local/typfolio:0.1.0": input',
    '#let data = input(json.with("./input.schema.json"))',
    '#set document(title: data.title)',
    '#set text(font: "Libertinus Serif")',
    '#image("chart.svg", alt: data.alt)',
  ].join('\n');
  const send = (id: number, assets: Assets) => dispatch({
    protocol: 1,
    type: 'compile',
    id,
    request: { entrypoint: 'main.typ', files: { 'main.typ': main }, documents: { 'input.schema.json': { title: 'Chart', alt: 'A bar' } }, assets },
  });
  send(1, { 'chart.svg': svg });
  const done = await settled('result', 1);
  assert.equal(new TextDecoder().decode(done.result.bytes.subarray(0, 5)), '%PDF-');
  assert.equal(done.result.metadata.title, 'Chart');
  send(2, {});
  assert.equal((await settled('failure', 2)).error.code, 'COMPILATION');
});
