// Dev-time tools. Nothing here is needed at runtime: applications install this package as a devDependency
// and core never imports it, so none of it (nor the generated sample source it embeds) reaches a production bundle.
import { TypstPdfError, type CompilerOptions, type Diagnostic, type PdfOptions, type PdfTemplate } from '@typfolio/core';
import { copyFonts, createEngine, initialize, prepareRequest, bundledPackageDirectory, packageFileMounts } from '@typfolio/core/internal';
import { sampleFile, sampleSource } from './sample-source.generated.js';

/** Which sample `@local/typfolio`'s `input()` builds: every property, or only what the schema requires. */
export type SampleMode = 'minimal' | 'full';
const sampleModes: readonly SampleMode[] = ['minimal', 'full'];

export interface TemplateCheckOptions {
  /** Defaults to `['minimal', 'full']`. Each mode is a separate compile. */
  modes?: readonly SampleMode[];
  /** Same options as a request's `pdf`. */
  pdf?: PdfOptions;
}

export interface TemplateCheckResult {
  mode: SampleMode;
  ok: boolean;
  /** Warnings when `ok`; the compile errors otherwise. */
  diagnostics: readonly Diagnostic[];
  /** The `COMPILATION` error of a failed mode. */
  error?: TypstPdfError;
  /** The PDF of a successful mode. Held in memory only; nothing is written anywhere. */
  bytes?: Uint8Array;
}

export interface TemplateCheckReport {
  /** True only if every requested mode compiled. */
  ok: boolean;
  results: TemplateCheckResult[];
}

export interface TemplateChecker {
  /**
   * Compiles `template` once per mode in editor mode: no runtime marker, so `input()` reads the schema
   * from `template.files` (at the path its `json.with(...)` names, relative to the file that writes it)
   * and builds the sample. A failed compile is reported in its result; a malformed template or option
   * rejects with `INVALID_REQUEST` or `UNSUPPORTED_OPTION`.
   */
  check(template: PdfTemplate, options?: TemplateCheckOptions): Promise<TemplateCheckReport>;
  /** Stops accepting checks; waits for an accepted one and frees the compiler. */
  dispose(): Promise<void>;
}

function parseOptions(options: unknown): { modes: readonly SampleMode[]; pdf?: PdfOptions } {
  if (options === undefined) return { modes: sampleModes };
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypstPdfError('INVALID_REQUEST', 'check options must be a plain object');
  const { modes = sampleModes, pdf, ...rest } = options as TemplateCheckOptions;
  for (const key of Object.keys(rest)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported check option ${key}`);
  if (!Array.isArray(modes) || !modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must be a non-empty array');
  for (const mode of modes) if (!sampleModes.includes(mode)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported sample mode ${String(mode)}`);
  if (new Set(modes).size !== modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must not repeat');
  return { modes, pdf };
}

/** Same options as `createCompiler`. One active check per checker. */
export async function createTemplateChecker(options: CompilerOptions): Promise<TemplateChecker> {
  const fonts = copyFonts(options?.fonts);
  await initialize(options.wasm);
  const engine = await createEngine(fonts);
  const encoder = new TextEncoder();
  // The package as the editor sees it: typst.toml, lib.typ and sample.typ, but no input at the package root.
  const mounts = [...packageFileMounts(), [`${bundledPackageDirectory}/${sampleFile}`, encoder.encode(sampleSource)] as const];
  let closed = false;
  let busy = false;
  let finished: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  return {
    async check(template, checkOptions) {
      if (closed) throw new TypstPdfError('DISPOSED', 'The template checker is disposed');
      if (busy) throw new TypstPdfError('BUSY', 'The template checker already has an active check');
      const { modes, pdf } = parseOptions(checkOptions);
      // `input: null` only fills the reserved /input.json; the editor branch never reads it.
      const prepared = prepareRequest({ template, input: null, pdf });
      busy = true;
      let release!: () => void;
      finished = new Promise<void>(resolve => { release = resolve; });
      try {
        const results: TemplateCheckResult[] = [];
        for (const mode of modes) {
          await Promise.resolve();
          try {
            const compiled = engine.compile(prepared, { mounts, inputs: [['typfolio-sample', mode]] });
            results.push({ mode, ok: true, diagnostics: compiled.diagnostics, bytes: compiled.bytes });
          } catch (error) {
            if (!(error instanceof TypstPdfError) || error.code !== 'COMPILATION') throw error;
            results.push({ mode, ok: false, diagnostics: error.diagnostics, error });
          }
        }
        return { ok: results.every(result => result.ok), results };
      } finally { busy = false; release(); }
    },
    dispose() {
      closed = true;
      return disposal ??= finished.then(() => engine.dispose());
    },
  };
}

/** One-shot form of `createTemplateChecker`: creates a checker, runs one check, disposes it. */
export async function checkTemplate(template: PdfTemplate, options: CompilerOptions & TemplateCheckOptions): Promise<TemplateCheckReport> {
  const { wasm, fonts, ...checkOptions } = options ?? {} as CompilerOptions;
  const checker = await createTemplateChecker({ wasm, fonts });
  try { return await checker.check(template, checkOptions); } finally { await checker.dispose(); }
}
