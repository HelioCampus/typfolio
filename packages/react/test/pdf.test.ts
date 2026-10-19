import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, Fragment, useEffect, type ReactElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { defineInput, definePartial, defineTemplate, type AnyPdfRequest, type PdfResult, type StandardSchemaV1 } from '@typfolio/core';
import { usePdf } from '../dist/index.js';
import type { AnyPdfTemplate, PdfDocument, UsePdfOptions } from '../dist/index.js';

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
  // What the client gets: the fields of every request form, flattened for the assertions.
  request: AnyPdfRequest & { input?: unknown; partials?: Record<string, unknown> };
  signal?: AbortSignal;
  resolve: (result: PdfResult) => void;
  reject: (error: unknown) => void;
}

// Records every compile and settles it when the test says so.
class FakeClient {
  calls: Call[] = [];
  compile(request: AnyPdfRequest, options: { signal?: AbortSignal } = {}): Promise<PdfResult> {
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

// The options a test gives; mount adds the client.
type Options<T extends AnyPdfTemplate> = Omit<UsePdfOptions<T>, 'client'>;

function mount<T extends AnyPdfTemplate>(options: Options<T>) {
  const client = new FakeClient();
  const harness: { current?: PdfDocument } = {};
  function Report(props: { options: Options<T> }): ReactElement {
    const pdf = usePdf({ ...props.options, client } as UsePdfOptions<T>);
    harness.current = pdf;
    return createElement(Fragment, null, createElement(pdf.AssetRenderer));
  }
  const tree = (next: Options<T>) => createElement(Report, { options: next });
  const view = render(tree(options));
  return { client, harness, view, update: (next: Options<T>) => view.rerender(tree(next)) };
}

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 30)));

test('usePdf draws the charts, then compiles the input, its charts and its assets', async () => {
  mounts = 0;
  const logo = new Uint8Array([1, 2, 3]);
  const events: string[] = [];
  const { client, harness, view } = mount({
    template,
    data: ({ render: draw }) => ({ input: { title: 'Report', chart: draw(createElement(Chart, { value: 3 })) } }),
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
  assert.deepEqual(request.input, { title: 'Report', chart: '/charts/0.svg' });
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
  const options = (includeDetails: boolean): Options<typeof template> => ({
    template,
    data: ({ render: draw }) => ({ input: { includeDetails, chart: draw(createElement(Chart, { value: 1 })) } }),
    deps: [includeDetails],
  });
  const { client, harness, view, update } = mount(options(true));
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('first')));

  update(options(false));
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.request.input, { includeDetails: false, chart: '/charts/0.svg' });
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
  const options = (): Options<typeof template> => ({
    template: { entrypoint: 'main.typ', files: { 'main.typ': template.files['main.typ'] } },
    data: { input: { title: 'Inline' } },
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
  update({ ...options(), data: { input: { title: 'Changed' } } });
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.request.input, { title: 'Changed' });
  view.unmount();
});

test('usePdf neither draws nor compiles while disabled', async () => {
  mounts = 0;
  const options = (enabled: boolean): Options<typeof template> => ({
    template,
    data: ({ render: draw }) => ({ input: draw(createElement(Chart, { value: 1 })) }),
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
  const failing = mount({ template, data: { input: { title: 'x' } }, onError: error => errors.push(error) });
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
    data: ({ render: draw }) => ({ input: draw(createElement('p', null, 'no svg')) }),
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
    data: ({ render: draw }) => ({ input: draw(createElement(Chart, { value: 2 })) }),
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
  const { client, harness, view } = mount({ template, data: { input: { title: 'x' } } });
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
  const options = (enabled: boolean): Options<typeof template> => ({
    template,
    data: { input: { title: 'Toggle' } },
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
  const validate = (data: { input?: unknown }) => {
    if (!(data.input as { title: string }).title) throw new Error('title must not be empty');
  };
  const options = (title: string): Options<typeof template> => ({
    template,
    data: ({ render: draw }) => ({ input: { title, chart: draw(createElement(Chart, { value: 1 })) } }),
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

// A Standard Schema without a schema library: `check` returns a message for invalid data.
function schema<T>(check: (value: T) => string | undefined): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => {
        const message = check(value as T);
        return message ? { issues: [{ message }] } : { value: value as T };
      },
    },
  };
}

const header = definePartial({
  files: { 'common/header.typ': '#import "@local/typfolio:0.1.0": input\n#let settings = input(json.with("./header.schema.json"))' },
  input: defineInput(schema<{ institution: string; logo: string }>(value => (value.institution ? undefined : 'institution is empty')), 'common/header.schema.json'),
});
const report = defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': '#import "../common/header.typ": settings' },
  input: defineInput(schema<{ title: string; chart: string }>(() => undefined), 'report/input.schema.json'),
  partials: { header },
});

test('usePdf compiles a defined template with its partials\' data, attachments and charts', async () => {
  const logo = new Uint8Array([7, 7, 7]);
  const { client, view } = mount({
    template: report,
    data: ({ render: draw, attach }) => ({
      input: { title: 'Report', chart: draw(createElement(Chart, { value: 4 })) },
      partials: { header: { institution: 'Example University', logo: attach(logo, 'png') } },
    }),
  });
  await waitFor(() => assert.equal(client.calls.length, 1));
  const request = client.last.request;
  assert.equal(request.template, report);
  assert.deepEqual(request.input, { title: 'Report', chart: '/charts/0.svg' });
  assert.deepEqual(request.partials, { header: { institution: 'Example University', logo: '/attachments/0.png' } });
  assert.deepEqual(Object.keys(request.assets ?? {}).sort(), ['attachments/0.png', 'charts/0.svg']);
  assert.equal(request.assets?.['attachments/0.png'], logo);
  view.unmount();
});

test('usePdf checks a defined template\'s schemas before drawing anything', async () => {
  mounts = 0;
  const errors: unknown[] = [];
  const { client, harness, view } = mount({
    template: report,
    data: ({ render: draw }) => ({
      input: { title: 'Report', chart: draw(createElement(Chart, { value: 5 })) },
      partials: { header: { institution: '', logo: '' } },
    }),
    onError: error => errors.push(error),
  });
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.match(String((harness.current?.error as Error).message), /The data of partial "header" does not match its schema \(common\/header\.schema\.json\):\n- institution is empty/);
  assert.equal((harness.current?.error as { code?: string }).code, 'INVALID_INPUT');
  assert.equal(errors.length, 1);
  assert.equal(mounts, 0, 'nothing is drawn for data that fails its schema');
  assert.equal(client.calls.length, 0);
  view.unmount();
});
