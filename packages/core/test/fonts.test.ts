import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCompiler, TypstPdfError } from '../dist/index.js';
import type { CompilerOptions, ErrorCode, PdfCompiler, PdfRequest } from '../dist/index.js';
import { resolveFonts } from '../dist/internal.js';

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const faces = (pdf: Uint8Array) => new Set(Buffer.from(pdf).toString('latin1').match(/LibertinusSerif-[A-Za-z]+/g));
const boldTemplate = '#set text(font: "Libertinus Serif")\nPlain and *strong*';

interface Route {
  status?: number;
  body: Buffer;
  delayMs?: number;
}

let server!: Server;
let origin!: string;
let wasm!: Buffer;
let regular!: Buffer;
let bold!: Buffer;
let basic!: PdfRequest<{ title: string }>;
const hits = new Map<string | undefined, number>();
// Responses to /slow-regular.otf are delayed, so the order in which downloads finish differs from the order of the fonts.
const routes: Record<string, () => Route> = {
  '/regular.otf': () => ({ body: regular }),
  '/bold.otf': () => ({ body: bold }),
  '/slow-regular.otf': () => ({ body: regular, delayMs: 80 }),
  '/empty.otf': () => ({ body: Buffer.alloc(0) }),
  '/missing.otf': () => ({ status: 404, body: Buffer.from('not here') }),
};

before(async () => {
  [wasm, regular, bold] = await Promise.all([
    file('packages/wasm/generated/compiler_bg.wasm'),
    file('fixtures/fonts/LibertinusSerif-Regular.otf'),
    file('fixtures/fonts/LibertinusSerif-Bold.otf'),
  ]);
  basic = {
    template: { entrypoint: 'main.typ', files: {
      'main.typ': (await file('fixtures/basic/main.typ')).toString(),
      'partials/layout.typ': (await file('fixtures/basic/partials/layout.typ')).toString(),
    } },
    input: JSON.parse((await file('fixtures/basic/input.json')).toString()),
    assets: { 'assets/chart.svg': await file('fixtures/basic/chart.svg') },
    pdf: { standards: ['ua-1'], tags: true, creationTimestamp: 1700000000 },
  };
  server = createServer((request, response) => {
    hits.set(request.url, (hits.get(request.url) ?? 0) + 1);
    const route = routes[request.url!];
    const { status = 200, body, delayMs = 0 } = route?.() ?? { status: 404, body: Buffer.alloc(0) };
    setTimeout(() => response.writeHead(status, { 'content-length': body.length }).end(body), delayMs);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

async function withCompiler<Result>(options: Pick<CompilerOptions, 'fonts'>, run: (compiler: PdfCompiler) => Promise<Result>) {
  const compiler = await createCompiler({ wasm, ...options });
  try { return await run(compiler); } finally { await compiler.dispose(); }
}

test('a URL font is fetched while the compiler is created and compiles the basic fixture', async () => {
  await withCompiler({ fonts: [new URL('/regular.otf', origin)] }, async compiler => {
    const result = await compiler.compile(basic);
    assert.equal(result.metadata.title, basic.input.title);
    assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  });
});

test('an absolute string is fetched like a URL', async () => {
  await withCompiler({ fonts: [`${origin}/regular.otf`] }, async compiler => {
    assert.ok(faces((await compiler.compile({ template: boldTemplate, input: null })).bytes).has('LibertinusSerif-Regular'));
  });
});

test('bytes and URL fonts mix, and the second font is the one the document uses', async () => {
  await withCompiler({ fonts: [regular, new URL('/bold.otf', origin)] }, async compiler => {
    const used = faces((await compiler.compile({ template: boldTemplate, input: null })).bytes);
    assert.ok(used.has('LibertinusSerif-Regular'), 'the bytes font');
    assert.ok(used.has('LibertinusSerif-Bold'), 'the URL font');
  });
  await withCompiler({ fonts: [new URL('/slow-regular.otf', origin), bold] }, async compiler => {
    const used = faces((await compiler.compile({ template: boldTemplate, input: null })).bytes);
    assert.ok(used.has('LibertinusSerif-Regular') && used.has('LibertinusSerif-Bold'));
  });
});

test('fonts keep their order whichever download finishes first', async () => {
  const copy = new Uint8Array(bold);
  const resolved = await resolveFonts([new URL('/slow-regular.otf', origin), `${origin}/bold.otf`, copy]);
  assert.equal(resolved.length, 3);
  assert.ok(Buffer.from(resolved[0]).equals(regular), 'the slow download stays first');
  assert.ok(Buffer.from(resolved[1]).equals(bold));
  assert.ok(Buffer.from(resolved[2]).equals(bold));
  assert.notEqual(resolved[2], copy, 'bytes are copied');
});

test('URL fonts download concurrently', async () => {
  const start = performance.now();
  await resolveFonts(Array.from({ length: 4 }, () => new URL('/slow-regular.otf', origin)));
  assert.ok(performance.now() - start < 80 * 3, 'four 80 ms downloads must overlap');
});

test('a font fetched at creation is not fetched again by compile', async () => {
  const path = '/regular.otf';
  const before = hits.get(path) ?? 0;
  await withCompiler({ fonts: [new URL(path, origin)] }, async compiler => {
    assert.equal(hits.get(path), before + 1);
    await compiler.compile({ template: boldTemplate, input: null });
    await compiler.compile(basic);
    assert.equal(hits.get(path), before + 1);
  });
});

test('a non-OK response rejects with INITIALIZATION naming the URL and status', async () => {
  const url = new URL('/missing.otf', origin);
  await assert.rejects(createCompiler({ wasm, fonts: [regular, url] }), (error: TypstPdfError) => {
    assert.ok(hasCode('INITIALIZATION')(error));
    assert.ok(error.message.includes(url.href), error.message);
    assert.match(error.message, /404/);
    return true;
  });
});

test('an empty body rejects with INITIALIZATION naming the URL', async () => {
  const url = new URL('/empty.otf', origin);
  await assert.rejects(createCompiler({ wasm, fonts: [url] }), (error: TypstPdfError) => {
    assert.ok(hasCode('INITIALIZATION')(error));
    assert.ok(error.message.includes(url.href), error.message);
    assert.match(error.message, /empty/);
    return true;
  });
});

test('a network error rejects with INITIALIZATION and keeps the original error as the cause', async () => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const url = new URL('/font.otf', `http://127.0.0.1:${(closed.address() as AddressInfo).port}`);
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(createCompiler({ wasm, fonts: [url] }), (error: TypstPdfError) => {
    assert.ok(hasCode('INITIALIZATION')(error));
    assert.ok(error.message.includes(url.href), error.message);
    assert.ok(error.cause instanceof Error);
    assert.ok(error.message.includes(error.cause.message));
    return true;
  });
});

test('a string that cannot be resolved is an INVALID_REQUEST', { skip: globalThis.location !== undefined }, async () => {
  await assert.rejects(createCompiler({ wasm, fonts: ['fonts/relative.otf'] }), hasCode('INVALID_REQUEST'));
  await assert.rejects(createCompiler({ wasm, fonts: [regular, ''] }), hasCode('INVALID_REQUEST'));
});

test('fonts still need at least one valid entry', async () => {
  await assert.rejects(createCompiler({ wasm, fonts: [] }), hasCode('INVALID_REQUEST'));
  await assert.rejects(createCompiler({ wasm, fonts: [new Uint8Array()] }), hasCode('INVALID_REQUEST'));
  // @ts-expect-error a font that is neither bytes, a URL nor a string must be rejected at run time
  await assert.rejects(createCompiler({ wasm, fonts: [42] }), hasCode('INVALID_REQUEST'));
});

test('URL fonts without fetch are an INITIALIZATION error; bytes keep working', async () => {
  const original = globalThis.fetch;
  // @ts-expect-error simulate a runtime without fetch
  globalThis.fetch = undefined;
  try {
    await assert.rejects(createCompiler({ wasm, fonts: [`${origin}/regular.otf`] }), (error: TypstPdfError) => {
      assert.ok(hasCode('INITIALIZATION')(error));
      assert.match(error.message, /fetch/);
      return true;
    });
    await withCompiler({ fonts: [regular] }, async compiler => {
      assert.ok((await compiler.compile({ template: boldTemplate, input: null })).bytes.length);
    });
  } finally { globalThis.fetch = original; }
});
