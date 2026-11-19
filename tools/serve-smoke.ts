import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const builtApp = resolve(root, '.build/vite-app');
const types: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.typ': 'text/plain', '.svg': 'image/svg+xml' };
// The smoke page loads unbundled core output. Browsers cannot resolve the bare
// `@typfolio/wasm` import there (and import maps do not apply inside module workers),
// so the server maps it to the generated bindings it already serves.
const wasmBindings = '/packages/wasm/generated/compiler.js';
const rewriteBareImports = (source: string) => source.replaceAll(`from '@typfolio/wasm'`, `from '${wasmBindings}'`);
const verapdfPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'";
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://127.0.0.1').pathname;
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const appPath = path === '/' ? '/index.html' : path;
  const servesApp = appPath === '/index.html' || appPath.startsWith('/assets/');
  if (!servesApp && !['/fixtures/', '/packages/core/dist/', '/packages/wasm/generated/', '/packages/verapdf-wasm/dist/', '/packages/verapdf-wasm/generated/'].some(prefix => path.startsWith(prefix))) { response.writeHead(404); response.end(); return; }
  const base = servesApp ? builtApp : root;
  const full = resolve(base, '.' + appPath);
  if (!full.startsWith(base.replace(/\/$/, '') + sep)) { response.writeHead(404); response.end(); return; }
  try {
    let bytes: Buffer | string = await readFile(full);
    if (path.startsWith('/packages/core/dist/') && full.endsWith('.js')) bytes = rewriteBareImports(bytes.toString('utf8'));
    const headers: Record<string, string> = { 'Content-Type': types[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' };
    // The veraPDF page and its worker run under the policy the package claims to work with: WebAssembly may be
    // compiled, JavaScript may not be constructed from strings. A worker takes its policy from its own script.
    if (path.startsWith('/fixtures/browser/verapdf')) headers['Content-Security-Policy'] = verapdfPolicy;
    response.writeHead(200, headers);
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(Number(process.env.PORT ?? 4178), '127.0.0.1', () => console.log(`Production worker smoke test: http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
