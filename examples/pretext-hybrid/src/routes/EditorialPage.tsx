import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { usePdfCompilation, usePdfObjectUrl } from '@typfolio/react';
import { CompilerBoundary } from '../CompilerBoundary.tsx';
import { FONT_FAMILY, type FontBytes } from '../assets.ts';
import { StaticPreview } from '../live/StaticPreview.tsx';
import { Shell } from '../Shell.tsx';
import { STAGE_BACKGROUND, layoutToInput, makeEditorialRequest, type Baselines } from '../editorial/capture.ts';
import {
  STAGE_PRESETS,
  createEditorialEngine,
  type EditorialLayout,
  type StagePresetId,
} from '../editorial/engine.ts';
import { EditorialView } from '../editorial/view.ts';
import { LivePanel, LiveSwitch, type LiveStatus } from '../live/LivePanel.tsx';
import type { Captured } from '../live/session.ts';

interface WorkbenchProps {
  readonly fonts: FontBytes;
  readonly preset: StagePresetId;
  readonly onPreset: (preset: StagePresetId) => void;
}

function baselinesFor(view: EditorialView, layout: EditorialLayout): Baselines {
  return {
    headline: view.baseline(layout.headline.font, layout.headline.lineHeight, layout.headline.letterSpacing),
    body: view.baseline(layout.body.font, layout.body.lineHeight),
    dropCap: view.baseline(layout.dropCap.font, layout.dropCap.fontSize),
    quote: view.baseline(layout.pullquotes.font, layout.pullquotes.lineHeight),
  };
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

function Workbench({ fonts, preset, onPreset }: WorkbenchProps) {
  const [engine] = useState(() => createEditorialEngine(FONT_FAMILY, STAGE_PRESETS[preset]));
  const { width, height } = engine.stage;

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorialView | undefined>(undefined);
  const layoutRef = useRef<EditorialLayout | undefined>(undefined);
  const frozenRef = useRef(false);
  const demandRef = useRef(false);
  const layoutMsRef = useRef(0);
  const lastAcquiredRef = useRef<EditorialLayout | undefined>(undefined);
  const scaleRef = useRef(1);
  const [scale, setScale] = useState(1);
  const [frozen, setFrozen] = useState(false);
  const [captured, setCaptured] = useState<{ ms?: number; bytes: number; layout: EditorialLayout }>();

  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('starting');

  const pdf = usePdfCompilation();
  const pdfUrl = usePdfObjectUrl(pdf.result);

  // Fit the fixed logical stage to the available width; the PDF page keeps the logical size.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const observer = new ResizeObserver(() => {
      const next = Math.min(1, viewport.clientWidth / width);
      scaleRef.current = next;
      setScale(next);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const view = new EditorialView(stage);
    viewRef.current = view;
    let handle = 0;
    let drawn: EditorialLayout | undefined;
    const frame = (now: number): void => {
      // In demand-driven live mode the PDF pipeline steps the engine itself.
      if (!frozenRef.current && !demandRef.current) {
        const startedAt = performance.now();
        engine.step(now);
        layoutRef.current = engine.layout();
        layoutMsRef.current = performance.now() - startedAt;
      }
      const layout = layoutRef.current;
      if (layout !== undefined && layout !== drawn) {
        drawn = layout;
        view.render(layout);
      }
      handle = requestAnimationFrame(frame);
    };
    handle = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(handle);
      stage.replaceChildren();
      viewRef.current = undefined;
    };
  }, [engine]);

  const toStage = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = rect.width / width;
    return { x: (event.clientX - rect.left) / factor, y: (event.clientY - rect.top) / factor };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (frozenRef.current) return;
    const { x, y } = toStage(event);
    if (engine.pointerDown(x, y)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (frozenRef.current) return;
    const { x, y } = toStage(event);
    engine.pointerMove(x, y);
    event.currentTarget.style.cursor = engine.hoveredOrb(x, y) ? 'grab' : '';
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (frozenRef.current) return;
    const { x, y } = toStage(event);
    engine.pointerUp(x, y);
  };

  const capture = useCallback(async () => {
    const view = viewRef.current;
    const layout = layoutRef.current;
    if (view === undefined || layout === undefined) return;
    // Freeze the orb configuration: the PDF is built from exactly this layout object.
    frozenRef.current = true;
    setFrozen(true);
    const input = layoutToInput(layout, baselinesFor(view, layout));
    const bytes = JSON.stringify(input).length;
    setCaptured({ bytes, layout });
    const startedAt = performance.now();
    try {
      await pdf.compile(makeEditorialRequest(input));
      setCaptured({ bytes, layout, ms: performance.now() - startedAt });
    } catch {
      // usePdfCompilation exposes the failure through its state.
    }
  }, [pdf]);

  // Live PDF mode: the shared pipeline (src/live) asks for a frame whenever a pool slot is free.
  const acquireFrame = useCallback(
    async (signal: AbortSignal, demand: boolean): Promise<Captured<EditorialLayout> | undefined> => {
      for (;;) {
        if (signal.aborted) return undefined;
        if (demand) {
          // Benchmark mode: advance the orbs and re-run pretext's layout on the spot.
          const startedAt = performance.now();
          engine.step(performance.now());
          const layout = engine.layout();
          layoutRef.current = layout;
          return { frame: layout, layoutMs: performance.now() - startedAt };
        }
        const layout = layoutRef.current;
        if (layout !== undefined && layout !== lastAcquiredRef.current) {
          lastAcquiredRef.current = layout;
          return { frame: layout, layoutMs: layoutMsRef.current };
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    },
    [engine],
  );
  const buildLiveRequest = useCallback((layout: EditorialLayout, burn: number) => {
    const view = viewRef.current;
    if (view === undefined) throw new Error('The live stage is not mounted');
    return makeEditorialRequest(layoutToInput(layout, baselinesFor(view, layout), burn));
  }, []);
  const onLiveActive = useCallback((state: { demand: boolean } | undefined) => {
    demandRef.current = state?.demand ?? false;
    lastAcquiredRef.current = undefined;
    if (state !== undefined) {
      frozenRef.current = false;
      setFrozen(false);
    }
  }, []);

  // Dragging orbs directly on the live PDF canvas: same engine calls as the DOM stage.
  const canvasInteraction = useMemo(
    () => ({
      stageWidth: width,
      onDown: (x: number, y: number) => engine.pointerDown(x, y),
      onMove: (x: number, y: number) => engine.pointerMove(x, y),
      onUp: (x: number, y: number) => engine.pointerUp(x, y),
      hover: (x: number, y: number) => engine.hoveredOrb(x, y),
    }),
    [engine, width],
  );

  const resume = (): void => {
    frozenRef.current = false;
    setFrozen(false);
  };

  return (
    <div className="ed-workbench">
      <section className="card">
        <header className="card-head">
          <div>
            <p className="kicker">Live · DOM</p>
            <h2>Orbs, columns and a pull quote</h2>
          </div>
          <div className="segmented" role="group" aria-label="Stage size">
            {(Object.keys(STAGE_PRESETS) as StagePresetId[]).map(id => (
              <button
                aria-pressed={preset === id}
                className={preset === id ? 'on' : undefined}
                key={id}
                onClick={() => onPreset(id)}
                type="button"
              >
                {STAGE_PRESETS[id].label}
              </button>
            ))}
          </div>
        </header>
        <div className="ed-viewport" ref={viewportRef} style={{ height: height * scale, '--stage-w': `${width}px` } as CSSProperties}>
          <div
            className="ed-stage"
            onPointerCancel={onPointerUp}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            ref={stageRef}
            style={{ width, height, background: STAGE_BACKGROUND, transform: `scale(${scale})` }}
          />
        </div>
        <div className="card-actions">
          <button className="button button--primary" disabled={pdf.isCompiling || live} onClick={() => void capture()} type="button">
            {pdf.isCompiling ? 'Compiling…' : 'Capture frame as PDF'}
          </button>
          <button className="button" disabled={!frozen || live} onClick={resume} type="button">Resume</button>
          <span className="hint">Drag an orb · click to pause it · {frozen ? 'frozen on the captured frame' : 'running'}</span>
        </div>
      </section>

      <section className="card" aria-live="polite">
        <header className="card-head">
          <div>
            <p className="kicker">Output · Typst</p>
            <h2>Rendered PDF</h2>
          </div>
          <div className="head-controls">
            <LiveSwitch checked={live} onChange={setLive} />
            <span className={`pill pill--${live ? (liveStatus === 'error' ? 'error' : 'success') : pdf.status}`}>
              {live ? liveStatus : pdf.status}
            </span>
          </div>
        </header>
        {live ? (
          <LivePanel
            acquireFrame={acquireFrame}
            aspect={width / height}
            buildRequest={buildLiveRequest}
            fonts={fonts}
            documentName="editorial.pdf"
            downloadName="typfolio-editorial-frame.pdf"
            interaction={canvasInteraction}
            maxWidth={width}
            onActiveChange={onLiveActive}
            onStatus={setLiveStatus}
          />
        ) : (
          <StaticPreview
            aspect={width / height}
            bytes={pdf.result?.bytes}
            documentName="editorial.pdf"
            downloadName="typfolio-editorial-frame.pdf"
            error={pdf.isError ? pdf.error : undefined}
            maxWidth={width}
            pending={pdf.isCompiling && pdfUrl === undefined}
            url={pdfUrl}
          />
        )}
        {live ? null : (
        <dl className="facts">
          <div><dt>Compile</dt><dd>{formatMs(captured?.ms)}</dd></div>
          <div><dt>Input JSON</dt><dd>{captured === undefined ? '—' : `${(captured.bytes / 1000).toFixed(1)} kB`}</dd></div>
          <div><dt>Body lines</dt><dd>{captured?.layout.body.lines.length ?? '—'}</dd></div>
          <div><dt>Columns</dt><dd>{captured?.layout.columnCount ?? '—'}</dd></div>
          <div><dt>Headline</dt><dd>{captured === undefined ? '—' : `${captured.layout.headline.fontSize} px · ${captured.layout.headline.lines.length} lines`}</dd></div>
        </dl>
        )}
      </section>
    </div>
  );
}

function EditorialRoute({ fonts }: { readonly fonts: FontBytes }) {
  const [preset, setPreset] = useState<StagePresetId>('wide');
  // Re-keying rebuilds the engine (and its prepared texts) for the new stage size.
  return <Workbench fonts={fonts} key={preset} onPreset={setPreset} preset={preset} />;
}

export default function EditorialPage() {
  return (
    <Shell
      wide
      eyebrow="Demo 2 · the editorial engine"
      title="Text that flows around orbs — as a PDF."
      lede="Pretext breaks every line around moving circular obstacles and hands text across columns mid-sentence. Capture freezes the orbs; Typst receives positioned lines and a few gradients, and does no line breaking at all."
    >
      <CompilerBoundary label="Loading Libertinus Serif and the Typst compiler…">
        {fonts => <EditorialRoute fonts={fonts} />}
      </CompilerBoundary>
    </Shell>
  );
}
