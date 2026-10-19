import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PdfDocument } from '@typfolio/core';
import type { FontUrls } from '../assets.ts';
import { ModeSwitch, ViewerToolbar, type PreviewMode } from './chrome.tsx';
import { ProofBar, usePdfBytesUrl } from './proof.tsx';
import type { Captured, LiveSession, LiveStats } from './session.ts';

export type LiveStatus = 'starting' | 'running' | 'error';

/** Synthetic Typst load: iterations of a pure script loop added to every frame. */
export const LOAD_STEPS = [0, 20_000, 40_000, 60_000] as const;
const POOL_SIZES = [1, 2, 3, 4] as const;

interface LiveSwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** The "Live PDF mode" toggle shown in a route's output header. */
export function LiveSwitch({ checked, onChange }: LiveSwitchProps) {
  return (
    <label className="switch">
      <input checked={checked} onChange={event => onChange(event.target.checked)} role="switch" type="checkbox" />
      <span aria-hidden="true" className="switch-track" />
      Live PDF mode
    </label>
  );
}

/**
 * Optional page-level pointer interaction over the live canvas. Coordinates are
 * in the route's logical stage units (the PDF page size in pt). The PDF itself
 * is static per frame: the route changes its simulation and the pipeline
 * re-typesets it.
 */
export interface CanvasInteraction {
  /** Logical stage width the canvas maps to; the height follows `aspect`. */
  readonly stageWidth: number;
  /** Return true to start a drag at this point. */
  readonly onDown: (x: number, y: number) => boolean;
  readonly onMove: (x: number, y: number) => void;
  readonly onUp: (x: number, y: number) => void;
  /** Whether a pointer at this point is over something draggable (cursor feedback). */
  readonly hover: (x: number, y: number) => boolean;
  /** The pointer left the canvas (and is not dragging). */
  readonly onLeave?: () => void;
}

interface LivePanelProps<T> {
  readonly interaction?: CanvasInteraction;
  /** Shown in the Viewer toolbar, e.g. `ascii-art.pdf`. */
  readonly documentName: string;
  /** File name for "Download frame". */
  readonly downloadName: string;
  readonly fonts: FontUrls;
  /** PDF page width / height. */
  readonly aspect: number;
  readonly maxWidth: number;
  readonly buildDocument: (frame: T, burn: number) => PdfDocument;
  /**
   * Resolves with the next frame to capture. Called whenever a pool slot is
   * free. With `demand`, the route advances its own simulation on the spot
   * instead of waiting for the display's next frame.
   */
  readonly acquireFrame: (signal: AbortSignal, demand: boolean) => Promise<Captured<T> | undefined>;
  /** Called with the capture mode while a session exists, `undefined` when it ends. */
  readonly onActiveChange?: (state: { demand: boolean } | undefined) => void;
  readonly onStatus?: (status: LiveStatus) => void;
}

interface NativeViewProps {
  readonly getFrame: () => { readonly bytes: Uint8Array } | undefined;
}

/**
 * Chrome's own PDF viewer in an iframe. It cannot follow live frames (re-pointing
 * it re-instantiates the viewer and resets its state), so it shows a snapshot of
 * the latest frame that is refreshed on demand, or on a slow fixed cadence.
 */
function NativeView({ getFrame }: NativeViewProps) {
  const [snapshot, setSnapshot] = useState<Uint8Array | undefined>(() => getFrame()?.bytes);
  const [auto, setAuto] = useState(false);
  const url = usePdfBytesUrl(snapshot);
  const refresh = useCallback(() => setSnapshot(getFrame()?.bytes), [getFrame]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(refresh, NATIVE_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [auto, refresh]);

  return (
    <div className="native">
      <div className="native-bar">
        <button className="button button--small" onClick={refresh} type="button">Refresh</button>
        <label className="switch">
          <input checked={auto} onChange={event => setAuto(event.target.checked)} role="switch" type="checkbox" />
          <span aria-hidden="true" className="switch-track" />
          Auto-refresh every {NATIVE_AUTO_REFRESH_MS / 1000} s
        </label>
      </div>
      <div className="native-frame">
        {url === undefined ? <div className="pdf-empty"><p>No frame yet.</p></div> : <iframe src={`${url}#view=Fit`} title="Chrome's PDF viewer" />}
      </div>
      <p className="native-caption">
        Chrome's built-in viewer owns pointer input and cannot be re-pointed every frame without flickering and
        resetting its state, so this view is a snapshot and dragging is unavailable. Switch to Fast or Viewer to
        drag, or press Refresh for the latest frame.
      </p>
    </div>
  );
}

const NATIVE_AUTO_REFRESH_MS = 2000;

const fmt = (value: number | undefined, unit: string, digits = 1): string =>
  value === undefined ? '—' : `${value.toFixed(digits)} ${unit}`;

/**
 * Live PDF preview: a canvas painted by pdf.js from PDFs compiled on a pool of
 * `@typfolio/workers` workers, plus the pool/load controls and live stats.
 * Mount it to start a session; unmount it to stop and free the pool.
 */
export function LivePanel<T>(props: LivePanelProps<T>) {
  const { fonts, aspect, maxWidth } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const sessionRef = useRef<LiveSession | undefined>(undefined);
  const dragging = useRef(false);
  const baseScale = useRef(1);

  const [poolSize, setPoolSize] = useState(2);
  const [load, setLoad] = useState<number>(0);
  const [demand, setDemand] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('fast');
  const [zoom, setZoom] = useState(1);
  const [fitPx, setFitPx] = useState(0);
  const [pages, setPages] = useState(1);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LiveStatus>('starting');
  const [error, setError] = useState<string>();
  const [stats, setStats] = useState<LiveStats>();

  useEffect(() => {
    latest.current.onStatus?.(status);
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    baseScale.current = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    setStatus('starting');
    setError(undefined);
    setStats(undefined);
    latest.current.onActiveChange?.({ demand });

    let cancelled = false;
    let session: LiveSession | undefined;
    void (async () => {
      // Lazy: pdf.js and the worker client stay out of the route chunk until live mode is on.
      const { createLiveSession } = await import('./session.ts');
      const created = await createLiveSession<T>({
        fonts,
        canvas,
        scale: baseScale.current,
        poolSize,
        burn: load,
        buildDocument: (frame, burn) => latest.current.buildDocument(frame, burn),
        acquireFrame: signal => latest.current.acquireFrame(signal, demand),
        onStats: setStats,
      });
      if (cancelled) {
        await created.dispose();
        return;
      }
      session = created;
      sessionRef.current = created;
      created.start();
      setStatus('running');
    })().catch(cause => {
      if (cancelled) return;
      setStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      sessionRef.current = undefined;
      latest.current.onActiveChange?.(undefined);
      void session?.dispose();
    };
  }, [fonts, poolSize, load, demand]);

  const getFrame = useCallback(() => sessionRef.current?.latest(), []);

  // Native mode shows Chrome's viewer from snapshots; stop painting the (hidden) canvas.
  useEffect(() => {
    sessionRef.current?.setPaint(mode !== 'native');
  }, [mode, status]);

  // Viewer: fit width follows the backdrop; the page indicator follows pdf.js's page count.
  useEffect(() => {
    const backdrop = backdropRef.current;
    if (backdrop === null || mode !== 'viewer') return;
    const observe = (): void => setFitPx(Math.min(props.maxWidth, Math.max(120, backdrop.clientWidth - 48)));
    observe();
    const observer = new ResizeObserver(observe);
    observer.observe(backdrop);
    const timer = setInterval(() => setPages(sessionRef.current?.latest()?.pages ?? 1), 300);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [mode, props.maxWidth]);

  // Zoom is a CSS transform of the live canvas; once it settles, re-rasterise at the new size.
  useEffect(() => {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const wanted = mode === 'viewer' && fitPx > 0 ? Math.min(3, Math.max(0.6, (fitPx * zoom * dpr) / props.maxWidth)) : dpr;
    const timer = setTimeout(() => {
      baseScale.current = wanted;
      if (!dragging.current) sessionRef.current?.setScale(wanted);
    }, 400);
    return () => clearTimeout(timer);
  }, [mode, zoom, fitPx, props.maxWidth]);

  const toStage = (event: ReactPointerEvent<HTMLCanvasElement>, interaction: CanvasInteraction) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = rect.width / interaction.stageWidth;
    return { x: (event.clientX - rect.left) / factor, y: (event.clientY - rect.top) / factor };
  };
  const canvasHandlers = props.interaction === undefined ? {} : {
    onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
      const interaction = props.interaction!;
      const { x, y } = toStage(event, interaction);
      if (!interaction.onDown(x, y)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.style.cursor = 'grabbing';
      event.preventDefault();
      dragging.current = true;
      // Interactive polish: rasterise coarser while dragging for a higher frame rate.
      sessionRef.current?.setScale(Math.max(0.6, baseScale.current * 0.6));
    },
    onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
      const interaction = props.interaction!;
      const { x, y } = toStage(event, interaction);
      interaction.onMove(x, y);
      if (!dragging.current) event.currentTarget.style.cursor = interaction.hover(x, y) ? 'grab' : '';
    },
    onPointerLeave() {
      if (!dragging.current) props.interaction?.onLeave?.();
    },
    onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
      if (!dragging.current) return;
      const interaction = props.interaction!;
      const { x, y } = toStage(event, interaction);
      interaction.onUp(x, y);
      dragging.current = false;
      sessionRef.current?.setScale(baseScale.current);
      event.currentTarget.style.cursor = interaction.hover(x, y) ? 'grab' : '';
    },
  };

  const viewer = mode === 'viewer';
  const sheetStyle = viewer && fitPx > 0
    ? { aspectRatio: String(aspect), width: fitPx * zoom }
    : { aspectRatio: String(aspect), maxWidth, width: '100%' };

  return (
    <>
      <ModeSwitch modes={['fast', 'viewer', 'native']} onChange={setMode} value={mode} />
      <div className={`preview preview--${mode}`} hidden={mode === 'native'}>
        {viewer ? (
          <ViewerToolbar name={props.documentName} onZoom={setZoom} page={1} pages={pages} zoom={zoom} />
        ) : null}
        <div className={viewer ? 'viewer-backdrop viewer-backdrop--on' : 'viewer-backdrop'} ref={backdropRef}>
          <div className={viewer ? 'pdf-frame sheet' : 'pdf-frame'} style={sheetStyle}>
            <canvas
              aria-label="Live PDF preview"
              className={`live-canvas${props.interaction === undefined ? '' : ' live-canvas--interactive'}`}
              ref={canvasRef}
              {...canvasHandlers}
              onPointerCancel={canvasHandlers.onPointerUp}
            />
            {status !== 'running' || stats === undefined ? (
              <div className="pdf-empty live-overlay">
                {status === 'error' ? (
                  <p>{error}</p>
                ) : (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    <p>Starting the Typst worker pool and pdf.js…</p>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {mode === 'native' ? <NativeView getFrame={getFrame} /> : null}
      <ProofBar fileName={props.downloadName} getFrame={getFrame} />
      <div className="live-controls">
        <div className="segmented" role="group" aria-label="Worker pool size">
          <span className="segmented-label">Pool</span>
          {POOL_SIZES.map(size => (
            <button
              aria-pressed={poolSize === size}
              className={poolSize === size ? 'on' : undefined}
              key={size}
              onClick={() => setPoolSize(size)}
              type="button"
            >
              {size}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Synthetic Typst load">
          <span className="segmented-label">Extra load</span>
          {LOAD_STEPS.map(value => (
            <button
              aria-pressed={load === value}
              className={load === value ? 'on' : undefined}
              key={value}
              onClick={() => setLoad(value)}
              title={value === 0 ? 'No synthetic load' : `A ${value.toLocaleString('en')}-iteration Typst script loop added to every frame (benchmark knob, no visual effect)`}
              type="button"
            >
              {value === 0 ? 'off' : `${value / 1000}k`}
            </button>
          ))}
        </div>
        <label className="switch" title="Advance the simulation whenever a pool slot frees instead of once per display frame">
          <input checked={demand} onChange={event => setDemand(event.target.checked)} role="switch" type="checkbox" />
          <span aria-hidden="true" className="switch-track" />
          Uncapped (benchmark)
        </label>
      </div>
      <dl className="facts facts--live">
        <div><dt>PDF frame rate</dt><dd className="big">{fmt(stats?.fps, 'fps')}</dd></div>
        <div><dt>Pool size</dt><dd>{poolSize} worker{poolSize === 1 ? '' : 's'}</dd></div>
        <div><dt>Layout (pretext)</dt><dd>{fmt(stats?.layoutMs, 'ms')}</dd></div>
        <div><dt>Typst compile · worker</dt><dd>{fmt(stats?.compileMs, 'ms')}</dd></div>
        <div><dt>pdf.js render</dt><dd>{fmt(stats?.renderMs, 'ms')}</dd></div>
        <div><dt>Compile throughput</dt><dd>{fmt(stats?.compileFps, '/s')}</dd></div>
        <div><dt>Dropped frames</dt><dd>{stats === undefined ? '—' : stats.dropped}</dd></div>
        <div><dt>Pool warm-up</dt><dd>{fmt(stats?.warmupMs, 'ms', 0)}</dd></div>
        <div className="facts-wide">
          <dt>Scheduling</dt>
          <dd>
            one lane per worker, a frame is captured when a slot frees · latest frame wins, stale frames are dropped · medians of the last 60 frames
            {stats === undefined ? '' : ` · ${stats.frames} PDFs painted`}
          </dd>
        </div>
      </dl>
    </>
  );
}
