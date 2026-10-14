import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCompiler, templateFromFiles, TypstPdfError } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const file = path => readFile(new URL(path, root));
const invalid = error => error instanceof TypstPdfError && error.code === 'INVALID_REQUEST';
let compiler;
before(async () => {
  compiler = await createCompiler({
    wasm: await file('packages/wasm/generated/compiler_bg.wasm'),
    fonts: [await file('fixtures/fonts/LibertinusSerif-Regular.otf')],
  });
});
after(() => compiler?.dispose());

test('strips the shared directory prefix and keeps nested paths', () => {
  assert.deepEqual(templateFromFiles({
    './report/main.typ': 'main',
    './report/partials/layout.typ': 'layout',
  }), { files: { 'main.typ': 'main', 'partials/layout.typ': 'layout' } });
  assert.deepEqual(templateFromFiles({ '/src/a/b/main.typ': 'x', '/src/a/b/c/d.typ': 'y', '/src/a/b/c/e/f.typ': 'z' }),
    { files: { 'main.typ': 'x', 'c/d.typ': 'y', 'c/e/f.typ': 'z' } });
  // Files that already sit at the root share no prefix.
  assert.deepEqual(templateFromFiles({ './main.typ': 'x', './partials/p.typ': 'y' }),
    { files: { 'main.typ': 'x', 'partials/p.typ': 'y' } });
  // A shared prefix is a directory prefix, not a string prefix.
  assert.deepEqual(templateFromFiles({ './report/main.typ': 'x', './report-extra/p.typ': 'y' }),
    { files: { 'report/main.typ': 'x', 'report-extra/p.typ': 'y' } });
});

test('a single file loses its whole directory', () => {
  assert.deepEqual(templateFromFiles({ './report/main.typ': 'x' }), { files: { 'main.typ': 'x' } });
  assert.deepEqual(templateFromFiles({ '../shared/report/main.typ': 'x' }), { files: { 'main.typ': 'x' } });
  assert.deepEqual(templateFromFiles({ 'main.typ': 'x' }), { files: { 'main.typ': 'x' } });
});

test('an explicit base is stripped even when it is not the shared prefix', () => {
  const files = { './src/report/main.typ': 'x', './src/report/partials/p.typ': 'y' };
  assert.deepEqual(templateFromFiles(files, { base: './src' }).files, { 'report/main.typ': 'x', 'report/partials/p.typ': 'y' });
  assert.deepEqual(templateFromFiles(files, { base: '/src/report/' }).files, { 'main.typ': 'x', 'partials/p.typ': 'y' });
  assert.deepEqual(templateFromFiles({ './main.typ': 'x' }, { base: '.' }).files, { 'main.typ': 'x' });
});

test('entrypoint is passed through only when given', () => {
  assert.ok(!('entrypoint' in templateFromFiles({ './a/main.typ': 'x' })));
  assert.ok(!('entrypoint' in templateFromFiles({ './a/main.typ': 'x' }, { base: './a' })));
  assert.equal(templateFromFiles({ './a/report.typ': 'x' }, { entrypoint: 'report.typ' }).entrypoint, 'report.typ');
});

test('rejects an empty record, bad keys and non-string values', () => {
  assert.throws(() => templateFromFiles({}), invalid);
  assert.throws(() => templateFromFiles(undefined), invalid);
  assert.throws(() => templateFromFiles(['x']), invalid);
  assert.throws(() => templateFromFiles({ './a/main.typ': 'x', './b/p.typ': 'y' }, { base: './a' }), error =>
    invalid(error) && /\.\/b\/p\.typ is not under base/.test(error.message));
  // A file named like the base is not under it.
  assert.throws(() => templateFromFiles({ './a': 'x' }, { base: './a' }), invalid);
  assert.throws(() => templateFromFiles({ './a/main.typ': 'x', '/a/main.typ': 'y' }), error =>
    invalid(error) && /collide on main\.typ/.test(error.message));
  assert.throws(() => templateFromFiles({ './main.typ': 'x', 'main.typ': 'y' }), invalid);
});

test('a non-string value hints at the glob options', () => {
  for (const value of [() => Promise.resolve('x'), { default: 'x' }, null, 1]) {
    assert.throws(() => templateFromFiles({ './a/main.typ': value }), error => {
      assert.ok(invalid(error));
      assert.match(error.message, /\.\/a\/main\.typ/);
      assert.match(error.message, /query: '\?raw', import: 'default', eager: true/);
      return true;
    });
  }
});

test('does not duplicate request validation', async () => {
  // These shapes are accepted by the loader and rejected by the compiler's own rules.
  const missing = templateFromFiles({ './a/other.typ': 'x' });
  await assert.rejects(compiler.compile({ template: missing, input: null }), error =>
    invalid(error) && /defaulted to main\.typ/.test(error.message));
  const reserved = templateFromFiles({ './a/main.typ': 'x', './a/input.json': '{}' });
  await assert.rejects(compiler.compile({ template: reserved, input: null }), error =>
    invalid(error) && /input\.json is reserved/.test(error.message));
});

test('a multi-file template built with the loader compiles with relative json("input.json")', async () => {
  const template = templateFromFiles({
    './report/main.typ': [
      '#import "partials/layout.typ": heading-block',
      '#let input = json("input.json")',
      '#set text(font: "Libertinus Serif")',
      '#set document(title: input.title)',
      '#heading-block(input)',
    ].join('\n'),
    './report/partials/layout.typ': '#let heading-block(input) = [= #input.title]',
  });
  assert.deepEqual(Object.keys(template.files).sort(), ['main.typ', 'partials/layout.typ']);
  const result = await compiler.compile({ template, input: { title: 'Loaded from files' } });
  assert.equal(result.metadata.title, 'Loaded from files');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  // A sample input.json beside the template is not part of the glob and never reaches the compiler.
  const custom = templateFromFiles({ './x/report.typ': '#let input = json("input.json")\n#set document(title: input.title)\n= #input.title' }, { entrypoint: 'report.typ' });
  const second = await compiler.compile({ template: custom, input: { title: 'Custom entrypoint' } });
  assert.equal(second.metadata.title, 'Custom entrypoint');
});
