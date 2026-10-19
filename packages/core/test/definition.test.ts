import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createAttachments,
  createCompiler,
  definePartial,
  defineTemplate,
  TypstPdfError,
} from '../dist/index.js';
import type { ErrorCode, PdfCompiler, PdfDocument, StandardSchemaV1 } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const failsWith = (code: ErrorCode, message: RegExp) => (error: unknown) => hasCode(code)(error) && message.test((error as Error).message);

// A Standard Schema without a schema library: `field` must be a non-empty string.
function required<T>(field: keyof T & string, async = false): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => {
        const given = (value as Record<string, unknown> | null)?.[field];
        const result = typeof given === 'string' && given ? { value: value as T } : { issues: [{ message: `${field} is empty`, path: [field] }] };
        return async ? Promise.resolve(result) : result;
      },
    },
  };
}

interface Header { institution: string }
interface Report { title: string }
interface Badge { label: string }

const helper = '#import "@local/typfolio:0.1.0": input';
const headerSource = [
  helper,
  '#let settings = input(json.with("./header.schema.json"))',
  '#let standard-header(title) = [#settings.institution: #title]',
].join('\n');
const mainSource = [
  helper,
  '#import "../common/header.typ": standard-header, settings',
  '#let data = input(json.with("./input.schema.json"))',
  '#set text(font: "Libertinus Serif")',
  '#set document(title: data.title + " / " + settings.institution)',
  '#standard-header(data.title)',
].join('\n');

const header = definePartial({
  files: { 'common/header.typ': headerSource },
  schema: required<Header>('institution'),
  schemaPath: 'common/header.schema.json',
});
const report = defineTemplate({
  entrypoint: 'template/main.typ',
  files: { 'template/main.typ': mainSource },
  schema: required<Report>('title'),
  schemaPath: 'template/input.schema.json',
  partials: { header },
});

let compiler!: PdfCompiler;
before(async () => {
  compiler = await createCompiler({
    wasm: await readFile(new URL('packages/wasm/generated/compiler_bg.wasm', root)),
    fonts: [await readFile(new URL('fixtures/fonts/LibertinusSerif-Regular.otf', root))],
  });
});
after(() => compiler?.dispose());

test('a template and its partial each read their own data, mounted at their schema paths', async () => {
  const document = report({ title: 'Outcomes' }, { header: { institution: 'Example University' } });
  assert.equal(document.kind, 'typfolio-document');
  assert.ok(Object.isFrozen(document));
  const result = await compiler.compile(document, { pdf: { creationTimestamp: 1700000000 } });
  assert.equal(result.metadata.title, 'Outcomes / Example University');
  assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 5)), '%PDF-');
});

// The badge is a partial of the header: its data is given flat, by its own key, beside the header's.
const badge = definePartial({
  files: { 'common/badge.typ': `${helper}\n#let badge = input(json.with("./badge.schema.json"))` },
  schema: required<Badge>('label'),
  schemaPath: 'common/badge.schema.json',
});
const badgedHeader = definePartial({
  files: { 'common/header.typ': `${headerSource}\n#import "badge.typ": badge\n#let label = settings.institution + " (" + badge.label + ")"` },
  schema: required<Header>('institution'),
  schemaPath: 'common/header.schema.json',
  partials: { badge },
});
const badgedMain = mainSource.replace('#import "../common/header.typ": standard-header, settings', '#import "../common/header.typ": standard-header, label')
  .replace('settings.institution', 'label');

test('defineTemplate collects every partial file and input, nested ones included', () => {
  const template = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': badgedMain },
    schema: required<Report>('title'),
    schemaPath: 'template/input.schema.json',
    // The badge is reached twice, at the top and through the header: it is collected once.
    partials: { header: badgedHeader, badge },
  });
  assert.equal(template.kind, 'typfolio-template');
  assert.equal(template.entrypoint, 'template/main.typ');
  assert.deepEqual(Object.keys(template.files).sort(), ['common/badge.typ', 'common/header.typ', 'template/main.typ']);
  assert.deepEqual(template.inputs.map(slot => [slot.key, slot.path]), [
    [null, 'template/input.schema.json'],
    ['header', 'common/header.schema.json'],
    ['badge', 'common/badge.schema.json'],
  ]);
  assert.ok(Object.isFrozen(template));
  assert.ok(Object.isFrozen(template.files));
});

test('a nested partial\'s data is given flat, by its key, in the same object as the others', async () => {
  const badged = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': badgedMain },
    schema: required<Report>('title'),
    schemaPath: 'template/input.schema.json',
    partials: { header: badgedHeader },
  });
  const result = await compiler.compile(badged({ title: 'Outcomes' }, { header: { institution: 'Example University' }, badge: { label: 'Gold' } }));
  assert.equal(result.metadata.title, 'Outcomes / Example University (Gold)');
  // The nested partial's data is required too, and checked against its own schema.
  await assert.rejects(
    // @ts-expect-error the badge's data is required
    compiler.compile(badged({ title: 'T' }, { header: { institution: 'X' } })),
    failsWith('INVALID_REQUEST', /Partial "badge" reads its data from common\/badge\.schema\.json, but none was given for "badge"/),
  );
  await assert.rejects(
    compiler.compile(badged({ title: 'T' }, { header: { institution: 'X' }, badge: { label: '' } })),
    failsWith('INVALID_INPUT', /The data of partial "badge" does not match its schema \(common\/badge\.schema\.json\):\n- label: label is empty/),
  );
});

test('defineTemplate rejects partials that clash', async () => {
  const other = definePartial({ files: { 'common/header.typ': 'different' }, schemaPath: 'common/other.schema.json' });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, other } }), /common\/header\.typ is given twice/);
  const sameKey = definePartial({ files: {}, schemaPath: 'common/x.schema.json' });
  const nested = definePartial({ files: {}, schemaPath: 'common/y.schema.json', partials: { header: sameKey } });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, nested } }), /two different partials are both named "header"/);
  const samePath = definePartial({ files: {}, schemaPath: 'common/header.schema.json' });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, samePath } }), /both read their data from common\/header\.schema\.json/);
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, schemaPath: 'common/header.schema.json', partials: { header } }), /both read their data from common\/header\.schema\.json/);
  assert.throws(
    () => defineTemplate({ files: { 'main.typ': '', 'common/header.schema.json': '{}' }, partials: { header } }),
    /common\/header\.schema\.json is where data is read; do not list it in files/,
  );
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header: {} as typeof header } }), /header is not a definePartial/);
  assert.throws(() => definePartial({ files: {}, schema: {} as StandardSchemaV1, schemaPath: 'a.schema.json' }), /Standard Schema/);
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, schema: {} as StandardSchemaV1, schemaPath: 'a.schema.json' }), /Standard Schema/);
  // @ts-expect-error a partial needs the path its Typst file reads its data from
  assert.throws(() => definePartial({ files: {} }), /schemaPath is required/);
  // Paths are checked when compiling: a definition only compares them.
  const outside = defineTemplate({ files: { 'main.typ': '' }, schemaPath: '../a.schema.json' });
  await assert.rejects(compiler.compile(outside({})), failsWith('INVALID_REQUEST', /Ambiguous or traversing path/));
  // A file whose name is no data path is not refused as one.
  assert.doesNotThrow(() => defineTemplate({ files: { 'main.typ': '', 'notes:draft.typ': '' }, partials: { header } }));
});

test('a schema without schemaPath is refused: the entrypoint would have nowhere to read the data', () => {
  assert.throws(
    // @ts-expect-error a schema needs schemaPath
    () => defineTemplate({ files: { 'main.typ': '' }, schema: required<Report>('title') }),
    (error: unknown) => error instanceof TypeError && /a schema needs schemaPath/.test(error.message),
  );
});

test('data that does not match its schema is rejected with INVALID_INPUT before compiling', async () => {
  await assert.rejects(
    compiler.compile(report({ title: '' }, { header: { institution: 'X' } })),
    (error: unknown) => {
      assert.ok(failsWith('INVALID_INPUT', /^The template data does not match its schema \(template\/input\.schema\.json\):\n- title: title is empty$/)(error));
      assert.deepEqual((error as TypstPdfError & { issues: unknown }).issues, [{ message: 'title is empty', path: ['title'] }]);
      return true;
    },
  );
  await assert.rejects(
    compiler.compile(report({ title: 'T' }, { header: { institution: '' } })),
    failsWith('INVALID_INPUT', /^The data of partial "header" does not match its schema \(common\/header\.schema\.json\):\n- institution: institution is empty$/),
  );
});

test('a schema that validates asynchronously is awaited, and its failure names the partial', async () => {
  const asyncHeader = definePartial({ ...header, schema: required<Header>('institution', true) });
  const asyncReport = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource },
    schema: required<Report>('title', true),
    schemaPath: 'template/input.schema.json',
    partials: { header: asyncHeader },
  });
  await assert.rejects(
    compiler.compile(asyncReport({ title: 'T' }, { header: { institution: '' } })),
    failsWith('INVALID_INPUT', /^The data of partial "header" does not match its schema \(common\/header\.schema\.json\)/),
  );
  await assert.rejects(
    compiler.compile(asyncReport({ title: '' }, { header: { institution: 'X' } })),
    failsWith('INVALID_INPUT', /^The template data does not match its schema/),
  );
  const ok = await compiler.compile(asyncReport({ title: 'Async' }, { header: { institution: 'X' } }));
  assert.equal(ok.metadata.title, 'Async / X');
});

test('validate: false skips the schemas but keeps the rest of the checks', async () => {
  const asyncHeader = definePartial({ ...header, schema: required<Header>('institution', true) });
  const asyncReport = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource },
    schema: required<Report>('title', true),
    schemaPath: 'template/input.schema.json',
    partials: { header: asyncHeader },
  });
  // Data each schema rejects compiles, synchronous and asynchronous schemas alike.
  assert.equal((await compiler.compile(report({ title: '' }, { header: { institution: '' } }), { validate: false })).metadata.title, ' / ');
  assert.equal((await compiler.compile(asyncReport({ title: '' }, { header: { institution: 'X' } }), { validate: false })).metadata.title, ' / X');
  // Missing data is still an INVALID_REQUEST, and a non-boolean is refused.
  await assert.rejects(
    // @ts-expect-error the header's data is required
    compiler.compile(report({ title: 'T' }), { validate: false }),
    failsWith('INVALID_REQUEST', /Partial "header" reads its data/),
  );
  await assert.rejects(
    // @ts-expect-error validate is a boolean
    compiler.compile(report({ title: 'T' }, { header: { institution: 'X' } }), { validate: 'no' }),
    failsWith('INVALID_REQUEST', /validate must be true or false/),
  );
});

test('missing or unknown data is an INVALID_REQUEST that names the partial', async () => {
  await assert.rejects(
    // @ts-expect-error the header's data is required
    compiler.compile(report({ title: 'T' })),
    failsWith('INVALID_REQUEST', /Partial "header" reads its data from common\/header\.schema\.json, but none was given for "header"/),
  );
  await assert.rejects(
    // @ts-expect-error a template with no "footer" partial
    compiler.compile(report({ title: 'T' }, { header: { institution: 'X' }, footer: {} })),
    failsWith('INVALID_REQUEST', /This template has no partial "footer"; it has "header"/),
  );
  await assert.rejects(
    // @ts-expect-error the template's own data is required
    compiler.compile(report(undefined, { header: { institution: 'X' } })),
    failsWith('INVALID_REQUEST', /The template reads its data from template\/input\.schema\.json, but none was given/),
  );
});

test('compile takes a document: anything else is an INVALID_REQUEST', async () => {
  const values: unknown[] = [
    { template: report, input: { title: 'T' }, partials: { header: { institution: 'X' } } },
    report, // the template itself, not called with its data
    { kind: 'typfolio-document', template: {}, data: {}, partials: {} },
    null, undefined, 'main.typ', ['x'], new Map(),
  ];
  for (const value of values) {
    // The cast stands in for a caller that bypasses the types; the compiler must still reject the value.
    await assert.rejects(compiler.compile(value as PdfDocument), failsWith('INVALID_REQUEST', /compile takes a document/));
  }
});

test('a template without a schema takes its data unchecked', async () => {
  const loose = defineTemplate({
    files: { 'main.typ': `${helper}\n#let data = input(json.with("./data.schema.json"))\n#set document(title: repr(data.n))` },
    schemaPath: 'data.schema.json',
  });
  assert.equal((await compiler.compile(loose({ n: 42 }))).metadata.title, '42');
  // Without a schema nothing checks the data: whatever its shape, it reaches the template as JSON.
  assert.equal((await compiler.compile(loose({ n: 'not a number', extra: [1] }))).metadata.title, '"not a number"');
  await assert.rejects(compiler.compile(loose({})), hasCode('COMPILATION'));
});

test('a template without data is called with nothing', async () => {
  const staticTemplate = defineTemplate({ files: { 'main.typ': '#set text(font: "Libertinus Serif")\n#set document(title: "Static")\nStatic' } });
  assert.deepEqual(staticTemplate.inputs, []);
  const result = await compiler.compile(staticTemplate());
  assert.equal(result.metadata.title, 'Static');
  // Data it has nowhere to mount is refused, not dropped.
  await assert.rejects(
    // @ts-expect-error a template without schemaPath takes no data
    compiler.compile(staticTemplate({ title: 'ignored' })),
    (error: unknown) => error instanceof TypstPdfError && error.code === 'INVALID_REQUEST' && /takes no data/.test(error.message),
  );
});

test('a file the template imports but does not list fails with what to do', async () => {
  const forgetful = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource },
    schema: required<Report>('title'),
    schemaPath: 'template/input.schema.json',
  });
  await assert.rejects(compiler.compile(forgetful({ title: 'T' })), (error: unknown) => {
    assert.ok(hasCode('COMPILATION')(error));
    const [missing] = (error as TypstPdfError).diagnostics.filter(d => d.code === 'file-not-found');
    assert.equal(missing.file, '/common/header.typ');
    assert.equal(missing.path, '/template/main.typ');
    assert.equal(missing.message, 'File not found: /common/header.typ (read by /template/main.typ). See https://github.com/HelioCampus/typfolio/blob/main/docs/errors.md#file-not-found');
    assert.match((error as Error).message, /^File not found: \/common\/header\.typ/);
    return true;
  });
  // The header's code is listed, but not as a partial: its data is not mounted.
  const codeOnly = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource, 'common/header.typ': headerSource },
    schema: required<Report>('title'),
    schemaPath: 'template/input.schema.json',
  });
  await assert.rejects(compiler.compile(codeOnly({ title: 'T' })), (error: unknown) => {
    assert.ok(hasCode('COMPILATION')(error));
    const [missing] = (error as TypstPdfError).diagnostics.filter(d => d.code === 'file-not-found');
    assert.equal(missing.file, '/common/header.schema.json');
    assert.equal(missing.path, '/common/header.typ');
    return true;
  });
});

test('attachments are referenced from the data by path, and the same bytes share one', async () => {
  const files = createAttachments();
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#123456"/></svg>');
  const logo = files.add(svg, 'svg');
  assert.equal(logo, '/attachments/0.svg');
  assert.equal(files.add(svg, '.SVG'), logo);
  assert.equal(files.add(new Uint8Array(svg), 'svg'), '/attachments/1.svg');
  assert.deepEqual(Object.keys(files.assets), ['attachments/0.svg', 'attachments/1.svg']);
  assert.throws(() => files.add(svg, 'p/g'), /letters and digits/);
  assert.throws(() => createAttachments('../up'), /directory must be a relative path/);

  const logoTemplate = defineTemplate({
    files: { 'main.typ': `${helper}\n#let data = input(json.with("./input.schema.json"))\n#image(data.logo, width: 2cm)` },
    schema: required<{ logo: string }>('logo'),
    schemaPath: 'input.schema.json',
  });
  const result = await compiler.compile(logoTemplate({ logo }), { assets: files.assets });
  assert.ok(result.bytes.length > 1000);
  // Without the assets the path in the data names a missing file.
  await assert.rejects(compiler.compile(logoTemplate({ logo })), hasCode('COMPILATION'));
});
