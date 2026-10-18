import type { Diagnostic, PdfClient, PdfOptions, PdfRequest, PdfResult, PdfTemplate } from '@typfolio/core';
import { useEffect, useMemo, useRef, useState, type ComponentType, type DependencyList } from 'react';
import { usePdfCompilation } from './compilation.js';
import { usePdfObjectUrl } from './object-url.js';
import { useRenderedAssets, type RenderAsset, type RenderAssetsOptions } from './rendered-assets.js';

export type PdfStatus = 'idle' | 'drawing' | 'compiling' | 'success' | 'error';

export interface UsePdfOptions<Input> {
  /** Keep it stable (defined outside the component, or memoized): a new template recompiles. */
  readonly template: PdfTemplate;
  /**
   * The template input, or a function that builds it. A function gets `render`, which draws a
   * React element (a chart) for the PDF and returns its asset path to put in the input.
   */
  readonly input: Input | ((tools: { readonly render: RenderAsset }) => Input);
  /**
   * What a function `input` reads, compared like `useMemo`'s dependencies: a change builds the
   * input again and recompiles. Defaults to `[]`, built once. A plain `input` value is compared
   * by reference instead.
   */
  readonly deps?: DependencyList;
  /** Files the template reads besides drawn charts, such as a logo. Compared by reference. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
  /** PDF output options, such as `{ standards: ['ua-1'] }`. */
  readonly pdf?: PdfOptions;
  /** How `render` draws charts: fonts, the font family, `beforeSerialize`, … */
  readonly charts?: RenderAssetsOptions;
  /** When false, nothing is drawn or compiled. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Checks the built input before anything is drawn or compiled: throw to reject it, for example
   * `validate: input => schema.parse(input)` with your schema library. A rejected input is
   * reported through `error` and `onError`, and nothing is compiled.
   */
  readonly validate?: (input: Input) => void;
  /** Compiles with this client instead of the one from `PdfProvider`. */
  readonly client?: PdfClient;
  readonly onSuccess?: (result: PdfResult) => void;
  /** A rejected input, a chart that could not be drawn, or a compile that failed. */
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

function sameTemplate(a: PdfTemplate, b: PdfTemplate): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
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

function pdfFileName(fileName: string | undefined, title: string | undefined): string {
  const stem = (fileName ?? '').trim().replace(/\.pdf$/i, '') || title?.trim() || 'document';
  return `${stem}.pdf`;
}

/**
 * A PDF, kept up to date with its inputs, like a query: it draws the input's charts, compiles
 * once they are drawn, and compiles again when `deps`, `assets`, `template` or `pdf` change. A
 * newer compile replaces an older one. Uses `client`, or the one from `PdfProvider`.
 *
 * ```tsx
 * const pdf = usePdf({
 *   template,
 *   input: ({ render }) => ({ rows: rows.map(row => ({ ...row, chart: render(<Chart row={row} />) })) }),
 *   deps: [rows],
 * });
 * return <><pdf.AssetRenderer /><a href={pdf.url}>Open PDF</a></>;
 * ```
 */
export function usePdf<Input>(options: UsePdfOptions<Input>): PdfDocument {
  const { deps = [], pdf: pdfOptions, charts, enabled = true } = options;
  const template = useStable(options.template, sameTemplate);
  const assets = useStable(options.assets, sameRecord);
  const builds = typeof options.input === 'function';
  // A plain input value is compared as JSON, and only when its reference changes.
  const input = useStable(options.input, (a, b) => !builds && typeof a !== 'function' && sameJson(a, b));
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const rendered = useRenderedAssets<Input>(
    builds ? input as (tools: { readonly render: RenderAsset }) => Input : () => input as Input,
    {
      ...charts,
      // Same length either way: a plain value is its own dependency.
      deps: [builds ? null : input, ...deps],
      enabled,
      validate: options.validate,
      onError: error => {
        latest.current.onError?.(error);
        latest.current.onSettled?.(undefined, error);
      },
    },
  );

  const compilation = usePdfCompilation({ client: options.client });
  // Compared as text, so `pdf: { standards: ['ua-1'] }` written inline does not recompile.
  const pdfKey = JSON.stringify(pdfOptions ?? null);
  const request = useMemo<PdfRequest<unknown> | undefined>(() => {
    if (rendered.status !== 'ready' || rendered.assets === undefined) return undefined;
    const files = { ...assets, ...rendered.assets };
    return {
      template,
      input: rendered.value,
      ...(Object.keys(files).length > 0 ? { assets: files } : {}),
      ...(pdfOptions === undefined ? {} : { pdf: pdfOptions }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered.status, rendered.value, rendered.assets, assets, template, pdfKey]);

  // The request the newest compile started for: until the effect below starts one for a new
  // request, the hook already reports it as compiling.
  const [started, setStarted] = useState<PdfRequest<unknown>>();
  const { compile } = compilation;
  // The request the newest finished PDF is for: enabling again with nothing changed reuses it.
  const succeeded = useRef<PdfRequest<unknown>>(undefined);
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
