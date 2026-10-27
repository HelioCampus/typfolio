#!/usr/bin/env node
// The command line, mirroring the Rust one:
//   paramdoc-export <template-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K] [--plain-pdf out.pdf] [--wasm file]
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createExporter } from './index.js';
import { defaultExporter, exportDirectory, readDirectory } from './node.js';

const usage = 'usage: paramdoc-export <template-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K] [--plain-pdf out.pdf] [--wasm file]';

async function main(argv: string[]): Promise<number> {
  const [template, ...rest] = argv;
  if (!template || template.startsWith('--')) { console.error(usage); return 2; }
  const options = { data: join(template, 'data.json'), fonts: 'fonts', out: join('paramdoc-out', basename(template)), fuzz: 0, seed: 1, fuzzReferences: 0, references: [] as string[], plainPdf: undefined as string | undefined, wasm: undefined as string | undefined };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (value === undefined) { console.error(`${flag} needs a value\n${usage}`); return 2; }
    switch (flag) {
      case '--data': options.data = value; break;
      case '--fonts': options.fonts = value; break;
      case '--out': options.out = value; break;
      case '--fuzz': options.fuzz = Number(value); break;
      case '--seed': options.seed = Number(value); break;
      case '--reference': options.references.push(value); break;
      case '--fuzz-references': options.fuzzReferences = Number(value); break;
      case '--plain-pdf': options.plainPdf = value; break;
      case '--wasm': options.wasm = value; break;
      default: console.error(`unknown flag ${flag}\n${usage}`); return 2;
    }
  }
  const exporter = options.wasm ? await createExporter(new Uint8Array(await readFile(options.wasm))) : await defaultExporter();
  if (options.plainPdf !== undefined) {
    const { pdf, log } = exporter.plainPdf({ template: await readDirectory(template), data: new Uint8Array(await readFile(options.data)), fonts: await readDirectory(options.fonts) });
    await writeFile(options.plainPdf, pdf);
    process.stdout.write(log);
    console.log(`wrote ${options.plainPdf} (${pdf.length} bytes)`);
    return 0;
  }
  const result = await exportDirectory(template, { ...options, exporter });
  process.stdout.write(result.log);
  if (result.error !== undefined) { console.error(`error: ${result.error}`); return 1; }
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
