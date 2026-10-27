// The paramdoc exporter as a library over its WebAssembly build: compiles a template in the slot dialect with
// Typst, exports its frames as a parametric document (`doc.json`, subset fonts, images) and runs the proof that
// nothing outside the slots depends on the data (the isolation fuzz, the repertoire proof, Typst references for
// other data). This module has no Node dependency and runs wherever WebAssembly does; `./node` adds the file
// system (directories in, directories out) and the command line.
//
// The wasm is the Rust crate `experiments/paramdoc/export` built as a `cdylib` with its C ABI (`ffi` in
// `src/lib.rs`): one call takes a framed request and returns a framed response. The framing is a little-endian
// u32 count, then per entry a u32 name length, the name (UTF-8), a u32 data length and the data.

/** A template's files by path relative to its directory (`main.typ`, `paramdoc.typ`, images, …). */
export type Files = Readonly<Record<string, Uint8Array | string>> | Iterable<readonly [string, Uint8Array | string]>;

export interface ExportRequest {
  /** The template's files, `main.typ` among them. */
  readonly template: Files;
  /** The sample data (`data.json`): bytes, text, or a value to serialize as JSON. */
  readonly data: Uint8Array | string | object;
  /** The fonts by file name (`.otf`, `.ttf`, `.ttc`, `.otc`); the document records the names. */
  readonly fonts: Files;
  /** Other data files to lay out with Typst as references for the runtimes, by name: the first one's reference
   *  is `reference.json` / `.pdf`, every further one `reference-<name>.json` / `.pdf`. */
  readonly references?: Files;
  /** Random data samples compared with the sample's layout outside the slots (default 0: none). */
  readonly fuzz?: number;
  /** The seed of the random samples (default 1). */
  readonly seed?: number;
  /** How many of the random samples are also written out with Typst's layout of them (default 0). */
  readonly fuzzReferences?: number;
}

export interface ExportResult {
  /** The files to write, by path relative to the output directory: `doc.json`, `fonts/<file>`, `images/<file>`,
   *  `baseline.pdf`, the references and the fuzz samples. On an error, the files produced before it. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** What the command line prints: the export's description of the document, the proof's findings. */
  readonly log: string;
  /** Why the export stopped, if it did: a refusal names the element, the reason and the fix. */
  readonly error?: string;
}

export interface Exporter {
  /** Compiles the template with the sample data and runs the whole proof. Never throws for a refusal: that is
   *  `error` on the result, with the files and the log the export produced before it. */
  export(request: ExportRequest): ExportResult;
  /** Compiles `main.typ` and returns typst-pdf's output and nothing else, for reproducing Typst's own behaviour
   *  on a plain file; throws when Typst cannot compile or export it. */
  plainPdf(request: Pick<ExportRequest, 'template' | 'data' | 'fonts'>): { pdf: Uint8Array; log: string };
}

/** Bytes, a module, or a response to compile (`WebAssembly.compileStreaming`). */
export type WasmSource = Uint8Array | ArrayBuffer | WebAssembly.Module | Response | Promise<Response>;

interface Exports {
  memory: WebAssembly.Memory;
  paramdoc_alloc(len: number): number;
  paramdoc_export(request: number, len: number, outLen: number): number;
  paramdoc_free(pointer: number, len: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function entries(files: Files | undefined, prefix: string, out: [string, Uint8Array][]): void {
  if (!files) return;
  const list: Iterable<readonly [string, Uint8Array | string]> = Symbol.iterator in files ? files : Object.entries(files);
  for (const [name, value] of list) {
    if (typeof name !== 'string' || !name) throw new TypeError(`${prefix}: a file needs a name`);
    out.push([prefix + name, typeof value === 'string' ? encoder.encode(value) : value]);
  }
}

function bytesOf(data: Uint8Array | string | object, what: string): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return encoder.encode(data);
  if (data && typeof data === 'object') return encoder.encode(JSON.stringify(data));
  throw new TypeError(`${what}: bytes, text or a JSON value expected`);
}

function frame(list: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const names = list.map(([name]) => encoder.encode(name));
  let size = 4;
  list.forEach(([, data], i) => { size += 8 + names[i]!.length + data.length; });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, list.length, true); at += 4;
  list.forEach(([, data], i) => {
    const name = names[i]!;
    view.setUint32(at, name.length, true); at += 4;
    out.set(name, at); at += name.length;
    view.setUint32(at, data.length, true); at += 4;
    out.set(data, at); at += data.length;
  });
  return out;
}

function unframe(bytes: Uint8Array): [string, Uint8Array][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = (): number => { if (at + 4 > bytes.length) throw new Error('truncated response from the exporter'); const v = view.getUint32(at, true); at += 4; return v; };
  const take = (n: number): Uint8Array => { if (at + n > bytes.length) throw new Error('truncated response from the exporter'); const s = bytes.slice(at, at + n); at += n; return s; };
  const count = u32();
  const out: [string, Uint8Array][] = [];
  for (let i = 0; i < count; i++) {
    const name = decoder.decode(take(u32()));
    out.push([name, take(u32())]);
  }
  return out;
}

function requestOf(request: ExportRequest, plain: boolean): Uint8Array {
  const list: [string, Uint8Array][] = [];
  entries(request.template, 'template/', list);
  list.push(['data', bytesOf(request.data, 'data')]);
  entries(request.fonts, 'font/', list);
  if (!plain) {
    const references: [string, Uint8Array][] = [];
    entries(request.references, 'reference/', references);
    list.push(...references);
    list.push(['fuzz', encoder.encode(String(request.fuzz ?? 0))]);
    list.push(['seed', encoder.encode(String(request.seed ?? 1))]);
    list.push(['fuzz-references', encoder.encode(String(request.fuzzReferences ?? 0))]);
  } else {
    list.push(['plain-pdf', new Uint8Array()]);
  }
  return frame(list);
}

async function instantiate(wasm: WasmSource): Promise<Exports> {
  let module: WebAssembly.Module;
  if (wasm instanceof WebAssembly.Module) module = wasm;
  else if (wasm instanceof ArrayBuffer) module = await WebAssembly.compile(wasm);
  else if (wasm instanceof Uint8Array) module = await WebAssembly.compile((wasm.buffer as ArrayBuffer).slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  else module = await WebAssembly.compileStreaming(wasm);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Partial<Exports>;
  for (const name of ['memory', 'paramdoc_alloc', 'paramdoc_export', 'paramdoc_free'] as const) {
    if (!(name in exports)) throw new Error(`not the paramdoc exporter: the module has no \`${name}\` export`);
  }
  return exports as Exports;
}

/** Creates an exporter from the wasm (`@typfolio/paramdoc-export/paramdoc_export.wasm`, 25 MB; load it once).
 *  One exporter runs any number of exports, one at a time; Typst's caches persist between them. */
export async function createExporter(wasm: WasmSource): Promise<Exporter> {
  const api = await instantiate(wasm);
  const call = (request: Uint8Array): [string, Uint8Array][] => {
    const input = api.paramdoc_alloc(request.length);
    new Uint8Array(api.memory.buffer).set(request, input);
    const outLen = api.paramdoc_alloc(4);
    const output = api.paramdoc_export(input, request.length, outLen);
    // The memory may have grown during the call: read through a fresh view.
    const len = new DataView(api.memory.buffer).getUint32(outLen, true);
    const response = new Uint8Array(api.memory.buffer).slice(output, output + len);
    api.paramdoc_free(output, len);
    api.paramdoc_free(outLen, 4);
    return unframe(response);
  };
  return {
    export(request) {
      const files = new Map<string, Uint8Array>();
      let log = '';
      let error: string | undefined;
      for (const [name, data] of call(requestOf(request, false))) {
        if (name.startsWith('file/')) files.set(name.slice(5), data);
        else if (name === 'log') log = decoder.decode(data);
        else if (name === 'error') error = decoder.decode(data);
      }
      return error === undefined ? { files, log } : { files, log, error };
    },
    plainPdf(request) {
      let pdf: Uint8Array | undefined;
      let log = '';
      let error: string | undefined;
      for (const [name, data] of call(requestOf({ ...request, references: undefined, fuzz: 0 }, true))) {
        if (name === 'file/plain.pdf') pdf = data;
        else if (name === 'log') log = decoder.decode(data);
        else if (name === 'error') error = decoder.decode(data);
      }
      if (error !== undefined || !pdf) throw new Error(error ?? 'the exporter returned no PDF');
      return { pdf, log };
    },
  };
}
