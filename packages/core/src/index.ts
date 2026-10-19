import { copyFonts } from './engine.js';
import { capabilities, TypstPdfError, type FontSource, type PdfClient, type PdfCompiler, type WasmSource } from './types.js';
import { resolveDocument } from './definition.js';
import { createRequestCompiler } from './request-compiler.js';
export { capabilities, pdfStandards, TypstPdfError } from './types.js';
export type {
  Assets,
  CompileOptions,
  Diagnostic,
  DiagnosticCode,
  ErrorCode,
  FontSource,
  PdfClient,
  PdfCompiler,
  PdfOptions,
  PdfResult,
  PdfStandard,
  WasmSource,
} from './types.js';
export { createAttachments, definePartial, defineTemplate } from './definition.js';
export type {
  AnyTemplate,
  InferSchemaInput,
  PartialDefinition,
  PartialsData,
  PartialsMap,
  PdfDocument,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  TemplateArguments,
  TemplateDefinition,
  TemplateInputSlot,
} from './definition.js';

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
   * Copy each asset when `compile` captures the document. Default `true`, so mutating or
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
 * `BUSY`; a call whose signal is aborted before its turn rejects with `ABORTED` without running. A document
 * is read when its turn comes. Synchronous, so it can be created at module level and passed as a
 * `PdfClient` (as `usePdf`'s `client`, say). Use `@typfolio/workers` to compile off the main thread.
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
    compile(document, compileOptions = {}) {
      if (closed) return Promise.reject(disposed());
      const job = queue.then(async () => {
        if (closed) throw disposed();
        if (compileOptions.signal?.aborted) {
          throw new TypstPdfError('ABORTED', 'Compilation was cancelled', [], { cause: compileOptions.signal.reason });
        }
        return (await load()).compile(document, compileOptions);
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
  const compiler = await createRequestCompiler(options);
  return {
    capabilities,
    // Each piece of data is checked against its schema; a synchronous schema throws before anything is captured.
    compile: (document, compileOptions = {}) => compiler.compile(() => resolveDocument(document, compileOptions), compileOptions),
    dispose: () => compiler.dispose(),
  };
}
