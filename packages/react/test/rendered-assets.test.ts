import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createContext, createElement, Fragment, useContext, useEffect, type DependencyList, type ReactElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
// usePdf's chart drawing, an internal module.
import { useRenderedAssets } from '../dist/rendered-assets.js';
import type { RenderAsset, RenderedAssets, UseRenderedAssetsOptions } from '../dist/rendered-assets.js';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://typfolio.test/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;

// jsdom does no layout: an SVG with a `width` attribute reports that size, as a drawn chart would.
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const width = Number(this.getAttribute('width') ?? 0);
  const height = Number(this.getAttribute('height') ?? 0);
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
};

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const Label = createContext('no provider');
let mounts = 0;

function Chart({ value, onPick }: { value: number; onPick?: () => void }): ReactElement {
  const label = useContext(Label);
  useEffect(() => {
    mounts += 1;
  }, []);
  void onPick;
  return createElement(
    'svg',
    { width: 300, height: 100, xmlns: 'http://www.w3.org/2000/svg' },
    createElement('rect', { width: value, height: 10, style: { fill: 'rgb(1, 2, 3)' } }),
    createElement('text', null, `${label}: ${value}`),
    createElement('g', { className: 'tooltip' }, createElement('text', null, 'Transient')),
  );
}

interface Harness<T> {
  current?: RenderedAssets<T>;
  builds: number;
}

type Build<T> = (tools: { readonly render: RenderAsset }) => T;

function mount<T>(
  build: Build<T>,
  options: UseRenderedAssetsOptions<T> = {},
  { withRenderer = true }: { withRenderer?: boolean } = {},
) {
  const harness: Harness<T> = { builds: 0 };
  function Exporter(props: { build: Build<T>; options: UseRenderedAssetsOptions<T> }): ReactElement {
    const result = useRenderedAssets(tools => {
      harness.builds += 1;
      return props.build(tools);
    }, props.options);
    harness.current = result;
    return createElement(Fragment, null, withRenderer ? createElement(result.AssetRenderer) : null);
  }
  const tree = (nextBuild: Build<T>, nextOptions: UseRenderedAssetsOptions<T>) =>
    createElement(Label.Provider, { value: 'From the app' }, createElement(Exporter, { build: nextBuild, options: nextOptions }));
  const view = render(tree(build, options));
  return {
    harness,
    view,
    update: (nextBuild: Build<T>, nextOptions: UseRenderedAssetsOptions<T>) => view.rerender(tree(nextBuild, nextOptions)),
  };
}

test('useRenderedAssets draws each rendered element into an SVG asset at the path it returned', async () => {
  const rows = [{ name: 'A', value: 40 }, { name: 'B', value: 70 }];
  let ready: unknown[] | undefined;
  const { harness, view } = mount(
    ({ render: draw }) => rows.map(row => ({ name: row.name, chart: draw(createElement(Chart, { value: row.value })) })),
    { onReady: (assets, value) => { ready = [assets, value]; } },
  );
  assert.deepEqual(harness.current?.value, [
    { name: 'A', chart: '/charts/0.svg' },
    { name: 'B', chart: '/charts/1.svg' },
  ]);
  assert.equal(harness.current?.status, 'drawing');
  assert.equal(harness.current?.assets, undefined);

  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  const assets = harness.current!.assets!;
  assert.deepEqual(Object.keys(assets), ['charts/0.svg', 'charts/1.svg']);
  const first = decode(assets['charts/0.svg']);
  // The element saw the app's providers: it is portalled from the caller's tree.
  assert.match(first, /From the app: 40/);
  assert.match(first, /fill: rgb\(1, 2, 3\)/);
  assert.match(first, /width="300"/);
  assert.equal(first.match(/xmlns=/g)?.length, 1);
  assert.match(decode(assets['charts/1.svg']), /From the app: 70/);
  assert.ok(Object.isFrozen(assets));
  assert.deepEqual(ready, [assets, harness.current!.value]);
  // Built once, and the renderer's element is gone from the document once drawn.
  assert.equal(harness.builds, 1);
  assert.equal(document.querySelector('[data-typfolio-asset-renderer]'), null);
  view.unmount();
});

test('useRenderedAssets forces the font family, runs beforeSerialize on the copy, and honours the directory', async () => {
  const { harness, view } = mount(({ render: draw }) => ({ chart: draw(createElement(Chart, { value: 10 })) }), {
    directory: 'figures/outcomes',
    fontFamily: 'Source Sans 3',
    beforeSerialize: svg => svg.querySelectorAll('.tooltip').forEach(node => node.remove()),
  });
  assert.deepEqual(harness.current?.value, { chart: '/figures/outcomes/0.svg' });
  await waitFor(() => assert.ok(document.querySelector('[data-typfolio-asset-renderer] svg')));
  const style = [...document.head.querySelectorAll('style')].find(node => node.textContent?.includes('Source Sans 3'));
  assert.ok(style, 'a scoped stylesheet forces the font while drawing');
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  const svg = decode(harness.current!.assets!['figures/outcomes/0.svg']);
  assert.match(svg, /font-family="Source Sans 3"/);
  assert.doesNotMatch(svg, /Transient/);
  assert.equal(style.isConnected, false);
  view.unmount();
});

test('useRenderedAssets loads its fonts before drawing and removes them on unmount', async () => {
  const added: unknown[] = [];
  const order: string[] = [];
  class FakeFontFace {
    readonly family: string;
    readonly source: unknown;
    constructor(family: string, source: unknown) {
      this.family = family;
      this.source = source;
    }
    async load() {
      order.push('font loaded');
      return this;
    }
  }
  Object.assign(globalThis, { FontFace: FakeFontFace });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: unknown) => added.push(face), delete: (face: unknown) => added.splice(added.indexOf(face), 1) },
  });
  try {
    const { harness, view } = mount(({ render: draw }) => {
      order.push('built');
      return draw(createElement(Chart, { value: 5 }));
    }, { fonts: [{ family: 'Body', source: '/fonts/body.otf', descriptors: { weight: '400' } }] });
    await waitFor(() => assert.equal(harness.current?.status, 'ready'));
    assert.equal(added.length, 1);
    const face = added[0] as FakeFontFace;
    assert.equal(face.family, 'Body');
    assert.equal(face.source, 'url("https://typfolio.test/fonts/body.otf")');
    assert.deepEqual(order, ['built', 'font loaded']);
    view.unmount();
    assert.equal(added.length, 0);
  } finally {
    delete (globalThis as { FontFace?: unknown }).FontFace;
    delete (document as { fonts?: unknown }).fonts;
  }
});

test('useRenderedAssets draws without its fonts where the platform cannot load fonts', async () => {
  assert.equal(typeof (globalThis as { FontFace?: unknown }).FontFace, 'undefined');
  const { harness, view } = mount(({ render: draw }) => draw(createElement(Chart, { value: 2 })), {
    fonts: [{ family: 'Body', source: '/fonts/body.otf' }],
  });
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  view.unmount();
});

test('useRenderedAssets rebuilds when deps change and draws only the elements that changed', async () => {
  mounts = 0;
  const build = (title: string, values: number[]): Build<{ title: string; charts: string[] }> =>
    ({ render: draw }) => ({ title, charts: values.map(value => draw(createElement(Chart, { value }))) });
  const options = (deps: DependencyList) => ({ deps });
  const { harness, view, update } = mount(build('First', [1, 2]), options(['First', 1, 2]));
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(mounts, 2);
  const firstAssets = harness.current!.assets!;

  // A new title, the same charts: built again, nothing drawn again.
  update(build('Second', [1, 2]), options(['Second', 1, 2]));
  await waitFor(() => assert.equal(harness.current?.value.title, 'Second'));
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(harness.builds, 2);
  assert.equal(mounts, 2);
  assert.equal(harness.current!.assets!['charts/0.svg'], firstAssets['charts/0.svg']);

  // One chart changed: only it is drawn.
  update(build('Second', [1, 3]), options(['Second', 1, 3]));
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(harness.builds, 3);
  assert.equal(mounts, 3);
  assert.equal(harness.current!.assets!['charts/0.svg'], firstAssets['charts/0.svg']);
  assert.match(decode(harness.current!.assets!['charts/1.svg']), /From the app: 3/);

  // An unchanged render does not build again.
  update(build('Second', [1, 3]), options(['Second', 1, 3]));
  assert.equal(harness.builds, 3);

  // rebuild() draws everything again.
  act(() => harness.current!.rebuild());
  await waitFor(() => assert.equal(harness.builds, 4));
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(mounts, 5);
  view.unmount();
});

test('useRenderedAssets draws an element with a function prop every time: it cannot be compared', async () => {
  mounts = 0;
  const build = (title: string): Build<string> => ({ render: draw }) => {
    draw(createElement(Chart, { value: 1, onPick: () => {} }));
    return title;
  };
  const { harness, view, update } = mount(build('a'), { deps: ['a'] });
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  update(build('b'), { deps: ['b'] });
  await waitFor(() => assert.equal(harness.current?.value, 'b'));
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(mounts, 2);
  view.unmount();
});

test('useRenderedAssets draws nothing while disabled', async () => {
  mounts = 0;
  const build: Build<string> = ({ render: draw }) => draw(createElement(Chart, { value: 1 }));
  const { harness, view, update } = mount(build, { enabled: false });
  await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
  assert.equal(harness.current?.status, 'idle');
  assert.equal(mounts, 0);
  update(build, { enabled: true });
  await waitFor(() => assert.equal(harness.current?.status, 'ready'));
  assert.equal(mounts, 1);
  view.unmount();
});

test('useRenderedAssets is ready at once when build renders nothing', () => {
  const { harness, view } = mount(() => 'no charts');
  assert.equal(harness.current?.status, 'ready');
  assert.deepEqual(harness.current?.assets, {});
  assert.equal(harness.current?.value, 'no charts');
  view.unmount();
});

test('useRenderedAssets reports an AssetRenderer that is never rendered', async () => {
  let reported: Error | undefined;
  const { harness, view } = mount(({ render: draw }) => draw(createElement(Chart, { value: 1 })), {
    timeoutMs: 50,
    onError: error => { reported = error; },
  }, { withRenderer: false });
  await waitFor(() => assert.equal(harness.current?.status, 'error'));
  assert.match(String(harness.current?.error?.message), /<AssetRenderer \/> is not rendered/);
  assert.equal(reported, harness.current?.error);
  view.unmount();
});

test('useRenderedAssets reports an element that never draws an SVG', async () => {
  const { harness, view } = mount(({ render: draw }) => draw(createElement('p', null, 'not a chart')), { timeoutMs: 50 });
  await waitFor(() => assert.equal(harness.current?.status, 'error'));
  assert.match(String(harness.current?.error?.message), /charts\/0\.svg did not draw an SVG/);
  view.unmount();
});

test('useRenderedAssets rejects render calls after build returns', () => {
  let late: RenderAsset | undefined;
  const { view } = mount(({ render: draw }) => {
    late = draw;
    return null;
  });
  assert.throws(() => late!(createElement(Chart, { value: 1 })), /after build returned/);
  view.unmount();
});

test('useRenderedAssets rejects a directory that is not a relative path', () => {
  for (const directory of ['/abs', '../up', 'trailing/', '']) {
    assert.throws(() => mount(() => null, { directory }), /directory must be a relative path/);
  }
});
