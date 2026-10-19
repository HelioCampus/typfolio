import type { AnyPdfRequest, CheckedRequest } from './definition.js';
import { bundledPackageSpec } from './typst-package.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WasmSource = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
/** Font bytes, or a URL (or string, resolved against the page URL when one exists) that `createCompiler` fetches. */
export type FontSource = Uint8Array | string | URL;

export const pdfStandards = ['1.4', '1.5', '1.6', '1.7', '2.0', 'a-1b', 'a-1a', 'a-2b', 'a-2u', 'a-2a', 'a-3b', 'a-3u', 'a-3a', 'a-4', 'a-4f', 'a-4e', 'ua-1'] as const;
export type PdfStandard = typeof pdfStandards[number];

export interface PdfOptions {
  /** The pinned binding supports zero or one standard per request. */
  standards?: readonly PdfStandard[];
  tags?: boolean;
  /** Unix seconds, used when the document date is auto. */
  creationTimestamp?: number;
}

/**
 * A string is a single-file template: it is mounted as `/main.typ` and used as the entrypoint, so
 * compile diagnostics report the path `/main.typ`. In the object form, `entrypoint` defaults to
 * `main.typ`; `files` must then contain it.
 */
export type PdfTemplate = string | { entrypoint?: string; files: Readonly<Record<string, string>> };

/**
 * `Input` types `input` for the caller and is intentionally unconstrained: a TypeScript `interface` is
 * not assignable to the `JsonValue` index-signature type, so a constraint would reject ordinary
 * application types. This is type-only; `prepareRequest` still enforces JSON compatibility at runtime.
 * Positions that accept a request take `PdfRequest<unknown>` so any typed request is accepted.
 */
export interface PdfRequest<Input = JsonValue> {
  template: PdfTemplate;
  input: Input;
  assets?: Readonly<Record<string, Uint8Array>>;
  pdf?: PdfOptions;
}

/** A failure Typfolio recognises; `docs/errors.md` explains each and what to do. */
export type DiagnosticCode = 'file-not-found' | 'missing-glyph';

export interface Diagnostic {
  severity: 'error' | 'warning' | string;
  message: string;
  path?: string;
  /** Upstream range: zero-based line:column-line:column. */
  range?: string;
  package?: string;
  /** Set on a failure Typfolio recognises; switch on it rather than on `message`. */
  code?: DiagnosticCode;
  /** `file-not-found`: the missing file, as an absolute virtual path. */
  file?: string;
  /** `missing-glyph`: the text none of the loaded fonts can display. */
  text?: string;
}

/** The section of docs/errors.md that explains `code`. */
export const errorLink = (code: DiagnosticCode) => `https://github.com/HelioCampus/typfolio/blob/main/docs/errors.md#${code}`;

export interface PdfResult {
  bytes: Uint8Array;
  diagnostics: readonly Diagnostic[];
  metadata: { title?: string };
}

export interface PdfClient {
  /** A plain request, or one for a template made with `defineTemplate`, type-checked against its `TemplateRequest`. */
  compile<R extends AnyPdfRequest>(request: R & CheckedRequest<R>, options?: { signal?: AbortSignal }): Promise<PdfResult>;
}

export interface PdfCompiler extends PdfClient {
  readonly capabilities: typeof capabilities;
  /** Stops accepting jobs; waits for an accepted job and frees this compiler. */
  dispose(): Promise<void>;
}

export const capabilities = Object.freeze({
  output: 'pdf',
  standards: Object.freeze([...pdfStandards]),
  maximumStandards: 1,
  tags: true,
  creationTimestamp: true,
  pageRanges: false,
  experimentalFeatures: false,
  remotePackages: false,
  /** Typst packages importable from templates; only the one bundled with core. */
  typstPackages: Object.freeze([bundledPackageSpec]),
  hardCancellation: false,
} as const);

/** `INVALID_INPUT`: a defined template's input, or a partial's data, does not match its schema. */
export type ErrorCode = 'INITIALIZATION' | 'INVALID_REQUEST' | 'INVALID_INPUT' | 'UNSUPPORTED_OPTION' | 'BUSY' | 'DISPOSED' | 'ABORTED' | 'COMPILATION' | 'ENGINE';

export class TypstPdfError extends Error {
  readonly name = 'TypstPdfError';
  constructor(readonly code: ErrorCode, message: string, readonly diagnostics: readonly Diagnostic[] = [], options?: ErrorOptions) {
    super(message, options);
  }
}
