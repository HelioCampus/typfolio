// Probe: node tools/probe-tinymist.mjs <tinymist-binary> <folder> [entry]   (entry defaults to main.typ)
// Starts tinymist as an LSP server, opens the entry file, asks for completion after the final "."
// of every line that ends with "." (or ". ]"), and prints the field labels it offered.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [bin, dir, entry = 'main.typ'] = process.argv.slice(2);
const root = resolve(dir);
const p = spawn(bin, ['lsp'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = Buffer.alloc(0), id = 0;
const pending = new Map();
p.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const len = +/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())[1];
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    if (msg.method === 'textDocument/publishDiagnostics' && process.env.PROBE_DIAG) console.log('diagnostics:', JSON.stringify((msg.params.diagnostics ?? []).map(d => d.message)).slice(0, 400));
    if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: null });
    else if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const send = m => { const s = JSON.stringify(m); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const req = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); send({ jsonrpc: '2.0', id: i, method, params }); });

const uri = pathToFileURL(root + '/' + entry).href;
const text = readFileSync(root + '/' + entry, 'utf8');
await req('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href,
  workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'probe' }],
  capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } }, initializationOptions: JSON.parse(process.env.PROBE_INIT ?? "{}") });
send({ jsonrpc: '2.0', method: 'initialized', params: {} });
send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typst', version: 1, text } } });
await new Promise(r => setTimeout(r, +(process.env.PROBE_WAIT_MS ?? 4000)));
const methods = new Set(['len', 'at', 'insert', 'remove', 'keys', 'values', 'pairs', 'first', 'last', 'slice', 'contains', 'push', 'pop', 'map', 'filter', 'join', 'sorted', 'rev', 'fold', 'sum', 'product', 'any', 'all', 'find', 'position', 'enumerate', 'zip', 'flatten', 'dedup', 'chunks', 'windows', 'intersperse', 'to-dict', 'reduce', 'range']);
for (const [i, line] of text.split('\n').entries()) {
  if (line.trim().startsWith('//') || !/\.\s*\]?$/.test(line.trim())) continue;
  const res = await req('textDocument/completion', { textDocument: { uri }, position: { line: i, character: line.lastIndexOf('.') + 1 }, context: { triggerKind: 2, triggerCharacter: '.' } });
  const items = res.result?.items ?? res.result ?? [];
  const fields = items.map(x => x.label).filter(l => !methods.has(l));
  console.log(JSON.stringify(line.trim()), '->', fields.length ? 'fields: ' + fields.join(', ') : `no fields (${items.length} items)`);
}
p.kill();
process.exit(0);
