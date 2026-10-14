import init, { TypstCompilerBuilder, type TypstCompiler, type TypstCompileWorld } from '@typfolio/wasm';
import { TypstPdfError, type Diagnostic, type PdfResult, type WasmSource } from './types.js';
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

/** What differs between compile flavors: extra files to mount and the `sys.inputs` to set. */
export interface CompileExtras {
  mounts: readonly (readonly [string, Uint8Array])[];
  inputs: readonly (readonly [string, string])[];
}

/** Copies the fonts and requires at least one non-empty `Uint8Array`. */
export function copyFonts(fonts: readonly Uint8Array[]): Uint8Array[] {
  if (!Array.isArray(fonts) || !fonts.length || fonts.some(font => !(font instanceof Uint8Array) || !font.length)) {
    throw new TypstPdfError('INVALID_REQUEST', 'Supply at least one non-empty font as Uint8Array');
  }
  return fonts.map(font => new Uint8Array(font));
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
      for (const [path, bytes] of request.files) {
        if (!this.compiler.map_shadow(path, bytes)) throw new TypstPdfError('ENGINE', `Could not mount ${path}`);
      }
      // For a runtime compile these are the helper package plus the input at its root (absolute paths inside a package resolve there).
      for (const [path, bytes] of extras.mounts) {
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
      // Upstream export failures currently lack structured source locations.
      const text = message(error);
      throw new TypstPdfError('COMPILATION', text, [...diagnostics, { severity: 'error', message: text }], { cause: error });
    } finally {
      try { world?.free(); } finally { this.compiler.reset_shadow(); }
    }
  }

  dispose() { this.compiler.free(); }
}
