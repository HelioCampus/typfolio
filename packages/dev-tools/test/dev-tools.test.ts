import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as main from '@typfolio/core';
import { defineInput, definePartial, defineTemplate, TypstPdfError } from '@typfolio/core';
import type { ErrorCode, StandardSchemaV1 } from '@typfolio/core';
import * as devTools from '../dist/index.js';
import { checkTemplate, createTemplateChecker, inputSchemaFiles } from '../dist/index.js';
import type { SampleMode, TemplateCheckReport, TemplateChecker, TemplateCheckResult } from '../dist/index.js';
import { headerInput } from '../../../examples/vite-react/src/common/header.schema.ts';
import { outcomesInput } from '../../../examples/vite-react/src/outcomes/outcomes.schema.ts';

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const helper = '#import "@local/typfolio:0.1.0": input\n';
const read = (...lines: string[]) => helper + lines.join('\n') + '\n';
const schemaFile = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    rows: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  },
  required: ['title', 'rows'],
});
const sampleMarkers = ['_is-nullable', 'Sample text', '123e4567-e89b-12d3-a456-426614174000'];
const byMode = (report: TemplateCheckReport): Record<string, TemplateCheckResult> => Object.fromEntries(report.results.map(result => [result.mode, result]));

let checker!: TemplateChecker;
let wasm!: Buffer;
let fonts!: Buffer[];
before(async () => {
  wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  fonts = [await file('fixtures/fonts/LibertinusSerif-Regular.otf')];
  checker = await createTemplateChecker({ wasm, fonts });
});
after(() => checker?.dispose());

test('the core main entry exports nothing from dev-tools and never reaches it', async () => {
  for (const name of Object.keys(devTools)) assert.equal(name in main, false, `${name} leaked into the main entry`);
  assert.deepEqual(Object.keys(devTools).sort(), ['checkTemplate', 'createTemplateChecker', 'inputSchemaFiles']);
  // Follow the static import graph of the main entry's compiled files.
  const seen = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    // (`sample-from-schema` is no marker: lib.typ names it in its import.) These appear only in sample.typ.
    for (const marker of sampleMarkers) assert.ok(!source.includes(marker), `${fileURLToPath(url)} contains the sample builder (${marker})`);
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) await visit(new URL(specifier, url));
  };
  await visit(new URL('../../core/dist/index.js', import.meta.url));
  assert.ok(seen.size > 3);
  for (const href of seen) assert.ok(!/dev-tools|sample-source/.test(href), `${href} is reachable from the main entry`);
});

test('dev-tools can write nothing: it imports no file system or network module', async () => {
  const seen = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    assert.ok(!/['"](?:node:)?(?:fs|fs\/promises|http|https|net|child_process)['"]/.test(source), `${fileURLToPath(url)} imports a Node I/O module`);
    for (const [, specifier] of source.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) await visit(new URL(specifier, url));
  };
  // Core is reached through its bare specifiers, so follow the internal entry's graph as well.
  await visit(new URL('../dist/index.js', import.meta.url));
  await visit(new URL('../../core/dist/internal.js', import.meta.url));
});

test('a correct template passes in both modes and returns PDF bytes', async () => {
  const report = await checker.check({ files: {
    'main.typ': read(
      '#let data = input(json.with("./report.schema.json"))',
      '#set document(title: "Check")',
      '= #data.title',
      '#data.at("subtitle", default: "")',
      '#for row in data.rows [ - #row.name ]'),
    'report.schema.json': schemaFile,
  } });
  assert.equal(report.ok, true, JSON.stringify(report.results.map(r => r.error?.message)));
  assert.deepEqual(report.results.map(result => result.mode), ['minimal', 'full']);
  for (const result of report.results) {
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.ok(result.bytes instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 5)), '%PDF-');
  }
});

test('a template that reads an optional field without a default fails only under minimal', async () => {
  const report = await checker.check({ files: {
    'main.typ': read('#let data = input(json.with("./report.schema.json"))', '#data.subtitle'),
    'report.schema.json': schemaFile,
  } });
  assert.equal(report.ok, false);
  const { minimal, full } = byMode(report);
  assert.equal(full.ok, true);
  assert.equal(minimal.ok, false);
  assert.ok(hasCode('COMPILATION')(minimal.error));
  assert.equal(minimal.bytes, undefined);
  assert.match(minimal.error!.message, /dictionary does not contain key "subtitle"/);
  assert.equal(minimal.diagnostics[0].path, '/main.typ');
  assert.equal(minimal.diagnostics[0].severity, 'error');
});

test('a template that calls first() on an array fails only under minimal', async () => {
  const report = await checker.check({ files: {
    'main.typ': read('#let data = input(json.with("./report.schema.json"))', '#data.rows.first().name'),
    'report.schema.json': schemaFile,
  } });
  const { minimal, full } = byMode(report);
  assert.equal(full.ok, true);
  assert.equal(minimal.ok, false);
  assert.match(minimal.error!.message, /array is empty/);
});

test('a template that reads a field the schema does not declare fails under both modes', async () => {
  const report = await checker.check({ files: {
    'main.typ': read('#let data = input(json.with("./report.schema.json"))', '#data.title', '#data.undeclared'),
    'report.schema.json': schemaFile,
  } });
  assert.equal(report.ok, false);
  for (const result of report.results) {
    assert.equal(result.ok, false, result.mode);
    assert.match(result.error!.message, /dictionary does not contain key "undeclared"/);
  }
});

test('a nested entrypoint finds its schema at a path relative to itself', async () => {
  const entrypoint = 'reports/outcome/main.typ';
  const report = await checker.check({ entrypoint, files: {
    [entrypoint]: read('#let data = input(json.with("./schemas/report.schema.json"))', '#data.title'),
    'reports/outcome/schemas/report.schema.json': schemaFile,
  } });
  assert.equal(report.ok, true, JSON.stringify(report.results.map(r => r.error?.message)));
  // The schema missing from files is a compile failure of every mode, not a thrown error.
  const missing = await checker.check({ entrypoint, files: { [entrypoint]: read('#let data = input(json.with("./schemas/report.schema.json"))', '#data.title') } });
  assert.equal(missing.ok, false);
  assert.equal(missing.results.length, 2);
  assert.deepEqual(missing.results[0].diagnostics.filter(d => d.code === 'file-not-found').map(d => d.file), ['/reports/outcome/schemas/report.schema.json']);
});

test('pdf options pass through to every compile', async () => {
  const template = { files: { 'main.typ': '#set text(font: "Libertinus Serif", lang: "en")\n#set document(title: "Accessible")\nHello' } };
  const plain = await checker.check(template);
  const ua = await checker.check(template, { pdf: { standards: ['ua-1'] } });
  assert.equal(ua.ok, true);
  for (const result of plain.results) assert.ok(!Buffer.from(result.bytes!).includes('pdfuaid'));
  for (const result of ua.results) assert.ok(Buffer.from(result.bytes!).includes('pdfuaid'), `${result.mode} was not compiled as PDF/UA`);
  // @ts-expect-error a PDF standard that does not exist must be rejected at run time
  await assert.rejects(checker.check(template, { pdf: { standards: ['imaginary'] } }), hasCode('UNSUPPORTED_OPTION'));
  await assert.rejects(checker.check(template, { pdf: { standards: ['ua-1'], tags: false } }), hasCode('INVALID_REQUEST'));
});

test('a recursive schema is expanded one level, then ends in empty lists, in both modes', async () => {
  // A tree as Zod writes it: the root refers to itself with "#", and through $defs.
  const selfReferring = {
    type: 'object',
    properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
    required: ['name', 'children'],
  };
  const throughDefs = {
    $ref: '#/$defs/Node',
    $defs: { Node: { ...selfReferring, properties: { ...selfReferring.properties, children: { type: 'array', items: { $ref: '#/$defs/Node' } }, parent: { $ref: '#/$defs/Node' } } } },
  };
  for (const schema of [selfReferring, throughDefs]) {
    const report = await checker.check({ files: {
      'main.typ': read(
        '#let data = input(json.with("./tree.schema.json"))',
        '#data.name',
        '#for child in data.children [ - #child.name (#child.children.len()) ]',
        '#repr(data.at("parent", default: "none"))'),
      'tree.schema.json': JSON.stringify(schema),
    } });
    assert.equal(report.ok, true, JSON.stringify(report.results.map(r => r.error?.message)));
  }
});

test('assets reach every compile, beside the sample input', async () => {
  const template = { files: {
    'main.typ': read(
      '#let data = input(json.with("./report.schema.json"))',
      '#let settings = json("/export-settings.json")',
      '#settings.institution: #data.title'),
    'report.schema.json': schemaFile,
  } };
  const assets = { 'export-settings.json': new TextEncoder().encode('{"institution":"Northwind"}') };
  const report = await checker.check(template, { assets });
  assert.equal(report.ok, true, JSON.stringify(report.results.map(r => r.error?.message)));
  const without = await checker.check(template);
  assert.equal(without.ok, false);
  assert.match(without.results[0].error!.message, /failed to load file|not found/);
  await assert.rejects(checker.check(template, { assets: { '/input.json': new Uint8Array([1]) } }), hasCode('INVALID_REQUEST'));
});

const zodLike = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'final'] },
    author: { anyOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, { type: 'null' }] },
    students: { type: 'array', items: { $ref: '#/$defs/Student' } },
    extras: { default: [], type: 'array', items: { $ref: '#/$defs/Student' } },
    meta: { default: { version: 1 }, type: 'object', properties: { version: { type: 'number' }, label: { type: 'string' } }, required: ['version', 'label'] },
  },
  required: ['title', 'status', 'author', 'students', 'extras', 'meta'],
  additionalProperties: false,
  $defs: {
    Student: {
      type: 'object',
      properties: { name: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 }, tags: { default: [], type: 'array', items: { type: 'string' } } },
      required: ['name', 'score', 'tags'],
    },
  },
};
const student = { name: 'Sample text', score: 0, tags: ['Sample text'] };
const expected: Record<SampleMode, unknown> = {
  minimal: { title: '', status: 'draft', author: null, students: [], extras: [], meta: { version: 0, label: '' } },
  full: { title: 'Sample text', subtitle: 'Sample text', status: 'draft', author: { name: 'Sample text' }, students: [student], extras: [student], meta: { version: 1, label: 'Sample text' } },
};

test('a Zod-4-shaped schema gets the minimal and the full sample', async () => {
  // The report carries bytes and diagnostics only, so the template asserts the sample it received
  // against an expected value shipped as a template file; a mismatch fails that mode.
  const template = (value: unknown) => ({ files: {
    'main.typ': read('#let data = input(json.with("./report.schema.json"))', `#assert.eq(data, json("expected.json"))`, '#data.title'),
    'report.schema.json': JSON.stringify(zodLike),
    'expected.json': JSON.stringify(value),
  } });
  for (const mode of ['minimal', 'full'] as const) {
    const report = await checker.check(template(expected[mode]), { modes: [mode] });
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].mode, mode);
    assert.equal(report.ok, true, `${mode}: ${report.results[0].error?.message}`);
    // The assertion bites: the other mode's value does not match.
    const other = mode === 'minimal' ? 'full' : 'minimal';
    const mismatch = await checker.check(template(expected[other]), { modes: [mode] });
    assert.equal(mismatch.ok, false, `${mode} must not equal the ${other} sample`);
    assert.match(mismatch.results[0].error!.message, /equality assertion failed/);
  }
});

test('modes are validated, subsettable and reported in the order given', async () => {
  const template = { files: { 'main.typ': 'Hello' } };
  const full = await checker.check(template, { modes: ['full'] });
  assert.deepEqual(full.results.map(result => result.mode), ['full']);
  const reversed = await checker.check(template, { modes: ['full', 'minimal'] });
  assert.deepEqual(reversed.results.map(result => result.mode), ['full', 'minimal']);
  // @ts-expect-error an unknown mode must be rejected at run time
  await assert.rejects(checker.check(template, { modes: ['sparse'] }), hasCode('UNSUPPORTED_OPTION'));
  await assert.rejects(checker.check(template, { modes: [] }), hasCode('INVALID_REQUEST'));
  await assert.rejects(checker.check(template, { modes: ['full', 'full'] }), hasCode('INVALID_REQUEST'));
  // @ts-expect-error an unknown option must be rejected at run time
  await assert.rejects(checker.check(template, { extra: true }), hasCode('UNSUPPORTED_OPTION'));
});

test('a malformed template is thrown, not reported', async () => {
  await assert.rejects(checker.check({ files: { 'other.typ': 'x' } }), hasCode('INVALID_REQUEST'));
  await assert.rejects(checker.check({ files: { 'main.typ': 'x', '@typfolio/lib.typ': 'y' } }), hasCode('INVALID_REQUEST'));
  await assert.rejects(checker.check({ files: { 'main.typ': 'x', 'input.json': '{}' } }), hasCode('INVALID_REQUEST'));
});

test('the editor sample.typ is mounted only by the check, and runtime imports stay restricted', async () => {
  // A check imports the package like the editor does; a different package is still refused.
  const report = await checker.check({ files: { 'main.typ': '#import "@local/typfolio:0.2.0": input' } });
  assert.equal(report.ok, false);
  assert.match(report.results[0].error!.message, /Only @local\/typfolio:0\.1\.0 is available/);
});

test('a checker runs one check at a time and refuses work once disposed', async () => {
  const local = await createTemplateChecker({ wasm, fonts });
  const first = local.check({ files: { 'main.typ': 'Hello' } });
  await assert.rejects(local.check({ files: { 'main.typ': 'Hello' } }), hasCode('BUSY'));
  assert.equal((await first).ok, true);
  const disposed = local.dispose();
  await assert.rejects(local.check({ files: { 'main.typ': 'Hello' } }), hasCode('DISPOSED'));
  await disposed;
  await local.dispose();
});

test('checkTemplate is the one-shot form, and fonts are required', async () => {
  const report = await checkTemplate({ files: { 'main.typ': 'Hello' } }, { wasm, fonts, modes: ['minimal'] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.results.map(result => result.mode), ['minimal']);
  await assert.rejects(createTemplateChecker({ wasm, fonts: [] }), hasCode('INVALID_REQUEST'));
});

// A Standard Schema that accepts anything and, unless `plain`, also implements Standard JSON Schema.
function described(json: object, plain = false): StandardSchemaV1 {
  const standard = { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) };
  const props = plain ? standard : { ...standard, jsonSchema: { input: () => json, output: () => json } };
  return { '~standard': props };
}

const headerJson = { type: 'object', properties: { institution: { type: 'string' } }, required: ['institution'] };
const reportJson = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
const header = definePartial({
  files: { 'common/header.typ': read('#let settings = input(json.with("./header.schema.json"))', '#let standard-header(title) = [#settings.institution: #title]') },
  input: defineInput(described(headerJson), 'common/header.schema.json'),
});
const reportMain = read(
  '#import "../common/header.typ": standard-header',
  '#let data = input(json.with("./input.schema.json"))',
  '#set text(font: "Libertinus Serif")',
  '#standard-header(data.title)',
);
const report = defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': reportMain },
  input: defineInput(described(reportJson), 'report/input.schema.json'),
  partials: { header },
});

test('inputSchemaFiles gives the JSON Schema file of every input, by path, from Standard JSON Schema or toJSONSchema', () => {
  const files = inputSchemaFiles(report);
  assert.deepEqual(Object.keys(files), ['report/input.schema.json', 'common/header.schema.json']);
  assert.deepEqual(JSON.parse(files['common/header.schema.json']), headerJson);
  assert.ok(files['report/input.schema.json'].endsWith('}\n'));
  // A partial on its own, and the same partial reached twice, give each file once.
  assert.deepEqual(Object.keys(inputSchemaFiles([header, report])), ['common/header.schema.json', 'report/input.schema.json']);

  const plain = definePartial({ files: {}, input: defineInput(described(headerJson, true), 'common/plain.schema.json') });
  assert.throws(() => inputSchemaFiles(plain), (error: unknown) => hasCode('INVALID_REQUEST')(error) && /common\/plain\.schema\.json does not implement Standard JSON Schema/.test((error as Error).message));
  const converted: StandardSchemaV1[] = [];
  const viaOption = inputSchemaFiles(plain, { toJSONSchema: schema => { converted.push(schema); return { converted: true }; } });
  assert.deepEqual(JSON.parse(viaOption['common/plain.schema.json']), { converted: true });
  assert.equal(converted[0], plain.input.schema);
});

test('check compiles a defined template from its declared files, with each input schema at its path', async () => {
  const report1 = await checker.check(report);
  assert.equal(report1.ok, true, report1.results.map(result => result.error?.message).join('\n'));
  assert.deepEqual(report1.results.map(result => result.mode), ['minimal', 'full']);
  // A schema file given in assets is used as it is.
  const given = await checker.check(report, {
    modes: ['full'],
    assets: { 'common/header.schema.json': new TextEncoder().encode(JSON.stringify({ type: 'object', properties: { institution: { type: 'string' } } })) },
  });
  assert.equal(given.ok, true);
});

test('check fails a defined template that imports a file it does not declare, saying what to do', async () => {
  const forgetful = defineTemplate({
    entrypoint: 'report/main.typ',
    files: { 'report/main.typ': reportMain },
    input: defineInput(described(reportJson), 'report/input.schema.json'),
  });
  const result = (await checker.check(forgetful, { modes: ['minimal'] })).results[0];
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.filter(d => d.code === 'file-not-found').map(d => [d.file, d.path]), [['/common/header.typ', '/report/main.typ']]);
  assert.match(result.error!.message, /^File not found: \/common\/header\.typ \(read by \/report\/main\.typ\)\. See https:\/\/github\.com\/HelioCampus\/typfolio\/blob\/main\/docs\/errors\.md#file-not-found/);

  // The header's code is listed, but not as a partial: no schema is mounted for it.
  const codeOnly = defineTemplate({
    entrypoint: 'report/main.typ',
    files: { 'report/main.typ': reportMain, 'common/header.typ': header.files['common/header.typ'] },
    input: defineInput(described(reportJson), 'report/input.schema.json'),
  });
  const missing = (await checker.check(codeOnly, { modes: ['minimal'] })).results[0];
  assert.deepEqual(missing.diagnostics.filter(d => d.code === 'file-not-found').map(d => [d.file, d.path]), [['/common/header.schema.json', '/common/header.typ']]);
});

// What an application's test does: its schema files are up to date, and its templates check in the editor.
test('the vite-react example: its schema files match its Zod schemas, and the outcomes template checks', async () => {
  const example = 'examples/vite-react/src/';
  const source = async (path: string) => String(await file(example + path));
  // The inputs come from modules a script can import (the definitions import .typ files through the bundler).
  const files = inputSchemaFiles([headerInput, outcomesInput]);
  assert.deepEqual(Object.keys(files), ['common/header.schema.json', 'outcomes/outcomes.schema.json']);
  for (const [path, text] of Object.entries(files)) {
    assert.deepEqual(JSON.parse(await source(path)), JSON.parse(text), `${example}${path} is out of date`);
  }
  // The definitions as the app makes them, with the Typst sources read from disk.
  const exampleHeader = definePartial({ files: { 'common/header.typ': await source('common/header.typ') }, input: headerInput });
  const outcomes = defineTemplate({
    entrypoint: 'outcomes/main.typ',
    files: { 'outcomes/main.typ': await source('outcomes/main.typ') },
    input: outcomesInput,
    partials: { header: exampleHeader },
  });
  assert.deepEqual(inputSchemaFiles(outcomes), { 'outcomes/outcomes.schema.json': files['outcomes/outcomes.schema.json'], 'common/header.schema.json': files['common/header.schema.json'] });
  // The chart and logo fields are images (contentMediaType): the sample draws placeholders for them.
  const report = await checker.check(outcomes, { pdf: { standards: ['ua-1'] } });
  assert.equal(report.ok, true, report.results.map(result => result.error?.message).join('\n'));
});
