import { serializeSvg, type SvgSerializeOptions } from '@typfolio/core/capture/svg';
import {
  createElement,
  startTransition,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DependencyList,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Adds an element to the PDF's assets and returns the path it is drawn into, such as
 * `/charts/0.svg`: absolute, so a template reads it with `image(path)` from any of its files. The
 * element is drawn at the size its own props give it.
 */
export type RenderAsset = (element: ReactElement) => string;

/** A font face to load into the page before drawing, so charts measure text in the PDF's font. */
export interface RenderFont {
  readonly family: string;
  /** Font bytes, or a URL to load them from. */
  readonly source: ArrayBuffer | ArrayBufferView<ArrayBuffer> | string | URL;
  readonly descriptors?: FontFaceDescriptors;
}

/** How `render` draws: shared by `useRenderedAssets` and `usePdf`'s `charts` option. */
export interface RenderAssetsOptions extends SvgSerializeOptions {
  /** Directory of the asset paths `render` returns. Defaults to `charts`. */
  readonly directory?: string;
  /** Width of the hidden renderer in CSS pixels, for elements without a width of their own. Defaults to 1024. */
  readonly width?: number;
  /**
   * Faces loaded into the document before anything is drawn, and removed when the hook
   * unmounts. With `fontFamily`, chart text is drawn, measured and serialized in that family
   * whatever font the chart asks for.
   */
  readonly fonts?: readonly RenderFont[];
  /** How long to wait for every element to draw an SVG with a size. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

export interface UseRenderedAssetsOptions<T> extends RenderAssetsOptions {
  /** What `build` reads, compared like `useMemo`'s dependencies. Defaults to `[]`: built once. */
  readonly deps?: DependencyList;
  /** When false, nothing is drawn. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Checks each built value before anything is drawn: throw to reject it (for example
   * `value => schema.parse(value)` with your schema library). A rejected value is not drawn, and
   * the hook reports the thrown error.
   */
  readonly validate?: (value: T) => void;
  readonly onReady?: (assets: Readonly<Record<string, Uint8Array>>, value: T) => void;
  readonly onError?: (error: Error) => void;
}

export type RenderedAssetsStatus = 'idle' | 'drawing' | 'ready' | 'error';

export interface RenderedAssets<T> {
  /** What `build` returned for the current dependencies. */
  readonly value: T;
  /** The drawn assets for `value`, by path; undefined until every element is drawn. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
  readonly status: RenderedAssetsStatus;
  readonly error?: Error;
  /** Builds again with the same dependencies, and draws every element again. */
  readonly rebuild: () => void;
  /**
   * Render it anywhere in your tree. The elements draw inside it, portalled to a hidden element
   * at the end of `<body>`, and see your providers (theme, i18n, data clients) and your CSS.
   */
  readonly AssetRenderer: ComponentType;
}

interface Built<T> {
  readonly id: number;
  readonly value: T;
  readonly elements: readonly ReactElement[];
  /** A reuse key per element, from its component and props; undefined when it cannot be compared. */
  readonly keys: readonly (string | undefined)[];
  /** Asset keys, such as `charts/0.svg`. */
  readonly paths: readonly string[];
}

type Drawn =
  | { readonly id: number; readonly status: 'ready'; readonly assets: Readonly<Record<string, Uint8Array>> }
  | { readonly id: number; readonly status: 'error'; readonly error: Error };

interface StageItem {
  readonly index: number;
  readonly element: ReactElement;
}

interface Stage {
  readonly id: number;
  readonly items: readonly StageItem[];
  readonly container: HTMLElement;
}

/** Shared by the hook and its stable AssetRenderer component. */
interface StageStore {
  stage: Stage | null;
  readonly listeners: Set<() => void>;
  readonly slots: Map<string, HTMLElement>;
  mounted: number;
}

const pathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const pollMs = 20;
const noAssets: Readonly<Record<string, Uint8Array>> = Object.freeze({});
let lastBuildId = 0;

class Uncomparable extends Error {}
const typeIds = new WeakMap<object, number>();
let lastTypeId = 0;

// Plain data only: a function, a React element, or a class instance (Date, Map) in the props
// makes the element uncomparable, so it is drawn every time.
function comparable(_key: string, value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Uncomparable();
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new Uncomparable();
    if ('$$typeof' in value) throw new Uncomparable();
  }
  return value;
}

function reuseKey(element: ReactElement): string | undefined {
  const type: unknown = element.type;
  let typeId: string;
  if (typeof type === 'string') {
    typeId = type;
  } else if ((typeof type === 'function' || typeof type === 'object') && type !== null) {
    let id = typeIds.get(type);
    if (id === undefined) {
      id = ++lastTypeId;
      typeIds.set(type, id);
    }
    typeId = `#${id}`;
  } else {
    return undefined;
  }
  try {
    return `${typeId}:${JSON.stringify(element.props, comparable)}`;
  } catch {
    return undefined;
  }
}

function build<T>(builder: (tools: { readonly render: RenderAsset }) => T, directory: string): Built<T> {
  const elements: ReactElement[] = [];
  const paths: string[] = [];
  let open = true;
  const value = builder({
    render: element => {
      if (!open) {
        throw new Error('useRenderedAssets: render was called after build returned; call it only inside build');
      }
      const path = `${directory}/${elements.length}.svg`;
      elements.push(element);
      paths.push(path);
      return `/${path}`;
    },
  });
  open = false;
  return { id: ++lastBuildId, value, elements, keys: elements.map(reuseKey), paths };
}

function fontSource(source: RenderFont['source']): string | BufferSource {
  if (typeof source === 'string' || source instanceof URL) {
    return `url(${JSON.stringify(new URL(source, document.baseURI).href)})`;
  }
  return source;
}

/** The largest SVG in a slot: chart libraries also draw small SVGs, for legends and icons. */
function drawnSvg(slot: HTMLElement | undefined): SVGSVGElement | null {
  let found: SVGSVGElement | null = null;
  let area = 0;
  for (const svg of slot?.querySelectorAll('svg') ?? []) {
    const { width, height } = svg.getBoundingClientRect();
    if (width * height > area) {
      found = svg;
      area = width * height;
    }
  }
  return found;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function setStage(store: StageStore, stage: Stage | null): void {
  store.stage = stage;
  for (const listener of store.listeners) listener();
}

function createAssetRenderer(store: StageStore): ComponentType {
  function AssetRenderer() {
    const [stage, setLocalStage] = useState(store.stage);
    useEffect(() => {
      store.mounted += 1;
      // A transition: React draws the elements in slices and lets the browser paint (the
      // dialog that asked for them, say) in between. Without a concurrent root it draws at once.
      const update = () => startTransition(() => setLocalStage(store.stage));
      store.listeners.add(update);
      update();
      return () => {
        store.mounted -= 1;
        store.listeners.delete(update);
      };
    }, []);
    if (stage === null) return null;
    return createPortal(
      stage.items.map(item => {
        const slotKey = `${stage.id}:${item.index}`;
        return createElement(
          'div',
          {
            key: slotKey,
            ref: (slot: HTMLDivElement | null) => {
              if (slot === null) store.slots.delete(slotKey);
              else store.slots.set(slotKey, slot);
            },
          },
          item.element,
        );
      }),
      stage.container,
    );
  }
  return AssetRenderer;
}

/**
 * Draws React elements, such as charts, for a PDF: away from the page, at the size their props
 * give them, so the PDF never depends on how wide the page is or what it hides. Each element
 * becomes an SVG asset.
 *
 * `build` runs during render whenever `deps` change, like `useMemo`: it returns your template's
 * data, and each `render(element)` inside it returns the asset path to put in that data.
 * Render `<AssetRenderer />` in your tree; once every element has drawn, `assets` holds the files
 * for `compile`'s `assets`. An element whose component and props are unchanged since the last
 * build is not drawn again. Turn chart animations off: the first drawing is the one serialized.
 *
 * Most applications use `usePdf`, which builds, draws and compiles; this hook is the drawing
 * part on its own, for a compile flow of your own.
 */
export function useRenderedAssets<T>(
  builder: (tools: { readonly render: RenderAsset }) => T,
  options: UseRenderedAssetsOptions<T> = {},
): RenderedAssets<T> {
  const { directory = 'charts', deps = [], enabled = true } = options;
  if (!pathPattern.test(directory) || directory.endsWith('/') || directory.includes('..')) {
    throw new TypeError(`useRenderedAssets: directory must be a relative path, got ${JSON.stringify(directory)}`);
  }

  const [generation, setGeneration] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => build(builder, directory), [...deps, generation]);
  const invalid = useMemo(() => {
    // Disabled, nothing is checked: the data may not be there yet. Enabling checks the current build.
    if (options.validate === undefined || !enabled) return undefined;
    try {
      options.validate(built.value);
      return undefined;
    } catch (error) {
      return asError(error);
    }
    // Checked once per build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, enabled]);
  const [drawn, setDrawn] = useState<Drawn>();
  const [store] = useState<StageStore>(() => ({ stage: null, listeners: new Set(), slots: new Map(), mounted: 0 }));
  const [AssetRenderer] = useState(() => createAssetRenderer(store));
  const cache = useRef(new Map<string, Uint8Array>());
  const fonts = useRef<{ faces: FontFace[]; loaded: Promise<unknown> }>(undefined);
  const latest = useRef(options);
  const rendererId = useId();
  useEffect(() => {
    latest.current = options;
  });

  // Fonts stay loaded while the hook is mounted: a rebuild draws in them again.
  useEffect(() => () => {
    for (const face of fonts.current?.faces ?? []) document.fonts.delete(face);
    fonts.current = undefined;
  }, []);

  useEffect(() => {
    if (!enabled || drawn?.id === built.id || invalid !== undefined) return;
    const { fontFamily, beforeSerialize, width = 1024, timeoutMs = 10_000 } = latest.current;
    const settle = (result: Drawn) => {
      setDrawn(result);
      if (result.status === 'ready') latest.current.onReady?.(result.assets, built.value);
      else latest.current.onError?.(result.error);
    };
    const assetsFrom = (fresh: ReadonlyMap<number, Uint8Array>) => {
      const assets: Record<string, Uint8Array> = {};
      built.paths.forEach((path, index) => {
        const key = built.keys[index];
        const bytes = fresh.get(index) ?? (key === undefined ? undefined : cache.current.get(key));
        if (bytes !== undefined) assets[path] = bytes;
      });
      // Keep only what this build uses.
      const used = new Set(built.keys);
      for (const key of cache.current.keys()) if (!used.has(key)) cache.current.delete(key);
      return Object.freeze(assets);
    };

    const pending = built.elements
      .map((element, index) => ({ element, index }))
      .filter(({ index }) => {
        const key = built.keys[index];
        return key === undefined || !cache.current.has(key);
      });
    if (pending.length === 0) {
      // The same empty record the render already reported, so nothing downstream sees a change.
      settle({ id: built.id, status: 'ready', assets: built.elements.length === 0 ? noAssets : assetsFrom(new Map()) });
      return;
    }

    let current = true;
    const container = document.createElement('div');
    container.dataset.typfolioAssetRenderer = rendererId;
    container.setAttribute('aria-hidden', 'true');
    container.setAttribute('inert', '');
    Object.assign(container.style, {
      position: 'fixed',
      top: '0',
      left: '-100000px',
      width: `${width}px`,
      pointerEvents: 'none',
    });
    const style = document.createElement('style');
    if (fontFamily) {
      const scope = `[data-typfolio-asset-renderer=${JSON.stringify(rendererId)}]`;
      style.textContent = `${scope} svg text, ${scope} svg tspan { font-family: ${JSON.stringify(fontFamily)} !important; }`;
    }

    const draw = async () => {
      if (fonts.current === undefined) {
        // Where the platform cannot load fonts (jsdom, say), there is nothing to load.
        const canLoad = typeof FontFace === 'function' && document.fonts !== undefined;
        const faces = (canLoad ? latest.current.fonts ?? [] : []).map(
          font => new FontFace(font.family, fontSource(font.source), font.descriptors),
        );
        for (const face of faces) document.fonts.add(face);
        fonts.current = { faces, loaded: Promise.all(faces.map(face => face.load())) };
      }
      try {
        await fonts.current.loaded;
      } catch (error) {
        throw new Error('useRenderedAssets: a font could not be loaded', { cause: error });
      }
      if (!current) return;
      document.head.append(style);
      document.body.append(container);
      setStage(store, { id: built.id, items: pending, container });

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const svgs = pending.map(({ index }) => drawnSvg(store.slots.get(`${built.id}:${index}`)));
        if (svgs.every(svg => svg !== null)) {
          const fresh = new Map<number, Uint8Array>();
          pending.forEach(({ index }, at) => {
            const bytes = serializeSvg(svgs[at]!, { fontFamily, beforeSerialize });
            fresh.set(index, bytes);
            const key = built.keys[index];
            if (key !== undefined) cache.current.set(key, bytes);
          });
          if (current) settle({ id: built.id, status: 'ready', assets: assetsFrom(fresh) });
          return;
        }
        if (Date.now() > deadline) {
          const missing = svgs.findIndex(svg => svg === null);
          throw new Error(
            store.mounted === 0
              ? 'useRenderedAssets: <AssetRenderer /> is not rendered; put it in your tree'
              : `useRenderedAssets: ${built.paths[pending[missing]!.index]} did not draw an SVG with a size in ${timeoutMs}ms`,
          );
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
        if (!current) return;
      }
    };

    draw().then(undefined, error => {
      if (current) settle({ id: built.id, status: 'error', error: asError(error) });
    }).finally(() => {
      if (store.stage?.id === built.id) setStage(store, null);
      container.remove();
      style.remove();
    });
    return () => {
      current = false;
      if (store.stage?.id === built.id) setStage(store, null);
      container.remove();
      style.remove();
    };
    // Drawn once per build; options are read when drawing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, enabled, invalid]);

  useEffect(() => {
    if (invalid !== undefined) latest.current.onError?.(invalid);
  }, [invalid]);

  const [rebuild] = useState(() => () => {
    cache.current.clear();
    setGeneration(value => value + 1);
  });

  // Nothing to draw is ready at once; the effect above still reports it through onReady.
  const current: Drawn | undefined = invalid !== undefined
    ? { id: built.id, status: 'error', error: invalid }
    : drawn?.id === built.id
    ? drawn
    : built.elements.length === 0 ? { id: built.id, status: 'ready', assets: noAssets } : undefined;
  const status: RenderedAssetsStatus = current?.status ?? (enabled ? 'drawing' : 'idle');
  return {
    value: built.value,
    assets: current?.status === 'ready' ? current.assets : undefined,
    status,
    error: current?.status === 'error' ? current.error : undefined,
    rebuild,
    AssetRenderer,
  };
}
