// The worker client and the batch over the checked-in report, with the package's real worker runtime installed
// on in-process fake workers: messages are structured-cloned (buffers transferred) and delivered asynchronously,
// as a Worker would, and a fake can hold a fill back, fail, or send junk.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectBatch, createRuntime, createWorkerClient, fillBatch, ParamdocError } from '../dist/index.js';
import type { CreateWorkerClientOptions, FillOutcome, FillProgress } from '../dist/index.js';
import { installParamdocWorker } from '../dist/worker-runtime.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const report = `${root}experiments/paramdoc/documents/report/`;

async function reportInput() {
  const document = await readFile(`${report}doc.json`);
  const listed = JSON.parse(document.toString()) as { fonts: { file: string }[] };
  const fonts = await Promise.all(listed.fonts.map(f => readFile(`${report}fonts/${f.file}`)));
  return { document: new Uint8Array(document), fonts: fonts.map(f => new Uint8Array(f)) };
}

const data = async () => JSON.parse(await readFile(`${root}experiments/paramdoc/fixtures/report/data.json`, 'utf8')) as Record<string, unknown>;

type EventType = 'message' | 'error' | 'messageerror';
type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  listeners: Record<EventType, Listener[]> = { message: [], error: [], messageerror: [] };
  /** What the worker received, cloned, in order. */
  received: { type: string }[] = [];
  /** Fills held back while `holding`; `release` delivers them. */
  held: unknown[] = [];
  holding: boolean;
  terminated = false;
  /** Resolves when the worker has opened its document (it posted `ready`). */
  ready: Promise<void>;
  private deliver: ((event: MessageEvent<unknown>) => void) | undefined;

  constructor(holding = false) {
    this.holding = holding;
    let opened!: () => void;
    this.ready = new Promise<void>(resolve => { opened = resolve; });
    installParamdocWorker({
      addEventListener: (_type, listener) => { this.deliver = listener; },
      postMessage: (message, transfer = []) => {
        const cloned = structuredClone(message, { transfer: [...transfer] });
        queueMicrotask(() => { this.emit(cloned); if (cloned.type === 'ready') opened(); });
      },
    });
  }

  addEventListener(type: EventType, listener: Listener) { this.listeners[type].push(listener); }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    const cloned = structuredClone(message, { transfer }) as { type: string };
    this.received.push(cloned);
    if (this.holding && cloned.type === 'fill') { this.held.push(cloned); return; }
    queueMicrotask(() => { if (!this.terminated) this.deliver?.({ data: cloned } as MessageEvent<unknown>); });
  }

  release() {
    this.holding = false;
    for (const message of this.held.splice(0)) this.deliver?.({ data: message } as MessageEvent<unknown>);
  }

  /** As the worker's global `error` event. */
  fail(message: string) { for (const listener of this.listeners.error) listener({ message }); }

  /** A message to the client, as the worker would post it. */
  emit(data: unknown) { if (!this.terminated) for (const listener of this.listeners.message) listener({ data }); }

  terminate() { this.terminated = true; }
}

/** `holding(nth)` decides for the nth worker made (slot indices are reused after a termination). */
function pool(made: FakeWorker[], holding: (nth: number) => boolean = () => false) {
  return (() => {
    const worker = new FakeWorker(holding(made.length));
    made.push(worker);
    return worker;
  }) as unknown as NonNullable<CreateWorkerClientOptions['workerFactory']>;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const rejects = (promise: Promise<unknown>, code: ParamdocError['code'], pattern?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof ParamdocError && error.code === code && (!pattern || pattern.test(error.message)));

test('fills through workers, the same bytes as on the calling thread, at most workerCount at once', async () => {
  const input = await reportInput();
  const runtime = await createRuntime(input);
  const expected = (await runtime.fill(await data())).pdf;
  const made: FakeWorker[] = [];
  const client = createWorkerClient({ document: input, workerCount: 2, workerFactory: pool(made) });
  // The data is copied when `fill` is called: changing it afterwards does not change the document.
  const mutable = await data();
  const pending = client.fill(mutable);
  mutable.comment = 'changed after the call';
  const first = await pending;
  assert.equal(first.pages, 1);
  assert.deepEqual(Buffer.from(first.pdf), Buffer.from(expected));

  const jobs = Array.from({ length: 6 }, (_, index) => ({ id: `doc-${index}`, data: { ...mutable, comment: `Report ${index}` } }));
  const settled: FillOutcome<string>[] = [];
  const progress: FillProgress<string>[] = [];
  for await (const outcome of fillBatch(client, jobs, { onItemSettled: outcome => settled.push(outcome), onProgress: p => progress.push(p) })) {
    assert.equal(outcome.status, 'success');
    if (outcome.status === 'success') assert.equal(Buffer.from(outcome.result.pdf.subarray(0, 5)).toString(), '%PDF-');
  }
  assert.equal(settled.length, 6);
  assert.deepEqual(progress.at(-1), { total: 6, completed: 6, succeeded: 6, failed: 0, cancelled: 0, latestJobId: settled.at(-1)!.id });
  assert.equal(made.length, 2, 'workers start lazily, one per concurrent fill');

  const collected = await collectBatch(client, jobs.slice(0, 3));
  assert.deepEqual(collected.map(outcome => outcome.id), ['doc-0', 'doc-1', 'doc-2']);
  const fills = made.reduce((count, worker) => count + worker.received.filter(m => m.type === 'fill').length, 0);
  assert.equal(fills, 1 + 6 + 3, 'every fill was posted once, to one worker');
  await client.dispose();
  assert.ok(made.every(worker => worker.terminated));
  await rejects(client.fill(mutable), 'disposed');
});

test('a refused fill is that job\'s error and the worker keeps going', async () => {
  const input = await reportInput();
  const made: FakeWorker[] = [];
  const client = createWorkerClient({ document: input, workerCount: 1, workerFactory: pool(made) });
  const good = await data();
  const outcomes = await collectBatch(client, [
    { id: 0, data: good },
    { id: 1, data: { ...good, average: 97.5 } },
    { id: 2, data: { ...good, comment: 'Arabic: مرحبا' } },
    { id: 3, data: good },
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['success', 'error', 'error', 'success']);
  const second = outcomes[1]!;
  assert.ok(second.status === 'error' && second.error.code === 'fill' && /97.5 is not an integer/.test(second.error.message));
  const third = outcomes[2]!;
  assert.ok(third.status === 'error' && /not in the slot's repertoire/.test(third.error.message));
  assert.equal(made.length, 1, 'a refusal does not cost the worker');
  await client.dispose();
});

test('a document the worker cannot open fails the fill with its code', async () => {
  const input = await reportInput();
  const made: FakeWorker[] = [];
  const client = createWorkerClient({ document: { ...input, fonts: [...input.fonts].reverse() }, workerFactory: pool(made) });
  await rejects(client.fill(await data()), 'document', /sha256/);
  assert.ok(made[0]!.terminated, 'a worker without a document is replaced');
  await client.dispose();
});

test('cancelling: a batch signal, a waiting fill, a running fill whose worker is kept', async () => {
  const input = await reportInput();
  const made: FakeWorker[] = [];
  const client = createWorkerClient({ document: input, workerCount: 1, workerFactory: pool(made, nth => nth === 0) });
  const good = await data();

  // The first worker holds its fills: the running fill is cancelled at once, the worker answers later, unheard.
  const controller = new AbortController();
  const running = client.fill(good, { signal: controller.signal });
  await made[0]!.ready;
  await tick();
  assert.equal(made[0]!.held.length, 1, 'the fill reached the worker');
  const waiting = client.fill(good, { signal: controller.signal });
  controller.abort('no longer needed');
  await rejects(running, 'aborted');
  await rejects(waiting, 'aborted');
  made[0]!.release();
  await tick();
  const after = await client.fill(good);
  assert.equal(after.pages, 1);
  assert.equal(made.length, 1, 'the worker whose fill was cancelled kept serving');

  const batch = new AbortController();
  const jobs = Array.from({ length: 5 }, (_, index) => ({ id: index, data: good }));
  const statuses: string[] = [];
  for await (const outcome of fillBatch(client, jobs, { signal: batch.signal })) {
    statuses.push(outcome.status);
    if (statuses.length === 1) batch.abort('stop');
  }
  assert.equal(statuses.length, 5);
  assert.equal(statuses[0], 'success');
  assert.ok(statuses.slice(1).every(status => status === 'cancelled'));
  await client.dispose();
});

test('a timeout terminates the worker it ran on and the next fill gets a fresh one', async () => {
  const input = await reportInput();
  const made: FakeWorker[] = [];
  // Long enough for the first worker to open the document (the fonts compressed) and hold the fill as it runs.
  const client = createWorkerClient({ document: input, workerCount: 1, timeoutMs: 300, workerFactory: pool(made, nth => nth === 0) });
  const good = await data();
  await rejects(client.fill(good), 'timeout', /300 ms/);
  assert.ok(made[0]!.terminated);
  const result = await client.fill(good, { timeoutMs: 10_000 });
  assert.equal(result.pages, 1);
  assert.equal(made.length, 2);
  await client.dispose();
});

test('the queue limit, a worker that fails, a message the client does not read, dispose', async () => {
  const input = await reportInput();
  const made: FakeWorker[] = [];
  const client = createWorkerClient({ document: input, workerCount: 1, queueLimit: 1, workerFactory: pool(made, () => true) });
  const good = await data();
  const first = client.fill(good);
  await made[0]!.ready;
  await tick();
  assert.equal(made[0]!.held.length, 1, 'the first fill is running');
  const second = client.fill(good);
  await rejects(client.fill(good), 'queue-full', /limit of 1/);

  made[0]!.emit({ protocol: 1, type: 'result', id: 'junk' });
  await rejects(first, 'worker', /does not read/);
  assert.ok(made[0]!.terminated);
  await tick();
  assert.equal(made.length, 2, 'the waiting fill moved to a fresh worker');
  made[1]!.fail('out of memory');
  await rejects(second, 'worker', /out of memory/);

  const pending = client.fill(good);
  const disposal = client.dispose();
  assert.equal(client.dispose(), disposal, 'dispose is idempotent');
  await disposal;
  await rejects(pending, 'disposed');
  assert.ok(made.every(worker => worker.terminated));
  await rejects(client.fill(good), 'disposed');
});

test('options are checked up front', async () => {
  const input = await reportInput();
  assert.throws(() => createWorkerClient({ document: input, workerCount: 0 }), RangeError);
  assert.throws(() => createWorkerClient({ document: input, timeoutMs: 1.5 }), RangeError);
  assert.throws(() => createWorkerClient({ document: { ...input, fonts: ['x' as unknown as Uint8Array] } }), TypeError);
  const client = createWorkerClient({ document: input, workerFactory: pool([]) });
  await rejects(client.fill(() => undefined), 'fill', /cannot be sent to a worker/);
  await assert.rejects(client.fill({}, { timeoutMs: 0 }), RangeError);
  await client.dispose();
});
