import { copyFonts, createEngine, fetchFonts, initialize } from './engine.js';
import { explainCompileError } from './explain.js';
import type { ResolvedRequest } from './definition.js';
import type { CompilerOptions } from './index.js';
import { prepareRequest } from './request.js';
import { TypstPdfError, type PdfResult } from './types.js';
import { packageFileMounts, runtimeMarker } from './typst-package.js';

/** What a request compiler compiles: a document resolved to its files and data by path, and its pending check. */
export type ResolveRequest = () => { request: ResolvedRequest; validated?: Promise<void> };

/**
 * Internal (exported through `@typfolio/core/internal`, not the main entry): a compiler of resolved documents. `createCompiler`
 * resolves each document and hands it here; a worker gets documents already resolved on the page's thread.
 */
export async function createRequestCompiler(options: CompilerOptions) {
  const sources = copyFonts(options?.fonts);
  const copyAssets = options.copyAssets ?? true;
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
    async compile(resolve: ResolveRequest, options: { signal?: AbortSignal } = {}): Promise<PdfResult> {
      if (closed) throw new TypstPdfError('DISPOSED', 'The compiler is disposed');
      if (busy) throw new TypstPdfError('BUSY', 'The compiler already has an active job');
      checkAbort(options.signal);
      const { request, validated } = resolve();
      const prepared = prepareRequest(request, { copyAssets }); // Capture data before yielding to caller code.
      busy = true;
      let release!: () => void;
      finished = new Promise<void>(resolve => { release = resolve; });
      try {
        // Yields to the caller even without an asynchronous schema, so a signal can still abort.
        await validated;
        checkAbort(options.signal);
        let result;
        try {
          result = engine.compile(prepared, { mounts: packageFileMounts(), inputs: [runtimeMarker] });
        } catch (error) {
          throw explainCompileError(error, prepared.files);
        }
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
