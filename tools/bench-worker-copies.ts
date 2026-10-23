#!/usr/bin/env node
// Measures the per-request asset copies on the @typfolio/workers path, step by step.
//
//   npm run build && node tools/bench-worker-copies.ts [iterations]
//
// Not wired into npm scripts: it is a measurement aid, not a test. It imports the built output of
// @typfolio/workers (snapshotRequest) and @typfolio/core (resolveDocument, prepareRequest), so build first.
// No dependencies.
//
// The document's compile options carry one 32 MB Uint8Array asset plus a few small ones. Steps, each timed
// over several iterations (median reported, with MB/s over the bytes of the asset payload):
//
//   a    snapshotRequest(document, { assets })          client thread, the one copy that protects callers
//   b1   structuredClone(snapshot)                     simulated postMessage without a transfer list
//   b2   structuredClone(snapshot, { transfer })       simulated postMessage that transfers the snapshot's buffers
//   c1   prepareRequest(resolved)                      core, default: defensive copy of every asset
//   c2   prepareRequest(resolved, { copyAssets: false }) core, worker path: assets mounted as received
//
// `resolved` is the document resolved with its assets (resolveDocument), what core's compiler prepares.
// c2 reports "n/a" on code that predates the copyAssets option. The "path" lines add the steps that make up
// one request: before = a + b1 + c1, after = a + b2 + c2. Step b stands in for the browser/Node
// structured-clone algorithm, so absolute numbers differ from a real Worker; the ratios are the point.
import { performance } from 'node:perf_hooks';
import { defineTemplate } from '@typfolio/core';
import { prepareRequest, resolveDocument, type ResolvedRequest } from '@typfolio/core/internal';
import * as snapshots from '../packages/workers/dist/snapshot.js';

const { snapshotRequest, transferableBuffers } = snapshots; // transferableBuffers is absent before the transfer change

const iterations = Number(process.argv[2] ?? 9);
const bigBytes = 32 * 1024 * 1024;
const smallBytes = [4096, 65536, 1024 * 1024];
const megabytes = (bytes: number) => bytes / (1024 * 1024);

const bench = defineTemplate({ files: { 'main.typ': '#let input = json("/input.json")\n= #input.title' }, schemaPath: 'input.json' });

function buildAssets() {
  const big = new Uint8Array(bigBytes);
  // Fill every byte with noise: untouched zero pages are mapped lazily and would flatter every copy.
  for (let offset = 0; offset < big.length; offset += 65536) crypto.getRandomValues(big.subarray(offset, offset + 65536));
  const assets: Record<string, Uint8Array> = { 'big.bin': big };
  smallBytes.forEach((size, index) => { assets[`small-${index}.bin`] = new Uint8Array(size).fill(index + 1); });
  return assets;
}

const payloadBytes = Object.values(buildAssets()).reduce((sum, bytes) => sum + bytes.byteLength, 0);

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `prepare` builds fresh inputs untimed (transfer detaches them); `run` is the timed step. */
function measure<T>(prepare: () => T, run: (input: T) => unknown) {
  run(prepare()); // warm-up, untimed
  const times = [];
  for (let i = 0; i < iterations; i += 1) {
    const input = prepare();
    const start = performance.now();
    run(input);
    times.push(performance.now() - start);
  }
  return median(times);
}

function row(label: string, ms: number | undefined) {
  if (ms === undefined) return console.log(`${label.padEnd(54)} n/a`);
  const rate = megabytes(payloadBytes) / (ms / 1000);
  console.log(`${label.padEnd(54)} ${ms.toFixed(2).padStart(9)} ms  ${rate.toFixed(0).padStart(8)} MB/s`);
}

const assets = buildAssets();
const document = bench({ title: 'Bench' });
const resolved = resolveDocument(document, { assets, validate: false }).request;
const snapshotted = () => snapshotRequest(document, { assets, validate: false });
const transferList = (snapshot: ResolvedRequest) => typeof transferableBuffers === 'function'
  ? transferableBuffers(snapshot)
  : [...new Set(Object.values(snapshot.assets!).map(bytes => bytes.buffer as ArrayBuffer))];

// The copyAssets option is detected by behavior: with it, a mounted view is the caller's own object.
const probe = new Uint8Array([1]);
const probeRequest: ResolvedRequest = { entrypoint: 'main.typ', files: { 'main.typ': '' }, documents: {}, assets: { 'p.bin': probe } };
const supportsNoCopy = prepareRequest(probeRequest, { copyAssets: false }).files.get('/p.bin') === probe;

console.log(`node ${process.version}, ${iterations} iterations (median), asset payload ${megabytes(payloadBytes).toFixed(2)} MB`);
const a = measure(() => undefined, snapshotted);
const b1 = measure(snapshotted, snapshot => structuredClone(snapshot));
const b2 = measure(snapshotted, snapshot => structuredClone(snapshot, { transfer: transferList(snapshot) }));
const c1 = measure(() => resolved, value => prepareRequest(value));
const c2 = supportsNoCopy ? measure(() => resolved, value => prepareRequest(value, { copyAssets: false })) : undefined;

row('a   snapshotRequest', a);
row('b1  postMessage clone (no transfer list)', b1);
row('b2  postMessage with transfer list', b2);
row('c1  prepareRequest, copy per asset (default)', c1);
row('c2  prepareRequest, copyAssets: false', c2);
console.log('');
row('path before  a + b1 + c1', a + b1 + c1);
row('path after   a + b2 + c2', c2 === undefined ? undefined : a + b2 + c2);
