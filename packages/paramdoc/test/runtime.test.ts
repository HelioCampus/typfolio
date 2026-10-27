// The public API over the checked-in report document (experiments/paramdoc/documents/report, exported natively
// and compared with a fresh export by the experiment's check.sh). The layout proof against Typst and the Rust
// runtime lives in that check; these tests cover the API's contract: what is accepted, what is refused and how.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRuntime, IR_VERSION, ParamdocError } from '../dist/index.js';
import { compare, Runtime } from '../dist/internal.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const report = `${root}experiments/paramdoc/documents/report/`;

async function reportInput() {
  const document = await readFile(`${report}doc.json`);
  const listed = JSON.parse(document.toString()) as { fonts: { file: string }[] };
  const fonts = await Promise.all(listed.fonts.map(f => readFile(`${report}fonts/${f.file}`)));
  return { document: new Uint8Array(document), fonts: fonts.map(f => new Uint8Array(f)) };
}

const data = async () => JSON.parse(await readFile(`${root}experiments/paramdoc/fixtures/report/data.json`, 'utf8')) as Record<string, unknown>;

test('fills the report and writes a tagged PDF, the same bytes every time', async () => {
  const runtime = await createRuntime(await reportInput());
  assert.equal(runtime.version, IR_VERSION);
  assert.equal(runtime.document.version, IR_VERSION);
  assert.ok(runtime.names.includes('comment') && runtime.names.includes('courses'), `names: ${runtime.names.join(', ')}`);
  const first = await runtime.fill(await data());
  const second = await runtime.fill(await data());
  assert.equal(first.pages, 1);
  assert.equal(Buffer.from(first.pdf.subarray(0, 8)).toString(), '%PDF-1.7');
  assert.ok(Buffer.from(first.pdf).includes('<pdfuaid:part>1</pdfuaid:part>'), 'declares PDF/UA-1');
  assert.deepEqual(Buffer.from(first.pdf), Buffer.from(second.pdf));
});

test('refuses data it cannot lay out as Typst would, naming the slot and the fix', async () => {
  const runtime = await createRuntime(await reportInput());
  const bad = { ...(await data()), average: 97.5 };
  await assert.rejects(runtime.fill(bad), (error: unknown) => error instanceof ParamdocError && error.code === 'fill' && /97.5 is not an integer/.test(error.message));
  const foreign = { ...(await data()), comment: 'Arabic: مرحبا' };
  await assert.rejects(runtime.fill(foreign), (error: unknown) => error instanceof ParamdocError && error.code === 'fill' && /not in the slot's repertoire/.test(error.message));
});

test('refuses a document whose fonts or version are not its own', async () => {
  const input = await reportInput();
  const swapped = { ...input, fonts: [...input.fonts].reverse() };
  await assert.rejects(createRuntime(swapped), (error: unknown) => error instanceof ParamdocError && error.code === 'document' && /sha256/.test(error.message));
  const old = { ...input, document: Buffer.from(input.document).toString().replace(`"version": ${IR_VERSION}`, '"version": 1') };
  await assert.rejects(createRuntime(old), (error: unknown) => error instanceof ParamdocError && error.code === 'document' && /IR version 1/.test(error.message));
});

test('the internal runtime traces what it drew and compares it with a reference', async () => {
  const input = await reportInput();
  const runtime = await Runtime.create(input.document, [...input.fonts]);
  const output = await runtime.fill(await data());
  assert.ok(output.trace.some(s => s.name === 'comment' && s.glyphs.length > 0));
  assert.deepEqual(compare(output.trace, output.trace), []);
  const moved = output.trace.map(s => ({ ...s, glyphs: s.glyphs.map(g => ({ ...g, x: g.x + 1 })) }));
  assert.ok(compare(output.trace, moved).length > 0);
});
