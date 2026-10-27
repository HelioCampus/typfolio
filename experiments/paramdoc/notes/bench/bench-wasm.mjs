// Renders the benchmark inputs through the runtime's wasm32 build in Node (V8), one thread, via the C ABI.
import { readFileSync, writeFileSync } from 'node:fs';
const [wasmPath, docDir, inputsPath, outDir] = process.argv.slice(2);
const doc = readFileSync(`${docDir}/doc.json`);
const listed = JSON.parse(doc.toString());
const fonts = listed.fonts.map(f => readFileSync(`${docDir}/fonts/${f.file}`));
const inputs = JSON.parse(readFileSync(inputsPath, 'utf8')).map(v => Buffer.from(JSON.stringify(v)));
const t0 = performance.now();
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const { memory, paramdoc_alloc, paramdoc_free, paramdoc_open, paramdoc_render, paramdoc_close } = instance.exports;
const mem = () => new Uint8Array(memory.buffer);
const put = bytes => { const p = paramdoc_alloc(bytes.length); mem().set(bytes, p); return p; };
const u32 = (p) => new DataView(memory.buffer).getUint32(p, true);
const docPtr = put(doc);
const fontPtrs = fonts.map(f => [put(f), f.length]);
const table = paramdoc_alloc(fontPtrs.length * 8);
fontPtrs.forEach(([p, l], i) => { const dv = new DataView(memory.buffer); dv.setUint32(table + i * 8, p, true); dv.setUint32(table + i * 8 + 4, l, true); });
const errPtrPtr = paramdoc_alloc(4), errLen = paramdoc_alloc(4);
const handle = paramdoc_open(docPtr, doc.length, table, fontPtrs.length, errPtrPtr, errLen);
if (!handle) { const ep = u32(errPtrPtr), el = u32(errLen); throw new Error(Buffer.from(mem().subarray(ep, ep + el)).toString()); }
const t1 = performance.now();
const outLen = paramdoc_alloc(4), status = paramdoc_alloc(4);
const times = []; let bytes = 0; let first;
const tStart = performance.now();
for (const data of inputs) {
  const t = performance.now();
  const dp = put(data);
  const out = paramdoc_render(handle, dp, data.length, outLen, status);
  const len = u32(outLen), st = u32(status);
  if (st !== 0) throw new Error(Buffer.from(mem().subarray(out, out + len)).toString());
  if (!first) first = Buffer.from(mem().subarray(out, out + len));
  bytes += len;
  paramdoc_free(out, len); paramdoc_free(dp, data.length);
  times.push(performance.now() - t);
}
const total = (performance.now() - tStart) / 1000;
paramdoc_close(handle);
times.sort((a, b) => a - b);
const pct = p => times[Math.round((times.length - 1) * p)];
if (outDir) writeFileSync(`${outDir}/bench-wasm-first.pdf`, first);
console.log(`wasm in Node: instantiate+open ${(t1 - t0).toFixed(0)} ms; ${inputs.length} documents in ${total.toFixed(3)} s on one thread = ${(inputs.length / total).toFixed(0)} documents/s; median ${pct(0.5).toFixed(3)} ms, p95 ${pct(0.95).toFixed(3)} ms, max ${pct(1).toFixed(3)} ms; ${(bytes / inputs.length / 1000).toFixed(1)} kB average PDF; memory ${(memory.buffer.byteLength / 1048576).toFixed(0)} MiB`);
