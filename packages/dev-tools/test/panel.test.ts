import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { configure, fireEvent, waitFor, within } from '@testing-library/dom';
import { createCompiler, defineTemplate, TypstPdfError } from '@typfolio/core';
import type { PdfCompiler, PdfOptions } from '@typfolio/core';
import type { StructurePanelPdfJs } from '../dist/panel.js';

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));

// The panel is the bundle a page gets, React and all, run in jsdom. React reads the DOM globals when it loads, so
// they are set before the bundle is imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://typfolio.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const { mountStructureDevtools, mountStructurePanel } = await import('../dist/panel.js');
const pdfjs: StructurePanelPdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');
configure({ asyncUtilTimeout: 5000 });

let compiler!: PdfCompiler;
before(async () => {
  const wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  const fonts = await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`)));
  compiler = await createCompiler({ wasm, fonts });
});
after(() => compiler?.dispose());

const levels = '#set text(font: "Libertinus Serif", lang: "en")\n#set document(title: "Levels")\n';
const compileSource = async (source: string, pdf: PdfOptions = {}) => (await compiler.compile(defineTemplate({ files: { 'main.typ': levels + source } })(), { pdf })).bytes;
const headerless = () => compileSource('= Results\n#table(columns: 2, [Ada], [90], [Grace], [85])');
const withHeader = () => compileSource('= Results\n#table(columns: 2, table.header([Name], [Score]), [Ada], [90], [Grace], [85])');

/** An element to mount into, and queries over what the panel shows inside its shadow root. */
function target() {
  const element = document.createElement('div');
  document.body.append(element);
  const shadow = () => element.querySelector('[data-typfolio-panel]')?.shadowRoot ?? undefined;
  const view = () => within(shadow()!.lastElementChild as HTMLElement);
  return { element, shadow, view };
}

/** pdf.js, counting the documents opened and freed. */
function counted() {
  const counts = { opened: 0, destroyed: 0 };
  const wrapped: StructurePanelPdfJs = {
    getDocument(source) {
      const task = pdfjs.getDocument(source);
      counts.opened += 1;
      return { promise: task.promise, destroy: () => { counts.destroyed += 1; return task.destroy(); } };
    },
  };
  return { counts, pdfjs: wrapped };
}

test('the panel shows the tags and their problems, and a problem opens the tag it is about', async () => {
  const { element, view } = target();
  const panel = mountStructurePanel(element, { pdfjs, bytes: await headerless() });
  try {
    await view().findByText('1 problem a screen reader user would hit');
    assert.ok(view().getByText('1 page · 1 heading · 1 table · 0 figures'));
    const problem = view().getByRole('button', { name: /^Page 1: The table starting "Ada 90 Grace 85" has no header cells/ });
    // The table starts closed, marked; its cells are not listed until it is opened.
    const tableRow = view().getByRole('button', { name: /^Table.*No header cells$/ });
    assert.ok(view().queryByText('Grace') === null);
    assert.ok(view().getByText('Select a tag to see its text, alt text and language.'));

    fireEvent.click(problem);
    await waitFor(() => assert.equal(tableRow.closest('.tf-row')?.getAttribute('data-selected'), 'true'));
    const details = within(view().getByRole('complementary', { name: 'Selected tag' }));
    assert.ok(details.getByText('Document › Table'));
    assert.ok(details.getByText('None: no TH cells'));
    assert.ok(details.getByText('2 TR'));
    assert.ok(details.getByText(/has no header cells \(TH\), so a screen reader cannot name its columns\.$/));

    fireEvent.click(view().getByRole('button', { name: 'Expand Table' }));
    await view().findByText('Grace');
    assert.ok(view().getByRole('button', { name: 'Collapse Table' }));
  } finally {
    panel.unmount();
  }
});

test('the filter shows what it finds and the tags it is in; a PDF without problems says what that does not cover', async () => {
  const { element, view } = target();
  const panel = mountStructurePanel(element, { pdfjs, bytes: await withHeader(), theme: 'dark' });
  try {
    await view().findByText(/^No problems found in the headings, figure alt text or table headers\./);
    assert.ok(view().getByText('Columns: Name, Score'));
    assert.equal(element.querySelector('[data-typfolio-panel]')?.shadowRoot?.querySelector('.tf')?.getAttribute('data-theme'), 'dark');

    const filter = view().getByRole('searchbox', { name: 'Filter the tags by role or text' });
    fireEvent.input(filter, { target: { value: 'grace' } });
    // Found by its text: the cell, opened up to it; not the row or the table, whose text holds the cell's.
    const cell = await view().findByText('Grace');
    assert.equal(cell.closest('.tf-row')?.getAttribute('data-found'), 'true');
    assert.ok(view().queryByText('Results') === null, 'the heading has no match in it, so it is not shown');
    assert.ok(view().getByRole('button', { name: 'Collapse Table' }), 'the table is opened to show the cell');

    fireEvent.input(filter, { target: { value: 'th' } });
    // Found by role: both header cells.
    await waitFor(() => assert.equal(view().getAllByText(/^(Name|Score)$/).length, 2));

    fireEvent.input(filter, { target: { value: 'nowhere' } });
    await view().findByText('No tag matches “nowhere”.');
  } finally {
    panel.unmount();
  }
});

test('a table over a page break is one table: the rest of it says so, and the rows drawn on the other page take one line', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => `[Student ${index + 1}], [${index}]`).join(', ');
  const { element, view } = target();
  const panel = mountStructurePanel(element, { pdfjs, bytes: await compileSource(`= Results\n#table(columns: 2, table.header([Name], [Score]), ${rows})`) });
  try {
    await view().findByText(/^No problems found/);
    assert.ok(view().getByText('2 pages · 1 heading · 1 table · 0 figures'));
    assert.ok(view().getByText('Continued from page 1'));
    for (const button of view().getAllByRole('button', { name: 'Expand Table' })) fireEvent.click(button);
    // pdf.js lists all of a table's rows on each page it is on: those drawn on the other page are one line.
    const folded = await view().findAllByText(/^× \d+ with no text on this page$/);
    assert.equal(folded.length, 2);
    assert.ok(view().getByText('Student 60'));
    fireEvent.click(view().getByRole('button', { name: /^Table\s*Continued from page 1$/ }));
    await within(view().getByRole('complementary', { name: 'Selected tag' })).findByText('The table at the end of page 1');
  } finally {
    panel.unmount();
  }
});

test('a new PDF is read in place of the last, the bytes are left as they are, and no PDF says so', async () => {
  const { element, view } = target();
  const good = await withHeader();
  const copy = good.slice();
  const panel = mountStructurePanel(element, { pdfjs });
  try {
    await view().findByText('No PDF yet: the tags show once there is one.');
    panel.update({ bytes: good });
    await view().findByText(/^No problems found/);
    assert.deepEqual(good, copy);
    assert.ok(good.byteLength > 0, 'the buffer must not be detached');

    panel.update({ bytes: await headerless() });
    await view().findByText('1 problem a screen reader user would hit');
    panel.update({ bytes: undefined });
    await view().findByText('No PDF yet: the tags show once there is one.');
  } finally {
    panel.unmount();
  }
});

test('an untagged PDF says so, and bytes that are not a PDF say why they could not be read', async () => {
  const { element, view } = target();
  const panel = mountStructurePanel(element, { pdfjs, bytes: await compileSource('#lorem(20)', { tags: false }) });
  try {
    await view().findByText('The PDF is not tagged, so a screen reader gets its text with no headings, tables or figures.');
    assert.ok(view().queryByRole('searchbox') === null);
    assert.ok(view().queryByRole('region', { name: 'Tags in reading order' }) === null);

    panel.update({ bytes: new TextEncoder().encode('hello') });
    const alert = await view().findByRole('alert');
    assert.match(alert.textContent ?? '', /^The tags could not be read: ./);
  } finally {
    panel.unmount();
  }
});

test('a PDF replaced while it is read is dropped, and every pdf.js document opened is freed', async () => {
  const { counts, pdfjs: tracked } = counted();
  const { element, shadow, view } = target();
  const first = await headerless();
  const second = await withHeader();
  const panel = mountStructurePanel(element, { pdfjs: tracked, bytes: first });
  await waitFor(() => assert.equal(counts.opened, 1));
  panel.update({ bytes: second });
  await view().findByText(/^No problems found/);
  // The first PDF's problem never shows, even once its read would have finished.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(view().queryByText(/problem a screen reader user would hit/) === null);
  assert.equal(counts.opened, 2);
  await waitFor(() => assert.equal(counts.destroyed, 2));

  panel.unmount();
  assert.equal(shadow(), undefined, 'unmount removes the panel');
  assert.equal(element.childElementCount, 0);
  panel.update({ bytes: first });
  panel.unmount();
  assert.equal(element.childElementCount, 0, 'update and unmount after unmount do nothing');
  assert.equal(counts.opened, 2);
});

test('the devtools button shows the number of problems and opens the panel along the bottom of the page', async () => {
  const devtools = mountStructureDevtools({ pdfjs, bytes: await headerless(), buttonPosition: 'top-left' });
  const host = document.body.lastElementChild!;
  const shadow = host.shadowRoot!;
  const view = within(shadow.lastElementChild as HTMLElement);
  try {
    const button = await view.findByRole('button', { name: 'Open the PDF tags panel: 1 problem' });
    assert.equal(button.getAttribute('data-position'), 'top-left');
    assert.equal(button.textContent, 'PDF tags 1');
    assert.ok(view.queryByRole('region', { name: 'PDF tags panel' }) === null, 'the panel starts closed');

    fireEvent.click(button);
    const dock = await view.findByRole('region', { name: 'PDF tags panel' });
    assert.equal(dock.getAttribute('data-side'), 'bottom', 'the panel opens along the bottom by default');
    assert.ok(shadow.activeElement === dock, 'focus moves into the panel');
    assert.ok(within(dock).getByText('1 problem a screen reader user would hit'));
    assert.ok(view.queryByRole('button', { name: /^Open the PDF tags panel/ }) === null);

    fireEvent.click(within(dock).getByRole('button', { name: 'Close the PDF tags panel' }));
    await waitFor(() => assert.ok(view.queryByRole('region', { name: 'PDF tags panel' }) === null));
    assert.ok(shadow.activeElement === button, 'focus goes back to the button');

    fireEvent.click(button);
    await view.findByRole('region', { name: 'PDF tags panel' });
    // Escape in a filter with text clears it; Escape elsewhere closes the panel.
    const filter = view.getByRole('searchbox');
    fireEvent.input(filter, { target: { value: 'x' } });
    fireEvent.keyDown(filter, { key: 'Escape' });
    assert.ok(view.getByRole('region', { name: 'PDF tags panel' }));
    fireEvent.keyDown(view.getByRole('button', { name: 'Close the PDF tags panel' }), { key: 'Escape' });
    await waitFor(() => assert.ok(view.queryByRole('region', { name: 'PDF tags panel' }) === null));

    devtools.update({ bytes: await withHeader() });
    await view.findByRole('button', { name: 'Open the PDF tags panel: no problems found' });
  } finally {
    devtools.unmount();
  }
  assert.equal(host.isConnected, false);

  const open = mountStructureDevtools({ pdfjs, initialIsOpen: true });
  try {
    const shown = within(document.body.lastElementChild!.shadowRoot!.lastElementChild as HTMLElement);
    await shown.findByText('No PDF yet: the tags show once there is one.');
    assert.ok(shown.getByRole('region', { name: 'PDF tags panel' }));
  } finally {
    open.unmount();
  }
});

test('the devtools panel docks to the side it is given, its toolbar moves it, and it resizes along that side', async () => {
  const devtools = mountStructureDevtools({ pdfjs, position: 'right', initialIsOpen: true });
  const view = within(document.body.lastElementChild!.shadowRoot!.lastElementChild as HTMLElement);
  const side = (name: string) => view.getByRole('button', { name: `Dock to the ${name}` });
  try {
    const dock = await view.findByRole('region', { name: 'PDF tags panel' });
    assert.equal(dock.getAttribute('data-side'), 'right');
    assert.equal(side('right').getAttribute('aria-pressed'), 'true');
    assert.equal(side('bottom').getAttribute('aria-pressed'), 'false');

    // Along the right edge, the panel is sized by its width, and the arrow key that moves its edge left widens it.
    const separator = view.getByRole('separator', { name: 'Resize the panel' });
    assert.equal(separator.getAttribute('aria-orientation'), 'vertical');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    await waitFor(() => assert.equal(dock.style.width, '280px', 'the smallest width it takes'));
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    await waitFor(() => assert.equal(dock.style.width, '320px'));
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    await waitFor(() => assert.equal(dock.style.width, '280px'));

    fireEvent.click(side('top'));
    await waitFor(() => assert.equal(dock.getAttribute('data-side'), 'top'));
    assert.equal(side('top').getAttribute('aria-pressed'), 'true');
    assert.equal(separator.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(dock.style.width, '', 'a height-sized side does not take the width');
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    await waitFor(() => assert.equal(dock.style.height, '140px'));

    // update moves it too; each axis keeps the size it had.
    devtools.update({ position: 'left' });
    await waitFor(() => assert.equal(dock.getAttribute('data-side'), 'left'));
    assert.equal(dock.style.width, '280px');
  } finally {
    devtools.unmount();
  }
});

test('options the panel cannot use throw INVALID_REQUEST, and a failed update keeps the options before it', async () => {
  const invalid = (pattern: RegExp) => (error: unknown) => error instanceof TypstPdfError && error.code === 'INVALID_REQUEST' && pattern.test(error.message);
  const { element, view } = target();
  // @ts-expect-error: the element is required
  assert.throws(() => mountStructurePanel(null, { pdfjs }), invalid(/^mountStructurePanel: element must be the DOM element/));
  // @ts-expect-error: pdfjs is required
  assert.throws(() => mountStructurePanel(element, {}), invalid(/pdfjs must be pdf\.js/));
  // @ts-expect-error: bytes are a Uint8Array
  assert.throws(() => mountStructurePanel(element, { pdfjs, bytes: 'pdf' }), invalid(/bytes must be the PDF as a Uint8Array/));
  // @ts-expect-error: not a theme
  assert.throws(() => mountStructurePanel(element, { pdfjs, theme: 'blue' }), invalid(/theme must be/));
  // @ts-expect-error: not a side
  assert.throws(() => mountStructureDevtools({ pdfjs, position: 'middle' }), invalid(/^mountStructureDevtools: position must be 'bottom', 'top', 'left' or 'right'$/));
  // @ts-expect-error: not a corner
  assert.throws(() => mountStructureDevtools({ pdfjs, buttonPosition: 'bottom' }), invalid(/^mountStructureDevtools: buttonPosition must be/));
  assert.equal(element.childElementCount, 0, 'nothing is added for options it cannot use');

  const panel = mountStructurePanel(element, { pdfjs, bytes: await headerless() });
  try {
    // @ts-expect-error: bytes are a Uint8Array
    assert.throws(() => panel.update({ bytes: [1, 2, 3] }), invalid(/bytes must be/));
    await view().findByText('1 problem a screen reader user would hit');
  } finally {
    panel.unmount();
  }
});

test('the bundle carries React and imports only @typfolio/core; the other entries never reach it', async () => {
  const bundle = await readFile(new URL('../dist/panel.js', import.meta.url), 'utf8');
  const imports = [...bundle.matchAll(/(?:^|[;}\s])import\s*(?:[\w*{}\s,$]+from\s*)?["'`]([^"'`]+)["'`]/g)].map(match => match[1]);
  assert.deepEqual([...new Set(imports)], ['@typfolio/core']);
  assert.equal(/\bimport\(/.test(bundle), false, 'the bundle loads nothing later');
  assert.equal(/process\.env/.test(bundle), false, 'React is bundled in its production build');
  for (const name of ['react.production.js', 'react-dom.production.js', 'react-dom-client.production.js', 'scheduler.production.js']) {
    assert.ok(bundle.includes(`@license React\n* ${name}`), `the bundle keeps the licence comment of ${name}`);
  }
  await assert.rejects(readFile(new URL('../dist/panel/view.js', import.meta.url)), { code: 'ENOENT' }, 'the unbundled modules are not in dist');
  for (const entry of ['index.js', 'pdf.js', 'structure.js']) {
    const source = await readFile(new URL(`../dist/${entry}`, import.meta.url), 'utf8');
    assert.equal(/(?:from\s*|import\(\s*)['"][^'"]*(?:panel|react)/.test(source), false, `${entry} must not import the panel or React`);
  }
});
