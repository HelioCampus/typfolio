import { useMemo } from 'react';
import { areaY, cell, defineChart, lineY } from '@tanstack/charts';
import { crosshair } from '@tanstack/charts/crosshair';
import { decorative } from '@tanstack/charts/mark/decorative';
import { Chart } from '@tanstack/charts/react/tooltip';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleOrdinal } from '@tanstack/charts/scales/ordinal';
import { tooltip } from '@tanstack/charts/tooltip';
import { portal } from '@tanstack/charts/tooltip/portal';
import { percentile, type BatchRun, type DocRow } from './batch.ts';

/** Status while running, then compile time from green (fast) through yellow and orange to red (slow).
 * Cold starts and errors use rings in the speed view; paints retain the original batch chart palette. */
export type ColorBy = 'status' | 'speed';

export const legends = {
  status: [
    { key: 'Queued', paint: 'var(--chart-queued)' },
    { key: 'Rendering', paint: 'var(--chart-active)' },
    { key: 'Done', paint: 'var(--chart-done)' },
    { key: 'Failed', paint: 'var(--chart-error)' },
    { key: 'Cancelled', paint: 'var(--chart-cancelled)' },
  ],
  speed: [
    { key: 'Under 10 ms', paint: 'var(--speed-1)' },
    { key: '10–25 ms', paint: 'var(--speed-2)' },
    { key: '25–100 ms', paint: 'var(--speed-3)' },
    { key: '100 ms or more', paint: 'var(--speed-4)' },
    { key: 'No time (not rendered or failed)', paint: 'var(--chart-queued)' },
  ],
} as const;

function bucket(row: DocRow, colorBy: ColorBy): string {
  if (colorBy === 'status') {
    switch (row.state) {
      case 'queued': return 'Queued';
      case 'rendering': return 'Rendering';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      case 'cancelled': return 'Cancelled';
    }
  }
  if (row.state !== 'done' || row.ms === undefined) return 'No time (not rendered or failed)';
  if (row.ms < 10) return 'Under 10 ms';
  if (row.ms < 25) return '10–25 ms';
  if (row.ms < 100) return '25–100 ms';
  return '100 ms or more';
}

const colorScales = {
  status: scaleOrdinal<string, string>().domain(legends.status.map(b => b.key)).range(legends.status.map(b => b.paint)),
  speed: scaleOrdinal<string, string>().domain(legends.speed.map(b => b.key)).range(legends.speed.map(b => b.paint)),
};

interface HeatCell extends DocRow {
  readonly col: number;
  readonly line: number;
  readonly bucket: string;
}

/** Columns for a roughly 1.6:1 grid: 40 × 25 for 1000 documents. */
function columns(total: number): number {
  return Math.max(10, Math.ceil(Math.sqrt(total * 1.6)));
}

interface HeatmapProps {
  readonly run: BatchRun;
  readonly version: number;
  readonly colorBy: ColorBy;
  readonly onOpen: (index: number) => void;
}

export function DocumentHeatmap({ run, version, colorBy, onOpen }: HeatmapProps) {
  const total = run.settings.total;
  const cols = columns(total);
  const lines = Math.ceil(total / cols);

  const definition = useMemo(() => {
    const cells: HeatCell[] = run.rows.map(row => ({
      ...row, col: row.index % cols, line: Math.floor(row.index / cols), bucket: bucket(row, colorBy),
    }));
    // Rings drawn over the fills, speed view only: cold starts (the text colour) and failures (red).
    const ring = (rows: HeatCell[], stroke: string) => decorative(cell(rows, {
      x: 'col', y: 'line', key: 'file', inset: 0, radius: 3, fill: 'transparent', stroke, strokeWidth: 1.5,
    }));
    const speed = colorBy === 'speed';
    return defineChart({
      marks: [
        cell(cells, { x: 'col', y: 'line', color: 'bucket', key: 'file', inset: 1, radius: 2 }),
        ring(speed ? cells.filter(c => c.cold && c.state === 'done') : [], 'var(--chart-ink)'),
        ring(speed ? cells.filter(c => c.state === 'error') : [], 'var(--chart-error)'),
      ],
      scales: {
        x: { scale: scaleBand<number>().domain(Array.from({ length: cols }, (_, i) => i)), axis: false },
        y: { scale: scaleBand<number>().domain(Array.from({ length: lines }, (_, i) => i)), axis: false },
      },
      color: { scale: colorScales[colorBy] },
      margin: 0,
      tooltip: { use: tooltip, portal, anchor: 'point', placement: ['right', 'left', 'top', 'bottom'], offset: 10, motion: false,
        // A click opens the PDF, so it must not also pin the tooltip.
        sticky: false },
    });
    // `version` is the store's change counter: the rows array is mutated in place, so it is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, version, cols, lines, colorBy]);

  const median = percentile(run.durations, 0.5);

  return (
    <Chart
      definition={definition}
      aspectRatio={cols / lines}
      initialWidth={480}
      ariaLabel={`${total} documents, coloured by ${colorBy === 'speed' ? 'compile time' : 'status'}`}
      ariaDescription="One cell per PDF in document order. Hover or use the arrow keys for each document's details; Enter opens it."
      className="heatmap"
      onSelect={point => { if (point?.datum.state === 'done') onOpen(point.datum.index); }}
      renderTooltipBody={({ points }) => {
        const row = points[0]?.datum;
        return row ? <DocCard row={row} median={median} /> : null;
      }}
    />
  );
}

function DocCard({ row, median }: { readonly row: HeatCell; readonly median?: number }) {
  const ratio = row.ms !== undefined && median ? row.ms / median : undefined;
  return (
    <div className="batch-doc-card">
      <strong>{row.file}</strong>
      <span className="muted">{row.student}</span>
      <dl>
        <dt>Status</dt><dd>{row.state === 'error' ? 'failed' : row.state}</dd>
        {row.ms !== undefined && <><dt>Compile time</dt><dd>{Math.round(row.ms)} ms</dd></>}
        {ratio !== undefined && <><dt>vs median</dt><dd>{ratio.toFixed(1)}× ({Math.round(median!)} ms)</dd></>}
        {row.bytes !== undefined && <><dt>Size</dt><dd>{(row.bytes / 1024).toFixed(1)} KB</dd></>}
        {row.error && <><dt>Error</dt><dd>{row.error}</dd></>}
      </dl>
      {row.cold && <p className="cold-note">Cold start: first job on its worker, so its time includes starting the worker.</p>}
    </div>
  );
}

interface ProgressProps {
  readonly run: BatchRun;
  readonly version: number;
}

/** Settled documents over time. A straight line means a steady rate. */
export function ProgressChart({ run, version }: ProgressProps) {
  const total = run.settings.total;
  const definition = useMemo(() => {
    // Samples arrive about every 100 ms; thin them out so a long run stays a light path.
    const step = Math.max(1, Math.ceil(run.samples.length / 300));
    const rows = run.samples.filter((_, i) => i % step === 0 || i === run.samples.length - 1);
    const end = Math.max(rows.at(-1)?.t ?? 0, 0.1);
    return defineChart({
      marks: [
        areaY(rows, { x: 't', y: 'settled', fill: 'var(--chart-done-soft)' }),
        lineY(rows, { x: 't', y: 'settled', stroke: 'var(--chart-done)', strokeWidth: 2 }),
        crosshair({ x: true, y: false }),
      ],
      scales: {
        x: { scale: scaleLinear().domain([0, end]), axis: { ticks: { count: 5, format: v => `${v} s` } } },
        y: { scale: scaleLinear().domain([0, total]), grid: true, axis: { ticks: { count: 4 } } },
      },
      focus: 'nearest-x',
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        portal,
        motion: false,
        format: point => `${point.datum.t.toFixed(1)} s · ${point.datum.settled} of ${total} done`,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, version, total]);

  return (
    <Chart
      definition={definition}
      height={150}
      ariaLabel="Documents completed over time"
      className="progress-chart"
    />
  );
}
