import {
  createAttachments,
  type AnyPdfRequest,
  type Diagnostic,
  type PdfClient,
  type PdfOptions,
  type PdfResult,
  type PdfTemplate,
  type TemplateDefinition,
} from '@typfolio/core';
import { isTemplateDefinition, resolveRequest } from '@typfolio/core/internal';
import { useEffect, useMemo, useRef, useState, type ComponentType, type DependencyList } from 'react';
import { usePdfCompilation } from './compilation.js';
import { usePdfObjectUrl } from './object-url.js';
import { useRenderedAssets, type RenderAsset, type RenderAssetsOptions } from './rendered-assets.js';

export type PdfStatus = 'idle' | 'drawing' | 'compiling' | 'success' | 'error';

/**
 * Adds a file the PDF shows, such as a logo, and returns its path to put in the data, such as
 * `/attachments/0.png`. The same bytes added twice share one path.
 */
export type AttachFile = (bytes: Uint8Array, extension: string) => string;

/** What a `data` function gets. */
export interface PdfBuildTools {
  /** Draws a React element (a chart) for the PDF and returns its path, such as `/charts/0.svg`. */
  readonly render: RenderAsset;
  readonly attach: AttachFile;
}

/** A template made with `defineTemplate`, or a plain one. */
export type AnyPdfTemplate = PdfTemplate | TemplateDefinition<unknown, unknown>;

/**
 * The data a template reads: for one made with `defineTemplate`, its input and the data of each of
 * its partials, typed by it; for a plain template, its `input`.
 */
export type PdfData<T> = T extends TemplateDefinition<infer Input, infer Partials>
  ? ([Input] extends [undefined] ? { readonly input?: undefined } : { readonly input: Input })
    & ([keyof Partials] extends [never] ? { readonly partials?: Record<never, never> } : { readonly partials: Partials })
  : { readonly input?: unknown; readonly partials?: undefined };

export interface UsePdfOptions<T extends AnyPdfTemplate = AnyPdfTemplate> {
  /** Keep it stable (defined outside the component, or memoized): a new template recompiles. */
  readonly template: T;
  /**
   * The data, `{ input, partials }`, or a function that builds it. A function gets `render`,
   * which draws a React element (a chart) for the PDF, and `attach`, which adds a file such as a
   * logo; each returns the path to put in the data.
   */
  readonly data: PdfData<T> | ((tools: PdfBuildTools) => PdfData<T>);
  /**
   * What a `data` function reads, compared like `useMemo`'s dependencies: a change builds the
   * data again and recompiles. Defaults to `[]`, built once. A plain `data` value is compared as
   * JSON instead, so an object written inline does not recompile.
   */
  readonly deps?: DependencyList;
  /** Files the template reads that `data` does not attach, by path. Compared by reference. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
  /** PDF output options, such as `{ standards: ['ua-1'] }`. */
  readonly pdf?: PdfOptions;
  /** How `render` draws charts: fonts, the font family, `beforeSerialize`, … */
  readonly charts?: RenderAssetsOptions;
  /** When false, nothing is drawn or compiled. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Checks the built data before anything is drawn or compiled: throw to reject it. A template
   * made with `defineTemplate` checks its schemas itself (before drawing, too); use this for a
   * plain template, for example `validate: data => schema.parse(data.input)`. Rejected data is
   * reported through `error` and `onError`, and nothing is compiled.
   */
  readonly validate?: (data: PdfData<T>) => void;
  /**
   * The client that compiles: `createLazyCompiler(...)` from `@typfolio/core`, or a worker client from
   * `@typfolio/workers`. Create it once, outside components; the hook neither creates nor disposes it.
   */
  readonly client: PdfClient;
  readonly onSuccess?: (result: PdfResult) => void;
  /** Data that does not match its schema, a chart that could not be drawn, or a compile that failed. */
  readonly onError?: (error: unknown) => void;
  readonly onSettled?: (result: PdfResult | undefined, error: unknown) => void;
}

export interface PdfDocument {
  readonly status: PdfStatus;
  /** The newest PDF; kept while a newer one draws or compiles. */
  readonly result?: PdfResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly error?: unknown;
  /** No PDF yet, and one is on its way. */
  readonly isLoading: boolean;
  /** Drawing or compiling, possibly with an older PDF still in `result`. */
  readonly isFetching: boolean;
  readonly isSuccess: boolean;
  readonly isError: boolean;
  /** An object URL of `result`, revoked when it is replaced or the component unmounts. */
  readonly url?: string;
  /** Downloads `result`. `.pdf` is added once; defaults to the PDF's title, then `document`. */
  readonly download: (fileName?: string) => void;
  /** Builds the input again with the same dependencies, draws every chart again, and recompiles. */
  readonly rebuild: () => void;
  /** Stops the compile in flight; the newest finished PDF stays in `result`. */
  readonly cancel: () => void;
  /** Render it anywhere in your tree: the PDF's charts draw inside it, off the page. */
  readonly AssetRenderer: ComponentType;
}

const emptyDiagnostics: readonly Diagnostic[] = Object.freeze([]);

function sameRecord<V>(a: Readonly<Record<string, V>> | undefined, b: Readonly<Record<string, V>> | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

function sameTemplate(a: AnyPdfTemplate, b: AnyPdfTemplate): boolean {
  // A defined template is also its schemas: it is the same only by reference.
  if (typeof a === 'string' || typeof b === 'string' || isTemplateDefinition(a) || isTemplateDefinition(b)) return a === b;
  return a.entrypoint === b.entrypoint && sameRecord(a.files, b.files);
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * The previous value while `same` says it is unchanged, so an object written inline in JSX (a
 * new object on every render) does not count as a change. `same` runs only when the reference
 * changes.
 */
function useStable<V>(value: V, same: (a: V, b: V) => boolean): V {
  const held = useRef(value);
  if (!Object.is(held.current, value) && !same(held.current, value)) held.current = value;
  return held.current;
}

interface Data {
  readonly input?: unknown;
  readonly partials?: Readonly<Record<string, unknown>>;
}

interface Built {
  readonly data: Data;
  readonly attachments: Readonly<Record<string, Uint8Array>>;
}

// A defined template's schemas, checked before anything is drawn. One that validates
// asynchronously is checked when the client compiles.
function checkSchemas(template: AnyPdfTemplate, data: Data): void {
  if (!isTemplateDefinition(template)) return;
  const { validated } = resolveRequest({ template, input: data.input, partials: data.partials });
  validated?.catch(() => {});
}

function pdfFileName(fileName: string | undefined, title: string | undefined): string {
  const stem = (fileName ?? '').trim().replace(/\.pdf$/i, '') || title?.trim() || 'document';
  return `${stem}.pdf`;
}

/**
 * A PDF, kept up to date with its data, like a query: it draws the data's charts, compiles once
 * they are drawn, and compiles again when `deps`, `assets`, `template` or `pdf` change. A newer
 * compile replaces an older one.
 *
 * ```tsx
 * const pdf = usePdf({
 *   client, // createLazyCompiler({ wasm, fonts }), created once
 *   template: report, // defineTemplate({ ..., partials: { header } })
 *   data: ({ render, attach }) => ({
 *     input: { rows: rows.map(row => ({ ...row, chart: render(<Chart row={row} />) })) },
 *     partials: { header: { institution, logo: attach(logo, 'png') } },
 *   }),
 *   deps: [rows, institution, logo],
 * });
 * return <><pdf.AssetRenderer /><a href={pdf.url}>Open PDF</a></>;
 * ```
 */
export function usePdf<T extends AnyPdfTemplate>(options: UsePdfOptions<T>): PdfDocument {
  const { deps = [], pdf: pdfOptions, charts, enabled = true } = options;
  const template = useStable<AnyPdfTemplate>(options.template, sameTemplate);
  const assets = useStable(options.assets, sameRecord);
  const builds = typeof options.data === 'function';
  // A plain data value is compared as JSON, and only when its reference changes.
  const data = useStable<unknown>(options.data, (a, b) => !builds && typeof a !== 'function' && sameJson(a, b));
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const rendered = useRenderedAssets<Built>(
    ({ render }) => {
      const files = createAttachments();
      let open = true;
      const attach: AttachFile = (bytes, extension) => {
        if (!open) throw new Error('usePdf: attach was called after data returned; call it only inside data');
        return files.add(bytes, extension);
      };
      try {
        const value = builds ? (data as (tools: PdfBuildTools) => Data)({ render, attach }) : data as Data;
        return { data: value ?? {}, attachments: files.assets };
      } finally {
        open = false;
      }
    },
    {
      ...charts,
      // Same length either way: a plain value is its own dependency.
      deps: [builds ? null : data, ...deps],
      enabled,
      validate: built => {
        checkSchemas(template, built.data);
        options.validate?.(built.data as PdfData<T>);
      },
      onError: error => {
        latest.current.onError?.(error);
        latest.current.onSettled?.(undefined, error);
      },
    },
  );

  const compilation = usePdfCompilation({ client: options.client });
  // Compared as text, so `pdf: { standards: ['ua-1'] }` written inline does not recompile.
  const pdfKey = JSON.stringify(pdfOptions ?? null);
  const request = useMemo<AnyPdfRequest | undefined>(() => {
    if (rendered.status !== 'ready' || rendered.assets === undefined) return undefined;
    const { data: value, attachments } = rendered.value;
    const files = { ...assets, ...attachments, ...rendered.assets };
    const rest = {
      ...(Object.keys(files).length > 0 ? { assets: files } : {}),
      ...(pdfOptions === undefined ? {} : { pdf: pdfOptions }),
    };
    if (!isTemplateDefinition(template)) return { template, input: value.input ?? null, ...rest };
    return {
      template,
      ...(value.input === undefined ? {} : { input: value.input }),
      ...(value.partials === undefined ? {} : { partials: value.partials }),
      ...rest,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered.status, rendered.value, rendered.assets, assets, template, pdfKey]);

  // The request the newest compile started for: until the effect below starts one for a new
  // request, the hook already reports it as compiling.
  const [started, setStarted] = useState<AnyPdfRequest>();
  const { compile } = compilation;
  // The request the newest finished PDF is for: enabling again with nothing changed reuses it.
  const succeeded = useRef<AnyPdfRequest>(undefined);
  const { cancel } = compilation;
  useEffect(() => {
    // Disabled (an export dialog closed, say): stop the compile in flight; nothing late is reported.
    if (!enabled) cancel();
  }, [enabled, cancel]);
  useEffect(() => {
    if (!enabled || request === undefined || succeeded.current === request) return;
    setStarted(request);
    compile(request, {
      onSuccess: result => {
        succeeded.current = request;
        latest.current.onSuccess?.(result);
        latest.current.onSettled?.(result, undefined);
      },
      onError: error => {
        latest.current.onError?.(error);
        latest.current.onSettled?.(undefined, error);
      },
    }).catch(() => {
      // Reported through the callbacks above and the hook's state; a superseded compile is
      // simply dropped.
    });
  }, [enabled, request, compile]);

  let status: PdfStatus;
  let error: unknown;
  if (rendered.status === 'error') {
    status = 'error';
    error = rendered.error;
  } else if (rendered.status === 'drawing') {
    status = 'drawing';
  } else if (!enabled || request === undefined) {
    status = compilation.status === 'success' ? 'success' : 'idle';
  } else if (succeeded.current === request && compilation.status === 'success') {
    status = 'success';
  } else if (started !== request || compilation.status === 'compiling') {
    status = 'compiling';
  } else if (compilation.status === 'error') {
    status = 'error';
    error = compilation.error;
  } else if (compilation.status === 'success') {
    status = 'success';
  } else {
    status = 'idle';
  }

  const result = compilation.result;
  const url = usePdfObjectUrl(result);
  const latestResult = useRef(result);
  useEffect(() => {
    latestResult.current = result;
  });
  const [download] = useState(() => (fileName?: string) => {
    const current = latestResult.current;
    if (current === undefined) return;
    const name = pdfFileName(fileName, current.metadata.title);
    // A URL of our own, revoked after the browser has taken the download: revoking it at once
    // can make a browser name the file after the blob instead of `download`.
    const href = URL.createObjectURL(new Blob([Uint8Array.from(current.bytes)], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(href);
    }, 0);
  });

  const fetching = status === 'drawing' || status === 'compiling';
  return {
    status,
    result,
    diagnostics: result?.diagnostics ?? emptyDiagnostics,
    error,
    isLoading: fetching && result === undefined,
    isFetching: fetching,
    isSuccess: status === 'success',
    isError: status === 'error',
    url,
    download,
    rebuild: rendered.rebuild,
    cancel: compilation.cancel,
    AssetRenderer: rendered.AssetRenderer,
  };
}
