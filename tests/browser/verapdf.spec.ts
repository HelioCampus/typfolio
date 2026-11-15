import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createCompiler, defineTemplate } from '@typfolio/core';
import { createValidator } from '../../packages/verapdf-wasm/dist/index.js';
import type { Flavour, ValidationReport, Validator } from '../../packages/verapdf-wasm/dist/index.js';

// veraPDF as WebAssembly in each browser engine: started in a module worker under a Content Security Policy without
// 'unsafe-eval', and compared with the same build in Node on PDFs compiled here.
const root = new URL('../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();
const page = 'http://127.0.0.1:4278/fixtures/browser/verapdf.html';

// The binary is built locally by `npm run build:verapdf`; without it there is nothing to test.
test.skip(!existsSync(fileURLToPath(new URL('packages/verapdf-wasm/generated/verapdf.wasm', root))), 'packages/verapdf-wasm/generated/verapdf.wasm is not built (npm run build:verapdf)');

interface PageResult { report?: ValidationReport; error?: { code: string; message: string }; ms: number }
interface PageApi { validate(bytes: number[], flavour: string): Promise<PageResult>; violations: string[]; workerGlobals: string[]; startMs: number; refusesEval: { page: boolean; worker: boolean } }

let reference!: Validator;
let ua1!: Uint8Array;
let tagged!: Uint8Array;
test.beforeAll(async () => {
  reference = await createValidator({ wasm: await file('packages/verapdf-wasm/generated/verapdf.wasm') });
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

test('veraPDF validates in a module worker under a CSP without unsafe-eval, with the same reports as in Node', async ({ page: tab }, testInfo) => {
  const messages: string[] = [];
  // The page probes that eval is refused, which browsers also log as an error.
  tab.on('console', message => { if (message.type() === 'error' && !/unsafe-eval|call to eval\(\)|EvalError/i.test(message.text())) messages.push(`console.error: ${message.text()}`); });
  tab.on('pageerror', error => messages.push(`pageerror: ${error.stack ?? error}`));
  await tab.goto(page);
  const result = tab.locator('#result');
  await expect(result).not.toHaveAttribute('data-status', 'running');
  expect(await result.getAttribute('data-status'), `${await result.textContent()}\n${messages.join('\n')}`).toBe('passed');

  const validate = (bytes: Uint8Array, flavour: string) =>
    tab.evaluate(([pdf, id]) => (globalThis as unknown as { verapdf: PageApi }).verapdf.validate(pdf as number[], id as string), [Array.from(bytes), flavour] as const);
  const timings: string[] = [];
  for (const [name, bytes] of [['ua1', ua1], ['tagged', tagged]] as const) {
    for (const flavour of ['ua1', 'ua2', '2b', 'wt1r'] satisfies Flavour[]) {
      const inPage = await validate(bytes, flavour);
      expect(inPage.error, `${name} as ${flavour}`).toBeUndefined();
      expect(inPage.report, `${name} as ${flavour}`).toEqual(reference.validate(bytes, { flavour }));
      timings.push(`${name} as ${flavour}: ${Math.round(inPage.ms)} ms`);
    }
  }
  expect((await validate(ua1, 'ua1')).report?.compliant).toBe(true);
  expect((await validate(tagged, 'ua1')).report?.compliant).toBe(false);
  // Errors cross the worker boundary with their code, and the instance keeps working.
  expect((await validate(new TextEncoder().encode('not a pdf'), 'ua1')).error?.code).toBe('VALIDATION');
  expect((await validate(ua1, 'ua3')).error?.code).toBe('INVALID_REQUEST');
  expect((await validate(ua1, 'ua1')).report?.compliant).toBe(true);

  const state = await tab.evaluate(() => {
    const api = (globalThis as unknown as { verapdf: PageApi }).verapdf;
    return { violations: api.violations, workerGlobals: api.workerGlobals, startMs: api.startMs, refusesEval: api.refusesEval };
  });
  // A policy that was not applied would make the test meaningless: constructing code must be refused in both realms.
  expect(state.refusesEval, 'the Content Security Policy is in force').toEqual({ page: true, worker: true });
  expect(state.violations, 'Content Security Policy violations').toEqual([]);
  expect(state.workerGlobals, 'globals added in the worker').toEqual([]);
  expect(messages, 'browser errors').toEqual([]);
  const summary = `validator ready in ${state.startMs} ms\n${timings.join('\n')}`;
  await testInfo.attach('timings', { body: summary, contentType: 'text/plain' });
  console.log(`[${testInfo.project.name}] ${summary.replaceAll('\n', '; ')}`);
});
