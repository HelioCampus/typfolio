import { copyFonts, createEngine, fetchFonts, initialize } from './engine.js';
import { prepareRequest } from './request.js';
import { capabilities, TypstPdfError, type FontSource, type PdfCompiler, type WasmSource } from './types.js';
import { packageMounts, runtimeMarker } from './typst-package.js';
export { capabilities, pdfStandards, TypstPdfError } from './types.js';
export type { JsonValue, PdfOptions, PdfStandard, PdfRequest, PdfTemplate, PdfResult, PdfClient, PdfCompiler, Diagnostic, ErrorCode } from './types.js';
export type { FontSource, WasmSource } from './types.js';
export { templateFromFiles } from './template.js';
export type { TemplateFromFilesOptions, TemplateFiles } from './template.js';

export interface CompilerOptions {
  /** Explicit bytes, compiled module, Response, or hosted URL. No implicit CDN. */
  wasm: WasmSource;
  /**
   * At least one font. `Uint8Array` values are copied. A `URL` or string is fetched with `fetch` while the
   * compiler is created (a string is resolved against the page URL when there is one, otherwise it must be
   * absolute). Order is preserved. No implicit fonts: name every one.
   */
  fonts: readonly FontSource[];
}

/** One active job per compiler. Use a worker client for queues and hard cancellation. */
export async function createCompiler(options: CompilerOptions): Promise<PdfCompiler> {
  const sources = copyFonts(options?.fonts);
  // Font downloads overlap the WASM initialization.
  const [fonts] = await Promise.all([fetchFonts(sources), initialize(options.wasm)]);
  const engine = await createEngine(fonts);
  let closed = false;
  let busy = false;
  let finished: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const checkAbort = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new TypstPdfError('ABORTED', 'Compilation was cancelled', [], { cause: signal.reason });
  };
  return {
    capabilities,
    async compile(request, options = {}) {
      if (closed) throw new TypstPdfError('DISPOSED', 'The compiler is disposed');
      if (busy) throw new TypstPdfError('BUSY', 'The compiler already has an active job');
      checkAbort(options.signal);
      const prepared = prepareRequest(request); // Capture data before yielding to caller code.
      busy = true;
      let release!: () => void;
      finished = new Promise<void>(resolve => { release = resolve; });
      try {
        await Promise.resolve();
        checkAbort(options.signal);
        const result = engine.compile(prepared, { mounts: packageMounts(prepared.files.get('/input.json')!), inputs: [runtimeMarker] });
        checkAbort(options.signal);
        return result;
      } finally { busy = false; release(); }
    },
    dispose() {
      closed = true;
      return disposal ??= finished.then(() => engine.dispose());
    },
  };
}
