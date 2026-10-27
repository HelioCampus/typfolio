// Writes every input of a benchmark set as a PDF with the TypeScript runtime, for validating the whole set
// (veraPDF takes a directory). Usage: node --experimental-strip-types write-all.mjs <doc-dir> <inputs.json> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime } from '../../ts/runtime.ts';

const [dir, inputsPath, out] = process.argv.slice(2);
if (!dir || !inputsPath || !out) { console.error('usage: write-all.mjs <doc-dir> <inputs.json> <out-dir>'); process.exit(2); }
const docJson = readFileSync(join(dir, 'doc.json'));
const listed = JSON.parse(docJson.toString());
const fonts = listed.fonts.map(f => new Uint8Array(readFileSync(join(dir, 'fonts', f.file))));
const runtime = await Runtime.create(new Uint8Array(docJson), fonts);
const inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));
mkdirSync(out, { recursive: true });
let bytes = 0;
const started = performance.now();
for (let i = 0; i < inputs.length; i++) {
  const { pdf } = await runtime.fill(inputs[i]);
  writeFileSync(join(out, `report-${String(i + 1).padStart(4, '0')}.pdf`), pdf);
  bytes += pdf.length;
}
console.log(`${inputs.length} PDFs, ${(bytes / 1e6).toFixed(1)} MB, written to ${out} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
