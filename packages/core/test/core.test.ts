import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCompiler, defineTemplate, pdfStandards, TypstPdfError } from '../dist/index.js';
import type { CompileOptions, ErrorCode, PdfClient, PdfCompiler, PdfDocument, PdfOptions } from '../dist/index.js';
import { prepareRequest, resolveDocument } from '../dist/internal.js';
import type { ResolvedRequest } from '../dist/internal.js';

// A fixture job: template files, their data, and the compile options, kept apart so tests can change one part.
interface Job<Input = unknown> {
  files: Record<string, string>;
  input: Input;
  assets?: Record<string, Uint8Array>;
  pdf?: PdfOptions;
}
type BasicJob = Job<{ title: string }> & { assets: Record<string, Uint8Array> };
type OutcomeSetsJob = Job<{ document: { title: string } }>;

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();
const output = new URL('.build/test-output/', root);
let compiler!: PdfCompiler;
let request!: BasicJob;
let outcomeSetsRequest!: OutcomeSetsJob;
let wasm!: Buffer;
let fonts!: Buffer[];
const timings: Record<string, number> = {};
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const failsWith = (code: ErrorCode, message: RegExp) => (error: unknown) => hasCode(code)(error) && message.test((error as Error).message);

// The fixtures read their data with json("/input.json"): schemaPath 'input.json' mounts it there.
const documentOf = (job: Job): PdfDocument => defineTemplate({ files: job.files, schemaPath: 'input.json' })(job.input);
const optionsOf = (job: Job): CompileOptions => ({ assets: job.assets, pdf: job.pdf });
const compile = (job: Job, options: CompileOptions = {}, client: PdfClient = compiler) =>
  client.compile(documentOf(job), { ...optionsOf(job), ...options });
// A template without data, from the source of its main.typ.
const bare = (source: string) => defineTemplate({ files: { 'main.typ': source } })();

before(async () => {
  await mkdir(output, { recursive: true });
  wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  fonts = await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`)));
  const start = performance.now();
  compiler = await createCompiler({ wasm, fonts });
  timings.initializeMs = performance.now() - start;
  request = {
    files: {
      'main.typ': await text('fixtures/basic/main.typ'),
      'partials/layout.typ': await text('fixtures/basic/partials/layout.typ'),
    },
    input: JSON.parse(await text('fixtures/basic/input.json')),
    assets: { 'assets/chart.svg': await file('fixtures/basic/chart.svg') },
    pdf: { standards: ['ua-1'], tags: true, creationTimestamp: 1700000000 },
  };
  outcomeSetsRequest = {
    files: {
      'main.typ': await text('fixtures/outcome-sets/main.typ'),
      'partials/report.typ': await text('fixtures/outcome-sets/partials/report.typ'),
    },
    input: JSON.parse(await text('fixtures/outcome-sets/input.json')),
    pdf: { standards: ['ua-1'], tags: true, creationTimestamp: 1700000000 },
  };
});
after(async () => {
  await compiler?.dispose();
  await writeFile(new URL('timings.json', output), JSON.stringify(timings, null, 2) + '\n');
});

test('compiles JSON, nested imports, fonts, SVG and a table to PDF/UA', async () => {
  const start = performance.now();
  const result = await compile(request);
  timings.firstCompileMs = performance.now() - start;
  assert.equal(result.metadata.title, request.input.title);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  await writeFile(new URL('ua.pdf', output), result.bytes);
  const warm = performance.now();
  await compile(request);
  timings.warmCompileMs = performance.now() - warm;
});

test('compiles a representative Outcome Sets document model', async () => {
  const result = await compile(outcomeSetsRequest);
  assert.equal(result.metadata.title, outcomeSetsRequest.input.document.title);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.bytes.length > 1000);
  await writeFile(new URL('outcome-sets.pdf', output), result.bytes);
});

test('PDF/UA rejects an image without alternative text', async () => {
  const source = request.files['main.typ'].replace(', alt: "A blue bar representing the completed outcome."', '');
  const withoutAlt = { ...request, files: { ...request.files, 'main.typ': source } };
  await assert.rejects(compile(withoutAlt), (error: TypstPdfError) => {
    assert.equal(error.code, 'COMPILATION');
    assert.match(error.message, /alt|alternative/i);
    return true;
  });
  // The same source can export without the UA constraint; policy must not leak.
  const normal = await compile({ ...withoutAlt, pdf: {} });
  assert.ok(normal.bytes.length > 1000);
});

test('a PDF standard\'s failure reads as its message and hint, one diagnostic per failure', async () => {
  // No loaded font draws these characters: PDF/UA-1 refuses each.
  const source = '#set text(font: "Libertinus Serif", lang: "en")\n#set document(title: "Glyphs")\nName: 王小';
  await assert.rejects(compiler.compile(bare(source), { pdf: { standards: ['ua-1'] } }), (error: TypstPdfError) => {
    assert.equal(error.code, 'COMPILATION');
    const failures = error.diagnostics.filter(d => d.severity === 'error');
    assert.deepEqual(failures.map(d => [d.code, d.text]), [['missing-glyph', '王'], ['missing-glyph', '小']]);
    assert.equal(failures[0].message, 'PDF/UA-1 error: the text `"王"` could not be displayed with font `"Libertinus Serif"`. See https://github.com/HelioCampus/typfolio/blob/main/docs/errors.md#missing-glyph');
    assert.equal(error.message, failures.map(d => d.message).join('\n'));
    assert.doesNotMatch(error.message, /SourceDiagnostic/);
    return true;
  });
});

test('JSON strings stay data and compile captures the data and assets before yielding', async () => {
  const mutated = structuredClone(request);
  const title = '#panic("must remain data") <script> & Turkish: İstanbul';
  mutated.input.title = title;
  const pending = compile(mutated);
  mutated.input.title = 'MUTATED';
  mutated.files['main.typ'] = '#panic("mutated source")';
  mutated.assets['assets/chart.svg'].fill(0);
  const result = await pending;
  assert.equal(result.metadata.title, title);
  await writeFile(new URL('snapshot.pdf', output), result.bytes);
});

test('copyAssets defaults to a defensive copy; false mounts the caller views and keeps validation', () => {
  const svg = request.assets['assets/chart.svg'];
  const resolved = resolveDocument(documentOf(request), optionsOf(request)).request;
  assert.notEqual(prepareRequest(resolved).files.get('/assets/chart.svg'), svg);
  assert.notEqual(prepareRequest(resolved, { copyAssets: true }).files.get('/assets/chart.svg'), svg);
  assert.deepEqual([...prepareRequest(resolved).files.get('/assets/chart.svg')!], [...svg]);
  assert.equal(prepareRequest(resolved, { copyAssets: false }).files.get('/assets/chart.svg'), svg);

  const own = { copyAssets: false };
  // @ts-expect-error an asset that is not a Uint8Array must be rejected at run time
  assert.throws(() => prepareRequest({ ...resolved, assets: { 'assets/a.bin': [1, 2] } }, own), failsWith('INVALID_REQUEST', /Asset assets\/a\.bin must be a Uint8Array/));
  // The data's path is taken like any other: an asset cannot replace it.
  assert.throws(() => prepareRequest({ ...resolved, assets: { '/input.json': svg } }, own), failsWith('INVALID_REQUEST', /Duplicate virtual path: \/input\.json/));
  assert.throws(() => prepareRequest({ ...resolved, assets: { '../a.bin': svg } }, own), hasCode('INVALID_REQUEST'));
  assert.throws(() => prepareRequest({ ...resolved, assets: { '@typfolio/a.bin': svg } }, own), hasCode('INVALID_REQUEST'));
  assert.throws(() => prepareRequest({ ...resolved, documents: { 'input.json': { value: () => 1 } } }, own), hasCode('INVALID_REQUEST'));
});

test('prepareRequest mounts each piece of data as JSON at its path and checks the template files', () => {
  const resolved: ResolvedRequest = { entrypoint: 'main.typ', files: { 'main.typ': 'x' }, documents: { 'input.json': { title: 'T' }, 'common/header.schema.json': ['a'] } };
  const prepared = prepareRequest(resolved);
  assert.equal(prepared.entrypoint, '/main.typ');
  assert.deepEqual([...prepared.files.keys()], ['/main.typ', '/input.json', '/common/header.schema.json']);
  const decoder = new TextDecoder();
  assert.equal(decoder.decode(prepared.files.get('/input.json')), '{"title":"T"}');
  assert.equal(decoder.decode(prepared.files.get('/common/header.schema.json')), '["a"]');
  assert.deepEqual(prepared.pdf, { pdf_standard: undefined, pdf_tags: true, creation_timestamp: undefined });

  assert.throws(() => prepareRequest({ ...resolved, entrypoint: 'other.typ' }), failsWith('INVALID_REQUEST', /The entrypoint \/other\.typ must be one of the template's files/));
  assert.throws(() => prepareRequest({ ...resolved, files: { 'main.typ': 'x', 'b.typ': 1 as unknown as string } }), failsWith('INVALID_REQUEST', /Template file b\.typ must be a string/));
  assert.throws(() => prepareRequest({ ...resolved, files: { 'main.typ': 'x', '/main.typ': 'y' } }), failsWith('INVALID_REQUEST', /Duplicate virtual path: \/main\.typ/));
  assert.throws(() => prepareRequest({ ...resolved, documents: { 'main.typ': {} } }), failsWith('INVALID_REQUEST', /Duplicate virtual path: \/main\.typ/));
  assert.throws(() => prepareRequest({ ...resolved, documents: { '@typfolio/input.json': {} } }), failsWith('INVALID_REQUEST', /reserved/));
  // The request shape of earlier releases is not read as this one.
  assert.throws(() => prepareRequest({ ...resolved, input: {} } as ResolvedRequest), hasCode('UNSUPPORTED_OPTION'));
});

test('a compiler created with copyAssets: false compiles the same bytes as the default', async () => {
  const own = await createCompiler({ wasm, fonts, copyAssets: false });
  try {
    const result = await compile(request, {}, own);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.bytes, (await compile(request)).bytes);
  } finally { await own.dispose(); }
});

test('files, data and export options are isolated across success and failure', async () => {
  await compile(request);
  await assert.rejects(compile({ ...request, assets: {} }), hasCode('COMPILATION'));
  await assert.rejects(compile({ ...request, input: {} }), hasCode('COMPILATION'));
  const normal = await compile({ ...request, pdf: { creationTimestamp: 1700000000 } });
  await writeFile(new URL('default.pdf', output), normal.bytes);
  const untagged = await compile({ ...request, pdf: { tags: false, creationTimestamp: 1700000000 } });
  await writeFile(new URL('untagged.pdf', output), untagged.bytes);
  const again = await compile(request);
  assert.deepEqual(again.bytes, (await compile(request)).bytes);
});

test('returns source diagnostics and keeps successful warnings', async () => {
  await assert.rejects(compiler.compile(bare('#let broken =')), (error: TypstPdfError) => {
    assert.equal(error.code, 'COMPILATION');
    // The default entrypoint is mounted as /main.typ.
    assert.ok(error.diagnostics.some(d => d.path === '/main.typ' && d.range));
    return true;
  });
  const nested = defineTemplate({ entrypoint: 'reports/main.typ', files: { 'reports/main.typ': '#let broken =' } });
  await assert.rejects(compiler.compile(nested()), (error: TypstPdfError) => {
    assert.equal(error.code, 'COMPILATION');
    assert.ok(error.diagnostics.some(d => d.path === '/reports/main.typ' && d.range));
    return true;
  });
  const source = request.files['main.typ'].replace('font: "Libertinus Serif"', 'font: ("Not A Real Test Font", "Libertinus Serif")');
  const result = await compile({ ...request, files: { ...request.files, 'main.typ': source } });
  assert.ok(result.diagnostics.some(d => d.severity === 'warning' && /font/i.test(d.message)));
});

test('a template\'s entrypoint defaults to main.typ and must be one of its files', async () => {
  const files = { 'main.typ': '#import "partials/title.typ": title\n#title', 'partials/title.typ': '#let title = json("/input.json").title' };
  const result = await compile({ files, input: { title: 'Default entrypoint' } });
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  const empty = await compiler.compile(bare(''));
  assert.equal(Buffer.from(empty.bytes.subarray(0, 5)).toString(), '%PDF-');
  await assert.rejects(
    compiler.compile(defineTemplate({ files: { 'other.typ': 'x' } })()),
    failsWith('INVALID_REQUEST', /The entrypoint \/main\.typ must be one of the template's files/),
  );
  await assert.rejects(
    compiler.compile(defineTemplate({ entrypoint: 'other.typ', files: { 'main.typ': 'x' } })()),
    failsWith('INVALID_REQUEST', /The entrypoint \/other\.typ must be one of the template's files/),
  );
  // A nested entrypoint, written with or without a leading slash.
  for (const entrypoint of ['reports/report.typ', '/reports/report.typ']) {
    const nested = await compiler.compile(defineTemplate({ entrypoint, files: { 'reports/report.typ': '#set document(title: "Nested")' } })());
    assert.equal(nested.metadata.title, 'Nested');
  }
});

test('each advertised single PDF standard reaches the exporter', async () => {
  for (const standard of pdfStandards) {
    const result = await compile({ ...request, pdf: { ...request.pdf, standards: [standard] } });
    await writeFile(new URL(`standard-${standard}.pdf`, output), result.bytes);
  }
});

test('rejects unsupported options, data path collisions and unsafe paths', async () => {
  // Options the types do not allow (unknown fields, a made-up standard, two standards); the cast keeps them reachable at run time.
  const unsupported = [{ pages: '1' }, { standards: ['ua-1', 'a-2b'] }, { standards: ['imaginary'] }, { features: ['a11y-extras'] }] as unknown as PdfOptions[];
  for (const pdf of unsupported) {
    await assert.rejects(compile({ ...request, pdf }), hasCode('UNSUPPORTED_OPTION'));
  }
  await assert.rejects(compile({ ...request, pdf: { standards: ['ua-1'], tags: false } }), hasCode('INVALID_REQUEST'));
  for (const name of ['../main.typ', 'nested/../main.typ', './main.typ', 'input.json/child.typ', 'bad\\path.typ']) {
    await assert.rejects(compile({ ...request, files: { ...request.files, [name]: '' } }), hasCode('INVALID_REQUEST'), name);
  }
  // The data is mounted at /input.json: a file listed there is refused when the template is defined.
  assert.throws(() => documentOf({ ...request, files: { ...request.files, 'input.json': '{}' } }), /input\.json is where data is read; do not list it in files/);
  await assert.rejects(compile({ ...request, assets: { 'input.json': new Uint8Array([1]) } }), failsWith('INVALID_REQUEST', /Duplicate virtual path: \/input\.json/));
  await assert.rejects(compile({ ...request, assets: { '/main.typ': new Uint8Array([1]) } }), failsWith('INVALID_REQUEST', /Duplicate virtual path: \/main\.typ/));
});

test('rejects non-JSON transport values without domain schema validation', async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [undefined, { a: undefined }, { a: NaN }, 1n, new Date(), cycle, [ , 1]]) {
    await assert.rejects(compile({ ...request, input }), hasCode('INVALID_REQUEST'));
  }
  await compile({ ...request, input: { ...request.input, additionalAppField: 'accepted' } });
});

test('rejects concurrent direct calls and respects cancellation before WASM execution', async () => {
  const pending = compile(request);
  await assert.rejects(compile(request), hasCode('BUSY'));
  await pending;
  const control = new AbortController();
  const cancelled = compile(request, { signal: control.signal });
  control.abort();
  await assert.rejects(cancelled, hasCode('ABORTED'));
  await assert.rejects(compile(request, { signal: control.signal }), hasCode('ABORTED'));
  await compile(request);
});

test('dispose waits for accepted work, is idempotent and closes the client', async () => {
  const own = await createCompiler({ wasm, fonts });
  const pending = compile(request, {}, own);
  const disposal = own.dispose();
  await assert.rejects(compile(request, {}, own), hasCode('DISPOSED'));
  assert.ok((await pending).bytes.length);
  await disposal;
  await own.dispose();
});
