import { copyFonts, createEngine, fetchFonts, initialize } from './engine.js';
import { prepareRequest } from './request.js';
import { capabilities, TypstPdfError, type FontSource, type PdfClient, type PdfCompiler, type WasmSource } from './types.js';
import { resolveRequest } from './definition.js';
import { explainCompileError } from './explain.js';
import { documentsMarker, packageMounts, runtimeMarker } from './typst-package.js';
export { capabilities, pdfStandards, TypstPdfError } from './types.js';
export type { JsonValue, PdfOptions, PdfStandard, PdfRequest, PdfTemplate, PdfResult, PdfClient, PdfCompiler, Diagnostic, DiagnosticCode, ErrorCode } from './types.js';
export { createAttachments, defineInput, definePartial, defineTemplate } from './definition.js';
export type {
  AnyPdfRequest,
  CheckedRequest,
  DocumentsRequest,
  InferSchemaInput,
  PartialDefinition,
  PartialsData,
  PartialsMap,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  TemplateDefinition,
  TemplateInput,
  TemplateInputSlot,
  TemplateRequest,
} from './definition.js';
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
  /**
   * Copy each `request.assets` entry when `compile` captures the request. Default `true`, so mutating or
   * reusing a buffer after submitting it cannot change the result. With `false` the compiler reads the
   * caller's `Uint8Array` views directly: the caller must not mutate, detach, or reuse the asset buffers until
   * the returned promise settles. Validation is unchanged. Meant for a compiler that owns its requests, such as
   * the one inside `@typfolio/workers`, where the request arrives by transfer.
   */
  copyAssets?: boolean;
}

/** A `PdfClient` whose compiler is created on its first `compile`. */
export interface LazyCompiler extends PdfClient {
  /** Stops accepting jobs, waits for the queued ones, and frees the compiler if one was created. */
  dispose(): Promise<void>;
}

/**
 * A compiler for the page, created when it is first needed: nothing is downloaded or initialized until
 * the first `compile`, which loads the WASM and the fonts once for every later call. A load that fails is
 * not kept, so the next `compile` tries again. Calls run one at a time, in order, so callers never see
 * `BUSY`; a call whose signal is aborted before its turn rejects with `ABORTED` without running. A request
 * is read when its turn comes. Synchronous, so it can be created at module level and passed as a
 * `PdfClient` (to `PdfProvider`, or as `client`). Use `@typfolio/workers` to compile off the main thread.
 */
export function createLazyCompiler(options: CompilerOptions): LazyCompiler {
  // Font sources are checked (and byte fonts copied) now, so a mistake shows where the client is made.
  const fonts = copyFonts(options?.fonts);
  let loading: Promise<PdfCompiler> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const load = () => {
    if (loading === undefined) {
      const attempt = createCompiler({ ...options, fonts });
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = undefined;
      });
    }
    return loading;
  };
  const disposed = () => new TypstPdfError('DISPOSED', 'The compiler is disposed');
  return {
    compile(request, compileOptions = {}) {
      if (closed) return Promise.reject(disposed());
      const job = queue.then(async () => {
        if (closed) throw disposed();
        if (compileOptions.signal?.aborted) {
          throw new TypstPdfError('ABORTED', 'Compilation was cancelled', [], { cause: compileOptions.signal.reason });
        }
        return (await load()).compile(request, compileOptions);
      });
      queue = job.catch(() => undefined);
      return job;
    },
    async dispose() {
      closed = true;
      await queue;
      const compiler = await loading?.catch(() => undefined);
      await compiler?.dispose();
    },
  };
}

/** One active job per compiler. Use a worker client for queues and hard cancellation. */
export async function createCompiler(options: CompilerOptions): Promise<PdfCompiler> {
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
    capabilities,
    async compile(request, options = {}) {
      if (closed) throw new TypstPdfError('DISPOSED', 'The compiler is disposed');
      if (busy) throw new TypstPdfError('BUSY', 'The compiler already has an active job');
      checkAbort(options.signal);
      // A defined template's documents are checked against their schemas here; a synchronous schema
      // throws before anything is captured.
      const { request: resolved, validated } = resolveRequest(request);
      const prepared = prepareRequest(resolved, { copyAssets }); // Capture data before yielding to caller code.
      busy = true;
      let release!: () => void;
      finished = new Promise<void>(resolve => { release = resolve; });
      try {
        // Yields to the caller even without an asynchronous schema, so a signal can still abort.
        await validated;
        checkAbort(options.signal);
        const inputs = prepared.documents ? [runtimeMarker, documentsMarker] : [runtimeMarker];
        let result;
        try {
          result = engine.compile(prepared, { mounts: packageMounts(prepared.files.get('/input.json')!), inputs });
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
