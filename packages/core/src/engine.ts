import init, { Compiler } from '@typfolio/wasm';
import { errorLink, TypstPdfError, type Diagnostic, type FontSource, type PdfResult, type WasmSource } from './types.js';
import type { prepareRequest } from './request.js';
import { bundledPackageDirectory, bundledPackageSpec } from './typst-package.js';

let initialization: Promise<unknown> | undefined;
let loadedSource: WasmSource | undefined;

export async function initialize(wasm: WasmSource) {
  if (wasm === undefined) throw new TypstPdfError('INITIALIZATION', 'An explicit WASM source is required');
  if (initialization && loadedSource !== wasm) {
    throw new TypstPdfError('INITIALIZATION', 'This JavaScript realm already uses another WASM source; reuse the same source value or create a worker');
  }
  if (!initialization) {
    loadedSource = wasm;
    initialization = init({ module_or_path: wasm }).catch(error => {
      initialization = undefined;
      loadedSource = undefined;
      throw new TypstPdfError('INITIALIZATION', 'Could not initialize Typst WASM', [], { cause: error });
    });
  }
  await initialization;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

/** A diagnostic as the compiler reports it (`crates/compiler/src/diagnostics.rs`): hints apart from the message. */
interface RawDiagnostic {
  severity: 'error' | 'warning' | 'hint';
  message: string;
  hints?: string[];
  path?: string;
  range?: string;
  package?: string;
}

// The hints follow the message, one per line. A character no loaded font can display (refused by a PDF standard) is
// `missing-glyph`, with the text as data.
function diagnostic({ severity, message, hints = [], path, range, package: pkg }: RawDiagnostic): Diagnostic {
  const where = { ...(path === undefined ? {} : { path }), ...(range === undefined ? {} : { range }), ...(pkg === undefined ? {} : { package: pkg }) };
  const [, glyph] = /^PDF\/\S+ error: the text `"(.*)"` could not be displayed with font/.exec(message) ?? [];
  if (glyph !== undefined) return { severity, code: 'missing-glyph', text: glyph, message: `${message}. See ${errorLink('missing-glyph')}`, ...where };
  return { severity, message: message + hints.map(hint => `\nhint: ${hint}`).join(''), ...where };
}

/** What differs between compile flavors: extra files to mount and the `sys.inputs` to set. */
export interface CompileExtras {
  mounts: readonly (readonly [string, Uint8Array])[];
  inputs: readonly (readonly [string, string])[];
}

function fontUrl(value: string | URL): URL {
  if (value instanceof URL) return value;
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    if (!value.trim()) throw new TypeError('The font URL is empty');
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch (cause) {
    throw new TypstPdfError('INVALID_REQUEST', `Cannot resolve the font URL ${JSON.stringify(value)}${base === undefined ? '; without a page URL it must be absolute' : ''}`, [], { cause });
  }
}

/**
 * Requires at least one font. Copies `Uint8Array` fonts and resolves strings to URLs, synchronously,
 * so the caller's bytes are captured before anything yields and bad input fails before any download.
 */
export function copyFonts(fonts: readonly FontSource[]): (Uint8Array | URL)[] {
  if (!Array.isArray(fonts) || !fonts.length) {
    throw new TypstPdfError('INVALID_REQUEST', 'Supply at least one font as Uint8Array, URL or URL string');
  }
  return fonts.map(font => {
    if (font instanceof Uint8Array && font.length) return new Uint8Array(font);
    if (typeof font === 'string' || font instanceof URL) return fontUrl(font);
    throw new TypstPdfError('INVALID_REQUEST', 'Every font must be a non-empty Uint8Array, a URL or a URL string');
  });
}

async function fetchFont(url: URL): Promise<Uint8Array> {
  const failure = (reason: string, cause?: unknown) =>
    new TypstPdfError('INITIALIZATION', `Could not load font ${url.href}: ${reason}`, [], cause === undefined ? undefined : { cause });
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw failure(message(cause), cause);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw failure(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw failure(message(cause), cause);
  }
  if (!bytes.length) throw failure(`HTTP ${response.status} with an empty body`);
  return bytes;
}

/** Downloads the URL fonts concurrently; the result keeps the order of `fonts`. */
export function fetchFonts(fonts: readonly (Uint8Array | URL)[]): Promise<Uint8Array[]> {
  if (fonts.some(font => font instanceof URL) && typeof globalThis.fetch !== 'function') {
    return Promise.reject(new TypstPdfError('INITIALIZATION', 'Fonts given as URLs need fetch, which is not available here; supply the font bytes instead'));
  }
  return Promise.all(fonts.map(font => font instanceof URL ? fetchFont(font) : font));
}

/** Resolves every font source to bytes: `copyFonts` followed by `fetchFonts`. */
export function resolveFonts(fonts: readonly FontSource[]): Promise<Uint8Array[]> {
  return fetchFonts(copyFonts(fonts));
}

export async function createEngine(fonts: readonly Uint8Array[]) {
  let compiler: Compiler | undefined;
  try {
    compiler = new Compiler();
    // Every face of every font, in the order given; a file without a readable face is an error, not a silent gap.
    for (const font of fonts) compiler.addFont(font);
    const engine = new Engine(compiler);
    compiler = undefined;
    return engine;
  } catch (error) {
    throw new TypstPdfError('INITIALIZATION', `Could not create compiler: ${message(error)}`, [], { cause: error });
  } finally { compiler?.free(); }
}

class Engine {
  constructor(private readonly compiler: Compiler) {}

  compile(request: ReturnType<typeof prepareRequest>, extras: CompileExtras): PdfResult {
    let compiled: ReturnType<Compiler['compile']> | undefined;
    try {
      this.compiler.reset();
      // The request's files (the template's, its data by path and the assets), then the extras: the helper
      // package's files, served as the bundled package.
      for (const [path, bytes] of [...request.files, ...extras.mounts]) this.compiler.mount(path, bytes);
      this.compiler.mountPackage(bundledPackageSpec, bundledPackageDirectory);
      // The clock: the PDF's creation date when the request sets none, and `datetime.today()`.
      const now = { unixSeconds: Math.floor(Date.now() / 1000), utcOffsetMinutes: -new Date().getTimezoneOffset() };
      compiled = this.compiler.compile(request.entrypoint, JSON.stringify({ inputs: Object.fromEntries(extras.inputs), pdf: request.pdf, now }));
      const diagnostics = (JSON.parse(compiled.diagnostics) as RawDiagnostic[]).map(diagnostic);
      const bytes = compiled.takePdf();
      if (bytes === undefined) {
        const errors = diagnostics.filter(d => d.severity === 'error');
        throw new TypstPdfError('COMPILATION', errors.map(d => d.message).join('\n') || 'Typst compilation failed', diagnostics);
      }
      return { bytes, diagnostics, metadata: { title: compiled.title } };
    } catch (error) {
      if (error instanceof TypstPdfError) throw error;
      // The binding refuses a malformed request (an unmounted entrypoint, an unknown standard); core checks those first.
      throw new TypstPdfError('ENGINE', `The compiler refused the request: ${message(error)}`, [], { cause: error });
    } finally {
      try { compiled?.free(); } finally { this.compiler.reset(); }
    }
  }

  dispose() { this.compiler.free(); }
}
