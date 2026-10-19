import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createLazyCompiler, TypstPdfError } from '../dist/index.js';
import type { ErrorCode, PdfRequest } from '../dist/index.js';

const root = new URL('../../../', import.meta.url);
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const request = (title: string): PdfRequest<{ title: string }> => ({
  template: '#set text(font: "Libertinus Serif")\n#let data = json("/input.json")\n#set document(title: data.title)\n#data.title',
  input: { title },
});

let wasm!: Buffer;
let font!: Buffer;
before(async () => {
  wasm = await readFile(new URL('packages/wasm/generated/compiler_bg.wasm', root));
  font = await readFile(new URL('fixtures/fonts/LibertinusSerif-Regular.otf', root));
});

// Fonts given as a URL go through the global fetch, so a stub sees every download the compiler makes.
function stubFetch(fail: number) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    if (calls.length <= fail) throw new TypeError('network down');
    return new Response(new Uint8Array(font));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('createLazyCompiler loads nothing until the first compile, then loads once', async () => {
  const fetched = stubFetch(0);
  try {
    const client = createLazyCompiler({ wasm, fonts: ['https://fonts.test/libertinus.otf'] });
    assert.deepEqual(fetched.calls, [], 'creating the client downloads nothing');
    const first = await client.compile(request('First'));
    const second = await client.compile(request('Second'));
    assert.equal(first.metadata.title, 'First');
    assert.equal(second.metadata.title, 'Second');
    assert.equal(fetched.calls.length, 1, 'the fonts are downloaded once');
    await client.dispose();
  } finally {
    fetched.restore();
  }
});

test('createLazyCompiler queues calls instead of reporting BUSY', async () => {
  const client = createLazyCompiler({ wasm, fonts: [font] });
  const results = await Promise.all(['A', 'B', 'C'].map(title => client.compile(request(title))));
  assert.deepEqual(results.map(result => result.metadata.title), ['A', 'B', 'C']);
  await client.dispose();
});

test('createLazyCompiler tries again after a failed load', async () => {
  const fetched = stubFetch(1);
  try {
    const client = createLazyCompiler({ wasm, fonts: ['https://fonts.test/libertinus.otf'] });
    await assert.rejects(client.compile(request('Offline')), hasCode('INITIALIZATION'));
    const result = await client.compile(request('Online'));
    assert.equal(result.metadata.title, 'Online');
    assert.equal(fetched.calls.length, 2);
    await client.dispose();
  } finally {
    fetched.restore();
  }
});

test('createLazyCompiler skips a call aborted before its turn, and refuses calls once disposed', async () => {
  const client = createLazyCompiler({ wasm, fonts: [font] });
  const controller = new AbortController();
  const running = client.compile(request('Runs'));
  const skipped = client.compile(request('Skipped'), { signal: controller.signal });
  controller.abort(new Error('closed'));
  assert.equal((await running).metadata.title, 'Runs');
  await assert.rejects(skipped, hasCode('ABORTED'));
  await client.dispose();
  await assert.rejects(client.compile(request('Late')), hasCode('DISPOSED'));
});

test('createLazyCompiler checks its fonts when it is created', () => {
  assert.throws(() => createLazyCompiler({ wasm, fonts: [] }), hasCode('INVALID_REQUEST'));
});
