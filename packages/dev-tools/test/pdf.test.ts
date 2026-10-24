import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCompiler, defineTemplate, pdfStandards, TypstPdfError } from '@typfolio/core';
import type { Assets, ErrorCode, PdfCompiler, PdfOptions } from '@typfolio/core';
import * as main from '../dist/index.js';
import * as pdfModule from '../dist/pdf.js';
import { checkStructure, inspectPdf, readStructure, structureWarnings } from '../dist/pdf.js';
import type { PdfStructureElement, PdfStructurePage, PdfStructureSource } from '../dist/pdf.js';

const root = new URL('../../../', import.meta.url);
type PdfModule = typeof import('../dist/pdf.js');

const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const timestamp = 1700000000;
// The fixtures read their data from /input.json, so that is where it is mounted.
const fixture = async (directory: string, partial: string) => defineTemplate({
  files: {
    'main.typ': await text(`fixtures/${directory}/main.typ`),
    [partial]: await text(`fixtures/${directory}/${partial}`),
  },
  schemaPath: 'input.json',
});

let compiler!: PdfCompiler;
let input!: { title: string };
let basic!: Awaited<ReturnType<typeof fixture>>;
let assets!: Assets;
const compile = async (pdf: PdfOptions = { standards: ['ua-1'], creationTimestamp: timestamp }) => (await compiler.compile(basic(input), { assets, pdf })).bytes;
before(async () => {
  const wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  const fonts = await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`)));
  compiler = await createCompiler({ wasm, fonts });
  basic = await fixture('basic', 'partials/layout.typ');
  input = JSON.parse(await text('fixtures/basic/input.json'));
  assets = { 'assets/chart.svg': await file('fixtures/basic/chart.svg') };
});
after(() => compiler?.dispose());

test('reports the structure of a PDF/UA compile of the basic fixture', async () => {
  const bytes = await compile();
  const copy = bytes.slice();
  const report = await inspectPdf(bytes);
  assert.deepEqual(bytes, copy, 'the input must not be modified');
  assert.ok(bytes.byteLength > 0, 'the input buffer must not be detached');
  assert.equal(report.pages, 1);
  assert.equal(report.tagged, true);
  assert.equal(report.structureTree, true);
  assert.equal(report.standard.pdfUa, 1);
  assert.equal(report.standard.pdfA, undefined);
  assert.equal(report.language, 'en');
  assert.equal(report.title, input.title);
  assert.equal(report.creationDate?.getTime(), timestamp * 1000);
  assert.deepEqual(report.headings, [{ level: 1, text: input.title }]);
  assert.deepEqual(report.figures, [{ alt: 'A blue bar representing the completed outcome.' }]);
  assert.equal(report.tables, 1);
  assert.ok(report.fonts.length >= 1 && report.fonts.every(font => font.embedded && /LibertinusSerif/.test(font.name)), JSON.stringify(report.fonts));
  assert.deepEqual(
    { H1: 1, Table: 1, Figure: 1, TH: 2, TD: 4 },
    Object.fromEntries(Object.entries(report.structureRoles).filter(([role]) => ['H1', 'Table', 'Figure', 'TH', 'TD'].includes(role))),
  );
  // Facts only: nothing in the report is a verdict.
  assert.deepEqual(Object.keys(report).sort(), ['creationDate', 'figures', 'fonts', 'headings', 'language', 'pages', 'standard', 'structure', 'structureRoles', 'structureTree', 'tables', 'tagged', 'title']);
  // The tree, as a screen reader gets it: the page's Document, then the tags in reading order with their text.
  assert.deepEqual(report.structure.map(({ page, elements }) => [page, elements.map(element => element.role)]), [[1, ['Document']]]);
  assert.deepEqual(report.structure[0].elements[0].children.map(child => [child.role, child.text]).filter(([role]) => role !== 'P'), [
    ['H1', input.title],
    ['Table', 'Outcome Status Communication Complete Critical thinking In progress'],
    ['Figure', ''],
  ]);
  assert.deepEqual(elementsOf(report.structure, 'TH').map(cell => cell.text), ['Outcome', 'Status']);
  assert.equal(elementsOf(report.structure, 'Figure')[0].alt, 'A blue bar representing the completed outcome.');
  assert.deepEqual(structureWarnings(report.structure), []);
  assert.deepEqual(await checkStructure(bytes), []);
});

test('an untagged compile reports no tags, no structure tree and no PDF/UA declaration', async () => {
  const report = await inspectPdf(await compile({ tags: false, creationTimestamp: timestamp }));
  assert.equal(report.tagged, false);
  assert.equal(report.structureTree, false);
  assert.equal(report.standard.pdfUa, undefined);
  assert.deepEqual(report.headings, []);
  assert.deepEqual(report.figures, []);
  assert.equal(report.tables, 0);
  assert.deepEqual(report.structureRoles, {});
  // The document-level facts are still there.
  assert.equal(report.title, input.title);
  assert.equal(report.language, 'en');
});

test('default options tag the PDF and have a structure tree but declare no PDF/UA', async () => {
  const report = await inspectPdf(await compile({ creationTimestamp: timestamp }));
  assert.equal(report.tagged, true);
  assert.equal(report.structureTree, true);
  assert.equal(report.standard.pdfUa, undefined);
  assert.equal(report.headings.length, 1);
});

test('a PDF/A-2b compile declares part 2, conformance B', async () => {
  const report = await inspectPdf(await compile({ standards: ['a-2b'], creationTimestamp: timestamp }));
  assert.deepEqual(report.standard.pdfA, { part: 2, conformance: 'B' });
  assert.equal(report.standard.pdfUa, undefined);
});

test('PDF/A-4 without a conformance level reports the part alone', async () => {
  const report = await inspectPdf(await compile({ standards: ['a-4'], creationTimestamp: timestamp }));
  assert.deepEqual(report.standard.pdfA, { part: 4 });
});

test('each advertised PDF standard is declared by the file it produces', async () => {
  for (const standard of pdfStandards) {
    const bytes = await compile({ standards: [standard], creationTimestamp: timestamp });
    const report = await inspectPdf(bytes);
    if (/^\d/.test(standard)) {
      // A version is not a field of the report; the file header carries it.
      assert.equal(new TextDecoder('latin1').decode(bytes.subarray(0, 8)), `%PDF-${standard}`, standard);
      assert.deepEqual(report.standard, { pdfUa: undefined, pdfA: undefined }, standard);
    } else if (standard.startsWith('a-')) {
      const expected: { part: number; conformance?: string } = { part: Number(standard[2]) };
      if (standard.length > 3) expected.conformance = standard[3].toUpperCase();
      assert.deepEqual(report.standard.pdfA, expected, standard);
    } else {
      assert.equal(standard, 'ua-1');
      assert.equal(report.standard.pdfUa, 1);
    }
  }
});

test('reports the headings and PDF/UA declaration of the outcome-sets fixture', async () => {
  const input: { document: { title: string } } = JSON.parse(await text('fixtures/outcome-sets/input.json'));
  const outcomeSets = await fixture('outcome-sets', 'partials/report.typ');
  const bytes = (await compiler.compile(outcomeSets(input), { pdf: { standards: ['ua-1'], creationTimestamp: timestamp } })).bytes;
  const report = await inspectPdf(bytes);
  assert.equal(report.title, input.document.title);
  assert.equal(report.tagged, true);
  assert.equal(report.standard.pdfUa, 1);
  assert.deepEqual(report.headings[0], { level: 1, text: input.document.title });
  assert.ok(report.headings.some(heading => heading.level === 2 && heading.text === 'Magna Aliqua'), JSON.stringify(report.headings));
  assert.ok(report.tables >= 1);
});

const levels = '#set text(font: "Libertinus Serif", lang: "en")\n#set document(title: "Levels")\n';
const compileSource = async (source: string, pdf: PdfOptions = {}) => (await compiler.compile(defineTemplate({ files: { 'main.typ': source } })(), { pdf })).bytes;

test('headings come back in document order with their levels and text', async () => {
  const report = await inspectPdf(await compileSource(levels + '= A\nText.\n== B\n=== C with *emphasis* and a long long long tail that wraps to a second line because it is longer than the line is wide'));
  assert.deepEqual(report.headings.map(heading => heading.level), [1, 2, 3]);
  assert.deepEqual(report.headings.map(heading => heading.text.slice(0, 1)), ['A', 'B', 'C']);
  assert.match(report.headings[2].text, /^C with emphasis and a long long long tail that wraps to a second line because it is longer than the line is wide$/);
});

test('a heading on a later page is found with its text', async () => {
  const report = await inspectPdf(await compileSource(levels + '= First\n#pagebreak()\n== Second page'));
  assert.equal(report.pages, 2);
  assert.deepEqual(report.headings, [{ level: 1, text: 'First' }, { level: 2, text: 'Second page' }]);
});

/** Every element with this role, in reading order. */
function elementsOf(pages: readonly PdfStructurePage[], role: string): PdfStructureElement[] {
  const found: PdfStructureElement[] = [];
  const walk = (element: PdfStructureElement) => {
    if (element.role === role) found.push(element);
    element.children.forEach(walk);
  };
  for (const page of pages) page.elements.forEach(walk);
  return found;
}
const rows = (count: number) => Array.from({ length: count }, (_, index) => `[Row ${index}], [${index}]`).join(', ');
const warningsOf = async (source: string, pdf: PdfOptions = {}) => {
  const { structure } = await inspectPdf(await compileSource(source, pdf));
  return { structure, warnings: structureWarnings(structure) };
};
const kinds = (warnings: readonly { kind: string; page?: number }[]) => warnings.map(warning => [warning.kind, warning.page]);

test('an inline element runs on with the text around it, and block elements are separate runs', async () => {
  const { structure } = await inspectPdf(await compileSource(levels + '= Foo#emph[bar] baz\nText.'));
  const [heading] = elementsOf(structure, 'H1');
  assert.equal(heading.text, 'Foobar baz');
  assert.deepEqual(heading.children.map(child => [child.role, child.text]), [['Span', 'bar']]);
  assert.equal(structure[0].elements[0].text, 'Foobar baz Text.');
});

test('a table without header cells is reported once, on the page it starts, though it runs over three pages', async () => {
  const { structure, warnings } = await warningsOf(levels + `= Results\n#table(columns: 2, ${rows(90)})`, { standards: ['ua-1'] });
  assert.equal(structure.length, 3);
  // pdf.js gives each page its own part of the table.
  assert.equal(elementsOf(structure, 'Table').length, 3);
  assert.deepEqual(kinds(warnings), [['table-without-headers', 1]]);
  assert.match(warnings[0].message, /^The table starting "Row 0 0 Row 1 1 .*…" has no header cells \(TH\)/);
  // The warning points at the element in the pages it was given.
  assert.equal(warnings[0].element, elementsOf(structure, 'Table')[0]);
});

test('a table with a header row is not reported, on any of its pages', async () => {
  const { structure, warnings } = await warningsOf(levels + `= Results\n#table(columns: 2, table.header([Name], [Score]), ${rows(90)})`, { standards: ['ua-1'] });
  assert.equal(structure.length, 3);
  assert.deepEqual(warnings, []);
});

test('a table nested in a table is checked on its own', async () => {
  const { warnings } = await warningsOf(levels + '= Results\n#table(columns: 1, table.header([Outer]), table(columns: 1, [inner a], [inner b]))', { standards: ['ua-1'] });
  assert.deepEqual(kinds(warnings), [['table-without-headers', 1]]);
  assert.match(warnings[0].message, /"inner a inner b"/);
});

test('several pages with no headings are reported, which PDF/UA-1 accepts; one page with none is not', async () => {
  const styled = levels + '#text(size: 20pt)[A title drawn large]\n';
  const { warnings } = await warningsOf(styled + '#lorem(30)\n#pagebreak()\n#lorem(30)', { standards: ['ua-1'] });
  assert.deepEqual(warnings.map(warning => [warning.kind, warning.page, warning.element]), [['no-headings', undefined, undefined]]);
  assert.equal(warnings[0].message, '2 pages and no headings, so a screen reader user cannot move between sections.');
  assert.deepEqual((await warningsOf(styled + '#lorem(30)', { standards: ['ua-1'] })).warnings, []);
});

test('headings that skip a level are reported for a tagged export; PDF/UA-1 refuses to compile them', async () => {
  const skipped = levels + '= One\n=== Three\nText.';
  const firstIsH2 = levels + '== Two\nText.';
  for (const source of [skipped, firstIsH2]) await assert.rejects(compileSource(source, { standards: ['ua-1'] }), hasCode('COMPILATION'));
  const skips = (await warningsOf(skipped)).warnings;
  assert.deepEqual(kinds(skips), [['heading-skips-level', 1]]);
  assert.equal(skips[0].message, '"Three" is H3 right after an H1, skipping a level.');
  assert.equal(skips[0].element?.role, 'H3');
  const first = (await warningsOf(firstIsH2)).warnings;
  assert.deepEqual(kinds(first), [['heading-skips-level', 1]]);
  assert.equal(first[0].message, 'The first heading, "Two", is H2; headings start at H1.');
  // Going back up any number of levels is fine.
  assert.deepEqual((await warningsOf(levels + '= A\n== B\n=== C\n= D\n== E')).warnings, []);
});

test('a figure without alt text is reported for a tagged export; PDF/UA-1 refuses to compile it', async () => {
  const dot = '#let dot = bytes("<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\'><rect width=\'10\' height=\'10\'/></svg>")\n';
  const source = levels + dot + '= Chart\n#image(dot)';
  await assert.rejects(compileSource(source, { standards: ['ua-1'] }), hasCode('COMPILATION'));
  const { structure, warnings } = await warningsOf(source);
  assert.deepEqual(kinds(warnings), [['figure-without-alt', 1]]);
  assert.equal(warnings[0].element, elementsOf(structure, 'Figure')[0]);
  assert.deepEqual((await warningsOf(levels + dot + '= Chart\n#image(dot, alt: "A black square.")')).warnings, []);
});

test('checkStructure: an untagged PDF is one untagged warning; otherwise the warnings of its pages', async () => {
  const untagged = await compileSource(levels + '#lorem(30)\n#pagebreak()\n#lorem(30)', { tags: false });
  assert.deepEqual(kinds(await checkStructure(untagged)), [['untagged', undefined]]);
  // Its pages have no tags, so all structureWarnings can see is two pages without headings.
  assert.deepEqual(kinds(structureWarnings((await inspectPdf(untagged)).structure)), [['no-headings', undefined]]);
  const headerless = await compileSource(levels + '= Results\n#table(columns: 2, [a], [b])');
  assert.deepEqual(kinds(await checkStructure(headerless)), [['table-without-headers', 1]]);
  // A tagged PDF with nothing tagged in it, like an empty sample, has nothing to report.
  assert.deepEqual(await checkStructure(await compileSource(levels)), []);
  await assert.rejects(checkStructure(new TextEncoder().encode('hello')), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /^checkStructure input is not a PDF/.test(error.message));
});

test('readStructure reads a pdf.js document the caller loaded, and gives what inspectPdf gives', async () => {
  const bytes = await compile();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    assert.deepEqual(await readStructure(await task.promise), (await inspectPdf(bytes)).structure);
  } finally {
    await task.destroy();
  }
});

// A pdf.js document stand-in: one page whose tree has a P in German, a heading split over two sections, and an artifact.
const standIn: PdfStructureSource = {
  numPages: 2,
  async getPage(number) {
    return {
      async getStructTree() {
        if (number === 2) return null;
        return { role: 'Root', children: [{ role: 'Document', children: [
          { role: 'H1', children: [{ type: 'content', id: 'mc0' }, { type: 'content', id: 'mc1' }] },
          { role: 'P', lang: 'de-DE', alt: '', children: [{ type: 'content', id: 'mc2' }, { type: 'annotation', id: 'a0' }] },
        ] }] };
      },
      async getTextContent() {
        return { items: [
          { type: 'beginMarkedContent', tag: 'Artifact' }, { str: 'Page 1' }, { type: 'endMarkedContent' },
          { type: 'beginMarkedContentProps', id: 'mc0', tag: 'H1' }, { str: 'Split ' }, { type: 'endMarkedContent' },
          { type: 'beginMarkedContentProps', id: 'mc1', tag: 'H1' }, { type: 'beginMarkedContent', tag: 'Span' }, { str: 'heading', hasEOL: true }, { type: 'endMarkedContent' }, { type: 'endMarkedContent' },
          { type: 'beginMarkedContentProps', id: 'mc2', tag: 'P' }, { str: 'Hallo' }, { type: 'beginMarkedContent', tag: 'Artifact' }, { str: ' (skipped)' }, { type: 'endMarkedContent' }, { str: ' Welt' }, { type: 'endMarkedContent' },
        ] };
      },
    };
  },
};

test('readStructure takes any pdf.js-shaped document, keeps lang and alt, and leaves artifacts out', async () => {
  assert.deepEqual(await readStructure(standIn), [
    { page: 1, elements: [{ role: 'Document', text: 'Split heading Hallo Welt', children: [
      { role: 'H1', text: 'Split heading', children: [] },
      { role: 'P', text: 'Hallo Welt', alt: '', lang: 'de-DE', children: [] },
    ] }] },
    { page: 2, elements: [] },
  ]);
  for (const bad of [undefined, {}, { numPages: 1 }, { numPages: Number.NaN, getPage() {} }]) {
    // @ts-expect-error not a pdf.js document
    await assert.rejects(readStructure(bad), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /PDFDocumentProxy/.test(error.message));
  }
  for (const bad of [undefined, 'pages', [{ page: 1 }]]) {
    // @ts-expect-error not pages of a structure tree
    assert.throws(() => structureWarnings(bad), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /readStructure/.test(error.message));
  }
});

// A one-page PDF whose only font is the unembedded standard Helvetica, written by hand (xref offsets computed).
function helveticaPdf() {
  const content = 'BT /F1 24 Tf 72 700 Td (Not embedded) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test('a font the file does not carry is reported as not embedded, and an untitled untagged PDF has nothing else', async () => {
  const report = await inspectPdf(helveticaPdf());
  assert.deepEqual(report.fonts, [{ name: 'Helvetica', embedded: false }]);
  assert.equal(report.pages, 1);
  assert.equal(report.tagged, false);
  assert.equal(report.structureTree, false);
  assert.equal(report.title, undefined);
  assert.equal(report.language, undefined);
  assert.equal(report.creationDate, undefined);
  assert.deepEqual(report.standard, { pdfUa: undefined, pdfA: undefined });
});

test('input that is not a PDF rejects with a clear message', async () => {
  await assert.rejects(inspectPdf(new TextEncoder().encode('hello, not a pdf')), (error: TypstPdfError) => {
    assert.ok(hasCode('INVALID_REQUEST')(error));
    assert.match(error.message, /not a PDF/);
    return true;
  });
  await assert.rejects(inspectPdf(new Uint8Array()), hasCode('INVALID_REQUEST'));
  // @ts-expect-error a string is not PDF bytes
  await assert.rejects(inspectPdf('%PDF-1.7'), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /Uint8Array/.test(error.message));
  // @ts-expect-error null is not PDF bytes
  await assert.rejects(inspectPdf(null), hasCode('INVALID_REQUEST'));
});

test('a file with a PDF header that pdf.js cannot read rejects with INVALID_REQUEST', async () => {
  await assert.rejects(inspectPdf(new TextEncoder().encode('%PDF-1.7\nthis is not a pdf body\n')), (error: TypstPdfError) => {
    assert.ok(hasCode('INVALID_REQUEST')(error));
    assert.match(error.message, /could not read the PDF/);
    assert.ok(error.cause);
    return true;
  });
});

test('the main entry has no inspectPdf and never reaches the pdf module or pdfjs-dist', async () => {
  assert.equal('inspectPdf' in main, false);
  assert.deepEqual(Object.keys(pdfModule), ['checkStructure', 'inspectPdf', 'readStructure', 'structureWarnings']);
  const seen = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    assert.ok(!/pdfjs/.test(source), `${url.pathname} mentions pdfjs`);
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) await visit(new URL(specifier, url));
  };
  await visit(new URL('../dist/index.js', import.meta.url));
  await visit(new URL('../../core/dist/internal.js', import.meta.url));
  assert.ok(![...seen].some(href => href.endsWith('/dev-tools/dist/pdf.js')));
});

test('a missing pdfjs-dist rejects with an install hint', async () => {
  // A copy of dist outside the repository cannot resolve the repo's pdfjs-dist devDependency. It still needs
  // @typfolio/core, which a symlink provides without bringing the repository's other packages into reach.
  const directory = await mkdtemp(join(tmpdir(), 'typfolio-no-pdfjs-'));
  try {
    await cp(new URL('../dist', import.meta.url), directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await mkdir(join(directory, 'node_modules/@typfolio'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../core', import.meta.url)), join(directory, 'node_modules/@typfolio/core'), 'dir');
    const copy: PdfModule = await import(pathToFileURL(join(directory, 'pdf.js')).href);
    const bytes = await compile();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(copy.inspectPdf(bytes), (error: TypstPdfError) => {
        assert.ok(hasCode('INITIALIZATION')(error));
        assert.match(error.message, /install pdfjs-dist/i);
        assert.equal((error.cause as { code?: string } | undefined)?.code, 'ERR_MODULE_NOT_FOUND');
        return true;
      });
    }
    await assert.rejects(copy.checkStructure(bytes), (error: TypstPdfError) => hasCode('INITIALIZATION')(error) && /^checkStructure could not load pdfjs-dist/.test(error.message));
    // A caller that brings its own pdf.js document needs none installed.
    assert.equal((await copy.readStructure(standIn))[0].elements[0].children[0].text, 'Split heading');
    assert.deepEqual(copy.structureWarnings(await copy.readStructure(standIn)), []);
    // Input checks come first, so they need no pdfjs-dist.
    await assert.rejects(copy.inspectPdf(new Uint8Array(4)), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /not a PDF/.test(error.message));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
