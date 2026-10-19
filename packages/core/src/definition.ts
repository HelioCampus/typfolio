import { TypstPdfError, type PdfOptions, type PdfRequest } from './types.js';

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

/**
 * A runtime input of a template or a partial: the data, and where its JSON Schema file sits in the
 * template's file tree. The Typst file reads it with `input(json.with("./<file>.schema.json"))`: in
 * an editor that file is the schema (for a sample), and when Typfolio compiles, the data is mounted
 * at the same path. The path is the input's identity: nothing else names it.
 */
export interface TemplateInput<T = unknown> {
  /** Virtual path of the schema file, relative to the template root, e.g. `common/header.schema.json`. */
  readonly path: string;
  /** Validates the data before compiling, and types it. Optional. */
  readonly schema?: StandardSchemaV1<T, unknown>;
  /** Type-only. */
  readonly '~type'?: T;
}

/** Pairs a schema with the virtual path of its JSON Schema file. */
export function defineInput<S extends StandardSchemaV1>(schema: S, path: string): TemplateInput<InferSchemaInput<S>> {
  if (!isStandardSchema(schema)) throw new TypeError('defineInput: schema must implement Standard Schema (~standard)');
  return Object.freeze({ path: relativePath(path), schema: schema as StandardSchemaV1<InferSchemaInput<S>, unknown> });
}

/** Typst code that takes runtime data of its own: its files, its input, and the partials it uses. */
export interface PartialDefinition<T = unknown, P extends PartialsMap = PartialsMap> {
  readonly kind: 'typfolio-partial';
  readonly files: Readonly<Record<string, string>>;
  readonly input: TemplateInput<T>;
  readonly partials: P;
}

// `any` here only so a map of partials with different data types is still a PartialsMap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartialsMap = Readonly<Record<string, PartialDefinition<any, any>>>;

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** The data a map of partials needs, nested partials included, by key. */
export type PartialsData<P extends PartialsMap> = { [K in keyof P]: P[K] extends PartialDefinition<infer T, PartialsMap> ? T : never } &
  UnionToIntersection<{ [K in keyof P]: P[K] extends PartialDefinition<unknown, infer N> ? PartialsData<N> : never }[keyof P]>;

export function definePartial<T, P extends PartialsMap = Record<never, never>>(definition: {
  readonly files: Readonly<Record<string, string>>;
  readonly input: TemplateInput<T>;
  readonly partials?: P;
}): PartialDefinition<T, P> {
  const { files, input, partials = {} as P } = definition ?? ({} as never);
  if (!input || typeof input.path !== 'string') throw new TypeError('definePartial: input must come from defineInput(schema, path)');
  return Object.freeze({ kind: 'typfolio-partial', files: Object.freeze({ ...files }), input, partials: Object.freeze({ ...partials }) as P });
}

/** One runtime input of a compiled template: `key` is `null` for the template's own input. */
export interface TemplateInputSlot {
  readonly key: string | null;
  readonly path: string;
  readonly schema?: StandardSchemaV1;
}

/**
 * A template: its Typst files (its own and every partial's), its entrypoint, and its runtime inputs.
 * `Input` and `Partials` type a request for it.
 */
export interface TemplateDefinition<Input = undefined, Partials = Record<never, never>> {
  readonly kind: 'typfolio-template';
  readonly entrypoint: string;
  readonly files: Readonly<Record<string, string>>;
  readonly inputs: readonly TemplateInputSlot[];
  /** Type-only. */
  readonly '~types'?: { readonly input: Input; readonly partials: Partials };
}

export function defineTemplate<I = undefined, P extends PartialsMap = Record<never, never>>(definition: {
  /** Defaults to `main.typ`. */
  readonly entrypoint?: string;
  readonly files: Readonly<Record<string, string>>;
  readonly input?: TemplateInput<I>;
  readonly partials?: P;
}): TemplateDefinition<I, PartialsData<P>> {
  const { entrypoint = 'main.typ', files, input, partials = {} as P } = definition ?? ({} as never);
  const merged: Record<string, string> = { ...files };
  const slots: TemplateInputSlot[] = [];
  const paths = new Map<string, string>();
  const claim = (path: string, owner: string) => {
    const previous = paths.get(path);
    if (previous !== undefined) throw new TypeError(`defineTemplate: ${owner} and ${previous} both read their input from ${path}`);
    paths.set(path, owner);
  };
  if (input !== undefined) {
    if (typeof input.path !== 'string') throw new TypeError('defineTemplate: input must come from defineInput(schema, path)');
    const path = relativePath(input.path);
    claim(path, 'the template');
    slots.push({ key: null, path, ...(input.schema ? { schema: input.schema } : {}) });
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
      const path = relativePath(partial.input.path);
      claim(path, `partial "${key}"`);
      slots.push({ key, path, ...(partial.input.schema ? { schema: partial.input.schema } : {}) });
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
      throw new TypeError(`defineTemplate: ${path} is an input path; do not list the schema file in files (it is not shipped, the data is mounted there)`);
    }
  }
  return Object.freeze({
    kind: 'typfolio-template',
    entrypoint,
    files: Object.freeze(merged),
    inputs: Object.freeze(slots),
  }) as TemplateDefinition<I, PartialsData<P>>;
}

export function isTemplateDefinition(value: unknown): value is TemplateDefinition<unknown, unknown> {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'typfolio-template';
}

/** A request for a defined template, typed by it: its input and its partials' data. */
export type TemplateRequest<T> = T extends TemplateDefinition<infer I, infer P>
  ? { template: T; assets?: Readonly<Record<string, Uint8Array>>; pdf?: PdfOptions }
    & ([I] extends [undefined] ? { input?: undefined } : unknown extends I ? { input?: unknown } : { input: I })
    & ([keyof P] extends [never] ? { partials?: Record<never, never> } : { partials: P })
  : never;

/**
 * What `compile` checks a request against: one for a template made with `defineTemplate` must be its
 * `TemplateRequest`; any other request is accepted as it is.
 */
export type CheckedRequest<R> = R extends { template: infer T }
  ? T extends TemplateDefinition<unknown, unknown> ? TemplateRequest<T> : unknown
  : unknown;

/** Any request a client accepts: a plain one, one for a defined template, or the low-level form. */
export type AnyPdfRequest =
  | PdfRequest<unknown>
  | DocumentsRequest
  | {
    template: TemplateDefinition<unknown, unknown>;
    input?: unknown;
    partials?: Readonly<Record<string, unknown>>;
    assets?: Readonly<Record<string, Uint8Array>>;
    pdf?: PdfOptions;
  };

/** The low-level form of a request: documents mounted at their schema paths. */
export interface DocumentsRequest {
  template: { entrypoint: string; files: Readonly<Record<string, string>> };
  input: null;
  documents: Readonly<Record<string, unknown>>;
  assets?: Readonly<Record<string, Uint8Array>>;
  pdf?: PdfOptions;
}

function invalidInput(slot: TemplateInputSlot, issues: readonly StandardSchemaIssue[]): TypstPdfError {
  const owner = slot.key === null ? 'The template input' : `The data of partial "${slot.key}"`;
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
 * Turns a request for a defined template into its low-level form, checking each document against its
 * schema. A schema that validates synchronously throws here, before anything is captured; one that
 * returns a promise is checked by the returned `validated`, which the caller awaits before compiling.
 * A plain request passes through.
 */
export function resolveRequest(request: AnyPdfRequest): { request: PdfRequest<unknown> | DocumentsRequest; validated?: Promise<void> } {
  if (!request || !isTemplateDefinition(request.template)) return { request: request as PdfRequest<unknown> };
  const { template, partials = {} } = request as Extract<AnyPdfRequest, { partials?: unknown }> & { template: TemplateDefinition<unknown, unknown> };
  for (const key of Object.keys(partials)) {
    if (!template.inputs.some(slot => slot.key === key)) {
      throw new TypstPdfError('INVALID_REQUEST', `partials.${key}: this template has no partial "${key}"; it has ${template.inputs.filter(slot => slot.key !== null).map(slot => `"${slot.key}"`).join(', ') || 'none'}`);
    }
  }
  const documents: Record<string, unknown> = {};
  const pending: Promise<void>[] = [];
  for (const slot of template.inputs) {
    const value = slot.key === null ? (request as { input?: unknown }).input : (partials as Record<string, unknown>)[slot.key];
    if (value === undefined) {
      throw new TypstPdfError('INVALID_REQUEST', slot.key === null
        ? `The template reads its input from ${slot.path}, but the request has no input`
        : `Partial "${slot.key}" reads its input from ${slot.path}, but the request has no partials.${slot.key}`);
    }
    documents[slot.path] = value;
    if (slot.schema) {
      const result = slot.schema['~standard'].validate(value);
      if (result instanceof Promise) {
        pending.push(result.then(settled => { if (settled.issues) throw invalidInput(slot, settled.issues); }));
      } else if (result.issues) {
        throw invalidInput(slot, result.issues);
      }
    }
  }
  const resolved: DocumentsRequest = {
    template: { entrypoint: template.entrypoint, files: template.files },
    input: null,
    documents,
    ...(request.assets === undefined ? {} : { assets: request.assets }),
    ...(request.pdf === undefined ? {} : { pdf: request.pdf }),
  };
  return pending.length ? { request: resolved, validated: Promise.all(pending).then(() => undefined) } : { request: resolved };
}

/**
 * Files a request carries, referenced from its data by path: `add(bytes, "png")` returns
 * `/attachments/0.png` and keeps the bytes for `assets`. The same bytes added twice share one path.
 */
export function createAttachments(directory = 'attachments'): {
  add(bytes: Uint8Array, extension: string): string;
  readonly assets: Readonly<Record<string, Uint8Array>>;
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

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object' && value !== null && typeof (value as StandardSchemaV1)['~standard']?.validate === 'function';
}

// Paths are checked when compiling, where every file and input path is; here they are only compared.
function relativePath(path: string): string {
  return String(path).replace(/^\/+/, '');
}
