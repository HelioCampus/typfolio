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
import { inspectPdf } from '../dist/pdf.js';

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
  assert.deepEqual(Object.keys(report).sort(), ['creationDate', 'figures', 'fonts', 'headings', 'language', 'pages', 'standard', 'structureRoles', 'structureTree', 'tables', 'tagged', 'title']);
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
  assert.deepEqual(Object.keys(pdfModule), ['inspectPdf']);
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
    // Input checks come first, so they need no pdfjs-dist.
    await assert.rejects(copy.inspectPdf(new Uint8Array(4)), (error: TypstPdfError) => hasCode('INVALID_REQUEST')(error) && /not a PDF/.test(error.message));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
