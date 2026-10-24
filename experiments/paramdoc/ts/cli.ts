// Command line for the TypeScript runtime, mirroring the Rust CLI.
//   node --experimental-strip-types ts/cli.ts <doc-dir> --data data.json --out out.pdf [--expect reference.json] [--expect-rust trace.json]
//   node --experimental-strip-types ts/cli.ts bench <doc-dir> --inputs inputs.json [--out dir] [--repeat N]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime, compare, type Document, type ReferenceSlot } from './runtime.ts';

function flags(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]!.startsWith('--') || args[i + 1] === undefined) throw new Error(`${args[i]} needs a value`);
    out.set(args[i]!.slice(2), args[i + 1]!);
  }
  return out;
}

async function load(dir: string): Promise<Runtime> {
  const docJson = readFileSync(join(dir, 'doc.json'));
  const listed: Document = JSON.parse(docJson.toString());
  const fonts = listed.fonts.map(f => new Uint8Array(readFileSync(join(dir, 'fonts', f.file))));
  return Runtime.create(new Uint8Array(docJson), fonts);
}

const percentile = (sorted: number[], p: number): number => sorted[Math.round((sorted.length - 1) * p)] ?? 0;

async function bench(args: string[]): Promise<void> {
  const dir = args[0]!;
  const options = flags(args.slice(1));
  const inputs = options.get('inputs');
  if (!inputs) throw new Error('--inputs is required');
  const out = options.get('out') ?? dir;
  const repeat = Number(options.get('repeat') ?? 1);
  const values: unknown[] = JSON.parse(readFileSync(inputs, 'utf8'));
  const setup = performance.now();
  const runtime = await load(dir);
  const setupMs = performance.now() - setup;
  const durations: number[] = [];
  let bytes = 0, pages = 0, first: Uint8Array | undefined;
  const started = performance.now();
  for (let r = 0; r < repeat; r++) {
    for (const value of values) {
      const t = performance.now();
      const output = await runtime.fill(value);
      durations.push(performance.now() - t);
      bytes += output.pdf.length; pages += output.pages;
      first ??= output.pdf;
    }
  }
  const total = (performance.now() - started) / 1000;
  mkdirSync(out, { recursive: true });
  if (first) writeFileSync(join(out, 'bench-ts-first.pdf'), first);
  durations.sort((a, b) => a - b);
  const n = durations.length;
  console.log(`bench (TypeScript): ${n} documents in ${total.toFixed(3)} s on one thread = ${(n / total).toFixed(0)} documents/s; setup ${setupMs.toFixed(1)} ms`);
  console.log(`       per document: median ${percentile(durations, 0.5).toFixed(3)} ms, p95 ${percentile(durations, 0.95).toFixed(3)} ms, max ${durations[n - 1]!.toFixed(3)} ms; ${pages} pages, ${(bytes / n / 1000).toFixed(1)} kB average PDF`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'bench') return bench(args.slice(1));
  const dir = args[0];
  if (!dir) throw new Error('usage: cli.ts <doc-dir> --data data.json --out out.pdf [--expect reference.json] [--expect-rust trace.json]');
  const options = flags(args.slice(1));
  const data = JSON.parse(readFileSync(options.get('data') ?? join(dir, 'data.json'), 'utf8'));
  const outPath = options.get('out') ?? join(dir, 'runtime-ts.pdf');
  const started = performance.now();
  const runtime = await load(dir);
  const output = await runtime.fill(data);
  const elapsed = performance.now() - started;
  writeFileSync(outPath, output.pdf);
  writeFileSync(outPath.replace(/\.pdf$/, '') + '.trace.json', JSON.stringify({ slots: output.trace }, null, 2));
  console.log(`filled ${output.trace.length} slot(s) on ${output.pages} page(s) and wrote ${output.pdf.length} bytes to ${outPath} in ${elapsed.toFixed(1)} ms`);
  let failed = false;
  const expect = options.get('expect');
  if (expect) {
    const problems = compare(output.trace, JSON.parse(readFileSync(expect, 'utf8')) as ReferenceSlot[]);
    if (problems.length) { failed = true; for (const p of problems) console.log(`reference mismatch: ${p}`); }
    else console.log("reference: every slot's glyphs and positions match Typst's own layout of this data");
  }
  const rust = options.get('expect-rust');
  if (rust) {
    const trace = (JSON.parse(readFileSync(rust, 'utf8')) as { slots: ReferenceSlot[] }).slots;
    const problems = compare(output.trace, trace);
    if (problems.length) { failed = true; for (const p of problems) console.log(`rust trace mismatch: ${p}`); }
    else console.log(`rust trace: identical to the Rust runtime's ${trace.length} filled slot(s)`);
  }
  if (failed) process.exit(1);
}

main().catch(error => { console.error(`error: ${error instanceof Error ? error.message : error}`); process.exit(1); });
