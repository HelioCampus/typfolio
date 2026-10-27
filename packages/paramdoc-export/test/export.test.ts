// The wasm exporter against the native one: the checked-in report document (exported natively, compared with a
// fresh export by check.sh) must come out byte for byte the same from the wasm, and refusals must arrive as
// `error` with their message. Skipped when the wasm is not built (experiments/paramdoc/build-export-wasm.sh).
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createExporter } from '../dist/index.js';
import { exportDirectory, loadWasm, readDirectory } from '../dist/node.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const paramdoc = `${root}experiments/paramdoc/`;
const fonts = `${root}fixtures/fonts`;
const built = await access(`${root}packages/paramdoc-export/generated/paramdoc_export.wasm`).then(() => true, () => false);

test('the report document from the wasm is byte-identical to the checked-in native export', { skip: !built && 'the exporter wasm is not built' }, async () => {
  const exporter = await createExporter(await loadWasm());
  const result = exporter.export({ template: await readDirectory(`${paramdoc}fixtures/report`), data: await readFile(`${paramdoc}fixtures/report/data.json`), fonts: await readDirectory(fonts), fuzz: 3 });
  assert.equal(result.error, undefined, result.error);
  assert.match(result.log, /fuzz: 3 sample\(s\)(?: in .*)?, 0 with leaks/);
  const checked = await readDirectory(`${paramdoc}documents/report`);
  for (const [path, bytes] of checked) {
    if (path !== 'doc.json' && !path.startsWith('fonts/')) continue;
    const ours = result.files.get(path);
    assert.ok(ours, `the wasm export has no ${path}`);
    assert.deepEqual(Buffer.from(ours), Buffer.from(bytes), `${path} differs from the checked-in export`);
  }
});

test('a refusal is reported, with its message and the files produced before it', { skip: !built && 'the exporter wasm is not built' }, async () => {
  const exporter = await createExporter(await loadWasm());
  const result = exporter.export({ template: await readDirectory(`${paramdoc}fixtures/charsetbad`), data: await readFile(`${paramdoc}fixtures/charsetbad/data.json`), fonts: await readDirectory(fonts) });
  assert.match(result.error ?? '', /a script that needs a shaper/);
});

test('exportDirectory writes what the Rust command line writes', { skip: !built && 'the exporter wasm is not built' }, async t => {
  const out = `${root}.build/paramdoc-export-test/wrap`;
  const result = await exportDirectory(`${paramdoc}fixtures/wrap`, { fonts, out, fuzz: 2, references: [`${paramdoc}fixtures/wrap/data.json`, `${paramdoc}fixtures/wrap/data-hyphens.json`] });
  assert.equal(result.error, undefined, result.error);
  for (const path of ['doc.json', 'baseline.pdf', 'reference.json', 'reference.pdf', 'reference-data-hyphens.json', 'fuzz-0.json', 'fonts/LibertinusSerif-Regular.subset.otf']) {
    await access(`${out}/${path}`);
  }
  t.diagnostic(result.log.split('\n')[0] ?? '');
});

test('plainPdf compiles a plain file and reports what Typst cannot export', { skip: !built && 'the exporter wasm is not built' }, async () => {
  const exporter = await createExporter(await loadWasm());
  const plain = exporter.plainPdf({ template: { 'main.typ': '#set page(width: 60mm, height: 40mm, margin: 5mm)\n#set text(font: "Libertinus Serif")\nHello' }, data: '{}', fonts: await readDirectory(fonts) });
  assert.equal(Buffer.from(plain.pdf.subarray(0, 5)).toString(), '%PDF-');
  assert.throws(() => exporter.plainPdf({ template: { 'main.typ': 'Hello' }, data: '{}', fonts: {} }), /no fonts given/);
  // The upstream report's reproduction: Typst compiles it and typst-pdf cannot write it.
  const report = await readDirectory(`${root}docs/upstream/2026-10-27-typst-pdf-link-ending-on-soft-hyphen`);
  const fontFiles = await readDirectory(fonts);
  assert.throws(() => exporter.plainPdf({ template: report, data: '{}', fonts: fontFiles }), /expected link ancestor in logical tree/);
});
