// One Typst: the compiler (`@typfolio/wasm`, crates/compiler) and the paramdoc exporter (`@typfolio/paramdoc-export`,
// experiments/paramdoc/export) are built from the same workspace, so the same template must give the same PDF bytes
// through either. This compiles each paramdoc fixture both ways, with no PDF standard, no timestamp and no clock (the
// exporter's plain mode), and fails on the first difference. experiments/paramdoc/check.sh runs it; it needs
// `npm run build` (the exporter's Node wrapper) and both wasm builds.
//
//   node tools/check-compiler-parity.ts [fixture...]
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import init, { Compiler } from '@typfolio/wasm';
import { createExporter } from '@typfolio/paramdoc-export';
import { readDirectory } from '@typfolio/paramdoc-export/node';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'experiments/paramdoc/fixtures');
const requested = process.argv.slice(2);
const names = requested.length ? requested : (await readdir(fixtures, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();

await init({ module_or_path: await readFile(join(root, 'packages/wasm/generated/compiler_bg.wasm')) });
const exporter = await createExporter(await readFile(join(root, 'packages/paramdoc-export/generated/paramdoc_export.wasm')));
const fonts = await readDirectory(join(root, 'fixtures/fonts'));
const compiler = new Compiler();
// The exporter takes every font file of the directory in sorted order; the compiler gets the same faces in the same order.
for (const [name, bytes] of fonts) if (/\.(otf|ttf|ttc|otc)$/i.test(name)) compiler.addFont(bytes);

let compared = 0;
for (const name of names) {
  const template = await readDirectory(join(fixtures, name));
  const data = template.get('data.json');
  if (!data || !template.has('main.typ')) continue;
  // Images arrive in the data as data URLs; the exporter rewrites them to files, which the compiler path does not do.
  if (new TextDecoder().decode(data).includes('data:image/')) { console.log(`skip   ${name} (images as data URLs)`); continue; }
  let exported: Uint8Array;
  try { exported = exporter.plainPdf({ template, data, fonts }).pdf; } catch (error) { console.log(`skip   ${name} (the exporter refuses it: ${(error as Error).message.split('\n')[0]})`); continue; }
  compiler.reset();
  for (const [path, bytes] of template) compiler.mount(`/${path}`, bytes);
  const compiled = compiler.compile('/main.typ', '{}');
  try {
    const pdf = compiled.takePdf();
    assert.ok(pdf, `${name}: the compiler produced no PDF: ${compiled.diagnostics}`);
    assert.ok(Buffer.from(exported).equals(Buffer.from(pdf)), `${name}: the exporter's PDF (${exported.length} bytes) and the compiler's (${pdf.length} bytes) differ`);
    console.log(`same   ${name} (${pdf.length} bytes)`);
    compared++;
  } finally { compiled.free(); compiler.reset(); }
}
compiler.free();
assert.ok(compared > 0, 'no fixture was compared');
console.log(`${compared} fixtures compile to the same bytes through the compiler and the exporter.`);
