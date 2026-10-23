import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfClient } from '@typfolio/core';
import { usePdf } from '@typfolio/react';
import { CompilerBoundary } from '../CompilerBoundary.tsx';
import { FONT_FAMILY, type FontUrls } from '../assets.ts';
import { Shell } from '../Shell.tsx';
import { StaticPreview } from '../live/StaticPreview.tsx';
import type { Captured } from '../live/session.ts';
import { LivePanel, LiveSwitch, type LiveStatus } from '../live/LivePanel.tsx';
import { measureBaseline } from '../measureBaseline.ts';
import { asciiTemplate, framesToInput, type AsciiFrameInput } from '../ascii/capture.ts';
import {
  LINE_HEIGHT,
  STAGE_H,
  STAGE_W,
  createAsciiEngine,
  fontString,
  type AsciiEngine,
  type Frame,
} from '../ascii/engine.ts';

const FLIPBOOK_FRAMES = 8;
const FLIPBOOK_INTERVAL_MS = 220;

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

interface AsciiWorkbenchProps {
  readonly engine: AsciiEngine;
  readonly fonts: FontUrls;
  readonly client: PdfClient;
}

function SourceField({ canvas }: { readonly canvas: HTMLCanvasElement }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    hostRef.current?.appendChild(canvas);
    return () => canvas.remove();
  }, [canvas]);

  return (
    <figure className="source-field" aria-label="Live reference source field">
      <div ref={hostRef} role="img" aria-label="Particle field driving the ASCII art" />
      <figcaption>Source field</figcaption>
    </figure>
  );
}

function AsciiWorkbench({ engine, fonts, client }: AsciiWorkbenchProps) {
  const frameRef = useRef<Frame | undefined>(undefined);
  const baselineRef = useRef(0);
  const pausedRef = useRef(false);
  const demandRef = useRef(false);
  const lastAcquiredRef = useRef<Frame | undefined>(undefined);
  const [captureMs, setCaptureMs] = useState<number>();
  const [inputBytes, setInputBytes] = useState<number>();
  const [pageCount, setPageCount] = useState<number>();
  const [recording, setRecording] = useState<{ done: number; total: number }>();

  const [live, setLive] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('starting');

  // The frames captured last: usePdf compiles them, and again on the next capture. Each capture is
  // a new object, and the document is built again whenever `deps` change, so the same frame captured
  // again compiles again too.
  const [capturedInput, setCapturedInput] = useState<AsciiFrameInput>();
  const startedAtRef = useRef(0);
  // Disabled until the first capture: nothing is checked or compiled before there is a frame.
  const pdf = usePdf(() => asciiTemplate(capturedInput as AsciiFrameInput), {
    client,
    validate: false,
    deps: [capturedInput],
    enabled: capturedInput !== undefined,
    onSuccess: () => setCaptureMs(performance.now() - startedAtRef.current),
  });
  const pdfUrl = pdf.url;

  useEffect(() => {
    baselineRef.current = measureBaseline(fontString(400, FONT_FAMILY), LINE_HEIGHT);
    let handle = 0;
    const step = (now: number): void => {
      // In uncapped mode the PDF pipeline advances the simulation itself.
      if (!pausedRef.current && !demandRef.current) frameRef.current = engine.step(now);
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [engine]);

  const capture = useCallback(async (count: number) => {
    if (frameRef.current === undefined) return;
    const frames: Frame[] = [];
    if (count > 1) {
      // Resume the PDF while recording, including when starting from a static capture.
      pausedRef.current = false;
      setLive(true);
      for (let index = 0; index < count - 1; index++) {
        frames.push(frameRef.current);
        setRecording({ done: index + 1, total: count });
        await new Promise(resolve => setTimeout(resolve, FLIPBOOK_INTERVAL_MS));
      }
      setRecording(undefined);
    }
    // Stop the live pool and display the captured PDF.
    pausedRef.current = true;
    setLive(false);
    const last = frameRef.current;
    if (last === undefined) return;
    frames.push(last);

    const input = framesToInput(frames, baselineRef.current);
    setInputBytes(JSON.stringify(input).length);
    setPageCount(frames.length);
    startedAtRef.current = performance.now();
    setCaptureMs(undefined);
    setCapturedInput(input);
  }, []);

  // Live PDF mode: capture is demand-driven by the shared pipeline (src/live).
  const acquireFrame = useCallback(
    async (signal: AbortSignal, demand: boolean): Promise<Captured<Frame> | undefined> => {
      for (;;) {
        if (signal.aborted) return undefined;
        if (demand) {
          // Benchmark mode: advance the simulation on demand instead of waiting for the display.
          const frame = engine.step(performance.now());
          frameRef.current = frame;
          return { frame, layoutMs: frame.layoutMs };
        }
        const frame = frameRef.current;
        if (frame !== undefined && frame !== lastAcquiredRef.current) {
          lastAcquiredRef.current = frame;
          return { frame, layoutMs: frame.layoutMs };
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    },
    [engine],
  );
  const buildLiveDocument = useCallback(
    (frame: Frame, burn: number) => asciiTemplate(framesToInput([frame], baselineRef.current, burn)),
    [],
  );
  // The pointer over the live PDF canvas acts as a particle attractor in the simulation.
  const canvasInteraction = useMemo(
    () => ({
      stageWidth: STAGE_W,
      onDown: () => false,
      onMove: (x: number, y: number) => engine.setPointer({ x, y }),
      onUp: () => undefined,
      hover: () => false,
      onLeave: () => engine.setPointer(null),
    }),
    [engine],
  );
  const onLiveActive = useCallback((state: { demand: boolean } | undefined) => {
    demandRef.current = state?.demand ?? false;
    lastAcquiredRef.current = undefined;
    if (state === undefined) engine.setPointer(null);
    if (state !== undefined) {
      pausedRef.current = false;
    }
  }, [engine]);

  const busy = pdf.isFetching || recording !== undefined;

  return (
    <div className="workbench">
      <section className="card" aria-live="polite">
        <header className="card-head">
          <div>
            <p className="kicker">Output · Typst</p>
            <h2>Rendered PDF</h2>
          </div>
          <div className="head-controls">
            <LiveSwitch checked={live} disabled={busy} onChange={enabled => enabled ? setLive(true) : void capture(1)} />
            <span className={`pill pill--${live ? (liveStatus === 'error' ? 'error' : 'success') : pdf.status}`}>
              {live ? liveStatus : pdf.status}
            </span>
          </div>
        </header>
        {live ? (
          <LivePanel
            acquireFrame={acquireFrame}
            aspect={STAGE_W / STAGE_H}
            buildDocument={buildLiveDocument}
            fonts={fonts}
            documentName="ascii-art.pdf"
            downloadName="typfolio-ascii-frame.pdf"
            initialZoom={1}
            interaction={canvasInteraction}
            maxWidth={468}
            onActiveChange={onLiveActive}
            onStatus={setLiveStatus}
            overlay={<SourceField canvas={engine.sourceCanvas} />}
          />
        ) : (
          <StaticPreview
            aspect={STAGE_W / STAGE_H}
            bytes={pdf.result?.bytes}
            documentName="ascii-art.pdf"
            downloadName="typfolio-ascii-frame.pdf"
            initialZoom={1}
            error={pdf.isError ? pdf.error : undefined}
            maxWidth={468}
            pages={pageCount}
            pending={pdf.isFetching && pdfUrl === undefined}
            url={pdfUrl}
          />
        )}
        <div className="card-actions">
          <button className="button button--primary" disabled={busy} onClick={() => void capture(1)} type="button">
            {pdf.isFetching ? 'Compiling…' : 'Capture frame as PDF'}
          </button>
          <button className="button" disabled={busy} onClick={() => void capture(FLIPBOOK_FRAMES)} type="button">
            {recording === undefined ? `Flipbook · ${FLIPBOOK_FRAMES} pages` : `Recording ${recording.done}/${recording.total}…`}
          </button>
          <button className="button" disabled={live || busy} onClick={() => setLive(true)} type="button">Resume live PDF</button>
          <span className="hint">{live ? 'Move the pointer over the PDF to attract particles.' : 'Frozen on the captured frame.'}</span>
        </div>
        {live ? null : (
        <dl className="facts">
          <div><dt>Palette</dt><dd>{engine.paletteInfo.entries} glyph variants</dd></div>
          <div><dt>Compile</dt><dd>{formatMs(captureMs)}</dd></div>
          <div><dt>Pages</dt><dd>{pageCount ?? '—'}</dd></div>
          <div><dt>Input JSON</dt><dd>{inputBytes === undefined ? '—' : `${(inputBytes / 1000).toFixed(1)} kB`}</dd></div>
        </dl>
        )}
      </section>
    </div>
  );
}

function AsciiRoute({ fonts, client }: { readonly fonts: FontUrls; readonly client: PdfClient }) {
  // Fonts are registered by CompilerBoundary before this mounts, so both
  // pretext widths and canvas brightness see the Libertinus faces.
  const [engine] = useState(() => createAsciiEngine(FONT_FAMILY));
  return <AsciiWorkbench client={client} engine={engine} fonts={fonts} />;
}

export default function AsciiPage() {
  return (
    <Shell
      eyebrow="Demo 1 · variable typographic ASCII"
      title="Proportional ASCII, laid out by pretext, drawn by Typst."
      lede="A particle field is sampled into a grid that spans the full frame. Every glyph is chosen by brightness and centered in its cell using its measured width. Capture freezes that geometry as JSON — Typst only places it."
    >
      <CompilerBoundary label="Loading Libertinus Serif and the Typst compiler…">
        {(fonts, client) => <AsciiRoute client={client} fonts={fonts} />}
      </CompilerBoundary>
    </Shell>
  );
}
