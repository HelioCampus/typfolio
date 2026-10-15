import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePdfCompilation, usePdfObjectUrl } from '@typfolio/react';
import { CompilerBoundary } from '../CompilerBoundary.tsx';
import { FONT_FAMILY, type FontUrls } from '../assets.ts';
import { Shell } from '../Shell.tsx';
import { StaticPreview } from '../live/StaticPreview.tsx';
import type { Captured } from '../live/session.ts';
import { LivePanel, LiveSwitch, type LiveStatus } from '../live/LivePanel.tsx';
import { COLORS, framesToInput, makeAsciiRequest } from '../ascii/capture.ts';
import {
  ART_PADDING,
  LINE_HEIGHT,
  ROWS,
  STAGE_H,
  STAGE_W,
  TARGET_ROW_W,
  createAsciiEngine,
  rowWidth,
  type AsciiEngine,
  type Cell,
  type Frame,
} from '../ascii/engine.ts';

function escapeHtml(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  if (ch === '"') return '&quot;';
  return ch;
}

function cellHtml(cell: Cell): string {
  return cell === null
    ? ' '
    : `<span class="w${cell.entry.weight} a${cell.alphaIndex}">${escapeHtml(cell.entry.char)}</span>`;
}

/**
 * Distance from the top of a row's line box to its baseline, read from the DOM
 * (a zero-size inline-block sits on the baseline) so the PDF uses the browser's
 * own half-leading arithmetic instead of an estimate.
 */
function measureBaseline(stage: HTMLElement): number {
  const row = document.createElement('div');
  row.className = 'art-row';
  row.style.visibility = 'hidden';
  row.innerHTML = 'H<i class="probe"></i>';
  stage.appendChild(row);
  const probe = row.querySelector('.probe') as HTMLElement;
  const baseline = probe.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
  row.remove();
  return baseline;
}

interface Parity {
  readonly maxRowDelta: number;
  readonly rows: number;
}

const FLIPBOOK_FRAMES = 8;
const FLIPBOOK_INTERVAL_MS = 220;

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

interface AsciiWorkbenchProps {
  readonly engine: AsciiEngine;
  readonly fonts: FontUrls;
}

function AsciiWorkbench({ engine, fonts }: AsciiWorkbenchProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<HTMLDivElement[]>([]);
  const frameRef = useRef<Frame | undefined>(undefined);
  const baselineRef = useRef(0);
  const pausedRef = useRef(false);
  const demandRef = useRef(false);
  const lastAcquiredRef = useRef<Frame | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [parity, setParity] = useState<Parity>();
  const [captureMs, setCaptureMs] = useState<number>();
  const [inputBytes, setInputBytes] = useState<number>();
  const [pageCount, setPageCount] = useState<number>();
  const [recording, setRecording] = useState<{ done: number; total: number }>();

  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('starting');

  const pdf = usePdfCompilation();
  const pdfUrl = usePdfObjectUrl(pdf.result);

  useEffect(() => {
    const stage = stageRef.current;
    const source = sourceRef.current;
    if (stage === null || source === null) return;

    baselineRef.current = measureBaseline(stage);
    source.appendChild(engine.sourceCanvas);

    const rows = rowRefs.current;
    let handle = 0;
    let drawn: Frame | undefined;
    const render = (now: number): void => {
      // In demand-driven live mode the PDF pipeline steps the simulation itself;
      // the DOM just paints whatever the newest frame is.
      if (!pausedRef.current && !demandRef.current) frameRef.current = engine.step(now);
      const frame = frameRef.current;
      if (frame !== undefined && frame !== drawn) {
        drawn = frame;
        frame.rows.forEach((cells, index) => {
          const node = rows[index];
          if (node === undefined) return;
          // Same centering the PDF receives: (maxW - rowW) / 2 from measured widths.
          node.style.marginLeft = `${(TARGET_ROW_W - rowWidth(cells, engine.spaceWidth)) / 2}px`;
          node.innerHTML = cells.map(cellHtml).join('');
        });
      }
      handle = requestAnimationFrame(render);
    };
    handle = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(handle);
      engine.sourceCanvas.remove();
    };
  }, [engine]);

  const capture = useCallback(async (count: number) => {
    if (frameRef.current === undefined) return;
    const frames: Frame[] = [];
    if (count > 1) {
      // Flipbook: sample the running simulation, then freeze on the final frame.
      for (let index = 0; index < count - 1; index++) {
        frames.push(frameRef.current);
        setRecording({ done: index + 1, total: count });
        await new Promise(resolve => setTimeout(resolve, FLIPBOOK_INTERVAL_MS));
      }
      setRecording(undefined);
    }
    // Freeze the live panel on the captured frame so both sides can be compared.
    pausedRef.current = true;
    setPaused(true);
    const last = frameRef.current;
    if (last === undefined) return;
    frames.push(last);

    // Parity check: predicted row width (sum of pretext advances) against the
    // width the browser actually laid out for the frozen row.
    let maxRowDelta = 0;
    last.rows.forEach((cells, index) => {
      const node = rowRefs.current[index];
      if (node === undefined) return;
      const actual = node.getBoundingClientRect().width;
      maxRowDelta = Math.max(maxRowDelta, Math.abs(actual - rowWidth(cells, engine.spaceWidth)));
    });
    setParity({ maxRowDelta, rows: last.rows.length });

    const input = framesToInput(frames, engine.spaceWidth, baselineRef.current);
    setInputBytes(JSON.stringify(input).length);
    setPageCount(frames.length);
    const startedAt = performance.now();
    try {
      await pdf.compile(makeAsciiRequest(input));
      setCaptureMs(performance.now() - startedAt);
    } catch {
      // usePdfCompilation exposes the failure through its state.
    }
  }, [engine, pdf]);

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
  const buildLiveRequest = useCallback(
    (frame: Frame, burn: number) => makeAsciiRequest(framesToInput([frame], engine.spaceWidth, baselineRef.current, burn)),
    [engine],
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
      setPaused(false);
    }
  }, [engine]);

  const busy = pdf.isCompiling || recording !== undefined || live;

  const resume = (): void => {
    pausedRef.current = false;
    setPaused(false);
  };

  const stageStyle = useMemo(
    () => ({
      width: STAGE_W,
      height: STAGE_H,
      padding: ART_PADDING,
      background: COLORS.background,
    }),
    [],
  );

  return (
    <div className="workbench">
      <section className="card">
        <header className="card-head">
          <div>
            <p className="kicker">Live · DOM</p>
            <h2>Pretext-measured frame</h2>
          </div>
          <span className={`pill${paused ? ' pill--hold' : ''}`}>{paused ? 'Frozen' : 'Running'}</span>
        </header>
        <div
          aria-label="Live proportional ASCII frame"
          className="stage"
          ref={stageRef}
          role="img"
          style={stageStyle}
        >
          {Array.from({ length: ROWS }, (_, index) => (
            <div
              className="art-row"
              key={index}
              ref={node => {
                if (node !== null) rowRefs.current[index] = node;
              }}
              style={{ height: LINE_HEIGHT }}
            />
          ))}
        </div>
        <div className="card-actions">
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => void capture(1)}
            type="button"
          >
            {pdf.isCompiling ? 'Compiling…' : 'Capture frame as PDF'}
          </button>
          <button className="button" disabled={busy} onClick={() => void capture(FLIPBOOK_FRAMES)} type="button">
            {recording === undefined ? `Flipbook · ${FLIPBOOK_FRAMES} pages` : `Recording ${recording.done}/${recording.total}…`}
          </button>
          <button className="button" disabled={!paused} onClick={resume} type="button">
            Resume
          </button>
          <div className="source" title="Source field">
            <div className="source-canvas" ref={sourceRef} />
          </div>
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
            aspect={STAGE_W / STAGE_H}
            buildRequest={buildLiveRequest}
            fonts={fonts}
            documentName="ascii-art.pdf"
            downloadName="typfolio-ascii-frame.pdf"
            interaction={canvasInteraction}
            maxWidth={468}
            onActiveChange={onLiveActive}
            onStatus={setLiveStatus}
          />
        ) : (
          <StaticPreview
            aspect={STAGE_W / STAGE_H}
            bytes={pdf.result?.bytes}
            documentName="ascii-art.pdf"
            downloadName="typfolio-ascii-frame.pdf"
            error={pdf.isError ? pdf.error : undefined}
            maxWidth={468}
            pages={pageCount}
            pending={pdf.isCompiling && pdfUrl === undefined}
            url={pdfUrl}
          />
        )}
        {live ? null : (
        <dl className="facts">
          <div><dt>Palette</dt><dd>{engine.paletteInfo.entries} glyph variants</dd></div>
          <div><dt>Compile</dt><dd>{formatMs(captureMs)}</dd></div>
          <div><dt>Pages</dt><dd>{pageCount ?? '—'}</dd></div>
          <div><dt>Input JSON</dt><dd>{inputBytes === undefined ? '—' : `${(inputBytes / 1000).toFixed(1)} kB`}</dd></div>
          <div className="facts-wide">
            <dt>Row width vs DOM</dt>
            <dd>{parity === undefined ? '—' : `max Δ ${parity.maxRowDelta.toFixed(3)} px over ${parity.rows} rows`}</dd>
          </div>
        </dl>
        )}
      </section>
    </div>
  );
}

function AsciiRoute({ fonts }: { readonly fonts: FontUrls }) {
  // Fonts are registered by CompilerBoundary before this mounts, so both
  // pretext widths and canvas brightness see the Libertinus faces.
  const [engine] = useState(() => createAsciiEngine(FONT_FAMILY));
  return <AsciiWorkbench engine={engine} fonts={fonts} />;
}

export default function AsciiPage() {
  return (
    <Shell
      eyebrow="Demo 1 · variable typographic ASCII"
      title="Proportional ASCII, laid out by pretext, drawn by Typst."
      lede="A particle field is sampled into a grid. Every cell is a glyph chosen by brightness and measured width; rows are centered from the measured advances. Capture freezes that geometry as JSON — Typst only places it."
    >
      <CompilerBoundary label="Loading Libertinus Serif and the Typst compiler…">
        {fonts => <AsciiRoute fonts={fonts} />}
      </CompilerBoundary>
    </Shell>
  );
}
