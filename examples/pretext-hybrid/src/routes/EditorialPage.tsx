import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfClient } from '@typfolio/core';
import { usePdf } from '@typfolio/react';
import { CompilerBoundary } from '../CompilerBoundary.tsx';
import { FONT_FAMILY, type FontUrls } from '../assets.ts';
import { StaticPreview } from '../live/StaticPreview.tsx';
import { Shell } from '../Shell.tsx';
import { editorialTemplate, layoutToInput, type Baselines, type EditorialInput } from '../editorial/capture.ts';
import {
  STAGE_PRESETS,
  createEditorialEngine,
  type EditorialLayout,
  type StagePresetId,
} from '../editorial/engine.ts';
import { measureBaseline } from '../measureBaseline.ts';
import { LivePanel, LiveSwitch, type LiveStatus } from '../live/LivePanel.tsx';
import type { Captured } from '../live/session.ts';

interface WorkbenchProps {
  readonly fonts: FontUrls;
  readonly client: PdfClient;
  readonly preset: StagePresetId;
  readonly onPreset: (preset: StagePresetId) => void;
}

function baselinesFor(layout: EditorialLayout): Baselines {
  return {
    headline: measureBaseline(layout.headline.font, layout.headline.lineHeight, layout.headline.letterSpacing),
    body: measureBaseline(layout.body.font, layout.body.lineHeight),
    dropCap: measureBaseline(layout.dropCap.font, layout.dropCap.fontSize),
    quote: measureBaseline(layout.pullquotes.font, layout.pullquotes.lineHeight),
  };
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

function Workbench({ fonts, client, preset, onPreset }: WorkbenchProps) {
  const [engine] = useState(() => createEditorialEngine(FONT_FAMILY, STAGE_PRESETS[preset]));
  const { width, height } = engine.stage;

  const layoutRef = useRef<EditorialLayout | undefined>(undefined);
  const frozenRef = useRef(false);
  const demandRef = useRef(false);
  const layoutMsRef = useRef(0);
  const lastAcquiredRef = useRef<EditorialLayout | undefined>(undefined);
  const [captured, setCaptured] = useState<{ ms?: number; bytes: number; layout: EditorialLayout }>();

  const [live, setLive] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('starting');

  // The frame captured last: usePdf compiles it, and again on the next capture. Each capture is a
  // new object, and the document is built again whenever `deps` change, so the same frame captured
  // again compiles again too.
  const [capturedInput, setCapturedInput] = useState<EditorialInput>();
  const startedAtRef = useRef(0);
  // Disabled until the first capture: nothing is checked or compiled before there is a layout.
  const pdf = usePdf(() => editorialTemplate(capturedInput as EditorialInput), {
    client,
    validate: false,
    deps: [capturedInput],
    enabled: capturedInput !== undefined,
    onSuccess: () => {
      const ms = performance.now() - startedAtRef.current;
      setCaptured(previous => (previous === undefined ? previous : { ...previous, ms }));
    },
  });
  const pdfUrl = pdf.url;

  useEffect(() => {
    let handle = 0;
    const frame = (now: number): void => {
      // In demand-driven live mode the PDF pipeline steps the engine itself.
      if (!frozenRef.current && !demandRef.current) {
        const startedAt = performance.now();
        engine.step(now);
        layoutRef.current = engine.layout();
        layoutMsRef.current = performance.now() - startedAt;
      }
      handle = requestAnimationFrame(frame);
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [engine]);

  const capture = useCallback(() => {
    const layout = layoutRef.current;
    if (layout === undefined) return;
    // Freeze the orb configuration: the PDF is built from exactly this layout object.
    frozenRef.current = true;
    setLive(false);
    const input = layoutToInput(layout, baselinesFor(layout));
    const bytes = JSON.stringify(input).length;
    setCaptured({ bytes, layout });
    startedAtRef.current = performance.now();
    setCapturedInput(input);
  }, []);

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
  const buildLiveDocument = useCallback((layout: EditorialLayout, burn: number) => {
    return editorialTemplate(layoutToInput(layout, baselinesFor(layout), burn));
  }, []);
  const onLiveActive = useCallback((state: { demand: boolean } | undefined) => {
    demandRef.current = state?.demand ?? false;
    lastAcquiredRef.current = undefined;
    if (state !== undefined) {
      frozenRef.current = false;
    }
  }, []);

  // Drag or pause the orbs directly on the live PDF canvas.
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

  return (
    <div className="ed-workbench">
      <section className="card" aria-live="polite">
        <header className="card-head">
          <div>
            <p className="kicker">Output · Typst</p>
            <h2>Rendered PDF</h2>
          </div>
          <div className="head-controls">
            <LiveSwitch checked={live} disabled={pdf.isFetching} onChange={enabled => enabled ? setLive(true) : capture()} />
            <span className={`pill pill--${live ? (liveStatus === 'error' ? 'error' : 'success') : pdf.status}`}>
              {live ? liveStatus : pdf.status}
            </span>
          </div>
        </header>
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
        {live ? (
          <LivePanel
            acquireFrame={acquireFrame}
            aspect={width / height}
            buildDocument={buildLiveDocument}
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
            pending={pdf.isFetching && pdfUrl === undefined}
            url={pdfUrl}
          />
        )}
        <div className="card-actions">
          <button className="button button--primary" disabled={pdf.isFetching} onClick={capture} type="button">
            {pdf.isFetching ? 'Compiling…' : 'Capture frame as PDF'}
          </button>
          <button className="button" disabled={live || pdf.isFetching} onClick={() => setLive(true)} type="button">Resume live PDF</button>
          <span className="hint">{live ? 'Drag an orb in the PDF · click to pause it' : 'Frozen on the captured frame.'}</span>
        </div>
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

function EditorialRoute({ fonts, client }: { readonly fonts: FontUrls; readonly client: PdfClient }) {
  const [preset, setPreset] = useState<StagePresetId>('wide');
  // Re-keying rebuilds the engine (and its prepared texts) for the new stage size.
  return <Workbench client={client} fonts={fonts} key={preset} onPreset={setPreset} preset={preset} />;
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
        {(fonts, client) => <EditorialRoute client={client} fonts={fonts} />}
      </CompilerBoundary>
    </Shell>
  );
}
