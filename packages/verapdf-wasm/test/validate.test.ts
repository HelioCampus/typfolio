import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCompiler, defineTemplate } from '@typfolio/core';
import { createValidator, flavours, VerapdfError } from '../dist/index.js';
import type { Validator, VerapdfErrorCode } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();
const hasCode = (code: VerapdfErrorCode) => (error: unknown) => error instanceof VerapdfError && error.code === code;

// The binary is built by `npm run build:verapdf` (GraalVM, see docs/verapdf-build.md), which CI does not run yet.
// Without it there is nothing to test.
const binary = new URL('packages/verapdf-wasm/generated/verapdf.wasm', root);
const skip = existsSync(fileURLToPath(binary)) ? false : 'packages/verapdf-wasm/generated/verapdf.wasm is not built (npm run build:verapdf)';

let wasm!: Buffer;
let validator!: Validator;
let ua1!: Uint8Array;
let tagged!: Uint8Array;
before(async () => {
  if (skip) return;
  wasm = await file('packages/verapdf-wasm/generated/verapdf.wasm');
  validator = await createValidator({ wasm });
  const compiler = await createCompiler({
    wasm: await file('packages/wasm/generated/compiler_bg.wasm'),
    fonts: await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`))),
  });
  const template = defineTemplate({
    files: { 'main.typ': await text('fixtures/basic/main.typ'), 'partials/layout.typ': await text('fixtures/basic/partials/layout.typ') },
    schemaPath: 'input.json',
  });
  const request = template(JSON.parse(await text('fixtures/basic/input.json')));
  const assets = { 'assets/chart.svg': await file('fixtures/basic/chart.svg') };
  ua1 = (await compiler.compile(request, { assets, pdf: { standards: ['ua-1'], creationTimestamp: 1700000000 } })).bytes;
  tagged = (await compiler.compile(request, { assets, pdf: { creationTimestamp: 1700000000 } })).bytes;
});

test('a PDF/UA-1 compile passes ua1, and the report says what was checked', { skip }, () => {
  const report = validator.validate(ua1, { flavour: 'ua1' });
  assert.equal(report.flavour, 'ua1');
  assert.equal(report.compliant, true);
  assert.deepEqual(report.failedRules, []);
  assert.ok(report.totalAssertions > 100, `only ${report.totalAssertions} assertions`);
});

test('a tagged compile without the PDF/UA identifier fails ua1 with the rule that says so', { skip }, () => {
  const report = validator.validate(tagged, { flavour: 'ua1' });
  assert.equal(report.compliant, false);
  const identification = report.failedRules.find(rule => rule.clause === '5' && rule.test === 1);
  assert.ok(identification, `clause 5 test 1 not among ${report.failedRules.map(rule => `${rule.clause}-${rule.test}`).join(', ')}`);
  assert.equal(identification.specification, 'ISO 14289-1:2014');
  assert.equal(identification.failedChecks, 1);
  assert.match(identification.message, /PDF\/UA/);
  assert.notEqual(identification.context, '');
});

test('every listed flavour has a profile in the image', { skip }, () => {
  for (const flavour of flavours) {
    const report = validator.validate(ua1, { flavour });
    assert.equal(report.flavour, flavour);
    assert.ok(report.totalAssertions > 0, `${flavour} ran no checks`);
    if (flavour !== 'ua1') assert.equal(typeof report.compliant, 'boolean');
  }
});

test('the same input gives the same report, also from a second instance', { skip }, async () => {
  const first = validator.validate(tagged, { flavour: 'ua2' });
  assert.deepEqual(validator.validate(tagged, { flavour: 'ua2' }), first);
  const other = await createValidator({ wasm: await WebAssembly.compile(Uint8Array.from(wasm)) });
  assert.deepEqual(other.validate(tagged, { flavour: 'ua2' }), first);
});

test('a subarray is validated as its own bytes', { skip }, () => {
  const padded = new Uint8Array(ua1.length + 20);
  padded.set(ua1, 7);
  assert.deepEqual(validator.validate(padded.subarray(7, 7 + ua1.length), { flavour: 'ua1' }), validator.validate(ua1, { flavour: 'ua1' }));
});

test('wrong requests are refused before the image is asked', { skip }, async () => {
  assert.throws(() => validator.validate(ua1, { flavour: 'ua3' as never }), hasCode('INVALID_REQUEST'));
  assert.throws(() => validator.validate(ua1, undefined as never), hasCode('INVALID_REQUEST'));
  assert.throws(() => validator.validate('%PDF-1.7' as never, { flavour: 'ua1' }), hasCode('INVALID_REQUEST'));
  await assert.rejects(createValidator({} as never), hasCode('INVALID_REQUEST'));
  await assert.rejects(createValidator({ wasm: new Uint8Array([0, 1, 2, 3]) }), hasCode('INITIALIZATION'));
});

test('bytes that are not a PDF are a VALIDATION error, and the instance keeps working', { skip }, () => {
  assert.throws(() => validator.validate(new TextEncoder().encode('not a pdf'), { flavour: 'ua1' }), hasCode('VALIDATION'));
  assert.throws(() => validator.validate(new Uint8Array(0), { flavour: 'ua1' }), hasCode('VALIDATION'));
  assert.equal(validator.validate(ua1, { flavour: 'ua1' }).compliant, true);
});

test('the loader leaves no globals and constructs no code', { skip }, async () => {
  for (const name of ['GraalVM', 'verapdfValidate', 'typfolioVerapdfExport']) assert.equal(name in globalThis, false, `${name} is a global`);
  const loader = await text('packages/verapdf-wasm/generated/verapdf.js');
  assert.doesNotMatch(loader, /\bnew Function\(|\beval\(/);
  assert.doesNotMatch(loader, /import\.meta\.url|\.wasm['"`]/, 'the loader must not name a default binary location');
});
