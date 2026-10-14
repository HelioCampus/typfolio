import type { PdfRequest } from './types.js';

const idAttribute = 'data-typfolio-capture';
const kindAttribute = 'data-typfolio-capture-kind';
const altAttribute = 'data-typfolio-capture-alt';
const decorativeAttribute = 'data-typfolio-capture-decorative';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const extensionPattern = /^\.[a-z0-9]+$/;

export type CaptureErrorCode =
  | 'ABORTED'
  | 'AMBIGUOUS'
  | 'CAPTURE_FAILED'
  | 'DUPLICATE_ID'
  | 'EMPTY_ASSET'
  | 'INVALID_ACCESSIBILITY'
  | 'INVALID_OPTIONS'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'UNKNOWN_KIND';

export class TypfolioCaptureError extends Error {
  readonly name = 'TypfolioCaptureError';

  constructor(
    readonly code: CaptureErrorCode,
    message: string,
    readonly captureId?: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CaptureAdapterContext {
  readonly captureId: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}

export interface CaptureAdapter {
  readonly name: string;
  /**
   * Lowercase file suffixes, each a period followed by letters or digits.
   * The first one is used for derived asset paths.
   */
  readonly extensions: readonly string[];
  readonly capture: (
    element: Element,
    context: CaptureAdapterContext,
  ) => Uint8Array | Promise<Uint8Array>;
}

/**
 * Describes one capturable region. Provide `altText`, or `decorative: true`
 * for images that carry no information.
 */
export type CaptureMarker =
  | {
    readonly id: string;
    readonly kind: string;
    readonly altText: string;
    readonly decorative?: false;
  }
  | {
    readonly id: string;
    readonly kind: string;
    readonly decorative: true;
    readonly altText?: never;
  };

export type CapturedAssetReference =
  | { readonly path: string; readonly decorative: false; readonly altText: string }
  | { readonly path: string; readonly decorative: true };

export interface CapturedAssets {
  readonly assets: NonNullable<PdfRequest['assets']>;
  /** JSON-safe metadata keyed by region id, suitable for request.input. */
  readonly references: Readonly<Record<string, CapturedAssetReference>>;
}

export interface CaptureAssetsOptions {
  /** Adapters keyed by region kind. */
  readonly adapters: Readonly<Record<string, CaptureAdapter>>;
  /** Region ids that must be present; a missing one fails with NOT_FOUND. */
  readonly require?: readonly string[];
  readonly signal?: AbortSignal;
}

function validateIdentity(id: unknown, kind: unknown): asserts id is string {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new TypfolioCaptureError(
      'INVALID_OPTIONS',
      'Capture id must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
      typeof id === 'string' ? id : undefined,
    );
  }
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new TypfolioCaptureError(
      'INVALID_OPTIONS',
      `Capture ${id} requires a non-empty kind`,
      id,
    );
  }
}

/**
 * Returns the data attributes that mark an element as a capture region. They
 * are semantic-neutral: no role or accessible name is added. Spread them onto
 * any element in any framework.
 *
 * Empty alt text is emitted as given so a component can render before its data
 * is ready; `captureAssets` rejects it when the region is captured.
 */
export function captureProps(marker: CaptureMarker): Readonly<Record<string, string>> {
  validateIdentity(marker?.id, marker?.kind);
  const props: Record<string, string> = {
    [idAttribute]: marker.id,
    [kindAttribute]: marker.kind,
  };
  if (marker.decorative === true) props[decorativeAttribute] = '';
  if (typeof marker.altText === 'string') props[altAttribute] = marker.altText;
  return Object.freeze(props);
}

function checkAbort(signal: AbortSignal | undefined, captureId?: string, path?: string): void {
  if (!signal?.aborted) return;
  throw new TypfolioCaptureError(
    'ABORTED',
    'Asset capture was cancelled',
    captureId,
    path,
    { cause: signal.reason },
  );
}

function validateAdapter(kind: string, adapter: CaptureAdapter | undefined): void {
  if (
    !adapter ||
    typeof adapter.name !== 'string' ||
    !adapter.name.trim() ||
    !Array.isArray(adapter.extensions) ||
    adapter.extensions.length === 0 ||
    adapter.extensions.some(extension => (
      typeof extension !== 'string' || !extensionPattern.test(extension)
    )) ||
    typeof adapter.capture !== 'function'
  ) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', `The adapter for kind ${kind} is invalid`);
  }
}

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

interface PlannedCapture {
  readonly id: string;
  readonly path: string;
  readonly element: Element;
  readonly adapter: CaptureAdapter;
  readonly reference: CapturedAssetReference;
}

function discover(
  root: ParentNode,
  adapters: Readonly<Record<string, CaptureAdapter>>,
  required: readonly string[],
): PlannedCapture[] {
  const elements: Element[] = [];
  if (isElement(root) && root.hasAttribute(idAttribute)) elements.push(root);
  elements.push(...root.querySelectorAll(`[${idAttribute}]`));

  const planned = new Map<string, PlannedCapture>();
  for (const element of elements) {
    const id = element.getAttribute(idAttribute);
    validateIdentity(id, element.getAttribute(kindAttribute));
    const kind = element.getAttribute(kindAttribute) as string;
    if (planned.has(id)) {
      throw new TypfolioCaptureError(
        'DUPLICATE_ID',
        `More than one capture region uses the ID ${id}`,
        id,
      );
    }
    if (!Object.hasOwn(adapters, kind)) {
      throw new TypfolioCaptureError(
        'UNKNOWN_KIND',
        `Capture ${id} has kind ${kind}, which has no adapter`,
        id,
      );
    }
    const adapter = adapters[kind];
    const path = `captures/${id}${adapter.extensions[0]}`;

    const altText = element.getAttribute(altAttribute);
    const decorative = element.hasAttribute(decorativeAttribute);
    let reference: CapturedAssetReference;
    if (decorative && altText === null) {
      reference = Object.freeze({ path, decorative: true });
    } else if (!decorative && altText !== null && altText.trim()) {
      reference = Object.freeze({ path, decorative: false, altText: altText.trim() });
    } else {
      throw new TypfolioCaptureError(
        'INVALID_ACCESSIBILITY',
        `Capture ${id} requires either non-empty alt text or to be marked decorative, not both or neither`,
        id,
        path,
      );
    }
    planned.set(id, { id, path, element, adapter, reference });
  }

  for (const id of required) {
    if (!planned.has(id)) {
      throw new TypfolioCaptureError('NOT_FOUND', `No capture region was found for ${id}`, id);
    }
  }
  return [...planned.values()];
}

/**
 * Discovers marked regions under `root` and captures each with the adapter for
 * its kind, producing compiler assets and JSON-safe image references.
 */
export async function captureAssets(
  root: ParentNode | null,
  options: CaptureAssetsOptions,
): Promise<CapturedAssets> {
  const { adapters, require = [], signal } = options ?? {};
  checkAbort(signal);
  if (typeof adapters !== 'object' || adapters === null) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'captureAssets requires an adapters record');
  }
  if (!Array.isArray(require) || require.some(id => typeof id !== 'string')) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'require must be an array of region ids');
  }
  for (const [kind, adapter] of Object.entries(adapters)) validateAdapter(kind, adapter);
  if (root === null) {
    throw new TypfolioCaptureError('NOT_READY', 'The capture root is not available');
  }

  const planned = discover(root, adapters, require);

  const assets: Array<readonly [string, Uint8Array]> = [];
  for (const { id, path, element, adapter } of planned) {
    checkAbort(signal, id, path);
    let bytes: Uint8Array;
    try {
      bytes = await adapter.capture(element, { captureId: id, path, signal });
    } catch (cause) {
      if (cause instanceof TypfolioCaptureError) throw cause;
      throw new TypfolioCaptureError(
        'CAPTURE_FAILED',
        `Could not capture ${id} with ${adapter.name}`,
        id,
        path,
        { cause },
      );
    }
    checkAbort(signal, id, path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypfolioCaptureError(
        'EMPTY_ASSET',
        `Capture ${id} produced no bytes`,
        id,
        path,
      );
    }
    assets.push([path, new Uint8Array(bytes)]);
  }

  return Object.freeze({
    assets: Object.freeze(Object.fromEntries(assets)),
    references: Object.freeze(Object.fromEntries(
      planned.map(({ id, reference }) => [id, reference] as const),
    )),
  });
}
