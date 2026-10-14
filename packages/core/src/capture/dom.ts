import {
  TypfolioCaptureError,
  type CaptureAdapter,
  type CaptureAdapterContext,
} from '../capture.js';

interface Html2CanvasOptions {
  readonly backgroundColor?: string | null;
  readonly imageTimeout?: number;
  readonly logging: boolean;
  readonly onclone: (document: Document, element: HTMLElement) => void;
  readonly scale?: number;
  readonly useCORS: boolean;
}

type Html2Canvas = (
  element: HTMLElement,
  options: Html2CanvasOptions,
) => Promise<HTMLCanvasElement>;

interface DefaultModule {
  readonly default: unknown;
}

let html2canvasLoader: Promise<Html2Canvas> | undefined;

function isHtml2Canvas(value: unknown): value is Html2Canvas {
  return typeof value === 'function';
}

function hasDefault(value: unknown): value is DefaultModule {
  return typeof value === 'object' && value !== null && 'default' in value;
}

/** Shared by concurrent callers, so it carries no capture identity. */
class Html2CanvasImportError extends Error {}

async function loadHtml2Canvas(): Promise<Html2Canvas> {
  let imported: unknown;
  try {
    imported = await import('html2canvas');
  } catch (cause) {
    throw new Html2CanvasImportError('html2canvas could not be imported', { cause });
  }
  if (isHtml2Canvas(imported)) return imported;
  if (hasDefault(imported) && isHtml2Canvas(imported.default)) return imported.default;
  throw new TypeError('html2canvas did not provide its expected default function');
}

function getHtml2Canvas(): Promise<Html2Canvas> {
  if (html2canvasLoader === undefined) {
    html2canvasLoader = loadHtml2Canvas().catch(cause => {
      html2canvasLoader = undefined;
      throw cause;
    });
  }
  return html2canvasLoader;
}

export interface DomPngRasterizeOptions {
  readonly pixelRatio?: number;
  readonly backgroundColor?: string | null;
  readonly useCORS: boolean;
  readonly imageTimeoutMs?: number;
  readonly logging: boolean;
  readonly removeSelectors: readonly string[];
}

export type DomPngRasterizer = (
  element: HTMLElement,
  options: DomPngRasterizeOptions,
) => Promise<HTMLCanvasElement>;

export interface DomPngCaptureOptions {
  /** Defaults to the browser device pixel ratio. */
  readonly pixelRatio?: number;
  /** Omit for html2canvas's white default; pass null for transparency. */
  readonly backgroundColor?: string | null;
  readonly useCORS?: boolean;
  readonly imageTimeoutMs?: number;
  readonly logging?: boolean;
  readonly removeSelectors?: readonly string[];
  /** Custom-host and test escape hatch. */
  readonly rasterize?: DomPngRasterizer;
}

async function defaultRasterizer(
  element: HTMLElement,
  options: DomPngRasterizeOptions,
  context: CaptureAdapterContext,
): Promise<HTMLCanvasElement> {
  let html2canvas: Html2Canvas;
  try {
    html2canvas = await getHtml2Canvas();
  } catch (error) {
    if (!(error instanceof Html2CanvasImportError)) throw error;
    throw new TypfolioCaptureError(
      'CAPTURE_FAILED',
      'DOM PNG capture could not load html2canvas. Install html2canvas or pass a custom rasterize function to domPngCapture.',
      context.captureId,
      context.path,
      { cause: error.cause },
    );
  }
  return html2canvas(element, {
    backgroundColor: options.backgroundColor,
    imageTimeout: options.imageTimeoutMs,
    logging: options.logging,
    onclone(_document, clonedElement) {
      for (const selector of options.removeSelectors) {
        for (const removable of clonedElement.querySelectorAll(selector)) removable.remove();
      }
    },
    scale: options.pixelRatio,
    useCORS: options.useCORS,
  });
}

function checkAbort(context: CaptureAdapterContext): void {
  if (!context.signal?.aborted) return;
  throw new TypfolioCaptureError(
    'ABORTED',
    'DOM capture was cancelled',
    context.captureId,
    context.path,
    { cause: context.signal.reason },
  );
}

function pngBytes(canvas: HTMLCanvasElement, context: CaptureAdapterContext): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (blob === null) {
          reject(new TypfolioCaptureError(
            'CAPTURE_FAILED',
            `Capture ${context.captureId} could not encode a PNG`,
            context.captureId,
            context.path,
          ));
          return;
        }
        void blob.arrayBuffer().then(
          buffer => resolve(new Uint8Array(buffer)),
          cause => reject(new TypfolioCaptureError(
            'CAPTURE_FAILED',
            `Capture ${context.captureId} could not read its PNG`,
            context.captureId,
            context.path,
            { cause },
          )),
        );
      }, 'image/png');
    } catch (cause) {
      reject(new TypfolioCaptureError(
        'CAPTURE_FAILED',
        `Capture ${context.captureId} could not encode a PNG`,
        context.captureId,
        context.path,
        { cause },
      ));
    }
  });
}

export function domPngCapture({
  pixelRatio,
  backgroundColor,
  useCORS = false,
  imageTimeoutMs,
  logging = false,
  removeSelectors = [],
  rasterize,
}: DomPngCaptureOptions = {}): CaptureAdapter {
  if (pixelRatio !== undefined && (!Number.isFinite(pixelRatio) || pixelRatio <= 0)) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'DOM pixelRatio must be greater than zero');
  }
  if (imageTimeoutMs !== undefined && (!Number.isInteger(imageTimeoutMs) || imageTimeoutMs < 0)) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'DOM imageTimeoutMs must be a non-negative integer');
  }
  if (removeSelectors.some(value => !value.trim())) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'DOM removeSelectors must be non-empty');
  }
  const selectors = Object.freeze([...removeSelectors]);

  return Object.freeze({
    name: 'DOM PNG capture',
    extensions: Object.freeze(['.png']),
    async capture(element: Element, context: CaptureAdapterContext): Promise<Uint8Array> {
      checkAbort(context);
      const view = element.ownerDocument.defaultView;
      if (view === null || !(element instanceof view.HTMLElement)) {
        throw new TypfolioCaptureError(
          'NOT_READY',
          `Capture ${context.captureId} is not an HTML element in a live document`,
          context.captureId,
          context.path,
        );
      }
      const bounds = element.getBoundingClientRect();
      if (!(bounds.width > 0) || !(bounds.height > 0)) {
        throw new TypfolioCaptureError(
          'NOT_READY',
          `Capture ${context.captureId} has no rendered size`,
          context.captureId,
          context.path,
        );
      }
      const rasterizeOptions: DomPngRasterizeOptions = {
        pixelRatio,
        backgroundColor,
        useCORS,
        imageTimeoutMs,
        logging,
        removeSelectors: selectors,
      };
      const canvas = rasterize === undefined
        ? await defaultRasterizer(element, rasterizeOptions, context)
        : await rasterize(element, rasterizeOptions);
      checkAbort(context);
      const bytes = await pngBytes(canvas, context);
      checkAbort(context);
      return bytes;
    },
  });
}
