import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectBatch,
  compileBatch,
  createWorkerClient,
  TypfolioWorkerError,
} from '../dist/index.js';

const request = title => ({
  template: { entrypoint: 'main.typ', files: { 'main.typ': '#input.title' } },
  input: { title },
});

const result = title => ({
  bytes: new Uint8Array([37, 80, 68, 70, 45]),
  diagnostics: [],
  metadata: { title },
});

class FakeWorker {
  listeners = { message: [], error: [], messageerror: [] };
  messages = [];
  terminated = false;

  constructor(handle) { this.handle = handle; }

  addEventListener(type, listener) { this.listeners[type].push(listener); }

  postMessage(message) {
    this.messages.push(message);
    this.handle?.(message, this);
  }

  emit(type, value) {
    const event = type === 'message' ? { data: value } : value;
    for (const listener of this.listeners[type]) listener(event);
  }

  terminate() { this.terminated = true; }
}

function ready(worker) {
  worker.emit('message', { protocol: 1, type: 'ready' });
}

function success(worker, id, title) {
  worker.emit('message', { protocol: 1, type: 'result', id, result: result(title) });
}

function options(workerFactory, extra = {}) {
  return {
    compiler: { wasm: 'https://example.test/compiler.wasm', fonts: [new Uint8Array([1])] },
    workerFactory,
    ...extra,
  };
}

function assertCode(error, code) {
  assert.ok(error instanceof TypfolioWorkerError);
  assert.equal(error.code, code);
  return true;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for worker state');
}

test('queues work in order, keeps one worker warm, and snapshots requests', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const firstRequest = request('First');
  const first = client.compile(firstRequest);
  const second = client.compile(request('Second'));
  firstRequest.input.title = 'Mutated';

  ready(worker);
  const firstMessage = worker.messages.at(-1);
  assert.equal(firstMessage.type, 'compile');
  assert.equal(firstMessage.request.input.title, 'First');
  assert.equal(worker.messages.filter(message => message.type === 'compile').length, 1);

  success(worker, firstMessage.id, 'First');
  const secondMessage = worker.messages.at(-1);
  assert.equal(secondMessage.type, 'compile');
  assert.equal(secondMessage.request.input.title, 'Second');
  success(worker, secondMessage.id, 'Second');

  assert.equal((await first).metadata.title, 'First');
  assert.equal((await second).metadata.title, 'Second');
  assert.equal(worker.terminated, false);
  await client.dispose();
  assert.equal(worker.terminated, true);
});

test('a string template crosses the worker boundary unchanged', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const pending = client.compile({ template: '#input.title', input: { title: 'String' } });
  ready(worker);
  const message = worker.messages.at(-1);
  assert.equal(message.type, 'compile');
  assert.equal(message.request.template, '#input.title');
  success(worker, message.id, 'String');
  assert.equal((await pending).metadata.title, 'String');
  await client.dispose();
});

test('cancels a queued job without disturbing active work', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(options(() => worker));
  const active = client.compile(request('Active'));
  ready(worker);
  const activeMessage = worker.messages.at(-1);
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
  const workers = [];
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
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  ready(workers[1]);
  const message = workers[1].messages.at(-1);
  success(workers[1], message.id, 'Keep');
  assert.equal((await waiting).metadata.title, 'Keep');
  await client.dispose();
});

test('enforces active timeouts by terminating and replacing the worker', async () => {
  const workers = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { timeoutMs: 10 }));
  const timedOut = client.compile(request('Slow'));
  ready(workers[0]);
  const waiting = client.compile(request('Next'), { timeoutMs: 100 });

  await assert.rejects(timedOut, error => assertCode(error, 'TIMEOUT'));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(workers[0].terminated, true);
  ready(workers[1]);
  const message = workers[1].messages.at(-1);
  success(workers[1], message.id, 'Next');
  assert.equal((await waiting).metadata.title, 'Next');
  await client.dispose();
});

test('replaces a crashed worker and settles its active job', async () => {
  const workers = [];
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
  const message = workers[1].messages.at(-1);
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
  const message = worker.messages.at(-1);
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
  const failedMessage = worker.messages.at(-1);
  worker.emit('message', {
    protocol: 1,
    type: 'failure',
    id: failedMessage.id,
    error: { code: 'COMPILATION', message: 'bad Typst', diagnostics: [{ severity: 'error', message: 'bad Typst' }] },
  });
  await assert.rejects(failed, error => assertCode(error, 'COMPILATION'));

  const next = client.compile(request('Valid'));
  const nextMessage = worker.messages.at(-1);
  success(worker, nextMessage.id, 'Valid');
  assert.equal((await next).metadata.title, 'Valid');
  assert.equal(worker.terminated, false);
  await client.dispose();
});

test('runs on a bounded pool and hard cancellation preserves unrelated active work', async () => {
  const workers = [];
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
  const firstMessage = workers[0].messages.at(-1);
  const secondMessage = workers[1].messages.at(-1);
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

  await assert.rejects(client.compile({ ...request('Ignored'), input }), error => assertCode(error, 'INVALID_REQUEST'));
  assert.equal(accessed, false);
  assert.equal(workers, 0);
  await client.dispose();
});

function automaticWorker(delays = {}) {
  return new FakeWorker((message, worker) => {
    if (message.type === 'initialize') {
      queueMicrotask(() => ready(worker));
      return;
    }
    const title = message.request.input.title;
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
  const progress = [];
  const client = createWorkerClient(options(
    () => automaticWorker({ First: 15, Second: 1, Third: 1 }),
    { workerCount: 2 },
  ));
  const jobs = ['First', 'Second', 'Third', 'Error'].map(title => ({ id: title, request: request(title) }));
  const outcomes = [];
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
  const outcomes = await collectBatch(client, ['First', 'Second'].map(title => ({ id: title, request: request(title) })));
  assert.deepEqual(outcomes.map(outcome => outcome.id), ['First', 'Second']);
  assert.ok(outcomes.every(outcome => outcome.status === 'success'));
  await client.dispose();
});

test('stopping batch iteration interrupts remaining Effect work', async () => {
  const workers = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { workerCount: 2 }));
  const iterator = compileBatch(client, [
    { id: 'first', request: request('First') },
    { id: 'second', request: request('Second') },
  ])[Symbol.asyncIterator]();
  const firstOutcome = iterator.next();

  await waitFor(() => workers.length === 2);
  ready(workers[0]);
  ready(workers[1]);
  const firstMessage = workers[0].messages.at(-1);
  success(workers[0], firstMessage.id, 'First');

  assert.equal((await firstOutcome).value.id, 'first');
  await iterator.return();
  await waitFor(() => workers[1].terminated);
  assert.equal(workers[0].terminated, false);
  await client.dispose();
});

test('batch cancellation cancels only its jobs on a shared client', async () => {
  const workers = [];
  const client = createWorkerClient(options(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, { workerCount: 2 }));
  const unrelated = client.compile(request('Unrelated'));
  ready(workers[0]);

  const controller = new AbortController();
  const stream = compileBatch(client, [
    { id: 'batch-1', request: request('Batch 1') },
    { id: 'batch-2', request: request('Batch 2') },
  ], { signal: controller.signal });
  const collecting = (async () => {
    const values = [];
    for await (const value of stream) values.push(value);
    return values;
  })();
  await waitFor(() => workers.length === 2);
  ready(workers[1]);
  controller.abort();

  const outcomes = await collecting;
  assert.ok(outcomes.every(outcome => outcome.status === 'cancelled'));
  assert.equal(workers[0].terminated, false);
  const unrelatedMessage = workers[0].messages.find(message => message.type === 'compile');
  success(workers[0], unrelatedMessage.id, 'Unrelated');
  assert.equal((await unrelated).metadata.title, 'Unrelated');
  await client.dispose();
});
