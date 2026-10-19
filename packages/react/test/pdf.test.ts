import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, Fragment, useEffect, type ReactElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import {
  definePartial,
  defineTemplate,
  type AnyTemplate,
  type CompileOptions,
  type PdfDocument,
  type PdfResult,
  type StandardSchemaV1,
} from '@typfolio/core';
import { usePdf } from '../dist/index.js';
import type { PdfSource, UsePdfOptions, UsePdfResult } from '../dist/index.js';

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
  document: PdfDocument;
  options: CompileOptions;
  resolve: (result: PdfResult) => void;
  reject: (error: unknown) => void;
}

// Records every compile and settles it when the test says so.
class FakeClient {
  calls: Call[] = [];
  compile(document: PdfDocument, options: CompileOptions = {}): Promise<PdfResult> {
    return new Promise((resolve, reject) => {
      this.calls.push({ document, options, resolve, reject });
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

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

let mounts = 0;
function Chart({ value }: { value: number }): ReactElement {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('svg', { width: 200, height: 80 }, createElement('text', null, `value ${value}`));
}

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

const readsInput = '#import "@local/typfolio:0.1.0": input\n#let data = input(json.with("./input.schema.json"))';

// A template without a schema: its data is not checked.
const page = defineTemplate({ files: { 'main.typ': readsInput }, schemaPath: 'input.schema.json' });

// A template whose schema rejects an empty title.
const titled = defineTemplate({
  files: { 'main.typ': readsInput },
  schema: schema<{ title: string; chart?: string }>(value => (value?.title ? undefined : 'title is empty')),
  schemaPath: 'input.schema.json',
});

const header = definePartial({
  files: { 'common/header.typ': '#import "@local/typfolio:0.1.0": input\n#let settings = input(json.with("./header.schema.json"))' },
  schema: schema<{ institution: string; logo: string }>(value => (value?.institution ? undefined : 'institution is empty')),
  schemaPath: 'common/header.schema.json',
});
const defineReport = () => defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': `${readsInput}\n#import "../common/header.typ": settings` },
  schema: schema<{ title: string; chart: string }>(() => undefined),
  schemaPath: 'report/input.schema.json',
  partials: { header },
});
const report = defineReport();

// The options a test gives; mount adds the client.
type Options = Omit<UsePdfOptions, 'client'>;

function mount(source: PdfSource, options: Options = {}) {
  const client = new FakeClient();
  const harness: { current?: UsePdfResult } = {};
  function Report(props: { source: PdfSource; options: Options }): ReactElement {
    const pdf = usePdf(props.source, { ...props.options, client });
    harness.current = pdf;
    return createElement(Fragment, null, createElement(pdf.AssetRenderer));
  }
  const tree = (source: PdfSource, options: Options) => createElement(Report, { source, options });
  const view = render(tree(source, options));
  return { client, harness, view, update: (next: PdfSource, nextOptions: Options = {}) => view.rerender(tree(next, nextOptions)) };
}

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 30)));

const errorCode = (error: unknown) => (error as { code?: string } | undefined)?.code;

test('usePdf draws the charts, then compiles the document, its charts and its assets', async () => {
  mounts = 0;
  const logo = new Uint8Array([1, 2, 3]);
  const events: string[] = [];
  const { client, harness, view } = mount(
    ({ render: draw }) => page({ title: 'Report', chart: draw(createElement(Chart, { value: 3 })) }),
    {
      assets: { 'logo.png': logo },
      pdf: { standards: ['ua-1'] },
      onSuccess: value => events.push(`success ${value.metadata.title}`),
      onSettled: value => events.push(`settled ${value?.metadata.title}`),
    },
  );
  assert.equal(harness.current?.status, 'drawing');
  assert.equal(harness.current?.isLoading, true);
  await waitFor(() => assert.equal(client.calls.length, 1));
  assert.equal(harness.current?.status, 'compiling');
  const { document, options } = client.last;
  assert.equal(document.template, page);
  assert.deepEqual(document.data, { title: 'Report', chart: '/charts/0.svg' });
  assert.deepEqual(document.partials, {});
  assert.deepEqual(options.pdf, { standards: ['ua-1'] });
  assert.equal(options.assets?.['logo.png'], logo);
  assert.match(decode(options.assets?.['charts/0.svg']), /value 3/);
  assert.equal(options.validate, undefined, 'the client checks the schemas by default');
  assert.ok(options.signal instanceof AbortSignal);

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
  const source = (includeDetails: boolean): PdfSource => ({ render: draw }) =>
    page({ includeDetails, chart: draw(createElement(Chart, { value: 1 })) });
  const { client, harness, view, update } = mount(source(true), { deps: [true] });
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('first')));

  update(source(false), { deps: [false] });
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.document.data, { includeDetails: false, chart: '/charts/0.svg' });
  assert.equal(harness.current?.status, 'compiling');
  assert.equal(harness.current?.isLoading, false);
  assert.equal(harness.current?.isFetching, true);
  assert.equal(harness.current?.result?.metadata.title, 'first');
  assert.equal(mounts, 1, 'the unchanged chart is not drawn again');

  // A newer change supersedes the compile in flight.
  update(source(true), { deps: [true] });
  await waitFor(() => assert.equal(client.calls.length, 3));
  assert.equal(client.calls[1]!.options.signal?.aborted, true);
  await act(async () => client.last.resolve(result('third')));
  assert.equal(harness.current?.result?.metadata.title, 'third');
  view.unmount();
});

test('usePdf does not recompile a document and options written inline when they are equal', async () => {
  const logoBytes = new Uint8Array([9]);
  // A new document, assets and pdf options on every render, as when written inline in a component.
  const inline = (title: string, institution = 'Example University', template = report) =>
    template({ title, chart: '' }, { header: { institution, logo: '' } });
  const options = (): Options => ({ assets: { 'logo.png': logoBytes }, pdf: { standards: ['ua-1'] } });
  const { client, harness, view, update } = mount(inline('Inline'), options());
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('Inline')));
  update(inline('Inline'), options());
  update(inline('Inline'), options());
  await settle();
  assert.equal(client.calls.length, 1);
  assert.equal(harness.current?.status, 'success');

  // Data that does change recompiles.
  update(inline('Changed'), options());
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.deepEqual(client.last.document.data, { title: 'Changed', chart: '' });

  // So does a partial's data.
  update(inline('Changed', 'Other University'), options());
  await waitFor(() => assert.equal(client.calls.length, 3));
  assert.deepEqual(client.last.document.partials, { header: { institution: 'Other University', logo: '' } });

  // A template is compared by reference: an equal one defined again is another template.
  const again = defineReport();
  update(inline('Changed', 'Other University', again), options());
  await waitFor(() => assert.equal(client.calls.length, 4));
  assert.equal(client.last.document.template, again);
  view.unmount();
});

test('usePdf neither draws nor compiles while disabled', async () => {
  mounts = 0;
  const source: PdfSource = ({ render: draw }) => page(draw(createElement(Chart, { value: 1 })));
  const { client, harness, view, update } = mount(source, { enabled: false });
  await settle();
  assert.equal(harness.current?.status, 'idle');
  assert.equal(client.calls.length, 0);
  assert.equal(mounts, 0);
  update(source, { enabled: true });
  await waitFor(() => assert.equal(client.calls.length, 1));
  view.unmount();
});

test('usePdf reports a failed compile and a chart that cannot be drawn', async () => {
  const errors: unknown[] = [];
  const failing = mount(page({ title: 'x' }), { onError: error => errors.push(error) });
  await waitFor(() => assert.equal(failing.client.calls.length, 1));
  const failure = new Error('compile failed');
  await act(async () => failing.client.last.reject(failure));
  assert.equal(failing.harness.current?.status, 'error');
  assert.equal(failing.harness.current?.isError, true);
  assert.equal(failing.harness.current?.error, failure);
  assert.deepEqual([...errors], [failure]);
  failing.view.unmount();

  const undrawn = mount(
    ({ render: draw }) => page(draw(createElement('p', null, 'no svg'))),
    { charts: { timeoutMs: 50 }, onError: error => errors.push(error) },
  );
  await waitFor(() => assert.equal(undrawn.harness.current?.status, 'error'));
  assert.match(String((undrawn.harness.current?.error as Error).message), /did not draw an SVG/);
  assert.equal(errors.length, 2);
  assert.equal(undrawn.client.calls.length, 0);
  undrawn.view.unmount();
});

test('usePdf rebuild() draws and compiles again; cancel() keeps the newest PDF', async () => {
  mounts = 0;
  const { client, harness, view } = mount(({ render: draw }) => page(draw(createElement(Chart, { value: 2 }))));
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('one')));
  act(() => harness.current!.rebuild());
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.equal(mounts, 2);
  act(() => harness.current!.cancel());
  assert.equal(client.last.options.signal?.aborted, true);
  assert.equal(harness.current?.status, 'idle');
  assert.equal(harness.current?.result?.metadata.title, 'one');
  view.unmount();
});

test('usePdf download() saves the newest PDF under one .pdf extension', async () => {
  const { client, harness, view } = mount(page({ title: 'x' }));
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
  const options = (enabled: boolean): Options => ({ enabled, onError: error => errors.push(error) });
  const toggle = page({ title: 'Toggle' });
  const { client, harness, view, update } = mount(toggle, options(true));
  await waitFor(() => assert.equal(client.calls.length, 1));
  update(toggle, options(false));
  await settle();
  assert.equal(client.calls[0]!.options.signal?.aborted, true);
  assert.equal(harness.current?.status, 'idle');
  assert.deepEqual(errors, [], 'a cancelled compile reports no error');

  update(toggle, options(true));
  await waitFor(() => assert.equal(client.calls.length, 2));
  await act(async () => client.last.resolve(result('Toggle')));
  update(toggle, options(false));
  update(toggle, options(true));
  await settle();
  assert.equal(client.calls.length, 2, 'nothing changed, so the finished PDF is reused');
  assert.equal(harness.current?.status, 'success');
  view.unmount();
});

test('usePdf rejects data its schema rejects: nothing is drawn or compiled', async () => {
  mounts = 0;
  const errors: unknown[] = [];
  const source = (title: string): PdfSource => ({ render: draw }) =>
    titled({ title, chart: draw(createElement(Chart, { value: 1 })) });
  const options = (title: string): Options => ({ deps: [title], onError: error => errors.push(error) });
  const { client, harness, view, update } = mount(source(''), options(''));
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.equal(errorCode(harness.current?.error), 'INVALID_INPUT');
  assert.match(String((harness.current?.error as Error).message), /title is empty/);
  assert.equal(errors.length, 1);
  assert.equal(mounts, 0, 'rejected data draws no chart');
  assert.equal(client.calls.length, 0);

  update(source('Valid'), options('Valid'));
  await waitFor(() => assert.equal(client.calls.length, 1));
  assert.deepEqual(client.last.document.data, { title: 'Valid', chart: '/charts/0.svg' });
  assert.equal(mounts, 1);
  view.unmount();
});

test('usePdf with validate: false compiles data its schema rejects; missing data is still an error', async () => {
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const { client, harness, view, update } = mount(titled({ title: '' }), { onError });
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.equal(errorCode(harness.current?.error), 'INVALID_INPUT');
  assert.match(String((harness.current?.error as Error).message), /The template data does not match its schema \(input\.schema\.json\):\n- title is empty/);
  assert.equal(client.calls.length, 0, 'by default, rejected data is not compiled');

  update(titled({ title: '' }), { validate: false, onError });
  await waitFor(() => assert.equal(client.calls.length, 1));
  assert.equal(client.last.document.template, titled);
  assert.deepEqual(client.last.document.data, { title: '' });
  assert.equal(client.last.options.validate, false, 'the client skips the schemas too');
  await act(async () => client.last.resolve(result('Unchecked')));
  assert.equal(harness.current?.status, 'success');
  assert.equal(errors.length, 1);

  // The types still ask for data; without any, nothing is compiled.
  update((titled as AnyTemplate)(), { validate: false, onError });
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.equal(errorCode(harness.current?.error), 'INVALID_REQUEST');
  assert.match(String((harness.current?.error as Error).message), /none was given/);
  assert.equal(errors.length, 2);
  assert.equal(client.calls.length, 1);
  view.unmount();
});

test('usePdf reports the uncalled template as INVALID_REQUEST: nothing is drawn or compiled', async () => {
  const errors: unknown[] = [];
  // A template without a schema takes any data, so it type-checks as a document function; usePdf tells them apart.
  const { client, harness, view } = mount(page, { onError: error => errors.push(error) });
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.equal(errorCode(harness.current?.error), 'INVALID_REQUEST');
  assert.match(String((harness.current?.error as Error).message), /usePdf takes a document/);
  assert.equal(errors.length, 1);
  assert.equal(client.calls.length, 0);
  view.unmount();
});

test('usePdf compiles a defined template with its partials\' data, attachments and charts', async () => {
  const logo = new Uint8Array([7, 7, 7]);
  const { client, view } = mount(({ render: draw, attach }) => report(
    { title: 'Report', chart: draw(createElement(Chart, { value: 4 })) },
    { header: { institution: 'Example University', logo: attach(logo, 'png') } },
  ));
  await waitFor(() => assert.equal(client.calls.length, 1));
  const { document, options } = client.last;
  assert.equal(document.template, report);
  assert.deepEqual(document.data, { title: 'Report', chart: '/charts/0.svg' });
  assert.deepEqual(document.partials, { header: { institution: 'Example University', logo: '/attachments/0.png' } });
  assert.deepEqual(Object.keys(options.assets ?? {}).sort(), ['attachments/0.png', 'charts/0.svg']);
  assert.equal(options.assets?.['attachments/0.png'], logo);
  view.unmount();
});

test('usePdf builds a document function again only when its deps change', async () => {
  mounts = 0;
  let builds = 0;
  const logo = new Uint8Array([5, 5]);
  // A new function on every render, as when written inline in a component.
  const source = (institution: string): PdfSource => ({ render: draw, attach }) => {
    builds += 1;
    return report(
      { title: 'Report', chart: draw(createElement(Chart, { value: 6 })) },
      { header: { institution, logo: attach(logo, 'png') } },
    );
  };
  const { client, harness, view, update } = mount(source('Example University'), { deps: ['Example University'] });
  await waitFor(() => assert.equal(client.calls.length, 1));
  await act(async () => client.last.resolve(result('first')));
  assert.equal(builds, 1);

  update(source('Example University'), { deps: ['Example University'] });
  await settle();
  assert.equal(builds, 1, 'the same deps do not build again');
  assert.equal(client.calls.length, 1);
  assert.equal(harness.current?.status, 'success');

  update(source('Other University'), { deps: ['Other University'] });
  await waitFor(() => assert.equal(client.calls.length, 2));
  assert.equal(builds, 2);
  const { document, options } = client.last;
  assert.deepEqual(document.data, { title: 'Report', chart: '/charts/0.svg' });
  assert.deepEqual(document.partials, { header: { institution: 'Other University', logo: '/attachments/0.png' } });
  assert.equal(options.assets?.['attachments/0.png'], logo);
  assert.match(decode(options.assets?.['charts/0.svg']), /value 6/);
  assert.equal(mounts, 1, 'the unchanged chart is not drawn again');
  view.unmount();
});

test('usePdf checks a defined template\'s schemas before drawing anything', async () => {
  mounts = 0;
  const errors: unknown[] = [];
  const { client, harness, view } = mount(
    ({ render: draw }) => report(
      { title: 'Report', chart: draw(createElement(Chart, { value: 5 })) },
      { header: { institution: '', logo: '' } },
    ),
    { onError: error => errors.push(error) },
  );
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.match(String((harness.current?.error as Error).message), /The data of partial "header" does not match its schema \(common\/header\.schema\.json\):\n- institution is empty/);
  assert.equal(errorCode(harness.current?.error), 'INVALID_INPUT');
  assert.equal(errors.length, 1);
  assert.equal(mounts, 0, 'nothing is drawn for data that fails its schema');
  assert.equal(client.calls.length, 0);
  view.unmount();
});

test('a disabled usePdf checks nothing: data that is not there yet is no error until it is enabled', async () => {
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  // As an app writes it while its data loads: enabled once the data is there.
  const { client, harness, view, update } = mount(page(undefined as unknown as { title: string }), { enabled: false, onError });
  await settle();
  assert.equal(harness.current?.status, 'idle');
  assert.deepEqual(errors, []);
  assert.equal(client.calls.length, 0);
  // Enabling the same document checks it then; a schema it fails is reported before anything compiles.
  update(titled({ title: '' }), { enabled: false, onError });
  await settle();
  assert.deepEqual(errors, []);
  update(titled({ title: '' }), { enabled: true, onError });
  await settle();
  assert.equal(harness.current?.status, 'error');
  assert.equal(errorCode(harness.current?.error), 'INVALID_INPUT');
  assert.equal(client.calls.length, 0);
  update(titled({ title: 'Loaded' }), { enabled: true, onError });
  await waitFor(() => assert.equal(client.calls.length, 1));
  view.unmount();
});
