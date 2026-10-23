import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BatchRun, percentile, type BatchSettings, type DocRow } from './batch.ts';
import { DocumentHeatmap, legends, ProgressChart, type ColorBy } from './charts.tsx';
import { loadRuns, recordRun, saveRuns, sweepWorkers, type RunRecord } from './runs.ts';
import { RunsPanel } from './RunsPanel.tsx';
import './styles.css';

const StaticViewer = lazy(() => import('../live/StaticViewer.tsx'));

// Settings can come from the URL, for recordings and automated runs: ?workers=4&count=1000&autostart
const cores = navigator.hardwareConcurrency || 4;
const maxWorkers = Math.min(16, cores);
const maxCount = 5000;

function clampCount(value: number): number {
  return Math.max(1, Math.min(maxCount, Math.floor(value) || 1000));
}

export function BatchWorkbench() {
  const [params] = useState(() => new URLSearchParams(location.search));
  const [workers, setWorkers] = useState(() => Math.max(1, Math.min(maxWorkers,
    Math.floor(Number(params.get('workers'))) || Math.min(4, cores - 1))));
  const [count, setCount] = useState(() => clampCount(Number(params.get('count') ?? 1000)));
  const [ua, setUa] = useState(true);
  const [keep, setKeep] = useState(true);
  const [follow, setFollow] = useState(true);
  const [run, setRun] = useState(() => new BatchRun({ total: count, workers, ua, keep }));
  const [preview, setPreview] = useState<number | null>(null);
  const version = useSyncExternalStore(run.subscribe, run.getVersion);
  // Status while a batch runs, speed once it is over. The toggle works at any time; once it is used during a
  // run, the end of that run leaves the chosen view alone.
  const [colorBy, setColorBy] = useState<ColorBy>('status');
  const picked = useRef(false);
  const pick = (mode: ColorBy): void => { picked.current = true; setColorBy(mode); };
  const ended = run.endedAt !== undefined;
  useEffect(() => { if (ended && !picked.current) setColorBy('speed'); }, [run, ended]);

  const [runs, setRuns] = useState<RunRecord[]>(loadRuns);
  const [sweep, setSweep] = useState<{ readonly at: number; readonly counts: readonly number[] }>();
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort('Left the performance demo');
    };
  }, []);

  /** Runs one batch to the end and records it when every document rendered. */
  const runBatch = useCallback(async (settings: BatchSettings, signal: AbortSignal): Promise<BatchRun> => {
    setPreview(null);
    setColorBy('status');
    picked.current = false;
    const next = new BatchRun(settings);
    setRun(next);
    const cancel = (): void => next.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await next.start();
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (!mounted.current || signal.aborted) return next;
    setRuns(previous => {
      const record = recordRun(next, (previous.at(-1)?.id ?? 0) + 1);
      if (!record) return previous;
      const all = [...previous, record].slice(-40);
      saveRuns(all);
      return all;
    });
    return next;
  }, []);

  /** One owned operation covers a single batch or an entire worker sweep. */
  const launch = useCallback(async (compare: boolean) => {
    if (operation.current !== undefined) return;
    const controller = new AbortController();
    operation.current = controller;
    const total = clampCount(count);
    const counts = compare ? sweepWorkers(maxWorkers) : [workers];
    setCount(total);
    try {
      for (let at = 0; at < counts.length; at++) {
        if (controller.signal.aborted) break;
        if (compare) setSweep({ at, counts });
        setWorkers(counts[at]!);
        const finished = await runBatch({ total, workers: counts[at]!, ua, keep }, controller.signal);
        if (finished.aborted || finished.error || finished.failed) break;
        // Let the previous pool and retained PDFs be collected between sweep runs.
        if (at + 1 < counts.length) await new Promise(resolve => setTimeout(resolve, 400));
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setSweep(undefined);
    }
  }, [count, workers, ua, keep, runBatch]);
  const start = useCallback(() => { void launch(false); }, [launch]);

  const clearRuns = useCallback(() => { setRuns([]); saveRuns([]); }, []);

  const autostarted = useRef(false);
  useEffect(() => {
    if (params.has('autostart') && !autostarted.current) {
      // Defer until after StrictMode's setup/cleanup probe.
      const timer = setTimeout(() => { autostarted.current = true; start(); }, 0);
      return () => clearTimeout(timer);
    }
  }, [params, start]);

  const open = useCallback((index: number) => { if (run.pdfs[index]) setPreview(index); }, [run]);
  // A sweep is busy between its runs too.
  const running = run.running || sweep !== undefined;

  return (
    <div className="batch-demo">
      <section className="panel controls" aria-label="Batch settings">
        <label>Workers
          <input type="range" min={1} max={maxWorkers} value={workers} disabled={running}
            onChange={event => setWorkers(Number(event.target.value))} />
          <output>{workers}</output>
        </label>
        <label>Documents
          <input type="number" min={1} max={maxCount} step={1} value={count} disabled={running}
            onChange={event => setCount(Number(event.target.value))} />
        </label>
        <label><input type="checkbox" checked={ua} disabled={running} onChange={event => setUa(event.target.checked)} /> PDF/UA-1</label>
        <label><input type="checkbox" checked={keep} disabled={running} onChange={event => setKeep(event.target.checked)} /> Keep PDFs to open</label>
        <div className="buttons">
          <button id="start" type="button" disabled={running} onClick={start}>Render</button>
          <button id="cancel" type="button" disabled={!running} onClick={() => operation.current?.abort('Cancelled by the user')}>Cancel</button>
        </div>
      </section>

      <Metrics run={run} version={version} />

      <div className="split">
        <section className="panel" aria-labelledby="overview-title">
          <h2 id="overview-title">Completed over time</h2>
          <ProgressChart run={run} version={version} />
          <div className="list-head">
            <h2>Documents</h2>
            <div className="toggle" role="group" aria-label="Colour cells by">
              {(['status', 'speed'] as const).map(mode => (
                <button key={mode} type="button" aria-pressed={colorBy === mode} onClick={() => pick(mode)}>
                  {mode === 'status' ? 'Status' : 'Speed'}
                </button>
              ))}
            </div>
          </div>
          <DocumentHeatmap run={run} version={version} colorBy={colorBy} onOpen={open} />
          <Legend colorBy={colorBy} />
        </section>
        <section className="panel" aria-labelledby="files-title">
          <div className="list-head">
            <h2 id="files-title">Files</h2>
            <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow</label>
          </div>
          <FileList run={run} version={version} follow={follow && run.running} onOpen={open} />
        </section>
      </div>

      <Status run={run} version={version} />
      <RunsPanel runs={runs} running={running} sweep={sweep} onSweep={() => void launch(true)} onClear={clearRuns} />
      <Preview run={run} index={preview} onChange={setPreview} />
    </div>
  );
}

function Legend({ colorBy }: { readonly colorBy: ColorBy }) {
  return (
    <div className="legend" aria-hidden="true">
      {legends[colorBy].filter(b => b.key !== 'Cancelled').map(b => (
        <span key={b.key}><i style={{ background: b.paint }} />{b.key}</span>
      ))}
      {colorBy === 'speed' && <>
        <span><i className="ring" />Cold start (first job on a worker)</span>
        <span><i className="ring failed" />Failed</span>
      </>}
    </div>
  );
}

function Metrics({ run, version }: { readonly run: BatchRun; readonly version: number }) {
  void version;
  const elapsed = run.elapsed();
  const rate = run.done / Math.max(elapsed, 0.001);
  const p50 = percentile(run.durations, 0.5);
  const p95 = percentile(run.durations, 0.95);
  const cold = run.rows.filter(row => row.cold && row.ms !== undefined).map(row => row.ms!);
  const warm = run.rows.filter(row => !row.cold && row.ms !== undefined).map(row => row.ms!);
  const coldMedian = percentile(cold, 0.5);
  const warmMedian = percentile(warm, 0.5);
  const total = run.settings.total;
  return (
    <section className="metrics" aria-label="Metrics">
      <Metric label="Completed" value={String(run.done)} sub={`of ${total}${run.failed ? ` · ${run.failed} failed` : ''}`}>
        <div className="progress"><div style={{ width: `${(run.settled / total) * 100}%` }} /></div>
      </Metric>
      <Metric label="Elapsed" value={`${elapsed.toFixed(1)} s`}
        sub={run.running && run.done ? `about ${Math.ceil((total - run.settled) / rate)} s left` : ' '} />
      <Metric label="Throughput" value={run.done ? rate.toFixed(1) : '–'}
        sub={run.done ? `PDFs per second · ${(rate / run.settings.workers).toFixed(1)} per worker` : 'PDFs per second'} />
      <Metric label="Compile time" value={p50 === undefined ? '–' : `${Math.round(p50)} ms`}
        sub={p95 === undefined ? 'median, per PDF' : `median per PDF · p95 ${Math.round(p95)} ms`} />
      <Metric label="Cold start" value={coldMedian === undefined ? '–' : `${Math.round(coldMedian)} ms`}
        sub={coldMedian !== undefined && warmMedian ? `first job per worker · ${(coldMedian / warmMedian).toFixed(0)}× a warm one` : 'first job per worker'} />
      <Metric label="Output" value={run.done ? `${(run.bytes / 1024 / 1024).toFixed(1)} MB` : '–'}
        sub={run.done ? `${(run.bytes / run.done / 1024).toFixed(1)} KB per PDF` : ' '} />
      <MainThread />
    </section>
  );
}

function Metric(props: { readonly label: string; readonly value: string; readonly sub: string; readonly children?: ReactNode }) {
  return (
    <div className="panel metric">
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      <div className="sub">{props.sub}</div>
      {props.children}
    </div>
  );
}

/**
 * Longest gap between animation frames over the last second. Compilation runs in the workers, so the page
 * should keep painting at full rate while a batch runs. Updated four times a second to stay cheap itself.
 */
function MainThread() {
  const [longest, setLongest] = useState<number | null>(null);
  useEffect(() => {
    const frames: { at: number; gap: number }[] = [];
    let last = performance.now();
    let shown = 0;
    let id = requestAnimationFrame(function tick(now) {
      frames.push({ at: now, gap: now - last });
      last = now;
      while (frames.length && frames[0]!.at < now - 1000) frames.shift();
      if (now - shown > 250) {
        shown = now;
        // A hidden tab gets about one frame per second, which says nothing about this page.
        setLongest(document.hidden ? null : Math.max(...frames.map(frame => frame.gap)));
      }
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return <Metric label="Main thread" value={longest === null ? 'paused' : `${Math.round(longest)} ms`} sub="longest frame, last second" />;
}

const FileRow = memo(function FileRow({ row, kept, onOpen }: { readonly row: DocRow; readonly kept: boolean; readonly onOpen: (index: number) => void }) {
  return (
    <div className={`row ${row.state}${kept ? ' kept' : ''}`} role="listitem" title={row.error}
      >
      <span className="file">{kept
        ? <button className="file-link" type="button" onClick={() => onOpen(row.index)} aria-label={`Open ${row.file}`}>{row.file}</button>
        : row.file}</span>
      <span className="name">{row.student}</span>
      <span className="badge">{row.state === 'error' ? 'failed' : row.state}{row.cold && row.state !== 'queued' ? ' · cold' : ''}</span>
      <span className="num">{row.ms === undefined ? '' : `${Math.round(row.ms)} ms`}</span>
      <span className="num">{row.bytes === undefined ? '' : `${(row.bytes / 1024).toFixed(1)} KB`}</span>
    </div>
  );
});

function FileList({ run, version, follow, onOpen }: { readonly run: BatchRun; readonly version: number; readonly follow: boolean; readonly onOpen: (index: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: 0 }); }, [run]);
  // Keeps the earliest rendering row near the top of the list.
  useEffect(() => {
    const element = list.current;
    if (!follow || !element) return;
    const index = run.rows.findIndex(row => row.state === 'rendering');
    const target = index >= 0 ? element.children[index] as HTMLElement | undefined : undefined;
    if (!target) return;
    const top = target.offsetTop - element.offsetTop - 2 * target.offsetHeight;
    if (Math.abs(element.scrollTop - top) > target.offsetHeight) element.scrollTop = top;
  }, [run, version, follow]);
  return (
    <div id="list" role="list" ref={list}>
      {run.rows.map(row => <FileRow key={row.index} row={row} kept={row.state === 'done' && !!run.pdfs[row.index]} onOpen={onOpen} />)}
    </div>
  );
}

function Status({ run, version }: { readonly run: BatchRun; readonly version: number }) {
  void version;
  const { workers } = run.settings;
  const plural = workers === 1 ? '' : 's';
  let status = 'idle';
  let text = 'Ready.';
  if (run.error) {
    status = 'failed';
    text = run.error;
  } else if (run.running) {
    status = 'running';
    text = `Rendering ${run.settings.total} PDFs on ${workers} worker${plural}…`;
  } else if (run.endedAt !== undefined) {
    const seconds = run.elapsed();
    status = run.failed ? 'failed' : run.aborted ? 'cancelled' : 'passed';
    text = run.aborted
      ? `Cancelled after ${run.done} PDFs in ${seconds.toFixed(1)} s.`
      : `${run.done} PDFs in ${seconds.toFixed(1)} s on ${workers} worker${plural} (${(run.done / seconds).toFixed(1)} per second)` +
        `${run.failed ? `, ${run.failed} failed` : ''}.`;
  }
  return <p id="status" role="status" data-status={status}>{text}</p>;
}

/** The shared PDF viewer, with an object URL only for the current PDF's open/download actions. */
function Preview({ run, index, onChange }: { readonly run: BatchRun; readonly index: number | null; readonly onChange: (index: number | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const bytes = index === null ? undefined : run.pdfs[index];
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!bytes) { setUrl(undefined); return; }
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (bytes && !element.open) element.showModal();
    if (!bytes && element.open) element.close();
  }, [bytes]);

  const step = (direction: 1 | -1): number | null => {
    if (index === null) return null;
    for (let at = index + direction; at >= 0 && at < run.settings.total; at += direction) if (run.pdfs[at]) return at;
    return null;
  };
  const previous = step(-1);
  const next = step(1);
  const row = index === null ? undefined : run.rows[index];

  return (
    <dialog id="preview" ref={dialog} aria-labelledby="preview-title"
      onClose={() => onChange(null)}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' && previous !== null) onChange(previous);
        if (event.key === 'ArrowRight' && next !== null) onChange(next);
      }}>
      <div className="content">
        <header>
          <strong id="preview-title">{row?.file}</strong>
          <span className="meta">{row ? `${row.student} · ${row.bytes ? (row.bytes / 1024).toFixed(1) : '?'} KB · ${row.ms ? Math.round(row.ms) : '?'} ms` : ''}</span>
          <div className="actions">
            <button type="button" aria-label="Previous PDF" disabled={previous === null} onClick={() => onChange(previous)}>←</button>
            <button type="button" aria-label="Next PDF" disabled={next === null} onClick={() => onChange(next)}>→</button>
            <a href={url} target="_blank" rel="noopener">Open in new tab</a>
            <a href={url} download={row?.file}>Download</a>
            <button type="button" onClick={() => dialog.current?.close()}>Close</button>
          </div>
        </header>
        {bytes && <Suspense fallback={<div className="pdf-empty">Loading PDF…</div>}>
          <StaticViewer bytes={bytes} name={row?.file ?? 'Report.pdf'} aspect={210 / 297} maxWidth={595} initialZoom={1} />
        </Suspense>}
      </div>
    </dialog>
  );
}
