import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { configure, fireEvent, waitFor, within } from '@testing-library/dom';
import { createCompiler, defineTemplate, TypstPdfError } from '@typfolio/core';
import type { PdfCompiler, PdfOptions } from '@typfolio/core';
import type { StructurePanelPdfJs, StructurePanelValidator } from '../dist/panel.js';
import type { PdfValidationReport } from '../dist/validate.js';

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
  const wasm = await file('packages/typst-wasm/generated/compiler_bg.wasm');
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
    // Nothing is selected, so no tag says more about itself.
    assert.equal(view().queryByRole('complementary', { name: 'Selected tag' }), null);

    fireEvent.click(problem);
    await waitFor(() => assert.equal(tableRow.closest('.tf-row')?.getAttribute('data-selected'), 'true'));
    // The selected tag says the rest about itself under its row, in the list.
    const details = within(view().getByRole('complementary', { name: 'Selected tag' }));
    assert.equal(view().getByRole('complementary', { name: 'Selected tag' }).previousElementSibling, tableRow.closest('.tf-row'));
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
    await within(await view().findByRole('complementary', { name: 'Selected tag' })).findByText('The table at the end of page 1');
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

test('a PDF replaced while it is read is dropped; the one on show stays open for the page view, and all are freed', async () => {
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
  // The first is freed; the one on show stays open until the panel goes.
  await waitFor(() => assert.equal(counts.destroyed, 1));

  panel.unmount();
  assert.equal(counts.destroyed, 2);
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

    // Over the whole page: no size of its own and nothing to resize; the same button, or a side, brings it back.
    const fill = view.getByRole('button', { name: 'Fill the page' });
    fireEvent.click(fill);
    await waitFor(() => assert.equal(dock.getAttribute('data-full'), 'true'));
    assert.equal(fill.getAttribute('aria-pressed'), 'true');
    assert.equal(side('left').getAttribute('aria-pressed'), 'false');
    assert.equal(dock.style.width, '');
    assert.ok(view.queryByRole('separator', { name: 'Resize the panel' }) === null);
    fireEvent.click(fill);
    await waitFor(() => assert.equal(dock.getAttribute('data-full'), 'false'));
    assert.equal(dock.getAttribute('data-side'), 'left');
    assert.equal(dock.style.width, '280px', 'the size it had');
    fireEvent.click(fill);
    await waitFor(() => assert.equal(dock.getAttribute('data-full'), 'true'));
    fireEvent.click(side('bottom'));
    await waitFor(() => assert.equal(dock.getAttribute('data-full'), 'false'));
    assert.equal(dock.getAttribute('data-side'), 'bottom');
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

test('a table shows its summary, a header cell its scope, and a cell the headers that label it', async () => {
  const { element, view } = target();
  const bytes = await compileSource(`= Results
#pdf.table-summary(summary: "Scores by student and term", table(columns: 3,
  table.header[Student][Autumn][Spring],
  pdf.header-cell(scope: "row")[Ada], [90], [85],
  pdf.header-cell(scope: "row")[Grace], [70], [65]))`, { standards: ['ua-1'] });
  const panel = mountStructurePanel(element, { pdfjs, bytes });
  try {
    // Row headers are not columns.
    const table = await view().findByRole('button', { name: /^Table.*Columns: Student, Autumn, Spring · Summary: Scores by student and term$/ });
    const details = () => within(view().getByRole('complementary', { name: 'Selected tag' }));
    fireEvent.click(table);
    await waitFor(() => assert.ok(details().getByText('Scores by student and term')));

    fireEvent.click(view().getByRole('button', { name: 'Expand Table' }));
    fireEvent.click(await view().findByRole('button', { name: /^TH.*scope Row.*Grace$/ }));
    await waitFor(() => assert.ok(details().getByText('Row: labels the cells of its row')));
    assert.ok(details().getByText('Student'), 'the row header is itself under the column header');
    assert.equal(view().getAllByRole('button', { name: /^TH.*scope Column/ }).length, 3);

    fireEvent.click(view().getByRole('button', { name: /^TD.*65$/ }));
    await waitFor(() => assert.ok(details().getByText('Spring, Grace')));
  } finally {
    panel.unmount();
  }
});

test('the page view marks the selected tag where it is drawn, follows the selection to its page, and can be hidden', async () => {
  const { element, shadow, view } = target();
  const bytes = await compileSource('= First\nOpening words.\n#pagebreak()\n= Second\n#table(columns: 2, table.header([Name], [Score]), [Ada], [90])');
  const panel = mountStructurePanel(element, { pdfjs, bytes });
  try {
    const page = () => within(view().getByRole('region', { name: 'Page' }));
    await waitFor(() => assert.ok(page().getByText('Page 1 of 2')));
    const mark = () => shadow()!.querySelector<HTMLElement>('.tf-box[data-kind="selected"]');
    // Compared as booleans: a failed comparison of a DOM element would print the whole document.
    assert.ok(mark() === null, 'nothing is marked before a tag is selected');
    const box = () => ['left', 'top', 'width', 'height'].map(side => parseFloat(mark()!.style.getPropertyValue(side)));

    fireEvent.click(view().getByRole('button', { name: /^H1.*First$/ }));
    await waitFor(() => assert.equal(mark()?.getAttribute('data-role'), 'H1'));
    const heading = box();
    assert.ok(heading.every(value => value > 0 && value < 100), `a box inside the page: ${heading}`);
    assert.ok(heading[1] < 30, 'the first heading is near the top of its page');

    // A tag of the second page brings that page.
    fireEvent.click(view().getByRole('button', { name: 'Expand Table' }));
    fireEvent.click(await view().findByRole('button', { name: /^TD.*90$/ }));
    await waitFor(() => assert.ok(page().getByText('Page 2 of 2')));
    await waitFor(() => assert.equal(mark()?.getAttribute('data-role'), 'TD'));
    const cell = box();
    // The table, selected, holds its cell.
    fireEvent.click(view().getByRole('button', { name: /^Table/ }));
    await waitFor(() => assert.equal(mark()?.getAttribute('data-role'), 'Table'));
    const table = box();
    assert.ok(table[0] <= cell[0] && table[1] <= cell[1] && table[0] + table[2] >= cell[0] + cell[2] && table[1] + table[3] >= cell[1] + cell[3], `${table} holds ${cell}`);

    fireEvent.click(page().getByRole('button', { name: 'Previous page' }));
    await waitFor(() => assert.ok(page().getByText('Page 1 of 2')));
    await waitFor(() => assert.ok(mark() === null, 'the table is not on the first page'));

    fireEvent.click(view().getByRole('button', { name: 'Page' }));
    await waitFor(() => assert.ok(view().queryByRole('region', { name: 'Page' }) === null));
  } finally {
    panel.unmount();
  }
});

test('the dividers between the tags, the page and veraPDF\'s findings move with the arrow keys and reset on a double click', async () => {
  const { element, shadow, view } = target();
  const bytes = await withHeader();
  const panel = mountStructurePanel(element, { pdfjs, bytes });
  try {
    await view().findByText(/^No problems found/);
    const share = (name: string) => Number(shadow()!.querySelector<HTMLElement>(`[data-pane="${name}"]`)!.style.flexGrow);
    // Without a validator: the tags and the page, and one divider.
    assert.deepEqual(['tree', 'page'].map(share), [5, 4]);
    assert.equal(shadow()!.querySelector('[data-pane="verapdf"]'), null);
    assert.equal(view().getAllByRole('separator').length, 1);

    // With one, veraPDF's findings are the third view.
    panel.update({ validator: scripted({ flavour: 'ua1', compliant: true, totalAssertions: 1, profile, failedRules: [] }).validator });
    const second = await view().findByRole('separator', { name: 'Resize the page and the veraPDF findings' });
    const first = view().getByRole('separator', { name: 'Resize the tags and the page' });
    const shares = () => ['tree', 'page', 'verapdf'].map(share);
    assert.deepEqual(shares(), [5, 4, 4]);
    assert.equal(first.getAttribute('aria-orientation'), 'vertical');

    // The first divider takes from the page and gives to the tags; veraPDF's findings keep their share.
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    await waitFor(() => assert.ok(share('tree') > 5));
    assert.ok(Math.abs(share('tree') + share('page') - 9) < 1e-9 && share('verapdf') === 4, String(shares()));
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    await waitFor(() => assert.ok(share('verapdf') > 4));

    fireEvent.doubleClick(first);
    fireEvent.doubleClick(second);
    await waitFor(() => assert.deepEqual(shares(), [5, 4, 4]));

    // Without the page, one divider is left, between the tags and veraPDF's findings.
    fireEvent.click(view().getByRole('button', { name: 'Page' }));
    await waitFor(() => assert.ok(view().getByRole('separator', { name: 'Resize the tags and the veraPDF findings' })));
    assert.equal(view().getAllByRole('separator').length, 1);
    // And without a validator either, the tags have the panel to themselves.
    panel.update({ validator: undefined });
    await waitFor(() => assert.equal(view().queryAllByRole('separator').length, 0));
  } finally {
    panel.unmount();
  }
});

test('a tag\'s row has a button that copies its whole text', async () => {
  const { element, view } = target();
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const panel = mountStructurePanel(element, { pdfjs, bytes: await withHeader() });
  try {
    await view().findByText(/^No problems found/);
    fireEvent.click(view().getByRole('button', { name: 'Copy the text of this H1' }));
    await waitFor(() => assert.deepEqual(copied, ['Results']));
    assert.ok(await view().findByText('Copied'));
    // The table's row copies the whole table's text, more than its line shows.
    fireEvent.click(view().getByRole('button', { name: 'Copy the text of this Table' }));
    await waitFor(() => assert.equal(copied[1], 'Name Score Ada 90 Grace 85'));

    // Selecting a tag leaves its row's button where it was; what shows under the row has no copy of the text.
    fireEvent.click(view().getByRole('button', { name: /^H1.*Results$/ }));
    const details = within(await view().findByRole('complementary', { name: 'Selected tag' }));
    assert.ok(details.getByText('Document › H1'));
    assert.equal(details.queryByRole('button'), null);
    fireEvent.click(view().getByRole('button', { name: 'Copy the text of this H1' }));
    await waitFor(() => assert.equal(copied[2], 'Results'));
  } finally {
    panel.unmount();
    delete (dom.window.navigator as { clipboard?: unknown }).clipboard;
  }
});

const rule = {
  specification: 'ISO 14289-1:2014', clause: '7.2', test: 3, failedChecks: 2, message: 'Table cells shall have headers', context: 'root/document[0]/StructTreeRoot[0]',
  object: 'SETD', condition: 'hasConnectedHeader == true', tags: ['structure', 'table'],
  checks: [{ context: 'root/document[0]/StructTreeRoot[0]', error: 'TD does not contain Headers attribute' }],
};
const profile = { name: 'A profile', description: 'Rules', rules: 106 };
/** A validator that answers from a list, in a later task like one in a worker, and records what it was asked. */
function scripted(...answers: (Omit<PdfValidationReport, 'logs'> & { logs?: PdfValidationReport['logs'] } | Error)[]) {
  const calls: { bytes: Uint8Array; flavour: string }[] = [];
  const validator: StructurePanelValidator = {
    async validate(pdf, { flavour }) {
      calls.push({ bytes: pdf, flavour });
      const answer = answers[Math.min(calls.length, answers.length) - 1]!;
      if (answer instanceof Error) throw answer;
      return { logs: [], ...answer, flavour };
    },
  };
  return { calls, validator };
}

test('without a validator there is no veraPDF view; with one it is beside the tags, and its button validates against the chosen flavour', async () => {
  const bytes = await withHeader();
  const plain = target();
  const without = mountStructurePanel(plain.element, { pdfjs, bytes });
  const { element, view } = target();
  const { calls, validator } = scripted({ flavour: 'ua1', compliant: true, totalAssertions: 734, profile, failedRules: [] }, { flavour: 'ua1', compliant: false, totalAssertions: 1350, profile, failedRules: [rule] });
  const panel = mountStructurePanel(element, { pdfjs, bytes, validator });
  try {
    await plain.view().findByText('1 page · 1 heading · 1 table · 0 figures');
    assert.equal(plain.view().queryByRole('region', { name: 'veraPDF validation' }), null);

    // veraPDF's findings are a view beside the tags and the page: all three show together.
    await view().findByText('1 page · 1 heading · 1 table · 0 figures');
    assert.ok(view().getByRole('region', { name: 'Tags in reading order' }));
    assert.equal(view().queryByRole('tablist'), null);

    const region = within(await view().findByRole('region', { name: 'veraPDF validation' }));
    // Nothing is validated until asked.
    assert.ok(region.getByText('Checks the file against the standard’s machine-checkable rules, with veraPDF.'));
    assert.equal(calls.length, 0);
    const choice = region.getByRole('combobox', { name: 'What to validate against' }) as HTMLSelectElement;
    assert.equal(choice.value, 'ua1');
    assert.deepEqual([...choice.options].slice(0, 3).map(option => option.textContent), ['PDF/UA-1', 'PDF/UA-2', 'PDF/A-1a']);

    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    await region.findByText('Passes veraPDF’s PDF/UA-1 rules (734 checks). That is a machine check: it does not show that the document is accessible.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.flavour, 'ua1');
    // The validator got a copy: the page's bytes are left as they are.
    assert.notEqual(calls[0]!.bytes, bytes);
    assert.deepEqual(calls[0]!.bytes, bytes);

    fireEvent.change(choice, { target: { value: 'ua2' } });
    // Choosing a flavour does not validate; the verdict on show is still the one asked for.
    assert.equal(calls.length, 1);
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    await region.findByText('Fails 1 rule of PDF/UA-2: 2 of 1350 checks');
    assert.equal(calls[1]!.flavour, 'ua2');
    assert.ok(region.getByText('ISO 14289-1:2014, 7.2, test 3 (2×):'));
    assert.ok(region.getByText(/Table cells shall have headers/));
    // Under the rule: its topics, each listed check with what was wrong and where, and how many are not listed.
    assert.deepEqual([...region.getByText(/Table cells shall have headers/).querySelectorAll('.tf-rule-tag')].map(tag => tag.textContent), ['structure', 'table']);
    assert.ok(region.getByText('TD does not contain Headers attribute'));
    assert.ok(region.getByText('root/document[0]/StructTreeRoot[0]'));
    assert.ok(region.getByText('… and 1 more'));
    // The tags are still there beside it, and a tag can be selected while the findings show.
    fireEvent.click(view().getByRole('button', { name: /^H1.*Results$/ }));
    assert.ok(await view().findByRole('complementary', { name: 'Selected tag' }));
    assert.ok(region.getByText('Fails 1 rule of PDF/UA-2: 2 of 1350 checks'));
  } finally {
    panel.unmount();
    without.unmount();
  }
});

test('what veraPDF logged while reading the file shows with the verdict, open when the file passes', async () => {
  const { element, view } = target();
  const logs = [{ level: 'WARNING' as const, message: 'Error while parsing content stream', occurrences: 3 }];
  const { validator } = scripted({ flavour: 'ua1', compliant: true, totalAssertions: 9, profile, failedRules: [], logs }, { flavour: 'ua1', compliant: false, totalAssertions: 9, profile, failedRules: [rule], logs });
  const panel = mountStructurePanel(element, { pdfjs, bytes: await withHeader(), validator });
  try {
    const region = within(await view().findByRole('region', { name: 'veraPDF validation' }));
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    // A pass with messages: veraPDF validated what it could read, which is said beside the verdict.
    const summary = await region.findByText('veraPDF logged 1 message while reading the file: it validated what it could read');
    assert.equal((summary.closest('details') as HTMLDetailsElement).open, true);
    assert.equal(summary.closest('details')!.querySelector('li')!.textContent, 'WARNING (3×): Error while parsing content stream');
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    const failed = await region.findByText('veraPDF logged 1 message while reading the file');
    assert.equal((failed.closest('details') as HTMLDetailsElement).open, false);
  } finally {
    panel.unmount();
  }
});

test('once asked, a new PDF is validated too, and a validator that fails says why', async () => {
  const { element, view } = target();
  const first = await withHeader();
  const { calls, validator } = scripted({ flavour: 'ua1', compliant: true, totalAssertions: 10, profile, failedRules: [] }, new Error('veraPDF could not read the file'), { flavour: 'ua1', compliant: true, totalAssertions: 12, profile, failedRules: [] });
  const panel = mountStructurePanel(element, { pdfjs, validator });
  try {
    const region = within(await view().findByRole('region', { name: 'veraPDF validation' }));
    // No PDF, nothing to validate.
    assert.ok(region.getByText('No PDF yet.'));
    assert.equal((region.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled, true);

    panel.update({ bytes: first });
    await waitFor(() => assert.equal((region.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled, false));
    assert.equal(calls.length, 0);
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    await region.findByText(/^Passes veraPDF’s PDF\/UA-1 rules \(10 checks\)/);

    panel.update({ bytes: await headerless() });
    assert.equal((await region.findByRole('alert')).textContent, 'veraPDF could not validate the PDF: veraPDF could not read the file');
    assert.equal(calls.length, 2);

    // The same flavour again runs again.
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    await region.findByText(/^Passes veraPDF’s PDF\/UA-1 rules \(12 checks\)/);
    assert.equal(calls.length, 3);
    assert.equal(region.queryByRole('alert'), null);
  } finally {
    panel.unmount();
  }
});

test('a validator that reads what the file declares validates each PDF without being asked: one verdict per declared standard, or none declared', async () => {
  const { element, view } = target();
  const bytes = await withHeader();
  const { calls, validator } = scripted({ flavour: 'ua1', compliant: true, totalAssertions: 5, profile, failedRules: [] }, { flavour: 'ua1', compliant: false, totalAssertions: 7, profile, failedRules: [rule] });
  let declared: ('2a' | 'ua1')[] = ['2a', 'ua1'];
  const detected: Uint8Array[] = [];
  const panel = mountStructurePanel(element, { pdfjs, bytes, validator: { ...validator, detectFlavours: async pdf => { detected.push(pdf); return declared; } } });
  try {
    const region = within(await view().findByRole('region', { name: 'veraPDF validation' }));
    const choice = region.getByRole('combobox', { name: 'What to validate against' }) as HTMLSelectElement;
    assert.equal(choice.value, 'declared');
    assert.deepEqual([...choice.options].slice(0, 2).map(option => option.textContent), ['What the file declares', 'PDF/UA-1']);

    // No button was used: the PDF says what to validate it against.
    await region.findByText('The PDF declares PDF/A-2a and PDF/UA-1.');
    assert.deepEqual(calls.map(call => call.flavour), ['2a', 'ua1']);
    assert.ok(region.getByText(/^Passes veraPDF’s PDF\/A-2a rules \(5 checks\)/));
    assert.ok(region.getByText('Fails 1 rule of PDF/UA-1: 2 of 7 checks'));
    // Detection got a copy of the bytes too.
    assert.equal(detected.length, 1);
    assert.notEqual(detected[0], bytes);

    // A new PDF that declares nothing is not validated, and says so; that is not a pass.
    declared = [];
    panel.update({ bytes: await headerless() });
    await region.findByText('The PDF declares no standard in its metadata, so there is nothing to validate it against. Pick one above to validate against it anyway.');
    assert.equal(detected.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(region.queryByText(/^Passes veraPDF/), null);

    // A standard picked by hand is validated against when the button is used, whatever the file declares.
    fireEvent.change(choice, { target: { value: 'ua2' } });
    assert.equal(calls.length, 2);
    fireEvent.click(region.getByRole('button', { name: 'Validate' }));
    await waitFor(() => assert.equal(calls.length, 3));
    assert.equal(calls[2]!.flavour, 'ua2');
  } finally {
    panel.unmount();
  }
});

test('the devtools panel does not validate while it is closed, and validates the PDF on show when it opens', async () => {
  const { calls, validator } = scripted({ flavour: 'ua1', compliant: true, totalAssertions: 5, profile, failedRules: [] });
  const detected: Uint8Array[] = [];
  const devtools = mountStructureDevtools({ pdfjs, bytes: await withHeader(), validator: { ...validator, detectFlavours: async pdf => { detected.push(pdf); return ['ua1']; } } });
  try {
    const host = document.body.querySelector('[data-typfolio-panel]:last-of-type')!;
    const view = within(host.shadowRoot!.lastElementChild as HTMLElement);
    // The tags are read while it is closed, for the button's count; veraPDF is not asked.
    await view.findByRole('button', { name: 'Open the PDF tags panel: no problems found' });
    devtools.update({ bytes: await headerless() });
    await view.findByRole('button', { name: 'Open the PDF tags panel: 1 problem' });
    assert.deepEqual([detected.length, calls.length], [0, 0]);

    fireEvent.click(view.getByRole('button', { name: 'Open the PDF tags panel: 1 problem' }));
    await within(await view.findByRole('region', { name: 'veraPDF validation' })).findByText(/^Passes veraPDF’s PDF\/UA-1 rules \(5 checks\)/);
    assert.deepEqual([detected.length, calls.length], [1, 1]);
  } finally {
    devtools.unmount();
  }
});

test('a validator without a validate function is refused', async () => {
  const { element } = target();
  assert.throws(() => mountStructurePanel(element, { pdfjs, validator: {} as never }), (error: unknown) => error instanceof TypstPdfError && error.code === 'INVALID_REQUEST' && /validator must have a validate function/.test(error.message));
  assert.throws(() => mountStructurePanel(element, { pdfjs, validator: { validate: () => { throw new Error('unused'); }, detectFlavours: true } as never }), (error: unknown) => error instanceof TypstPdfError && error.code === 'INVALID_REQUEST' && /detectFlavours must be a function/.test(error.message));
});

