import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, Fragment, useEffect, type ReactElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import type { PdfRequest, PdfResult } from '@typfolio/core';
import { PdfProvider, usePdf } from '../dist/index.js';
import type { PdfDocument, UsePdfOptions } from '../dist/index.js';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://typfolio.test/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const width = Number(this.getAttribute('width') ?? 0);
  const height = Number(this.getAttribute('height') ?? 0);
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
};
let urls = 0;
const revoked: string[] = [];
URL.createObjectURL = () => `blob:test-${++urls}`;
URL.revokeObjectURL = (url: string) => { revoked.push(url); };

interface Call {
  request: PdfRequest<unknown>;
  signal?: AbortSignal;
  resolve: (result: PdfResult) => void;
  reject: (error: unknown) => void;
}

// Records every compile and settles it when the test says so.
class FakeClient {
  calls: Call[] = [];
  compile(request: PdfRequest<unknown>, options: { signal?: AbortSignal } = {}): Promise<PdfResult> {
    return new Promise((resolve, reject) => {
      this.calls.push({ request, signal: options.signal, resolve, reject });
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
  }
  get last(): Call {
    return this.calls[this.calls.length - 1]!;
  }
}

const result = (title: string): PdfResult => ({
  bytes: new Uint8Array([37, 80, 68, 70]),
  diagnostics: [],
  metadata: { title },
});

let mounts = 0;
function Chart({ value }: { value: number }): ReactElement {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('svg', { width: 200, height: 80 }, createElement('text', null, `value ${value}`));
}

const template = { entrypoint: 'main.typ', files: { 'main.typ': '#let data = json("/input.json")' } };

function mount<Input>(options: UsePdfOptions<Input>) {
  const client = new FakeClient();
  const harness: { current?: PdfDocument } = {};
  function Report(props: { options: UsePdfOptions<Input> }): ReactElement {
    const pdf = usePdf(props.options);
    harness.current = pdf;
    return createElement(Fragment, null, createElement(pdf.AssetRenderer));
  }
  const tree = (next: UsePdfOptions<Input>) => createElement(PdfProvider, { client }, createElement(Report, { options: next }));
  const view = render(tree(options));
  return { client, harness, view, update: (next: UsePdfOptions<Input>) => view.rerender(tree(next)) };
}

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 30)));

test('usePdf draws the charts, then compiles the input, its charts and its assets', async () => {
  mounts = 0;
  const logo = new Uint8Array([1, 2, 3]);
  const events: string[] = [];
  const { client, harness, view } = mount({
    template,
    input: ({ render: draw }) => ({ title: 'Report', chart: draw(createElement(Chart, { value: 3 })) }),
    assets: { 'logo.png': logo },
    pdf: { standards: ['ua-1'] },
    onSuccess: value => events.push(`success ${value.metadata.title}`),
    onSettled: value => events.push(`settled ${value?.metadata.title}`),
  });
  assert.equal(harness.current?.status, 'drawing');
  assert.equal(harness.current?.isLoading, true);
  await waitFor(() => assert.equal(client.calls.length, 1));
  assert.equal(harness.current?.status, 'compiling');
  const request = client.last.request;
  assert.deepEqual(request.input, { title: 'Report', chart: 'charts/0.svg' });
  assert.equal(request.template, template);
  assert.deepEqual(request.pdf, { standards: ['ua-1'] });
  assert.equal(request.assets?.['logo.png'], logo);
  assert.match(new TextDecoder().decode(request.assets?.['charts/0.svg']), /value 3/);

  await act(async () => client.last.resolve(result('Report')));
  assert.equal(harness.current?.status, 'success');
  assert.equal(harness.current?.isSuccess, true);
  assert.equal(harness.current?.isFetching, false);
  assert.equal(harness.current?.result?.metadata.title, 'Report');
  assert.match(String(harness.current?.url), /^blob:test-/);
  assert.deepEqual(events, ['success Report', 'settled Report']);
  assert.equal(mounts, 1);
  view.unmount();
});

test('usePdf recompiles when deps change, keeps the older PDF meanwhile, and redraws only changed charts', async () => {
  mounts = 0;
  const options = (includeDetails: boolean): UsePdfOptions<{ includeDetails: boolean; chart: string }> => ({
    template,
    input: ({ render: draw }) => ({ includeDetails, chart: draw(createElement(Chart, { value: 1 })) }),
    deps: [includeDetails],
  });
  const { client, harness, view, update } = mount(options(true));
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('first')));

  update(options(false));
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.request.input, { includeDetails: false, chart: 'charts/0.svg' });
  assert.equal(harness.current?.status, 'compiling');
  assert.equal(harness.current?.isLoading, false);
  assert.equal(harness.current?.isFetching, true);
  assert.equal(harness.current?.result?.metadata.title, 'first');
  assert.equal(mounts, 1, 'the unchanged chart is not drawn again');

  // A newer change supersedes the compile in flight.
  update(options(true));
  await waitFor(() => assert.equal(client.calls.length, 3));
  assert.equal(client.calls[1]!.signal?.aborted, true);
  await act(async () => client.last.resolve(result('third')));
  assert.equal(harness.current?.result?.metadata.title, 'third');
  view.unmount();
});

test('usePdf does not recompile for equal values written inline on every render', async () => {
  const options = (): UsePdfOptions<{ title: string }> => ({
    template: { entrypoint: 'main.typ', files: { 'main.typ': template.files['main.typ'] } },
    input: { title: 'Inline' },
    assets: { 'logo.png': logoBytes },
    pdf: { standards: ['ua-1'] },
  });
  const logoBytes = new Uint8Array([9]);
  const { client, harness, view, update } = mount(options());
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('Inline')));
  update(options());
  update(options());
  await settle();
  assert.equal(client.calls.length, 1);
  assert.equal(harness.current?.status, 'success');

  // A plain input value that does change recompiles.
  update({ ...options(), input: { title: 'Changed' } });
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.request.input, { title: 'Changed' });
  view.unmount();
});

test('usePdf neither draws nor compiles while disabled', async () => {
  mounts = 0;
  const options = (enabled: boolean): UsePdfOptions<string> => ({
    template,
    input: ({ render: draw }) => draw(createElement(Chart, { value: 1 })),
    enabled,
  });
  const { client, harness, view, update } = mount(options(false));
  await settle();
  assert.equal(harness.current?.status, 'idle');
  assert.equal(client.calls.length, 0);
  assert.equal(mounts, 0);
  update(options(true));
  await waitFor(() => assert.equal(client.calls.length, 1));
  view.unmount();
});

test('usePdf reports a failed compile and a chart that cannot be drawn', async () => {
  const errors: unknown[] = [];
  const failing = mount({ template, input: { title: 'x' }, onError: error => errors.push(error) });
  await waitFor(() => assert.equal(failing.client.calls.length, 1));
  const failure = new Error('compile failed');
  await act(async () => failing.client.last.reject(failure));
  assert.equal(failing.harness.current?.status, 'error');
  assert.equal(failing.harness.current?.isError, true);
  assert.equal(failing.harness.current?.error, failure);
  assert.deepEqual([...errors], [failure]);
  failing.view.unmount();

  const undrawn = mount({
    template,
    input: ({ render: draw }) => draw(createElement('p', null, 'no svg')),
    charts: { timeoutMs: 50 },
    onError: error => errors.push(error),
  });
  await waitFor(() => assert.equal(undrawn.harness.current?.status, 'error'));
  assert.match(String((undrawn.harness.current?.error as Error).message), /did not draw an SVG/);
  assert.equal(errors.length, 2);
  assert.equal(undrawn.client.calls.length, 0);
  undrawn.view.unmount();
});

test('usePdf rebuild() draws and compiles again; cancel() keeps the newest PDF', async () => {
  mounts = 0;
  const { client, harness, view } = mount({
    template,
    input: ({ render: draw }) => draw(createElement(Chart, { value: 2 })),
  });
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('one')));
  act(() => harness.current!.rebuild());
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.equal(mounts, 2);
  act(() => harness.current!.cancel());
  assert.equal(client.last.signal?.aborted, true);
  assert.equal(harness.current?.status, 'idle');
  assert.equal(harness.current?.result?.metadata.title, 'one');
  view.unmount();
});

test('usePdf download() saves the newest PDF under one .pdf extension', async () => {
  const { client, harness, view } = mount({ template, input: { title: 'x' } });
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('Assessment Results')));
  const clicked: string[] = [];
  const click = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push(this.download);
  };
  try {
    harness.current!.download('report.pdf');
    harness.current!.download('  report  ');
    harness.current!.download();
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = click;
  }
  assert.deepEqual(clicked, ['report.pdf', 'report.pdf', 'Assessment Results.pdf']);
  await settle();
  assert.equal(document.querySelectorAll('a').length, 0);
  view.unmount();
});

test('usePdf cancels a compile in flight when disabled, and reuses a finished PDF when enabled again', async () => {
  const errors: unknown[] = [];
  const options = (enabled: boolean): UsePdfOptions<{ title: string }> => ({
    template,
    input: { title: 'Toggle' },
    enabled,
    onError: error => errors.push(error),
  });
  const { client, harness, view, update } = mount(options(true));
  await waitFor(() => assert.equal(client.calls.length, 1));
  update(options(false));
  await settle();
  assert.equal(client.calls[0]!.signal?.aborted, true);
  assert.equal(harness.current?.status, 'idle');
  assert.deepEqual(errors, [], 'a cancelled compile reports no error');

  update(options(true));
  await waitFor(() => assert.equal(client.calls.length, 2));
  await act(async () => client.last.resolve(result('Toggle')));
  update(options(false));
  update(options(true));
  await settle();
  assert.equal(client.calls.length, 2, 'nothing changed, so the finished PDF is reused');
  assert.equal(harness.current?.status, 'success');
  view.unmount();
});

test('usePdf rejects an input that validate throws for: nothing is drawn or compiled', async () => {
  mounts = 0;
  const errors: unknown[] = [];
  const validate = (input: { title: string }) => {
    if (!input.title) throw new Error('title must not be empty');
  };
  const options = (title: string): UsePdfOptions<{ title: string; chart: string }> => ({
    template,
    input: ({ render: draw }) => ({ title, chart: draw(createElement(Chart, { value: 1 })) }),
    deps: [title],
    validate,
    onError: error => errors.push(error),
  });
  const { client, harness, view, update } = mount(options(''));
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.match(String((harness.current?.error as Error).message), /title must not be empty/);
  assert.equal(errors.length, 1);
  assert.equal(mounts, 0, 'a rejected input draws no chart');
  assert.equal(client.calls.length, 0);

  update(options('Valid'));
  await waitFor(() => assert.equal(client.calls.length, 1));
  assert.equal(mounts, 1);
  view.unmount();
});

test('usePdf compiles with a client passed as an option, without a PdfProvider', async () => {
  const client = new FakeClient();
  const harness: { current?: PdfDocument } = {};
  function Report(): ReactElement {
    const pdf = usePdf({ template, input: { title: 'No provider' }, client });
    harness.current = pdf;
    return createElement(pdf.AssetRenderer);
  }
  const view = render(createElement(Report));
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('No provider')));
  assert.equal(harness.current?.status, 'success');
  view.unmount();
});
