import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, render } from '@testing-library/react';
import type { AnyPdfRequest, PdfRequest, PdfResult } from '@typfolio/core';
// usePdf's internals: the compile lifecycle and the object URL it shows.
import { usePdfCompilation } from '../dist/compilation.js';
import type { PdfCompilation, UsePdfCompilationOptions } from '../dist/compilation.js';
import { usePdfObjectUrl } from '../dist/object-url.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://typfolio.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;

const request = (title: string): PdfRequest<{ title: string }> => ({
  template: { entrypoint: 'main.typ', files: { 'main.typ': '#input.title' } },
  input: { title },
});

const result = (title: string): PdfResult => ({
  bytes: new Uint8Array([37, 80, 68, 70]),
  diagnostics: [{ severity: 'warning', message: title }],
  metadata: { title },
});

interface FakeCall {
  request: AnyPdfRequest;
  signal: AbortSignal | undefined;
  resolve: (value: PdfResult) => void;
  reject: (reason?: unknown) => void;
}

interface LifecycleEvent {
  type: string;
  value?: PdfResult;
  error?: unknown;
  input?: AnyPdfRequest;
}

// What the hooks do with their `PdfClient`: it records every call and settles it when the test says so.
class FakeClient {
  calls: FakeCall[] = [];
  disposals = 0;

  compile(value: AnyPdfRequest, options: { signal?: AbortSignal } = {}): Promise<PdfResult> {
    return new Promise((resolve, reject) => {
      const call = { request: value, signal: options.signal, resolve, reject };
      this.calls.push(call);
      const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  dispose() {
    this.disposals += 1;
  }
}

test('manual compilation exposes state, diagnostics, and stable actions', async () => {
  const client = new FakeClient();
  let current!: PdfCompilation;
  function Harness() {
    current = usePdfCompilation({ client });
    return null;
  }
  const view = render(createElement(Harness));
  const actions = {
    compile: current.compile,
    cancel: current.cancel,
    reset: current.reset,
  };
  assert.equal(current.isIdle, true);
  assert.equal(current.isCompiling, false);
  assert.equal(current.isRecompiling, false);

  let pending!: Promise<PdfResult>;
  await act(async () => {
    pending = current.compile(request('Manual'));
  });
  assert.equal(current.status, 'compiling');
  assert.equal(current.isIdle, false);
  assert.equal(current.isCompiling, true);
  assert.equal(current.isRecompiling, false);
  assert.equal(current.compile, actions.compile);
  assert.equal(current.cancel, actions.cancel);
  assert.equal(current.reset, actions.reset);

  await act(async () => {
    client.calls[0].resolve(result('Manual'));
    await pending;
  });
  assert.equal(current.status, 'success');
  assert.equal(current.isSuccess, true);
  assert.equal(current.isCompiling, false);
  assert.equal(current.result!.metadata.title, 'Manual');
  assert.equal(current.diagnostics[0].message, 'Manual');

  view.unmount();
  assert.equal(client.disposals, 0);
});

test('lifecycle callbacks follow the latest visible compilation without changing actions', async () => {
  const client = new FakeClient();
  const staleEvents: PdfResult[] = [];
  const events: LifecycleEvent[] = [];
  let current!: PdfCompilation;
  function Harness({ options }: { options: UsePdfCompilationOptions }) {
    current = usePdfCompilation(options);
    return null;
  }
  const component = (options: Omit<UsePdfCompilationOptions, 'client'>) => createElement(Harness, { options: { ...options, client } });
  const view = render(component({
    onSuccess: value => staleEvents.push(value),
  }));
  const actions = {
    compile: current.compile,
    cancel: current.cancel,
    reset: current.reset,
  };

  view.rerender(component({
    onSuccess: (value, input) => events.push({ type: 'hook-success', value, input }),
    onError: (error, input) => events.push({ type: 'hook-error', error, input }),
    onCancel: (error, input) => events.push({ type: 'hook-cancel', error, input }),
    onSettled: (value, error, input) => events.push({
      type: 'hook-settled', value, error, input,
    }),
  }));
  assert.equal(current.compile, actions.compile);
  assert.equal(current.cancel, actions.cancel);
  assert.equal(current.reset, actions.reset);

  let successful!: Promise<PdfResult>;
  const successfulRequest = request('Callback success');
  await act(async () => {
    successful = current.compile(successfulRequest, {
      onSuccess: (value, input) => events.push({ type: 'call-success', value, input }),
      onSettled: (value, error, input) => events.push({
        type: 'call-settled', value, error, input,
      }),
    });
    await Promise.resolve();
    client.calls[0].resolve(result('Callback success'));
    await successful;
  });
  assert.equal(staleEvents.length, 0);
  assert.deepEqual(events.map(event => event.type), [
    'hook-success', 'call-success', 'hook-settled', 'call-settled',
  ]);
  assert.equal(events[0].value!.metadata.title, 'Callback success');
  assert.equal(events[0].input, successfulRequest);
  assert.equal(events[2].error, undefined);

  const failure = new Error('Callback failure');
  const failedRequest = request('Callback failure');
  let failed!: Promise<PdfResult | Error>;
  await act(async () => {
    failed = current.compile(failedRequest, {
      onError: (error, input) => events.push({ type: 'call-error', error, input }),
      onSettled: (value, error, input) => events.push({
        type: 'call-settled', value, error, input,
      }),
    }).catch((error: Error) => error);
    await Promise.resolve();
    client.calls[1].reject(failure);
    await failed;
  });
  assert.deepEqual(events.slice(4).map(event => event.type), [
    'hook-error', 'call-error', 'hook-settled', 'call-settled',
  ]);
  assert.equal(events[4].error, failure);
  assert.equal(events[4].input, failedRequest);
  assert.equal(events[6].value, undefined);

  const cancelledRequest = request('Callback cancellation');
  let cancelled!: Promise<PdfResult | Error>;
  await act(async () => {
    cancelled = current.compile(cancelledRequest, {
      onCancel: (error, input) => events.push({ type: 'call-cancel', error, input }),
      onSettled: (value, error, input) => events.push({
        type: 'call-settled', value, error, input,
      }),
    }).catch((error: Error) => error);
    await Promise.resolve();
    current.cancel('No longer needed');
    await cancelled;
  });
  assert.deepEqual(events.slice(8).map(event => event.type), [
    'hook-cancel', 'call-cancel', 'hook-settled', 'call-settled',
  ]);
  assert.match((events[8].error as Error).message, /cancelled/);
  assert.equal((events[8].error as Error).cause, 'No longer needed');
  assert.equal(events[8].input, cancelledRequest);
  view.unmount();
});

test('a newer manual request cancels the old request and owns the visible result', async () => {
  const client = new FakeClient();
  let current!: PdfCompilation;
  function Harness() {
    current = usePdfCompilation({ client });
    return null;
  }
  const view = render(createElement(Harness));

  let first!: Promise<PdfResult | Error>;
  let second!: Promise<PdfResult>;
  await act(async () => {
    first = current.compile(request('Old')).catch((error: Error) => error);
    second = current.compile(request('New'));
    await Promise.resolve();
  });
  assert.match((await first as Error).message, /superseded/);
  assert.equal(client.calls[0].signal!.aborted, true);

  await act(async () => {
    client.calls[1].resolve(result('New'));
    await second;
  });
  assert.equal(current.status, 'success');
  assert.equal(current.result!.metadata.title, 'New');
  view.unmount();
});

test('recompilation preserves the latest result through failure, cancellation, and reset', async () => {
  const client = new FakeClient();
  let current!: PdfCompilation;
  function Harness() {
    current = usePdfCompilation({ client });
    return null;
  }
  const view = render(createElement(Harness));

  let initial!: Promise<PdfResult>;
  await act(async () => {
    initial = current.compile(request('Retained'));
    await Promise.resolve();
    client.calls[0].resolve(result('Retained'));
    await initial;
  });

  const failure = new Error('Replacement failed');
  let failed!: Promise<PdfResult | Error>;
  await act(async () => {
    failed = current.compile(request('Failed replacement')).catch((error: Error) => error);
  });
  assert.equal(current.isCompiling, true);
  assert.equal(current.isRecompiling, true);
  assert.equal(current.result!.metadata.title, 'Retained');
  await act(async () => {
    client.calls[1].reject(failure);
    await failed;
  });
  assert.equal(current.isError, true);
  assert.equal(current.error, failure);
  assert.equal(current.result!.metadata.title, 'Retained');
  assert.equal(current.diagnostics[0].message, 'Retained');

  let cancelled!: Promise<PdfResult | Error>;
  await act(async () => {
    cancelled = current.compile(request('Cancelled replacement')).catch((error: Error) => error);
  });
  assert.equal(current.isRecompiling, true);
  await act(async () => {
    current.cancel('Keep the previous result');
    await cancelled;
  });
  assert.equal(current.isCancelled, true);
  assert.equal(current.result!.metadata.title, 'Retained');

  act(() => current.reset());
  assert.equal(current.isIdle, true);
  assert.equal(current.result, undefined);
  assert.equal(current.diagnostics.length, 0);
  view.unmount();
});

test('unmount cancels hook-owned work without disposing the injected client', async () => {
  const client = new FakeClient();
  let current!: PdfCompilation;
  function Harness() {
    current = usePdfCompilation({ client });
    return null;
  }
  const view = render(createElement(Harness));
  let pending!: Promise<PdfResult | Error>;
  await act(async () => {
    pending = current.compile(request('Unmount')).catch((error: Error) => error);
  });
  view.unmount();
  await pending;
  assert.equal(client.calls[0].signal!.aborted, true);
  assert.equal(client.disposals, 0);
});

test('the PDF object URL hook creates exact blobs and revokes replaced URLs', () => {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const created: Blob[] = [];
  const revoked: string[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      created.push(blob);
      return `blob:typfolio-${created.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });

  try {
    let current: string | undefined;
    function Harness({ value }: { value: PdfResult | undefined }) {
      current = usePdfObjectUrl(value);
      return null;
    }
    const view = render(createElement(Harness, { value: undefined }));
    assert.equal(current, undefined);

    const first = result('First URL');
    view.rerender(createElement(Harness, { value: first }));
    assert.equal(current, 'blob:typfolio-1');
    assert.equal(created[0].type, 'application/pdf');
    assert.equal(created[0].size, first.bytes.length);

    view.rerender(createElement(Harness, { value: result('Second URL') }));
    assert.equal(current, 'blob:typfolio-2');
    assert.deepEqual(revoked, ['blob:typfolio-1']);

    view.unmount();
    assert.deepEqual(revoked, ['blob:typfolio-1', 'blob:typfolio-2']);
  } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor);
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
  }
});

test('the hooks render on the server without starting work', () => {
  const client = new FakeClient();
  function Harness() {
    const compilation = usePdfCompilation({ client });
    const url = usePdfObjectUrl(result('Server render'));
    return createElement('span', null, compilation.status, url);
  }
  const html = renderToString(createElement(Harness));
  assert.equal(html, '<span>idle</span>');
  assert.equal(client.calls.length, 0);
});
