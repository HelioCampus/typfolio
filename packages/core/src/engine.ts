import init, { TypstCompilerBuilder, type TypstCompiler, type TypstCompileWorld } from '@typfolio/wasm';
import { errorLink, TypstPdfError, type Diagnostic, type FontSource, type PdfResult, type WasmSource } from './types.js';
import type { prepareRequest } from './request.js';
import { resolvePackage } from './typst-package.js';

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

const quoted = /"((?:[^"\\]|\\.)*)"/g;
const unquote = (text: string) => { try { return JSON.parse(`"${text}"`) as string; } catch { return text; } };

// The binding reports a failed PDF export as Rust debug text,
// `[SourceDiagnostic { severity: Error, span: …, message: "…", trace: [], hints: ["…"] }]`:
// one diagnostic per message, its hints appended. A character no loaded font can display (refused
// by a PDF standard) is `missing-glyph`. Anything else is kept as it is.
function exportDiagnostics(text: string): Diagnostic[] {
  const found = text.split('SourceDiagnostic {').slice(1).flatMap((part): Diagnostic[] => {
    const [, said] = /message: "((?:[^"\\]|\\.)*)"/.exec(part) ?? [];
    if (said === undefined) return [];
    const message = unquote(said);
    const [, glyph] = /^PDF\/\S+ error: the text `"(.*)"` could not be displayed with font/.exec(message) ?? [];
    if (glyph !== undefined) return [{ severity: 'error', code: 'missing-glyph', text: glyph, message: `${message}. See ${errorLink('missing-glyph')}` }];
    const hints = [...(/hints: \[(.*)\]/s.exec(part)?.[1] ?? '').matchAll(quoted)].map(([, hint]) => `\nhint: ${unquote(hint)}`);
    return [{ severity: 'error', message: message + hints.join('') }];
  });
  return found.length ? found : [{ severity: 'error', message: text }];
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
  let builder: TypstCompilerBuilder | undefined;
  try {
    builder = new TypstCompilerBuilder();
    // All resource bytes must come from the request; never access host files or a registry.
    await builder.set_access_model(undefined, () => 0, () => false, (path: string) => path,
      (path: string) => { throw new Error(`Resource is not supplied in this request: ${path}`); });
    // Only the package bundled with core is served (from the request's virtual file system); no registry or network.
    await builder.set_package_registry(undefined, resolvePackage);
    for (const font of fonts) await builder.add_raw_font(font);
    const consumed = builder;
    builder = undefined; // build() consumes the Rust builder, including on rejection.
    return new Engine(await consumed.build());
  } catch (error) {
    throw new TypstPdfError('INITIALIZATION', `Could not create compiler: ${message(error)}`, [], { cause: error });
  } finally { builder?.free(); }
}

class Engine {
  constructor(private readonly compiler: TypstCompiler) {}

  compile(request: ReturnType<typeof prepareRequest>, extras: CompileExtras): PdfResult {
    let world: TypstCompileWorld | undefined;
    let diagnostics: Diagnostic[] = [];
    try {
      this.compiler.reset_shadow();
      // The request's files (the template's, its data by path and the assets), then the extras: the helper
      // package's files.
      for (const [path, bytes] of [...request.files, ...extras.mounts]) {
        if (!this.compiler.map_shadow(path, bytes)) throw new TypstPdfError('ENGINE', `Could not mount ${path}`);
      }
      world = this.compiler.snapshot('/', request.entrypoint, extras.inputs.map(entry => [...entry]));
      world.set_pdf_opts(request.pdf);
      // Compile separately because get_artifact() omits warnings on successful output.
      const compiled = world.compile(0, 3) as { hasError: boolean; diagnostics: Diagnostic[] };
      diagnostics = compiled.diagnostics ?? [];
      if (compiled.hasError) throw new TypstPdfError('COMPILATION', diagnostics.map(d => d.message).join('\n') || 'Typst compilation failed', diagnostics);
      const bytes = world.get_artifact(1, 0) as Uint8Array;
      if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
        throw new TypstPdfError('ENGINE', 'The compiler did not return PDF bytes', diagnostics);
      }
      return { bytes, diagnostics, metadata: { title: world.title(0) } };
    } catch (error) {
      if (error instanceof TypstPdfError) throw error;
      // Upstream export failures (a PDF standard's checks) lack source locations.
      const failures = exportDiagnostics(message(error));
      throw new TypstPdfError('COMPILATION', failures.map(d => d.message).join('\n'), [...diagnostics, ...failures], { cause: error });
    } finally {
      try { world?.free(); } finally { this.compiler.reset_shadow(); }
    }
  }

  dispose() { this.compiler.free(); }
}
