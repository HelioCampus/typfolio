import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createAttachments,
  createCompiler,
  defineInput,
  definePartial,
  defineTemplate,
  TypstPdfError,
} from '../dist/index.js';
import type { ErrorCode, PdfCompiler, StandardSchemaV1, TemplateRequest } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;

// A Standard Schema without a schema library: `check` returns a message for invalid data.
function schema<T>(check: (value: T) => string | undefined, async = false): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => {
        const message = check(value as T);
        const result = message ? { issues: [{ message, path: ['title'] }] } : { value: value as T };
        return async ? Promise.resolve(result) : result;
      },
    },
  };
}

interface Header { institution: string }
interface Report { title: string }

const headerSource = [
  '#import "@local/typfolio:0.1.0": input',
  '#let settings = input(json.with("./header.schema.json"))',
  '#let standard-header(title) = [#settings.institution: #title]',
].join('\n');
const mainSource = [
  '#import "@local/typfolio:0.1.0": input',
  '#import "../common/header.typ": standard-header, settings',
  '#let data = input(json.with("./input.schema.json"))',
  '#set text(font: "Libertinus Serif")',
  '#set document(title: data.title + " / " + settings.institution)',
  '#standard-header(data.title)',
].join('\n');

const header = definePartial({
  files: { 'common/header.typ': headerSource },
  input: defineInput(schema<Header>(value => (value.institution ? undefined : 'institution is empty')), 'common/header.schema.json'),
});
const report = defineTemplate({
  entrypoint: 'template/main.typ',
  files: { 'template/main.typ': mainSource },
  input: defineInput(schema<Report>(value => (value.title ? undefined : 'title is empty')), 'template/input.schema.json'),
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

test('a template and its partial each read their own input, mounted at their schema paths', async () => {
  const request: TemplateRequest<typeof report> = {
    template: report,
    input: { title: 'Outcomes' },
    partials: { header: { institution: 'Example University' } },
  };
  const result = await compiler.compile(request);
  assert.equal(result.metadata.title, 'Outcomes / Example University');
  assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 5)), '%PDF-');
});

test('defineTemplate collects every partial file and input, nested ones included', () => {
  const badge = definePartial({
    files: { 'common/badge.typ': '#let badge = none' },
    input: defineInput(schema<{ color: string }>(() => undefined), 'common/badge.schema.json'),
  });
  const withBadge = definePartial({ ...header, partials: { badge } });
  const template = defineTemplate({ entrypoint: 'template/main.typ', files: { 'template/main.typ': mainSource }, partials: { header: withBadge, badge } });
  assert.deepEqual(Object.keys(template.files).sort(), ['common/badge.typ', 'common/header.typ', 'template/main.typ']);
  assert.deepEqual(template.inputs.map(slot => [slot.key, slot.path]), [
    ['header', 'common/header.schema.json'],
    ['badge', 'common/badge.schema.json'],
  ]);
  assert.ok(Object.isFrozen(template));
});

test('defineTemplate rejects partials that clash', async () => {
  const other = definePartial({ files: { 'common/header.typ': 'different' }, input: defineInput(schema(() => undefined), 'common/other.schema.json') });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, other } }), /common\/header\.typ is given twice/);
  const sameKey = definePartial({ files: {}, input: defineInput(schema(() => undefined), 'common/x.schema.json') });
  const nested = definePartial({ files: {}, input: defineInput(schema(() => undefined), 'common/y.schema.json'), partials: { header: sameKey } });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, nested } }), /two different partials are both named "header"/);
  const samePath = definePartial({ files: {}, input: defineInput(schema(() => undefined), 'common/header.schema.json') });
  assert.throws(() => defineTemplate({ files: { 'main.typ': '' }, partials: { header, samePath } }), /both read their input from common\/header\.schema\.json/);
  assert.throws(
    () => defineTemplate({ files: { 'main.typ': '', 'common/header.schema.json': '{}' }, partials: { header } }),
    /do not list the schema file in files/,
  );
  assert.throws(() => defineInput({} as StandardSchemaV1, 'a.schema.json'), /Standard Schema/);
  // Paths are checked when compiling: a definition only compares them.
  const outside = defineTemplate({ files: { 'main.typ': '' }, input: defineInput(schema(() => undefined), '../a.schema.json') });
  await assert.rejects(compiler.compile({ template: outside, input: {} }), (error: unknown) => hasCode('INVALID_REQUEST')(error) && /Ambiguous or traversing path/.test((error as Error).message));
  // A file whose name is no input path is not refused as one.
  assert.doesNotThrow(() => defineTemplate({ files: { 'main.typ': '', 'notes:draft.typ': '' }, partials: { header } }));
});

test('data that does not match its schema is rejected with INVALID_INPUT before compiling', async () => {
  await assert.rejects(
    compiler.compile({ template: report, input: { title: '' }, partials: { header: { institution: 'X' } } }),
    (error: unknown) => hasCode('INVALID_INPUT')(error) && /The template input does not match its schema \(template\/input\.schema\.json\):\n- title: title is empty/.test((error as Error).message),
  );
  await assert.rejects(
    compiler.compile({ template: report, input: { title: 'T' }, partials: { header: { institution: '' } } }),
    (error: unknown) => hasCode('INVALID_INPUT')(error) && /The data of partial "header" does not match/.test((error as Error).message),
  );
  const asyncTemplate = defineTemplate({
    files: { 'main.typ': '#import "@local/typfolio:0.1.0": input\n#let data = input(json.with("./input.schema.json"))\n#data.title' },
    input: defineInput(schema<Report>(value => (value.title ? undefined : 'title is empty'), true), 'input.schema.json'),
  });
  await assert.rejects(compiler.compile({ template: asyncTemplate, input: { title: '' } }), hasCode('INVALID_INPUT'));
  const ok = await compiler.compile({ template: asyncTemplate, input: { title: 'Async' } });
  assert.ok(ok.bytes.length > 1000);
});

test('missing or unknown partial data is an INVALID_REQUEST that names the partial', async () => {
  await assert.rejects(
    compiler.compile({ template: report, input: { title: 'T' } } as never),
    (error: unknown) => hasCode('INVALID_REQUEST')(error) && /Partial "header" reads its input from common\/header\.schema\.json, but the request has no partials\.header/.test((error as Error).message),
  );
  await assert.rejects(
    compiler.compile({ template: report, input: { title: 'T' }, partials: { header: { institution: 'X' }, footer: {} } } as never),
    (error: unknown) => hasCode('INVALID_REQUEST')(error) && /this template has no partial "footer"; it has "header"/.test((error as Error).message),
  );
});

test('a file the template imports but does not list fails with what to do', async () => {
  const forgetful = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource },
    input: defineInput(schema<Report>(() => undefined), 'template/input.schema.json'),
  });
  await assert.rejects(compiler.compile({ template: forgetful, input: { title: 'T' } }), (error: unknown) => {
    assert.ok(hasCode('COMPILATION')(error));
    const [missing] = (error as TypstPdfError).diagnostics.filter(d => d.code === 'file-not-found');
    assert.equal(missing.file, '/common/header.typ');
    assert.equal(missing.path, '/template/main.typ');
    assert.equal(missing.message, 'File not found: /common/header.typ (read by /template/main.typ). See https://github.com/HelioCampus/typfolio/blob/main/docs/errors.md#file-not-found');
    assert.match((error as Error).message, /^File not found: \/common\/header\.typ/);
    return true;
  });
  // The header's code is listed, but not as a partial: its input is not mounted.
  const codeOnly = defineTemplate({
    entrypoint: 'template/main.typ',
    files: { 'template/main.typ': mainSource, 'common/header.typ': headerSource },
    input: defineInput(schema<Report>(() => undefined), 'template/input.schema.json'),
  });
  await assert.rejects(compiler.compile({ template: codeOnly, input: { title: 'T' } }), (error: unknown) => {
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

  const logoTemplate = defineTemplate({
    files: { 'main.typ': '#import "@local/typfolio:0.1.0": input\n#let data = input(json.with("./input.schema.json"))\n#image(data.logo, width: 2cm)' },
    input: defineInput(schema<{ logo: string }>(() => undefined), 'input.schema.json'),
  });
  const result = await compiler.compile({ template: logoTemplate, input: { logo }, assets: files.assets });
  assert.ok(result.bytes.length > 1000);
});

test('plain requests keep reading /input.json', async () => {
  const result = await compiler.compile({
    template: '#import "@local/typfolio:0.1.0": input\n#let data = input(json.with("./input.schema.json"))\n#set document(title: data.title)\nx',
    input: { title: 'Plain' },
  });
  assert.equal(result.metadata.title, 'Plain');
});
