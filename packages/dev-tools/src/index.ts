// Dev-time tools. Nothing here is needed at runtime: applications install this package as a devDependency
// and core never imports it, so none of it (nor the generated sample source it embeds) reaches a production bundle.
import {
  TypstPdfError,
  type CompilerOptions,
  type Diagnostic,
  type PartialDefinition,
  type PdfOptions,
  type PdfTemplate,
  type StandardSchemaV1,
  type TemplateDefinition,
  type TemplateInput,
} from '@typfolio/core';
import {
  bundledPackageDirectory,
  createEngine,
  explainCompileError,
  initialize,
  isTemplateDefinition,
  packageFileMounts,
  prepareRequest,
  resolveFonts,
} from '@typfolio/core/internal';
import { sampleFile, sampleSource } from './sample-source.generated.js';

/** Which sample `@local/typfolio`'s `input()` builds: every property, or only what the schema requires. */
export type SampleMode = 'minimal' | 'full';
const sampleModes: readonly SampleMode[] = ['minimal', 'full'];

export interface JSONSchemaOptions {
  /**
   * Turns a schema into JSON Schema. Needed only for a schema that does not implement Standard JSON
   * Schema (`~standard.jsonSchema`), such as Zod Mini's: `toJSONSchema: schema => z.toJSONSchema(schema, { io: 'input' })`.
   */
  toJSONSchema?(schema: StandardSchemaV1): unknown;
}

type Definition = TemplateDefinition<unknown, unknown> | PartialDefinition | TemplateInput;

// Each input of these templates, partials and inputs, nested partials included, once per path.
function inputsOf(definitions: readonly Definition[]): Map<string, StandardSchemaV1 | undefined> {
  const found = new Map<string, StandardSchemaV1 | undefined>();
  const add = (path: string, schema: StandardSchemaV1 | undefined) => {
    if (found.has(path) && found.get(path) !== schema) {
      throw new TypstPdfError('INVALID_REQUEST', `Two different schemas read their input from ${path}`);
    }
    found.set(path, schema);
  };
  const visit = (definition: Definition) => {
    if (isTemplateDefinition(definition)) {
      for (const slot of definition.inputs) add(slot.path, slot.schema);
    } else if ((definition as PartialDefinition)?.kind === 'typfolio-partial') {
      const partial = definition as PartialDefinition;
      visit(partial.input);
      for (const nested of Object.values(partial.partials)) visit(nested);
    } else if (typeof (definition as TemplateInput)?.path === 'string') {
      const input = definition as TemplateInput;
      add(input.path.replace(/^\/+/, ''), input.schema as StandardSchemaV1 | undefined);
    } else {
      throw new TypstPdfError('INVALID_REQUEST', 'Expected a defineTemplate(...), a definePartial(...) or a defineInput(...)');
    }
  };
  for (const definition of definitions) visit(definition);
  return found;
}

function jsonSchemaOf(schema: StandardSchemaV1, path: string, options: JSONSchemaOptions): unknown {
  if (options.toJSONSchema) return options.toJSONSchema(schema);
  const converter = (schema['~standard'] as { jsonSchema?: { input?: (options: { target: string }) => unknown } }).jsonSchema;
  if (typeof converter?.input === 'function') return converter.input({ target: 'draft-2020-12' });
  throw new TypstPdfError(
    'INVALID_REQUEST',
    `The schema of ${path} does not implement Standard JSON Schema (~standard.jsonSchema): pass toJSONSchema, for Zod Mini \`schema => z.toJSONSchema(schema, { io: 'input' })\``,
  );
}

/**
 * The JSON Schema file of each input of these templates, partials (nested ones included) or
 * `defineInput(...)` results, by its path, such as `common/header.schema.json`, as JSON text. Write
 * each next to the Typst files, where its `input(json.with("./header.schema.json"))` reads it in an
 * editor for a sample, and in a test compare the parsed files with these to catch a schema that
 * changed without its file. An input without a schema is left out. Nothing is written here.
 */
export function inputSchemaFiles(
  definitions: Definition | readonly Definition[],
  options: JSONSchemaOptions = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, schema] of inputsOf(Array.isArray(definitions) ? definitions : [definitions as Definition])) {
    if (schema !== undefined) files[path] = `${JSON.stringify(jsonSchemaOf(schema, path, options), null, 2)}\n`;
  }
  return files;
}

export interface TemplateCheckOptions extends JSONSchemaOptions {
  /** Defaults to `['minimal', 'full']`. Each mode is a separate compile. */
  modes?: readonly SampleMode[];
  /** Same options as a request's `pdf`. */
  pdf?: PdfOptions;
  /**
   * Files the template reads besides its input, such as shared settings or a logo: same as a
   * request's `assets`. For a template made with `defineTemplate`, a schema file given here is used
   * as it is instead of one made from the input's schema.
   */
  assets?: Readonly<Record<string, Uint8Array>>;
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
   * and builds the sample. A template made with `defineTemplate` is compiled from the files it
   * declares only, with each input's JSON Schema at its path (see `inputSchemaFiles`): a file it
   * imports without declaring it fails, with what to do. A failed compile is reported in its result;
   * a malformed template or option rejects with `INVALID_REQUEST` or `UNSUPPORTED_OPTION`.
   */
  check(template: PdfTemplate | TemplateDefinition<unknown, unknown>, options?: TemplateCheckOptions): Promise<TemplateCheckReport>;
  /** Stops accepting checks; waits for an accepted one and frees the compiler. */
  dispose(): Promise<void>;
}

function parseOptions(options: unknown): Omit<TemplateCheckOptions, 'modes'> & { modes: readonly SampleMode[] } {
  if (options === undefined) return { modes: sampleModes };
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypstPdfError('INVALID_REQUEST', 'check options must be a plain object');
  const { modes = sampleModes, pdf, assets, toJSONSchema, ...rest } = options as TemplateCheckOptions;
  for (const key of Object.keys(rest)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported check option ${key}`);
  if (!Array.isArray(modes) || !modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must be a non-empty array');
  for (const mode of modes) if (!sampleModes.includes(mode)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported sample mode ${String(mode)}`);
  if (new Set(modes).size !== modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must not repeat');
  if (toJSONSchema !== undefined && typeof toJSONSchema !== 'function') throw new TypstPdfError('INVALID_REQUEST', 'toJSONSchema must be a function');
  return { modes, pdf, assets, ...(toJSONSchema === undefined ? {} : { toJSONSchema }) };
}

// A defined template as the editor sees it: its declared files, and each input's JSON Schema at its path.
function editorRequest(template: PdfTemplate | TemplateDefinition<unknown, unknown>, options: Omit<TemplateCheckOptions, 'modes'>) {
  const { pdf, assets } = options;
  if (!isTemplateDefinition(template)) return { template, input: null, pdf, ...(assets === undefined ? {} : { assets }) };
  const encoder = new TextEncoder();
  const schemas: Record<string, Uint8Array> = {};
  for (const [path, schema] of inputsOf([template])) {
    if (assets?.[path] !== undefined) continue;
    if (schema === undefined) {
      throw new TypstPdfError('INVALID_REQUEST', `The input at ${path} has no schema: give its JSON Schema file in assets`);
    }
    schemas[path] = encoder.encode(JSON.stringify(jsonSchemaOf(schema, path, options)));
  }
  return { template: { entrypoint: template.entrypoint, files: template.files }, input: null, pdf, assets: { ...assets, ...schemas } };
}

/** Same options as `createCompiler`. One active check per checker. */
export async function createTemplateChecker(options: CompilerOptions): Promise<TemplateChecker> {
  const fonts = await resolveFonts(options?.fonts);
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
      const { modes, ...rest } = parseOptions(checkOptions);
      // `input: null` only fills the reserved /input.json; the editor branch never reads it.
      const prepared = prepareRequest(editorRequest(template, rest));
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
            const explained = explainCompileError(error, prepared.files) as TypstPdfError;
            results.push({ mode, ok: false, diagnostics: explained.diagnostics, error: explained });
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
export async function checkTemplate(template: PdfTemplate | TemplateDefinition<unknown, unknown>, options: CompilerOptions & TemplateCheckOptions): Promise<TemplateCheckReport> {
  const { wasm, fonts, ...checkOptions } = options ?? {} as CompilerOptions;
  const checker = await createTemplateChecker({ wasm, fonts });
  try { return await checker.check(template, checkOptions); } finally { await checker.dispose(); }
}
