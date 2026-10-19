import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import * as core from '../dist/index.js';
import {
  TypfolioCaptureError,
  captureAssets,
  captureProps,
} from '../dist/capture.js';
import type {
  CaptureAdapter,
  CaptureAdapterContext,
  CaptureErrorCode,
  CaptureMarker,
} from '../dist/capture.js';
import { domPngCapture } from '../dist/capture/dom.js';
import type { DomPngRasterizeOptions } from '../dist/capture/dom.js';
import { svgCapture } from '../dist/capture/svg.js';

type CaptureModule = typeof import('../dist/capture.js');
type DomModule = typeof import('../dist/capture/dom.js');

const bounds = (width = 400, height = 120): DOMRect => ({
  width,
  height,
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  toJSON: () => ({}),
});

const isCaptureError = (code: CaptureErrorCode) => (error: unknown): error is TypfolioCaptureError =>
  error instanceof TypfolioCaptureError && error.code === code;

const fake = (
  extension = '.bin',
  bytes: number[] = [1, 2, 3],
  onCapture: (element: Element, context: CaptureAdapterContext) => void = () => {},
): CaptureAdapter => ({
  name: `fake ${extension}`,
  extensions: [extension],
  capture(element, context) {
    onCapture(element, context);
    return new Uint8Array(bytes);
  },
});

const rootOf = (html: string) => {
  const dom = new JSDOM(`<!doctype html><body><main id="root">${html}</main></body>`);
  return dom.window.document.querySelector('#root')!;
};

test('the main entry does not expose capture code', () => {
  assert.equal('captureAssets' in core, false);
  assert.equal('captureProps' in core, false);
});

test('captureProps emits neutral data attributes and does not add semantics', () => {
  const alt = captureProps({ id: 'chart', kind: 'svg', altText: '72% met the goal.' });
  assert.deepEqual({ ...alt }, {
    'data-typfolio-capture': 'chart',
    'data-typfolio-capture-kind': 'svg',
    'data-typfolio-capture-alt': '72% met the goal.',
  });
  assert.ok(Object.isFrozen(alt));
  const decorative = captureProps({ id: 'divider', kind: 'png', decorative: true });
  assert.deepEqual({ ...decorative }, {
    'data-typfolio-capture': 'divider',
    'data-typfolio-capture-kind': 'png',
    'data-typfolio-capture-decorative': '',
  });
  for (const props of [alt, decorative]) {
    assert.ok(!Object.keys(props).some(name => name === 'role' || name.startsWith('aria-')));
  }
});

test('captureProps rejects invalid ids and kinds but tolerates empty alt text', () => {
  for (const id of ['', ' ', '-a', '.a', 'a/b', 'a b', '../x', 'ü']) {
    assert.throws(
      () => captureProps({ id, kind: 'svg', altText: 'x' }),
      isCaptureError('INVALID_OPTIONS'),
      JSON.stringify(id),
    );
  }
  const kinds: unknown[] = ['', '  ', undefined, 3];
  for (const kind of kinds) {
    assert.throws(
      // The cast stands in for a caller that bypasses the types; the kind must still be rejected at run time.
      () => captureProps({ id: 'chart', kind: kind as string, altText: 'x' }),
      isCaptureError('INVALID_OPTIONS'),
    );
  }
  for (const id of ['a', '0', 'a.b-c_d', 'Chart-1']) {
    assert.doesNotThrow(() => captureProps({ id, kind: 'svg', altText: 'x' }));
  }
  const empty = captureProps({ id: 'chart', kind: 'svg', altText: '' });
  assert.equal(empty['data-typfolio-capture-alt'], '');
});

test('SVG capture discovers regions and returns compiler assets and references', async () => {
  const root = rootOf(`
    <section data-typfolio-capture="chart" data-typfolio-capture-kind="svg"
             data-typfolio-capture-alt="A chart summary.">
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><clipPath id="clip"><rect width="400" height="120"/></clipPath></defs>
        <g clip-path="url(https://typfolio.test/report#clip)">
          <rect class="bar" width="200" height="30" style="fill: rgb(10, 110, 50)"/>
          <text style="font-family: Arial">Proficient</text>
        </g>
        <g class="tooltip"><text>Transient</text></g>
      </svg>
    </section>`);
  root.querySelector('svg')!.getBoundingClientRect = () => bounds();

  const captured = await captureAssets(root, {
    adapters: {
      svg: svgCapture({
        fontFamily: 'Open Sans',
        beforeSerialize: svg => {
          // The clone, sized and styled: the live SVG keeps its tooltip.
          assert.notEqual(svg, root.querySelector('svg'));
          assert.equal(svg.getAttribute('width'), '400');
          for (const node of svg.querySelectorAll('.tooltip')) node.remove();
        },
      }),
    },
  });
  assert.deepEqual(Object.keys(captured.assets), ['captures/chart.svg']);
  const source = new TextDecoder().decode(captured.assets['captures/chart.svg']);
  assert.match(source, /width="400"/);
  assert.match(source, /viewBox="0 0 400 120"/);
  assert.match(source, /fill: rgb\(10, 110, 50\)/);
  assert.match(source, /font-family="Open Sans"/);
  assert.match(source, /clip-path="url\(#clip\)"/);
  assert.doesNotMatch(source, /Transient|class="tooltip"/);
  assert.deepEqual(captured.references, {
    chart: {
      path: 'captures/chart.svg',
      decorative: false,
      altText: 'A chart summary.',
    },
  });
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.assets));
  assert.ok(Object.isFrozen(captured.references));
  assert.ok(Object.isFrozen(captured.references.chart));
});

test('DOM capture rasterizes only when requested and trims alt text', async () => {
  const root = rootOf(`<article data-typfolio-capture="card" data-typfolio-capture-kind="png"
      data-typfolio-capture-alt="  Assessment outcome summary.  "><h2>Summary</h2></article>`);
  const card = root.querySelector('article')!;
  card.getBoundingClientRect = () => bounds(320, 180);
  const expected = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let rasterized = undefined as { element: HTMLElement; options: DomPngRasterizeOptions } | undefined;
  const beforeRasterize = (element: HTMLElement) => element.querySelector('.transient')?.remove();
  const adapter = domPngCapture({
    pixelRatio: 2,
    backgroundColor: null,
    beforeRasterize,
    rasterize: async (element, options) => {
      rasterized = { element, options };
      // A canvas stand-in: the adapter only asks it for a blob.
      return {
        toBlob(callback: BlobCallback, type?: string) {
          callback(new Blob([expected], { type }));
        },
      } as unknown as HTMLCanvasElement;
    },
  });

  const captured = await captureAssets(root, { adapters: { png: adapter } });
  assert.equal(rasterized!.element, card);
  assert.equal(rasterized!.options.pixelRatio, 2);
  assert.equal(rasterized!.options.backgroundColor, null);
  assert.equal(rasterized!.options.beforeRasterize, beforeRasterize);
  assert.deepEqual(captured.assets['captures/card.png'], expected);
  assert.deepEqual(captured.references.card, {
    path: 'captures/card.png',
    decorative: false,
    altText: 'Assessment outcome summary.',
  });
});

test('the default DOM rasterizer reports a missing html2canvas with an install hint', async () => {
  // A copy of dist outside the repository cannot resolve the repo's html2canvas devDependency.
  const directory = await mkdtemp(join(tmpdir(), 'typfolio-no-html2canvas-'));
  try {
    await cp(new URL('../dist', import.meta.url), directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const capture: CaptureModule = await import(pathToFileURL(join(directory, 'capture.js')).href);
    const dom: DomModule = await import(pathToFileURL(join(directory, 'capture/dom.js')).href);
    const root = rootOf(`<article data-typfolio-capture="card" data-typfolio-capture-kind="png"
        data-typfolio-capture-alt="Card"></article>`);
    root.querySelector('article')!.getBoundingClientRect = () => bounds(10, 10);

    await assert.rejects(
      capture.captureAssets(root, { adapters: { png: dom.domPngCapture() } }),
      error => {
        assert.ok(error instanceof capture.TypfolioCaptureError);
        assert.equal(error.code, 'CAPTURE_FAILED');
        assert.match(error.message, /install html2canvas/i);
        assert.match(error.message, /custom rasterize/);
        assert.equal(error.captureId, 'card');
        assert.equal(error.path, 'captures/card.png');
        assert.equal((error.cause as { code?: string } | undefined)?.code, 'ERR_MODULE_NOT_FOUND');
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('regions are discovered in DOM order and paths use the first adapter extension', async () => {
  const root = rootOf(`
    <div data-typfolio-capture="second" data-typfolio-capture-kind="b" data-typfolio-capture-alt="Second">
      <div data-typfolio-capture="nested.one" data-typfolio-capture-kind="a" data-typfolio-capture-alt="Nested"></div>
    </div>
    <p data-typfolio-capture="third" data-typfolio-capture-kind="a" data-typfolio-capture-decorative></p>`);
  const order: string[][] = [];
  const record = (_element: Element, context: CaptureAdapterContext) => order.push([context.captureId, context.path]);
  const a = { ...fake('.aa', [1], record), extensions: ['.aa', '.alt'] };
  const b = fake('.bb', [2], record);

  const captured = await captureAssets(root, { adapters: { a, b } });
  assert.deepEqual(order, [
    ['second', 'captures/second.bb'],
    ['nested.one', 'captures/nested.one.aa'],
    ['third', 'captures/third.aa'],
  ]);
  assert.deepEqual(Object.keys(captured.assets), order.map(([, path]) => path));
  assert.deepEqual(Object.keys(captured.references), ['second', 'nested.one', 'third']);
});

test('the root element itself can be the region', async () => {
  const root = rootOf('');
  root.setAttribute('data-typfolio-capture', 'self');
  root.setAttribute('data-typfolio-capture-kind', 'x');
  root.setAttribute('data-typfolio-capture-alt', 'Whole root');
  const seen: Element[] = [];
  const captured = await captureAssets(root, {
    adapters: { x: fake('.x', [9], element => seen.push(element)) },
  });
  assert.deepEqual(seen, [root]);
  assert.deepEqual(captured.references.self, {
    path: 'captures/self.x',
    decorative: false,
    altText: 'Whole root',
  });
});

test('decorative regions produce decorative references without alt text', async () => {
  const root = rootOf(`<div data-typfolio-capture="rule" data-typfolio-capture-kind="x"
      data-typfolio-capture-decorative=""></div>`);
  const captured = await captureAssets(root, { adapters: { x: fake('.x') } });
  assert.deepEqual(captured.references, { rule: { path: 'captures/rule.x', decorative: true } });
  assert.ok(Object.isFrozen(captured.references.rule));
});

test('no regions and nothing required resolves with empty frozen results', async () => {
  const captured = await captureAssets(rootOf('<p>nothing</p>'), { adapters: {} });
  assert.deepEqual(captured.assets, {});
  assert.deepEqual(captured.references, {});
  assert.ok(Object.isFrozen(captured.assets));
  assert.ok(Object.isFrozen(captured.references));
});

test('a missing root is not ready', async () => {
  await assert.rejects(captureAssets(null, { adapters: {} }), isCaptureError('NOT_READY'));
});

test('required ids that are missing fail with NOT_FOUND', async () => {
  const root = rootOf(`<div data-typfolio-capture="here" data-typfolio-capture-kind="x"
      data-typfolio-capture-alt="Here"></div>`);
  let ran = false;
  const adapter = fake('.x', [1], () => { ran = true; });
  await assert.rejects(
    captureAssets(root, { adapters: { x: adapter }, require: ['here', 'gone'] }),
    error => isCaptureError('NOT_FOUND')(error) && error.captureId === 'gone',
  );
  assert.equal(ran, false);
  await assert.rejects(
    captureAssets(rootOf(''), { adapters: {}, require: ['gone'] }),
    isCaptureError('NOT_FOUND'),
  );
  const captured = await captureAssets(root, { adapters: { x: adapter }, require: ['here'] });
  assert.deepEqual(Object.keys(captured.references), ['here']);
});

test('invalid regions fail before any adapter runs', async () => {
  const bad: Record<string, [html: string, code: CaptureErrorCode]> = {
    duplicate: [
      `<div data-typfolio-capture="chart" data-typfolio-capture-kind="x" data-typfolio-capture-alt="One"></div>
       <div data-typfolio-capture="chart" data-typfolio-capture-kind="x" data-typfolio-capture-alt="Two"></div>`,
      'DUPLICATE_ID',
    ],
    unknownKind: [
      `<div data-typfolio-capture="a" data-typfolio-capture-kind="x" data-typfolio-capture-alt="A"></div>
       <div data-typfolio-capture="b" data-typfolio-capture-kind="nope" data-typfolio-capture-alt="B"></div>`,
      'UNKNOWN_KIND',
    ],
    inheritedKind: [
      '<div data-typfolio-capture="a" data-typfolio-capture-kind="constructor" data-typfolio-capture-alt="A"></div>',
      'UNKNOWN_KIND',
    ],
    missingAlt: [
      `<div data-typfolio-capture="a" data-typfolio-capture-kind="x" data-typfolio-capture-alt="A"></div>
       <div data-typfolio-capture="b" data-typfolio-capture-kind="x"></div>`,
      'INVALID_ACCESSIBILITY',
    ],
    blankAlt: [
      '<div data-typfolio-capture="a" data-typfolio-capture-kind="x" data-typfolio-capture-alt="  "></div>',
      'INVALID_ACCESSIBILITY',
    ],
    both: [
      `<div data-typfolio-capture="a" data-typfolio-capture-kind="x"
            data-typfolio-capture-alt="A" data-typfolio-capture-decorative></div>`,
      'INVALID_ACCESSIBILITY',
    ],
    badId: [
      '<div data-typfolio-capture="a b" data-typfolio-capture-kind="x" data-typfolio-capture-alt="A"></div>',
      'INVALID_OPTIONS',
    ],
    missingKind: [
      '<div data-typfolio-capture="a" data-typfolio-capture-alt="A"></div>',
      'INVALID_OPTIONS',
    ],
  };
  for (const [name, [html, code]] of Object.entries(bad)) {
    let ran = false;
    const adapter = fake('.x', [1], () => { ran = true; });
    await assert.rejects(
      captureAssets(rootOf(html), { adapters: { x: adapter } }),
      isCaptureError(code),
      name,
    );
    assert.equal(ran, false, `${name} ran an adapter`);
  }
});

test('invalid adapters and options are rejected', async () => {
  const root = rootOf('');
  // Adapters the types do not allow; each must be rejected at run time.
  const invalid: unknown[] = [
    undefined,
    { name: 'no extensions', extensions: [], capture() {} },
    { name: 'dotless', extensions: ['svg'], capture() {} },
    { name: 'uppercase', extensions: ['.SVG'], capture() {} },
    { name: 'compound', extensions: ['.tar.gz'], capture() {} },
    { name: ' ', extensions: ['.x'], capture() {} },
    { name: 'no capture', extensions: ['.x'] },
  ];
  for (const adapter of invalid) {
    await assert.rejects(
      captureAssets(root, { adapters: { x: adapter as CaptureAdapter } }),
      isCaptureError('INVALID_OPTIONS'),
    );
  }
  // @ts-expect-error options without adapters must be rejected at run time
  await assert.rejects(captureAssets(root, {}), isCaptureError('INVALID_OPTIONS'));
  await assert.rejects(
    // @ts-expect-error require must be an array of ids
    captureAssets(root, { adapters: {}, require: 'chart' }),
    isCaptureError('INVALID_OPTIONS'),
  );
  // @ts-expect-error beforeSerialize must be a function
  assert.throws(() => svgCapture({ beforeSerialize: '.tooltip' }), isCaptureError('INVALID_OPTIONS'));
  // @ts-expect-error beforeRasterize must be a function
  assert.throws(() => domPngCapture({ beforeRasterize: ['.tooltip'] }), isCaptureError('INVALID_OPTIONS'));
});

test('adapter failures are wrapped and empty output is rejected', async () => {
  const region = `<div data-typfolio-capture="a" data-typfolio-capture-kind="x"
      data-typfolio-capture-alt="A"></div>`;
  const cause = new Error('boom');
  await assert.rejects(
    captureAssets(rootOf(region), {
      adapters: { x: { name: 'bad', extensions: ['.x'], capture() { throw cause; } } },
    }),
    error => isCaptureError('CAPTURE_FAILED')(error)
      && error.cause === cause
      && error.captureId === 'a'
      && error.path === 'captures/a.x',
  );
  await assert.rejects(
    captureAssets(rootOf(region), { adapters: { x: fake('.x', []) } }),
    isCaptureError('EMPTY_ASSET'),
  );
  const own = new TypfolioCaptureError('NOT_READY', 'no size');
  await assert.rejects(
    captureAssets(rootOf(region), {
      adapters: { x: { name: 'own', extensions: ['.x'], capture() { throw own; } } },
    }),
    error => error === own,
  );
});

test('capture cancellation is observed before and between captures', async () => {
  const controller = new AbortController();
  controller.abort('closed');
  await assert.rejects(
    captureAssets(null, { adapters: {}, signal: controller.signal }),
    isCaptureError('ABORTED'),
  );

  const second = new AbortController();
  let captures = 0;
  const adapter = fake('.x', [1], () => { captures += 1; second.abort('stop'); });
  const root = rootOf(`
    <div data-typfolio-capture="a" data-typfolio-capture-kind="x" data-typfolio-capture-alt="A"></div>
    <div data-typfolio-capture="b" data-typfolio-capture-kind="x" data-typfolio-capture-alt="B"></div>`);
  await assert.rejects(
    captureAssets(root, { adapters: { x: adapter }, signal: second.signal }),
    error => isCaptureError('ABORTED')(error) && error.cause === 'stop',
  );
  assert.equal(captures, 1);
});

test('captureProps output round-trips through discovery', async () => {
  const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>');
  const { document } = dom.window;
  const root = document.querySelector('#root')!;
  const markers: CaptureMarker[] = [
    { id: 'chart', kind: 'x', altText: 'Chart' },
    { id: 'rule', kind: 'x', decorative: true },
  ];
  for (const marker of markers) {
    const element = document.createElement('div');
    for (const [name, value] of Object.entries(captureProps(marker))) element.setAttribute(name, value);
    root.append(element);
  }
  const captured = await captureAssets(root, { adapters: { x: fake('.x') } });
  assert.deepEqual(captured.references, {
    chart: { path: 'captures/chart.x', decorative: false, altText: 'Chart' },
    rule: { path: 'captures/rule.x', decorative: true },
  });
});
