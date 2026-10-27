// The exporter on the file system: a template directory in, an output directory out, as the Rust command line
// does it. Node only.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExporter, type Exporter, type ExportResult, type WasmSource } from './index.js';

/** Every file under `dir`, by its path relative to `dir` with `/` separators, in sorted order. */
export async function readDirectory(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (at: string): Promise<void> => {
    const entries = (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.set(relative(dir, path).split('\\').join('/'), new Uint8Array(await readFile(path)));
    }
  };
  await walk(dir);
  return out;
}

/** Writes an export's files under `dir`, creating the directories. */
export async function writeResult(dir: string, result: ExportResult): Promise<void> {
  for (const [path, bytes] of result.files) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

/** The package's own wasm (`generated/paramdoc_export.wasm`). */
export async function loadWasm(): Promise<Uint8Array> {
  const path = fileURLToPath(new URL('../generated/paramdoc_export.wasm', import.meta.url));
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new Error(`The exporter's wasm is not at ${path}; build it with experiments/paramdoc/build-export-wasm.sh or reinstall the package`, { cause: error });
  }
}

let shared: Promise<Exporter> | undefined;

/** An exporter over the package's own wasm, created once per process. */
export function defaultExporter(wasm?: WasmSource): Promise<Exporter> {
  if (wasm !== undefined) return createExporter(wasm);
  shared ??= loadWasm().then(createExporter).catch(error => { shared = undefined; throw error; });
  return shared;
}

export interface ExportDirectoryOptions {
  /** The data file; default `<template>/data.json`. */
  readonly data?: string;
  /** The fonts directory. */
  readonly fonts: string;
  /** Where the files go. */
  readonly out: string;
  /** Data files to lay out as references, their names taken from the file names without extension. */
  readonly references?: readonly string[];
  readonly fuzz?: number;
  readonly seed?: number;
  readonly fuzzReferences?: number;
  readonly exporter?: Exporter;
}

/** Exports a template directory like the Rust command line: reads it, its data, fonts and references, writes
 *  the result's files under `out` and returns the result (its `error` is not thrown). */
export async function exportDirectory(template: string, options: ExportDirectoryOptions): Promise<ExportResult> {
  const exporter = options.exporter ?? await defaultExporter();
  const data = new Uint8Array(await readFile(options.data ?? join(template, 'data.json')));
  const references: [string, Uint8Array][] = [];
  for (const path of options.references ?? []) {
    const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '');
    references.push([name, new Uint8Array(await readFile(path))]);
  }
  const result = exporter.export({
    template: await readDirectory(template),
    data,
    fonts: await readDirectory(options.fonts),
    references,
    fuzz: options.fuzz,
    seed: options.seed,
    fuzzReferences: options.fuzzReferences,
  });
  await writeResult(options.out, result);
  return result;
}
