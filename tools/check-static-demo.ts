import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = resolve(root, 'examples/pretext-hybrid');
const output = resolve(root, '.build/pretext-hybrid/client');
const config = JSON.parse(await readFile(resolve(app, 'wrangler.json'), 'utf8'));
assert.equal(config.main, undefined, 'The demo must deploy static assets without a Cloudflare Worker entry');
assert.equal(config.assets.binding, undefined, 'The demo does not need a server-side asset binding');
assert.equal(resolve(app, config.assets.directory), output, 'Only the client directory may be deployed');

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }))).flat();
}

const files = await listFiles(output);
assert.ok(files.length <= 20_000, 'Static assets exceed the Cloudflare Pages free-plan file count');
for (const path of files) {
  const name = relative(output, path);
  assert.ok(!/(^|\/)(server|functions)(\/|\.)|(^|\/)_worker\.js(\/|$)/.test(name), `Server code must not ship as an asset: ${name}`);
  assert.ok((await stat(path)).size <= 25 * 1024 * 1024, `Asset exceeds Cloudflare's 25 MiB limit: ${name}`);
}
for (const name of ['_headers', '404.html']) {
  assert.equal(await readFile(resolve(output, name), 'utf8'), await readFile(resolve(app, 'public', name), 'utf8'), `${name} must be copied into the static deployment`);
}
const index = await readFile(resolve(output, 'index.html'), 'utf8');
assert.ok(index.includes('id="home-title"'), 'Homepage must be prerendered into index.html');
for (const route of ['ascii', 'editorial', 'performance']) {
  const shell = await readFile(resolve(output, `${route}.html`), 'utf8');
  assert.ok(shell.includes('Loading the demo'), `${route} must have a static loading shell`);
  assert.ok(!shell.includes('id="home-title"'), `${route} must not serve the homepage`);
}
const wasm = files.filter(path => path.endsWith('.wasm'));
assert.equal(wasm.length, 1, 'The demo must ship one external compiler WASM asset');
const pin = JSON.parse(await readFile(resolve(root, 'compiler-source.json'), 'utf8'));
const bytes = await readFile(wasm[0]!);
assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.wasmSha256, 'The deployed compiler must match the pinned WASM');
console.log(`Static demo verified: ${files.length} files, compiler ${(bytes.length / 1024 / 1024).toFixed(2)} MiB, no application server entry.`);
