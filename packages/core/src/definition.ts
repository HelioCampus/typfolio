import { TypstPdfError, type Assets, type PdfOptions } from './types.js';

/**
 * The Standard Schema interface (https://standardschema.dev), declared here so core depends on no
 * schema library: Zod, Valibot, ArkType and others implement it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** What a schema accepts: the data a caller passes. */
export type InferSchemaInput<S> = S extends StandardSchemaV1<infer Input, unknown> ? Input : unknown;

// The data a definition takes: its schema's input, or anything without a schema.
type DataOf<S> = [S] extends [StandardSchemaV1] ? InferSchemaInput<S> : unknown;

/**
 * Typst code with runtime data of its own, such as a header shared by several templates: its files, the
 * schema of its data, the path its Typst file reads that data from, and the partials it uses in turn.
 */
export interface PartialDefinition<Data = unknown, Partials extends PartialsMap = PartialsMap> {
  readonly kind: 'typfolio-partial';
  readonly files: Readonly<Record<string, string>>;
  readonly schema?: StandardSchemaV1<Data, unknown>;
  readonly schemaPath: string;
  readonly partials: Partials;
}

// `any` here only so a map of partials with different data types is still a PartialsMap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartialsMap = Readonly<Record<string, PartialDefinition<any, any>>>;

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** The data a map of partials takes, by key, nested partials included (flat: keys are unique per template). */
export type PartialsData<P extends PartialsMap> = { [K in keyof P]: P[K] extends PartialDefinition<infer D, PartialsMap> ? D : never } &
  UnionToIntersection<{ [K in keyof P]: P[K] extends PartialDefinition<unknown, infer N> ? PartialsData<N> : never }[keyof P]>;

export function definePartial<S extends StandardSchemaV1 | undefined = undefined, P extends PartialsMap = Record<never, never>>(definition: {
  readonly files: Readonly<Record<string, string>>;
  /** Checks and types the partial's data. Optional: without it the data is `unknown` and not checked. */
  readonly schema?: S;
  /** Where the partial's Typst file reads its data, relative to the template root: `common/header.schema.json`. */
  readonly schemaPath: string;
  readonly partials?: P;
}): PartialDefinition<DataOf<S>, P> {
  const { files = {}, schema, schemaPath, partials = {} as P } = definition ?? ({} as never);
  checkSchema(schema, 'definePartial');
  if (typeof schemaPath !== 'string') throw new TypeError('definePartial: schemaPath is required: the path its Typst file reads its data from');
  return Object.freeze({
    kind: 'typfolio-partial',
    files: Object.freeze({ ...files }),
    ...(schema === undefined ? {} : { schema }),
    schemaPath: relativePath(schemaPath),
    partials: Object.freeze({ ...partials }) as P,
  }) as PartialDefinition<DataOf<S>, P>;
}

/** One runtime input of a template: `key` is `null` for the template's own data, else the partial's key. */
export interface TemplateInputSlot {
  readonly key: string | null;
  readonly path: string;
  readonly schema?: StandardSchemaV1;
}

/** A template with its data bound: what `compile` takes. Made by calling a template, `report(data, { header })`. */
export interface PdfDocument {
  readonly kind: 'typfolio-document';
  readonly template: AnyTemplate;
  readonly data: unknown;
  readonly partials: Readonly<Record<string, unknown>>;
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** The arguments of a template call: its own data, then the data of its partials by key (when it has any). */
// The partials are checked first: with known partials and generic data (a wrapper's `TemplateDefinition<T, P>`),
// the arguments resolve to `[data: T, partials: P]` instead of waiting on `T`.
export type TemplateArguments<Data, Partials> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  IsAny<Partials> extends true ? [data?: any, partials?: any]
  : [keyof Partials] extends [never]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (IsAny<Data> extends true ? [data?: any] : [Data] extends [undefined] ? [data?: undefined] : [data: Data])
    : [data: Data, partials: Partials];

/**
 * A template: call it with its data, and its partials' data by key, to get the document to compile:
 * `compile(report(data, { header: headerData }))`. The call is typed by the schemas.
 */
export interface TemplateDefinition<Data = unknown, Partials = Record<never, never>> {
  (...args: TemplateArguments<Data, Partials>): PdfDocument;
  readonly kind: 'typfolio-template';
  readonly entrypoint: string;
  /** Every Typst file: the template's own and each partial's, nested ones included. */
  readonly files: Readonly<Record<string, string>>;
  /** Every runtime input: the template's own (`key: null`, when it has one) and each partial's. */
  readonly inputs: readonly TemplateInputSlot[];
}

/** Any template, whatever its data. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTemplate = TemplateDefinition<any, any>;

export function defineTemplate<
  S extends StandardSchemaV1 | undefined = undefined,
  Path extends string | undefined = undefined,
  P extends PartialsMap = Record<never, never>,
>(definition: {
  /** Defaults to `main.typ`. */
  readonly entrypoint?: string;
  /** The template's own Typst files. Shared files without data of their own go here too. */
  readonly files: Readonly<Record<string, string>>;
  /** Checks and types the template's data. Optional: without it the data is `unknown` and not checked. */
  readonly schema?: S;
  /** Where the entrypoint reads its data: `report/input.schema.json`. Omit it for a template without data. */
  readonly schemaPath?: Path;
  /** The partials the template uses, by the key their data takes in a call. */
  readonly partials?: P;
  // A schema needs the path its data is read at.
} & ([S] extends [StandardSchemaV1] ? { readonly schemaPath: string } : unknown)): TemplateDefinition<Path extends string ? DataOf<S> : undefined, PartialsData<P>> {
  const { entrypoint = 'main.typ', files = {}, schema, schemaPath, partials = {} as P } = definition ?? ({} as never);
  checkSchema(schema, 'defineTemplate');
  if (schema !== undefined && schemaPath === undefined) {
    throw new TypeError('defineTemplate: a schema needs schemaPath, the path the entrypoint reads the data from');
  }
  const merged: Record<string, string> = { ...files };
  const slots: TemplateInputSlot[] = [];
  const paths = new Map<string, string>();
  const claim = (path: string, owner: string) => {
    const previous = paths.get(path);
    if (previous !== undefined) throw new TypeError(`defineTemplate: ${owner} and ${previous} both read their data from ${path}`);
    paths.set(path, owner);
  };
  if (schemaPath !== undefined) {
    const path = relativePath(schemaPath);
    claim(path, 'the template');
    slots.push({ key: null, path, ...(schema ? { schema } : {}) });
  }
  // Partials, nested ones included, each once: the same definition under one key may be reached twice.
  const byKey = new Map<string, PartialDefinition>();
  const visit = (map: PartialsMap, trail: string) => {
    for (const [key, partial] of Object.entries(map)) {
      if (!partial || partial.kind !== 'typfolio-partial') throw new TypeError(`defineTemplate: ${trail}${key} is not a definePartial(...)`);
      const known = byKey.get(key);
      if (known === partial) continue;
      if (known !== undefined) throw new TypeError(`defineTemplate: two different partials are both named "${key}"`);
      byKey.set(key, partial);
      claim(partial.schemaPath, `partial "${key}"`);
      slots.push({ key, path: partial.schemaPath, ...(partial.schema ? { schema: partial.schema } : {}) });
      for (const [path, source] of Object.entries(partial.files)) {
        if (path in merged && merged[path] !== source) throw new TypeError(`defineTemplate: ${path} is given twice with different contents (partial "${key}")`);
        merged[path] = source;
      }
      visit(partial.partials, `${trail}${key}.`);
    }
  };
  visit(partials, '');
  for (const path of paths.keys()) {
    if (Object.keys(merged).some(file => relativePath(file) === path)) {
      throw new TypeError(`defineTemplate: ${path} is where data is read; do not list it in files (the schema file is not shipped, the data is mounted there)`);
    }
  }
  const template = ((data?: unknown, partialData?: Readonly<Record<string, unknown>>): PdfDocument =>
    Object.freeze({ kind: 'typfolio-document', template: template as AnyTemplate, data, partials: partialData ?? {} })) as TemplateDefinition;
  Object.assign(template, { kind: 'typfolio-template', entrypoint, files: Object.freeze(merged), inputs: Object.freeze(slots) });
  return Object.freeze(template) as unknown as TemplateDefinition<Path extends string ? DataOf<S> : undefined, PartialsData<P>>;
}

export function isTemplateDefinition(value: unknown): value is AnyTemplate {
  return typeof value === 'function' && (value as { kind?: unknown }).kind === 'typfolio-template';
}

/** What a client compiles, after resolving a document: files, and data by the path it is mounted at. */
export interface ResolvedRequest {
  entrypoint: string;
  files: Readonly<Record<string, string>>;
  documents: Readonly<Record<string, unknown>>;
  assets?: Assets;
  pdf?: PdfOptions;
}

function invalidInput(slot: TemplateInputSlot, issues: readonly StandardSchemaIssue[]): TypstPdfError {
  const owner = slot.key === null ? 'The template data' : `The data of partial "${slot.key}"`;
  const lines = issues.slice(0, 10).map(issue => {
    const path = (issue.path ?? []).map(part => (typeof part === 'object' ? part.key : part)).map(String).join('.');
    return `- ${path ? `${path}: ` : ''}${issue.message}`;
  });
  const more = issues.length > 10 ? `\n- … ${issues.length - 10} more` : '';
  return Object.assign(
    new TypstPdfError('INVALID_INPUT', `${owner} does not match its schema (${slot.path}):\n${lines.join('\n')}${more}`, [], { cause: issues }),
    { issues },
  );
}

/**
 * A document's template files, its data by mount path, and the compile options: what a client compiles.
 * Each piece of data is checked against its schema, unless `validate` is false. One that validates
 * synchronously throws here; one that returns a promise is checked by `validated`, which the caller awaits
 * before compiling.
 */
export function resolveDocument(document: PdfDocument, options: { assets?: Assets; pdf?: PdfOptions; validate?: boolean } = {}): { request: ResolvedRequest; validated?: Promise<void> } {
  if (!document || (document as { kind?: unknown }).kind !== 'typfolio-document' || !isTemplateDefinition(document.template)) {
    throw new TypstPdfError('INVALID_REQUEST', 'compile takes a document: call the template with its data, as in compile(report(data, { header: headerData }))');
  }
  const { template, data } = document;
  if (options.validate !== undefined && typeof options.validate !== 'boolean') throw new TypstPdfError('INVALID_REQUEST', 'validate must be true or false');
  const partials = document.partials ?? {};
  if (typeof partials !== 'object' || Array.isArray(partials)) throw new TypstPdfError('INVALID_REQUEST', 'The partials\' data must be an object, by partial key');
  for (const key of Object.keys(partials)) {
    if (!template.inputs.some(slot => slot.key === key)) {
      const known = template.inputs.filter(slot => slot.key !== null).map(slot => `"${slot.key}"`).join(', ') || 'none';
      throw new TypstPdfError('INVALID_REQUEST', `This template has no partial "${key}"; it has ${known}`);
    }
  }
  if (data !== undefined && !template.inputs.some(slot => slot.key === null)) {
    throw new TypstPdfError('INVALID_REQUEST', 'This template takes no data (it has no schemaPath): call it without any');
  }
  const documents: Record<string, unknown> = {};
  const pending: Promise<void>[] = [];
  for (const slot of template.inputs) {
    const value = slot.key === null ? data : (partials as Record<string, unknown>)[slot.key];
    if (value === undefined) {
      throw new TypstPdfError('INVALID_REQUEST', slot.key === null
        ? `The template reads its data from ${slot.path}, but none was given: call it with its data`
        : `Partial "${slot.key}" reads its data from ${slot.path}, but none was given for "${slot.key}"`);
    }
    documents[slot.path] = value;
    if (slot.schema && options.validate !== false) {
      const result = slot.schema['~standard'].validate(value);
      if (result instanceof Promise) {
        pending.push(result.then(settled => { if (settled.issues) throw invalidInput(slot, settled.issues); }));
      } else if (result.issues) {
        throw invalidInput(slot, result.issues);
      }
    }
  }
  const request: ResolvedRequest = {
    entrypoint: template.entrypoint,
    files: template.files,
    documents,
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.pdf === undefined ? {} : { pdf: options.pdf }),
  };
  return pending.length ? { request, validated: Promise.all(pending).then(() => undefined) } : { request };
}

/**
 * Files a request carries, referenced from its data by path: `add(bytes, "png")` returns
 * `/attachments/0.png` and keeps the bytes for `assets`. The same bytes added twice share one path.
 */
export function createAttachments(directory = 'attachments'): {
  add(bytes: Uint8Array, extension: string): string;
  readonly assets: Assets;
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(directory) || directory.endsWith('/') || directory.includes('..')) {
    throw new TypeError(`createAttachments: directory must be a relative path, got ${JSON.stringify(directory)}`);
  }
  const assets: Record<string, Uint8Array> = {};
  const seen = new Map<Uint8Array, string>();
  return {
    add(bytes, extension) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('attach: bytes must be a Uint8Array');
      const ext = String(extension).replace(/^\./, '').toLowerCase();
      if (!/^[a-z0-9]+$/.test(ext)) throw new TypeError(`attach: the extension must be letters and digits, got ${JSON.stringify(extension)}`);
      const known = seen.get(bytes);
      if (known !== undefined) return known;
      const name = `${directory}/${seen.size}.${ext}`;
      seen.set(bytes, `/${name}`);
      assets[name] = bytes;
      return `/${name}`;
    },
    get assets() {
      return assets;
    },
  };
}

function checkSchema(schema: unknown, at: string): void {
  if (schema === undefined) return;
  if (typeof schema !== 'object' || schema === null || typeof (schema as StandardSchemaV1)['~standard']?.validate !== 'function') {
    throw new TypeError(`${at}: schema must implement Standard Schema (~standard)`);
  }
}

// Paths are checked when compiling, where every file and input path is; here they are only compared.
function relativePath(path: string): string {
  return String(path).replace(/^\/+/, '');
}
