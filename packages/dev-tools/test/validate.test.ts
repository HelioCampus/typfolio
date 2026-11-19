import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompiler, defineTemplate, TypstPdfError } from '@typfolio/core';
import type { ErrorCode } from '@typfolio/core';
import * as main from '../dist/index.js';
import * as validateModule from '../dist/validate.js';
import { createPdfValidator, formatValidationReport, pdfValidationFlavourIds, pdfValidationFlavours, validateDeclaredPdf, validatePdf } from '../dist/validate.js';

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;

// The validator's binary is built locally by `npm run build:verapdf` (docs/verapdf-build.md), not in CI.
const skip = existsSync(fileURLToPath(new URL('packages/verapdf-wasm/generated/verapdf.wasm', root))) ? false : 'packages/verapdf-wasm/generated/verapdf.wasm is not built (npm run build:verapdf)';

let ua1!: Uint8Array;
let tagged!: Uint8Array;
before(async () => {
  if (skip) return;
  const compiler = await createCompiler({
    wasm: await file('packages/typst-wasm/generated/compiler_bg.wasm'),
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
  compiler.dispose();
});

test('validatePdf finds the installed binary in Node: a PDF/UA-1 compile passes ua1, a plain tagged one fails it', { skip }, async () => {
  const pass = await validatePdf(ua1, { flavour: 'ua1' });
  assert.deepEqual({ flavour: pass.flavour, compliant: pass.compliant, failedRules: pass.failedRules }, { flavour: 'ua1', compliant: true, failedRules: [] });
  assert.ok(pass.totalAssertions > 100);
  const fail = await validatePdf(tagged, { flavour: 'ua1' });
  assert.equal(fail.compliant, false);
  assert.ok(fail.failedRules.some(rule => rule.specification === 'ISO 14289-1:2014' && rule.clause === '5' && rule.test === 1));
});

test('a validator of your own takes the binary you give it and gives the same reports', { skip }, async () => {
  const validator = await createPdfValidator({ wasm: await file('packages/verapdf-wasm/generated/verapdf.wasm') });
  assert.deepEqual(validator.validate(tagged, { flavour: 'ua2' }), await validatePdf(tagged, { flavour: 'ua2' }));
});

test('validateDeclaredPdf validates against what the file declares, and returns nothing for a file that declares nothing', { skip }, async () => {
  const [report, ...rest] = await validateDeclaredPdf(ua1);
  assert.deepEqual(rest, []);
  assert.deepEqual(report, await validatePdf(ua1, { flavour: 'ua1' }));
  assert.deepEqual(await validateDeclaredPdf(tagged), []);
  const validator = await createPdfValidator();
  assert.deepEqual(validator.detectFlavours(ua1), ['ua1']);
  assert.deepEqual(validator.detectFlavours(tagged), []);
  await assert.rejects(validateDeclaredPdf(new TextEncoder().encode('not a pdf')), hasCode('INVALID_REQUEST'));
});

test('wrong requests and unreadable files are TypstPdfErrors with core\'s codes', { skip }, async () => {
  await assert.rejects(validatePdf(ua1, { flavour: 'ua3' as never }), hasCode('INVALID_REQUEST'));
  await assert.rejects(validatePdf(new TextEncoder().encode('not a pdf'), { flavour: 'ua1' }), hasCode('INVALID_REQUEST'));
  await assert.rejects(validatePdf('%PDF' as never, { flavour: 'ua1' }), hasCode('INVALID_REQUEST'));
  await assert.rejects(createPdfValidator({ wasm: new Uint8Array([0, 1, 2]) }), hasCode('INITIALIZATION'));
  assert.equal((await validatePdf(ua1, { flavour: 'ua1' })).compliant, true);
});

test('every flavour has a name, in listing order, and a report formats as text', { skip }, async () => {
  assert.deepEqual([...pdfValidationFlavourIds].sort(), Object.keys(pdfValidationFlavours).sort());
  assert.deepEqual(pdfValidationFlavourIds.slice(0, 2), ['ua1', 'ua2']);
  for (const flavour of pdfValidationFlavourIds) assert.equal((await validatePdf(ua1, { flavour })).flavour, flavour);
  assert.match(formatValidationReport(await validatePdf(ua1, { flavour: 'ua1' }), 'a.pdf'), /^a\.pdf: PASS PDF\/UA-1 \(\d+ checks\)$/);
  const lines = formatValidationReport(await validatePdf(tagged, { flavour: 'ua1' })).split('\n');
  assert.match(lines[0]!, /^FAIL PDF\/UA-1: \d+ rules?, \d+ of \d+ checks$/);
  const at = lines.findIndex(line => /^  ISO 14289-1:2014 5, test 1 \(1x\) \[metadata\]: .*PDF\/UA/.test(line));
  assert.ok(at > 0, lines.join('\n'));
  // Under the rule, what was wrong and where.
  assert.equal(lines[at + 1], '    The document metadata stream doesn\'t contain PDF/UA Identification Schema');
  assert.match(lines[at + 2]!, /^      at root\/document\[0\]\/metadata\[0\]/);
  // A rule that failed more often than it lists says how many are left out; the count is exact.
  const short = await validatePdf(tagged, { flavour: '1b', maxChecksPerRule: 1 });
  const repeated = short.failedRules.find(rule => rule.failedChecks > 1)!;
  assert.equal(repeated.checks.length, 1);
  assert.ok(formatValidationReport(short).includes(`    … and ${repeated.failedChecks - 1} more`));
});

test('a report\'s veraPDF messages are printed with it, and a pass with messages says so', () => {
  const profile = { name: 'P', description: 'D', rules: 1 };
  const logs = [{ level: 'WARNING' as const, message: 'Error while parsing content stream', occurrences: 2 }, { level: 'SEVERE' as const, message: 'Broken', occurrences: 1 }];
  assert.equal(formatValidationReport({ flavour: 'ua1', compliant: true, totalAssertions: 4, profile, failedRules: [], logs }, 'a.pdf'),
    'a.pdf: PASS PDF/UA-1 (4 checks), with 2 veraPDF messages\n  WARNING (2x): Error while parsing content stream\n  SEVERE: Broken');
  assert.equal(formatValidationReport({ flavour: 'ua1', compliant: true, totalAssertions: 4, profile, failedRules: [], logs: [] }), 'PASS PDF/UA-1 (4 checks)');
});

test('the main entry does not carry the validation exports', () => {
  for (const name of Object.keys(validateModule)) assert.equal(name in main, false, `${name} leaked into the main entry`);
});

const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
  execFile(process.execPath, [fileURLToPath(new URL('packages/dev-tools/dist/validate-cli.js', root)), ...args], (error, stdout, stderr) =>
    resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
});

test('typfolio-validate prints a report per file and exits 0, 1 or 2', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typfolio-validate-'));
  try {
    const good = join(directory, 'good.pdf');
    const bad = join(directory, 'bad.pdf');
    const junk = join(directory, 'junk.pdf');
    await Promise.all([writeFile(good, ua1), writeFile(bad, tagged), writeFile(junk, 'not a pdf')]);

    const passes = await cli(good);
    assert.deepEqual({ code: passes.code, stderr: passes.stderr }, { code: 0, stderr: '' });
    assert.match(passes.stdout, /good\.pdf: PASS PDF\/UA-1 \(\d+ checks\)\n$/);

    const fails = await cli('--flavour', 'ua1', good, bad);
    assert.equal(fails.code, 1);
    assert.match(fails.stdout, /good\.pdf: PASS/);
    assert.match(fails.stdout, /bad\.pdf: FAIL PDF\/UA-1: \d+ rules?/);

    const json = await cli('--format=json', '-f', 'ua2', bad);
    assert.equal(json.code, 1);
    const [entry] = JSON.parse(json.stdout);
    assert.deepEqual({ file: entry.file, flavour: entry.flavour, compliant: entry.compliant }, { file: bad, flavour: 'ua2', compliant: false });
    assert.ok(entry.failedRules.length > 0);
    assert.equal(entry.profile.rules > 100, true);
    assert.ok(entry.failedRules.every((rule: { checks: unknown[]; tags: unknown[] }) => rule.checks.length >= 1 && Array.isArray(rule.tags)));

    // --max-checks limits what is listed, in text and in JSON.
    const limited = JSON.parse((await cli('--format', 'json', '--max-checks', '1', '-f', '1b', bad)).stdout)[0];
    assert.ok(limited.failedRules.every((rule: { checks: unknown[] }) => rule.checks.length === 1));
    assert.ok(limited.failedRules.some((rule: { failedChecks: number }) => rule.failedChecks > 1));
    assert.equal((await cli('--max-checks', '0', bad)).code, 2);

    // --flavour auto: each file against what it declares; one that declares nothing was not validated.
    const auto = await cli('--flavour', 'auto', good);
    assert.equal(auto.code, 0);
    assert.match(auto.stdout, /good\.pdf: PASS PDF\/UA-1 /);
    const undeclared = await cli('-f', 'auto', good, bad);
    assert.equal(undeclared.code, 2);
    assert.match(undeclared.stdout, /bad\.pdf: ERROR the file declares no standard in its metadata; name one with --flavour/);

    const unreadable = await cli(good, junk);
    assert.equal(unreadable.code, 2);
    assert.match(unreadable.stdout, /junk\.pdf: ERROR /);
    assert.match(unreadable.stdout, /good\.pdf: PASS/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('typfolio-validate refuses wrong usage with status 2 and explains itself', async () => {
  const unknown = await cli('-f', 'ua9', 'a.pdf');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown flavour "ua9"; the flavours are auto, ua1, ua2, /);
  assert.equal((await cli()).code, 2);
  assert.equal((await cli('--format', 'xml', 'a.pdf')).code, 2);
  assert.equal((await cli('--nope')).code, 2);
  const help = await cli('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: typfolio-validate/);
  assert.match(help.stdout, /ua1 +PDF\/UA-1/);
});
