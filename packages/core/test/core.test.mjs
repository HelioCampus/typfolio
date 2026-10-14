import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCompiler, pdfStandards, TypstPdfError } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const file = path => readFile(new URL(path, root));
const text = async path => (await file(path)).toString();
const output = new URL('.build/test-output/', root);
let compiler, request, outcomeSetsRequest, wasm, fonts;
const timings = {};
const hasCode = code => error => error instanceof TypstPdfError && error.code === code;
before(async () => {
  await mkdir(output, { recursive: true });
  wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  fonts = await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`)));
  const start = performance.now();
  compiler = await createCompiler({ wasm, fonts });
  timings.initializeMs = performance.now() - start;
  request = {
    template: { entrypoint: 'main.typ', files: {
      'main.typ': await text('fixtures/basic/main.typ'),
      'partials/layout.typ': await text('fixtures/basic/partials/layout.typ'),
    } },
    input: JSON.parse(await text('fixtures/basic/input.json')),
    assets: { 'assets/chart.svg': await file('fixtures/basic/chart.svg') },
    pdf: { standards: ['ua-1'], tags: true, creationTimestamp: 1700000000 },
  };
  outcomeSetsRequest = {
    template: { entrypoint: 'main.typ', files: {
      'main.typ': await text('fixtures/outcome-sets/main.typ'),
      'partials/report.typ': await text('fixtures/outcome-sets/partials/report.typ'),
    } },
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
  const result = await compiler.compile(request);
  timings.firstCompileMs = performance.now() - start;
  assert.equal(result.metadata.title, request.input.title);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  await writeFile(new URL('ua.pdf', output), result.bytes);
  const warm = performance.now();
  await compiler.compile(request);
  timings.warmCompileMs = performance.now() - warm;
});

test('compiles a representative Outcome Sets document model', async () => {
  const result = await compiler.compile(outcomeSetsRequest);
  assert.equal(result.metadata.title, outcomeSetsRequest.input.document.title);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.bytes.length > 1000);
  await writeFile(new URL('outcome-sets.pdf', output), result.bytes);
});

test('PDF/UA rejects an image without alternative text', async () => {
  const source = request.template.files['main.typ'].replace(', alt: "A blue bar representing the completed outcome."', '');
  await assert.rejects(compiler.compile({ ...request, template: { ...request.template, files: { ...request.template.files, 'main.typ': source } } }), error => {
    assert.equal(error.code, 'COMPILATION');
    assert.match(error.message, /alt|alternative/i);
    return true;
  });
  // The same source can export without the UA constraint; policy must not leak.
  const normal = await compiler.compile({ ...request, pdf: {}, template: { ...request.template, files: { ...request.template.files, 'main.typ': source } } });
  assert.ok(normal.bytes.length > 1000);
});

test('JSON strings stay data and requests capture caller input before yielding', async () => {
  const mutated = structuredClone(request);
  const title = '#panic("must remain data") <script> & Turkish: İstanbul';
  mutated.input.title = title;
  const pending = compiler.compile(mutated);
  mutated.input.title = 'MUTATED';
  mutated.template.files['main.typ'] = '#panic("mutated source")';
  mutated.assets['assets/chart.svg'].fill(0);
  const result = await pending;
  assert.equal(result.metadata.title, title);
  await writeFile(new URL('snapshot.pdf', output), result.bytes);
});

test('files, input and export options are isolated across success and failure', async () => {
  await compiler.compile(request);
  await assert.rejects(compiler.compile({ ...request, assets: {} }), hasCode('COMPILATION'));
  await assert.rejects(compiler.compile({ ...request, input: {} }), hasCode('COMPILATION'));
  const normal = await compiler.compile({ ...request, pdf: { creationTimestamp: 1700000000 } });
  await writeFile(new URL('default.pdf', output), normal.bytes);
  const untagged = await compiler.compile({ ...request, pdf: { tags: false, creationTimestamp: 1700000000 } });
  await writeFile(new URL('untagged.pdf', output), untagged.bytes);
  const again = await compiler.compile(request);
  assert.deepEqual(again.bytes, (await compiler.compile(request)).bytes);
});

test('returns source diagnostics and keeps successful warnings', async () => {
  const syntax = { ...request, template: { entrypoint: 'main.typ', files: { 'main.typ': '#let broken =' } } };
  await assert.rejects(compiler.compile(syntax), error => {
    assert.equal(error.code, 'COMPILATION');
    assert.ok(error.diagnostics.some(d => d.path?.includes('main.typ') && d.range));
    return true;
  });
  const source = request.template.files['main.typ'].replace('font: "Libertinus Serif"', 'font: ("Not A Real Test Font", "Libertinus Serif")');
  const result = await compiler.compile({ ...request, template: { ...request.template, files: { ...request.template.files, 'main.typ': source } } });
  assert.ok(result.diagnostics.some(d => d.severity === 'warning' && /font/i.test(d.message)));
});

const titleSource = '#let input = json("/input.json")\n#set text(font: "Libertinus Serif")\n#set document(title: input.title)\n= #input.title';

test('a string template is mounted as /main.typ and compiles', async () => {
  const result = await compiler.compile({ template: titleSource, input: { title: 'String template' } });
  assert.equal(result.metadata.title, 'String template');
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  const empty = await compiler.compile({ template: '', input: null });
  assert.equal(Buffer.from(empty.bytes.subarray(0, 5)).toString(), '%PDF-');
});

test('an object template without entrypoint defaults to main.typ', async () => {
  const files = { 'main.typ': '#import "partials/title.typ": title\n#title', 'partials/title.typ': '#let title = json("/input.json").title' };
  const result = await compiler.compile({ template: { files }, input: { title: 'Default entrypoint' } });
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  await assert.rejects(compiler.compile({ template: { files: { 'other.typ': 'x' } }, input: null }), error => {
    assert.ok(hasCode('INVALID_REQUEST')(error));
    assert.match(error.message, /entrypoint was omitted and defaulted to main\.typ/);
    return true;
  });
  // An explicit entrypoint keeps its original error.
  await assert.rejects(compiler.compile({ template: { entrypoint: 'other.typ', files: { 'main.typ': 'x' } }, input: null }), error => {
    assert.ok(hasCode('INVALID_REQUEST')(error));
    assert.match(error.message, /Entrypoint \/other\.typ must be a template file/);
    return true;
  });
});

test('a string template still obeys the normalised request rules', async () => {
  await assert.rejects(compiler.compile({ template: 'x', input: null, assets: { 'main.typ': new Uint8Array([1]) } }), error => {
    assert.ok(hasCode('INVALID_REQUEST')(error));
    assert.match(error.message, /Duplicate virtual path: \/main\.typ/);
    return true;
  });
  for (const template of [null, undefined, 1, true, ['x'], new Map(), new (class Template { files = {}; })()]) {
    await assert.rejects(compiler.compile({ template, input: null }), hasCode('INVALID_REQUEST'));
  }
});

test('a compile error in a string template reports /main.typ', async () => {
  await assert.rejects(compiler.compile({ template: '#let broken =', input: null }), error => {
    assert.equal(error.code, 'COMPILATION');
    assert.ok(error.diagnostics.some(d => d.path === '/main.typ' && d.range));
    return true;
  });
});

test('each advertised single PDF standard reaches the exporter', async () => {
  for (const standard of pdfStandards) {
    const result = await compiler.compile({ ...request, pdf: { ...request.pdf, standards: [standard] } });
    await writeFile(new URL(`standard-${standard}.pdf`, output), result.bytes);
  }
});

test('rejects unsupported options, reserved input collisions and unsafe paths', async () => {
  for (const pdf of [{ pages: '1' }, { standards: ['ua-1', 'a-2b'] }, { standards: ['imaginary'] }, { features: ['a11y-extras'] }]) {
    await assert.rejects(compiler.compile({ ...request, pdf }), hasCode('UNSUPPORTED_OPTION'));
  }
  await assert.rejects(compiler.compile({ ...request, pdf: { standards: ['ua-1'], tags: false } }), hasCode('INVALID_REQUEST'));
  for (const name of ['input.json', '../main.typ', 'nested/../main.typ', '/input.json/child.typ', 'bad\\path.typ']) {
    await assert.rejects(compiler.compile({ ...request, template: { ...request.template, files: { ...request.template.files, [name]: '' } } }), hasCode('INVALID_REQUEST'));
  }
  await assert.rejects(compiler.compile({ ...request, assets: { '/main.typ': new Uint8Array([1]) } }), hasCode('INVALID_REQUEST'));
});

test('rejects non-JSON transport values without domain schema validation', async () => {
  const cycle = {}; cycle.self = cycle;
  for (const input of [undefined, { a: undefined }, { a: NaN }, 1n, new Date(), cycle, [ , 1]]) {
    await assert.rejects(compiler.compile({ ...request, input }), hasCode('INVALID_REQUEST'));
  }
  await compiler.compile({ ...request, input: { ...request.input, additionalAppField: 'accepted' } });
});

test('rejects concurrent direct calls and respects cancellation before WASM execution', async () => {
  const pending = compiler.compile(request);
  await assert.rejects(compiler.compile(request), hasCode('BUSY'));
  await pending;
  const control = new AbortController();
  const cancelled = compiler.compile(request, { signal: control.signal });
  control.abort();
  await assert.rejects(cancelled, hasCode('ABORTED'));
  await assert.rejects(compiler.compile(request, { signal: control.signal }), hasCode('ABORTED'));
  await compiler.compile(request);
});

test('dispose waits for accepted work, is idempotent and closes the client', async () => {
  const own = await createCompiler({ wasm, fonts });
  const pending = own.compile(request);
  const disposal = own.dispose();
  await assert.rejects(own.compile(request), hasCode('DISPOSED'));
  assert.ok((await pending).bytes.length);
  await disposal;
  await own.dispose();
});
