// Dev-time tools. Nothing here is needed at runtime: applications install this package as a devDependency
// and core never imports it, so none of it (nor the generated sample source it embeds) reaches a production bundle.
import {
  TypstPdfError,
  type AnyTemplate,
  type Assets,
  type CompilerOptions,
  type Diagnostic,
  type PartialDefinition,
  type PdfOptions,
  type PdfResult,
  type StandardSchemaV1,
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
// Types only, erased from the compiled file: the main entry never loads the pdf module or pdfjs-dist.
import type { PdfStructureWarning } from './pdf.js';

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

/** A schema and the path its Typst file reads the data from, for a script that cannot import the definitions. */
export interface SchemaFile {
  readonly schema: StandardSchemaV1;
  readonly schemaPath: string;
}

type Definition = AnyTemplate | PartialDefinition | SchemaFile;

// Each input of these templates, partials and schema files, nested partials included, once per path.
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
      add(partial.schemaPath, partial.schema as StandardSchemaV1 | undefined);
      for (const nested of Object.values(partial.partials)) visit(nested);
    } else if (typeof (definition as SchemaFile)?.schemaPath === 'string') {
      const file = definition as SchemaFile;
      add(file.schemaPath.replace(/^\/+/, ''), file.schema);
    } else {
      throw new TypstPdfError('INVALID_REQUEST', 'Expected a defineTemplate(...), a definePartial(...) or { schema, schemaPath }');
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
 * `{ schema, schemaPath }` pairs, by its path, such as `common/header.schema.json`, as JSON text. Write
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
  /** Same options as `compile`'s `pdf`. */
  pdf?: PdfOptions;
  /**
   * Files the template reads besides its data, such as a logo: as `compile`'s `assets`. A JSON Schema
   * file given here at a data path is used as it is, instead of one made from the schema.
   */
  assets?: Assets;
  /**
   * Reads the PDF of each mode that compiled and fails the mode on any warning it returns: `checkStructure` from
   * `@typfolio/dev-tools/pdf` (which needs pdfjs-dist), or a function of your own, such as one that filters its
   * warnings. A function that rejects rejects the check.
   */
  structure?: (bytes: Uint8Array) => Promise<readonly PdfStructureWarning[]>;
}

export interface TemplateCheckResult {
  mode: SampleMode;
  /** The mode compiled and, with `structure`, its PDF has no structure warnings. */
  ok: boolean;
  /** The compile's warnings when it compiled; its errors otherwise. */
  diagnostics: readonly Diagnostic[];
  /** The `COMPILATION` error of a mode that did not compile. */
  error?: TypstPdfError;
  /** The PDF of a mode that compiled. Held in memory only; nothing is written anywhere. */
  bytes?: Uint8Array;
  /** With `structure`: what it found in the PDF of a mode that compiled. */
  structure?: readonly PdfStructureWarning[];
}

export interface TemplateCheckReport {
  /** True only if every requested mode is `ok`. */
  ok: boolean;
  results: TemplateCheckResult[];
}

export interface TemplateChecker {
  /**
   * Compiles `template` once per mode in editor mode: no runtime marker, so `input()` reads the JSON
   * Schema at each data path (made from the schema, see `inputSchemaFiles`, or given in `assets`) and
   * builds the sample. The template is compiled from the files it declares only: a file it imports
   * without declaring it fails, with what to do. A failed compile is reported in its result;
   * a malformed template or option rejects with `INVALID_REQUEST` or `UNSUPPORTED_OPTION`.
   */
  check(template: AnyTemplate, options?: TemplateCheckOptions): Promise<TemplateCheckReport>;
  /** Stops accepting checks; waits for an accepted one and frees the compiler. */
  dispose(): Promise<void>;
}

function parseOptions(options: unknown): Omit<TemplateCheckOptions, 'modes'> & { modes: readonly SampleMode[] } {
  if (options === undefined) return { modes: sampleModes };
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypstPdfError('INVALID_REQUEST', 'check options must be a plain object');
  const { modes = sampleModes, pdf, assets, toJSONSchema, structure, ...rest } = options as TemplateCheckOptions;
  for (const key of Object.keys(rest)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported check option ${key}`);
  if (!Array.isArray(modes) || !modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must be a non-empty array');
  for (const mode of modes) if (!sampleModes.includes(mode)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported sample mode ${String(mode)}`);
  if (new Set(modes).size !== modes.length) throw new TypstPdfError('INVALID_REQUEST', 'modes must not repeat');
  if (toJSONSchema !== undefined && typeof toJSONSchema !== 'function') throw new TypstPdfError('INVALID_REQUEST', 'toJSONSchema must be a function');
  if (structure !== undefined && typeof structure !== 'function') {
    throw new TypstPdfError('INVALID_REQUEST', 'structure must be a function that reads the PDF bytes, such as checkStructure from @typfolio/dev-tools/pdf');
  }
  return { modes, pdf, assets, structure, ...(toJSONSchema === undefined ? {} : { toJSONSchema }) };
}

// A template as the editor sees it: its declared files, and each input's JSON Schema at the path its data is read.
function editorRequest(template: AnyTemplate, options: Omit<TemplateCheckOptions, 'modes'>) {
  const { pdf, assets } = options;
  if (!isTemplateDefinition(template)) throw new TypstPdfError('INVALID_REQUEST', 'check takes a template made with defineTemplate');
  // A JSON Schema is JSON: mounted like data, where `input(json.with(...))` reads it in the editor branch.
  const schemas: Record<string, unknown> = {};
  const given = new Set(Object.keys(assets ?? {}).map(path => path.replace(/^\/+/, '')));
  for (const [path, schema] of inputsOf([template])) {
    if (given.has(path)) continue;
    if (schema === undefined) {
      throw new TypstPdfError('INVALID_REQUEST', `The data at ${path} has no schema: give its JSON Schema file in assets`);
    }
    schemas[path] = jsonSchemaOf(schema, path, options);
  }
  return {
    entrypoint: template.entrypoint,
    files: template.files,
    documents: schemas,
    ...(assets === undefined ? {} : { assets }),
    ...(pdf === undefined ? {} : { pdf }),
  };
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
      const { modes, structure, ...rest } = parseOptions(checkOptions);
      const prepared = prepareRequest(editorRequest(template, rest));
      busy = true;
      let release!: () => void;
      finished = new Promise<void>(resolve => { release = resolve; });
      try {
        const results: TemplateCheckResult[] = [];
        for (const mode of modes) {
          await Promise.resolve();
          let compiled: PdfResult;
          try {
            compiled = engine.compile(prepared, { mounts, inputs: [['typfolio-sample', mode]] });
          } catch (error) {
            if (!(error instanceof TypstPdfError) || error.code !== 'COMPILATION') throw error;
            const explained = explainCompileError(error, prepared.files) as TypstPdfError;
            results.push({ mode, ok: false, diagnostics: explained.diagnostics, error: explained });
            continue;
          }
          if (structure === undefined) {
            results.push({ mode, ok: true, diagnostics: compiled.diagnostics, bytes: compiled.bytes });
            continue;
          }
          const warnings = await structure(compiled.bytes);
          if (!Array.isArray(warnings)) throw new TypstPdfError('INVALID_REQUEST', 'structure must resolve to an array of warnings');
          results.push({ mode, ok: warnings.length === 0, diagnostics: compiled.diagnostics, bytes: compiled.bytes, structure: warnings });
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
export async function checkTemplate(template: AnyTemplate, options: CompilerOptions & TemplateCheckOptions): Promise<TemplateCheckReport> {
  const { wasm, fonts, ...checkOptions } = options ?? {} as CompilerOptions;
  const checker = await createTemplateChecker({ wasm, fonts });
  try { return await checker.check(template, checkOptions); } finally { await checker.dispose(); }
}
