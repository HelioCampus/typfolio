import {
  createAttachments,
  TypstPdfError,
  type Assets,
  type Diagnostic,
  type PdfClient,
  type PdfDocument,
  type PdfOptions,
  type PdfResult,
} from '@typfolio/core';
import { isTemplateDefinition, resolveDocument } from '@typfolio/core/internal';
import { useEffect, useMemo, useRef, useState, type ComponentType, type DependencyList } from 'react';
import { usePdfCompilation, type PdfJob } from './compilation.js';
import { usePdfObjectUrl } from './object-url.js';
import { useRenderedAssets, type RenderAsset, type RenderAssetsOptions } from './rendered-assets.js';

export type PdfStatus = 'idle' | 'drawing' | 'compiling' | 'success' | 'error';

/**
 * Adds a file the PDF shows, such as a logo, and returns its path to put in the data, such as
 * `/attachments/0.png`. The same bytes added twice share one path.
 */
export type AttachFile = (bytes: Uint8Array, extension: string) => string;

/** What a document function gets. */
export interface PdfBuildTools {
  /** Draws a React element (a chart) for the PDF and returns its path, such as `/charts/0.svg`. */
  readonly render: RenderAsset;
  readonly attach: AttachFile;
}

/**
 * A template called with its data, `report(data, { header })`, or a function that returns one. A function
 * gets `render`, which draws a React element (a chart) for the PDF, and `attach`, which adds a file such as
 * a logo; each returns the path to put in the data.
 */
export type PdfSource = PdfDocument | ((tools: PdfBuildTools) => PdfDocument);

export interface UsePdfOptions {
  /**
   * What a document function reads, compared like `useMemo`'s dependencies: a change builds the
   * document again and recompiles. Defaults to `[]`, built once. A document value is compared by its
   * template and its data as JSON instead, so one written inline does not recompile.
   */
  readonly deps?: DependencyList;
  /** Files the template reads that the document does not attach, by path. Compared by reference. */
  readonly assets?: Assets;
  /** PDF output options, such as `{ standards: ['ua-1'] }`. */
  readonly pdf?: PdfOptions;
  /** How `render` draws charts: fonts, the font family, `beforeSerialize`, … */
  readonly charts?: RenderAssetsOptions;
  /** When false, nothing is drawn or compiled. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * The schemas check the data before anything is drawn or compiled; rejected data is reported through
   * `error` and `onError`, and nothing is compiled. `false` skips them: the types still apply.
   */
  readonly validate?: boolean;
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

export interface UsePdfResult {
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
  /** Builds the document again with the same dependencies, draws every chart again, and recompiles. */
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

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// The same template (by reference: it is also its schemas) with the same data.
function sameDocument(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const [x, y] = [a as PdfDocument, b as PdfDocument];
  return x.template === y.template && sameJson(x.data, y.data) && sameJson(x.partials, y.partials);
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

interface Built {
  readonly document: PdfDocument;
  readonly attachments: Readonly<Record<string, Uint8Array>>;
}

// The document, and its schemas unless `validate` is false, checked before anything is drawn. A schema
// that validates asynchronously is checked when the client compiles. A failure here is the hook's error.
function checkDocument(document: PdfDocument, validate: boolean | undefined): void {
  if (isTemplateDefinition(document)) {
    throw new TypstPdfError('INVALID_REQUEST', 'usePdf takes a document: call the template with its data, as in usePdf(report(data, { header: headerData }), options)');
  }
  const { validated } = resolveDocument(document, validate === undefined ? {} : { validate });
  validated?.catch(() => {});
}

function pdfFileName(fileName: string | undefined, title: string | undefined): string {
  const stem = (fileName ?? '').trim().replace(/\.pdf$/i, '') || title?.trim() || 'document';
  return `${stem}.pdf`;
}

/**
 * A PDF, kept up to date with its document, like a query: it draws the document's charts, compiles once
 * they are drawn, and compiles again when `deps`, `assets` or `pdf` change. A newer compile replaces an
 * older one. The document is the template called with its data, as `compile` takes it.
 *
 * ```tsx
 * const pdf = usePdf(
 *   ({ render, attach }) => report( // defineTemplate({ ..., partials: { header } }), outside the component
 *     { rows: rows.map(row => ({ ...row, chart: render(<Chart row={row} />) })) },
 *     { header: { institution, logo: attach(logo, 'png') } },
 *   ),
 *   { client, deps: [rows, institution, logo] }, // client: createLazyCompiler({ wasm, fonts }), created once
 * );
 * return <><pdf.AssetRenderer /><a href={pdf.url}>Open PDF</a></>;
 * ```
 */
export function usePdf(source: PdfSource, options: UsePdfOptions): UsePdfResult {
  const { deps = [], pdf: pdfOptions, charts, enabled = true, validate } = options;
  const assets = useStable(options.assets, sameRecord);
  // A template is a function too: called with the tools, it would make a document of them.
  const builds = typeof source === 'function' && !isTemplateDefinition(source);
  // A document value is compared by its template and its data, and only when its reference changes.
  const held = useStable<unknown>(source, (a, b) => !builds && sameDocument(a, b));
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const rendered = useRenderedAssets<Built>(
    ({ render }) => {
      const files = createAttachments();
      let open = true;
      const attach: AttachFile = (bytes, extension) => {
        if (!open) throw new Error('usePdf: attach was called after the document function returned; call it only inside it');
        return files.add(bytes, extension);
      };
      try {
        const value = builds ? (held as (tools: PdfBuildTools) => PdfDocument)({ render, attach }) : held as PdfDocument;
        return { document: value, attachments: files.assets };
      } finally {
        open = false;
      }
    },
    {
      ...charts,
      // Same length either way: a document value is its own dependency.
      deps: [builds ? null : held, validate, ...deps],
      enabled,
      validate: built => checkDocument(built.document, validate),
      onError: error => {
        latest.current.onError?.(error);
        latest.current.onSettled?.(undefined, error);
      },
    },
  );

  const compilation = usePdfCompilation({ client: options.client });
  // Compared as text, so `pdf: { standards: ['ua-1'] }` written inline does not recompile.
  const pdfKey = JSON.stringify(pdfOptions ?? null);
  const request = useMemo<PdfJob | undefined>(() => {
    if (rendered.status !== 'ready' || rendered.assets === undefined) return undefined;
    const { document: built, attachments } = rendered.value;
    const files = { ...assets, ...attachments, ...rendered.assets };
    return {
      document: built,
      ...(Object.keys(files).length > 0 ? { assets: files } : {}),
      ...(pdfOptions === undefined ? {} : { pdf: pdfOptions }),
      ...(validate === undefined ? {} : { validate }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered.status, rendered.value, rendered.assets, assets, pdfKey]);

  // The request the newest compile started for: until the effect below starts one for a new
  // request, the hook already reports it as compiling.
  const [started, setStarted] = useState<PdfJob>();
  const { compile } = compilation;
  // The request the newest finished PDF is for: enabling again with nothing changed reuses it.
  const succeeded = useRef<PdfJob>(undefined);
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
