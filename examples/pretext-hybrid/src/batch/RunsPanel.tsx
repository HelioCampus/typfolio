import { useMemo } from 'react';
import { defineChart, dot, lineY } from '@tanstack/charts';
import { decorative } from '@tanstack/charts/mark/decorative';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { portal } from '@tanstack/charts/tooltip/portal';
import type { Engine } from './batch.ts';
import { median, medianRates, workerPaint, type RunRecord } from './runs.ts';

interface RunsPanelProps {
  readonly runs: readonly RunRecord[];
  /** Only this engine's runs are charted and listed: the two engines' rates are an order of magnitude apart. */
  readonly engine: Engine;
  readonly running: boolean;
  readonly sweep?: { readonly at: number; readonly counts: readonly number[] };
  readonly onSweep: () => void;
  readonly onClear: () => void;
}

/** Compares finished runs: how throughput scales with workers, how each run progressed, and the numbers. */
export function RunsPanel({ runs, engine, running, sweep, onSweep, onClear }: RunsPanelProps) {
  const cores = navigator.hardwareConcurrency || 0;
  const shown = runs.filter(run => (run.engine ?? 'typst') === engine);
  const other = runs.length - shown.length;
  return (
    <section className="panel runs" aria-labelledby="runs-title">
      <div className="list-head">
        <h2 id="runs-title">Runs</h2>
        <div className="buttons">
          <button type="button" className="secondary" disabled={running} onClick={onSweep}
            title="Render the same batch with 1, 2, 4, 8… workers, one run after another">Sweep workers</button>
          <button type="button" className="secondary" disabled={running || !runs.length} onClick={onClear}>Clear</button>
        </div>
      </div>
      <p className="note">
        {sweep
          ? `Sweep: run ${sweep.at + 1} of ${sweep.counts.length} (${sweep.counts.join(', ')} workers).`
          : `Every finished run is kept here, in this browser only; these are the ${engine === 'paramdoc' ? 'paramdoc runtime' : 'Typst compiler'} runs${other ? ` (${other} more with the other engine)` : ''}. Change the worker count and render again, or sweep.`}
        {' '}This browser reports {cores} logical cores. Other work on the machine changes the numbers, so compare runs
        made close together.
      </p>
      {shown.length ? (
        <>
          <div className="runs-charts">
            <div>
              <h3>Throughput by workers</h3>
              <ScalingChart runs={shown} />
              <div className="legend" aria-hidden="true">
                <span><i className="line" />Median of runs</span>
                <span><i className="line dashed" />Perfect scaling from the fewest workers</span>
              </div>
            </div>
            <div>
              <h3>Progress, latest runs</h3>
              <ProgressLines runs={shown} />
              <WorkerLegend runs={shown.slice(-6)} />
            </div>
          </div>
          <RunsTable runs={shown} />
        </>
      ) : null}
    </section>
  );
}

function WorkerLegend({ runs }: { readonly runs: readonly RunRecord[] }) {
  const counts = [...new Set(runs.map(run => run.workers))].sort((a, b) => a - b);
  return (
    <div className="legend" aria-hidden="true">
      {counts.map(count => (
        <span key={count}><i style={{ background: workerPaint(count) }} />{count} worker{count === 1 ? '' : 's'}</span>
      ))}
    </div>
  );
}

/**
 * PDFs per second against worker count: one dot per run, the median per worker count as a line, and the
 * line a perfectly parallel batch would follow, scaled from the fewest-workers median.
 */
function ScalingChart({ runs }: { readonly runs: readonly RunRecord[] }) {
  const definition = useMemo(() => {
    const medians = medianRates(runs);
    const base = medians[0]!;
    const maxWorkers = Math.max(...runs.map(run => run.workers));
    const ideal = Array.from({ length: maxWorkers - base.workers + 1 }, (_, i) => {
      const workers = base.workers + i;
      return { workers, rate: (base.rate / base.workers) * workers };
    });
    const top = Math.max(...runs.map(run => run.rate), ...ideal.map(row => row.rate));
    return defineChart({
      marks: [
        decorative(lineY(ideal, { x: 'workers', y: 'rate', stroke: 'var(--chart-muted)', strokeWidth: 1.5, strokeDasharray: '4 4' })),
        decorative(lineY(medians, { x: 'workers', y: 'rate', stroke: 'var(--chart-ink)', strokeWidth: 2 })),
        dot(runs, { x: 'workers', y: 'rate', key: 'id', r: 5, color: 'workers', stroke: 'var(--panel)', strokeWidth: 1.5 }),
      ],
      scales: {
        x: {
          scale: scaleLinear().domain([Math.max(0, base.workers - 0.5), maxWorkers + 0.5]),
          axis: { label: 'Workers', ticks: { values: [...new Set(runs.map(run => run.workers))].sort((a, b) => a - b), format: v => String(v) } },
        },
        y: { scale: scaleLinear().domain([0, top * 1.08]), grid: true, axis: { label: 'PDFs per second', ticks: { count: 4 } } },
      },
      color: { domain: [...new Set(runs.map(run => run.workers))].sort((a, b) => a - b), range: [...new Set(runs.map(run => run.workers))].sort((a, b) => a - b).map(workerPaint) },
      tooltip: {
        use: tooltip,
        portal,
        motion: false,
        format: point => {
          const run = point.datum;
          const speedup = run.rate / base.rate;
          return `Run ${run.id} · ${run.workers} worker${run.workers === 1 ? '' : 's'}\n${run.rate} PDFs/s · ${run.seconds} s for ${run.total}` +
            `\n${speedup.toFixed(1)}× the ${base.workers}-worker median${run.hidden ? '\nTab was hidden: slowed down' : ''}`;
        },
      },
    });
  }, [runs]);

  return <Chart definition={definition} height={240} ariaLabel="PDFs per second by worker count, per run" className="runs-chart" />;
}

/** Percent complete over time for the latest six runs, coloured by worker count. */
function ProgressLines({ runs }: { readonly runs: readonly RunRecord[] }) {
  const definition = useMemo(() => {
    const latest = runs.slice(-6);
    const rows = latest.flatMap(run => run.progress.map(p => ({ ...p, run: `Run ${run.id}`, workers: run.workers, id: run.id })));
    return defineChart({
      marks: [
        lineY(rows, { x: 't', y: 'percent', z: 'run', stroke: row => workerPaint(row.workers), strokeWidth: 2 }),
      ],
      scales: {
        x: { scale: scaleLinear, nice: true, axis: { label: 'Seconds', ticks: { count: 5 } } },
        y: { scale: scaleLinear().domain([0, 100]), grid: true, axis: { label: 'Complete', ticks: { count: 5, format: v => `${v}%` } } },
      },
      focus: 'nearest-x',
      tooltip: {
        use: tooltip,
        portal,
        motion: false,
        format: point => `${point.datum.run} · ${point.datum.workers} worker${point.datum.workers === 1 ? '' : 's'}\n${point.datum.percent.toFixed(0)}% after ${point.datum.t.toFixed(1)} s`,
      },
    });
  }, [runs]);

  return <Chart definition={definition} height={240} ariaLabel="Percent complete over time for the latest runs" className="runs-chart" />;
}

/** The exact numbers behind both charts, newest first. */
function RunsTable({ runs }: { readonly runs: readonly RunRecord[] }) {
  const base = medianRates(runs)[0]!;
  const baseRate = median(runs.filter(run => run.workers === base.workers).map(run => run.rate));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Workers</th>
            <th scope="col">PDFs</th>
            <th scope="col">Time</th>
            <th scope="col">PDFs/s</th>
            <th scope="col" title={`Against the ${base.workers}-worker median`}>Speed-up</th>
            <th scope="col" title="Speed-up divided by the worker ratio">Efficiency</th>
            <th scope="col">Median</th>
            <th scope="col">p95</th>
            <th scope="col">Cold start</th>
          </tr>
        </thead>
        <tbody>
          {[...runs].reverse().map(run => {
            const speedup = run.rate / baseRate;
            const efficiency = speedup / (run.workers / base.workers);
            return (
              <tr key={run.id} className={run.hidden ? 'hidden-run' : undefined} title={run.hidden ? 'The tab was hidden during this run, which slows it down' : undefined}>
                <td><i className="swatch" style={{ background: workerPaint(run.workers) }} />{run.id}{run.hidden ? ' *' : ''}</td>
                <td>{run.workers}</td>
                <td>{run.total}</td>
                <td>{run.seconds.toFixed(1)} s</td>
                <td>{run.rate.toFixed(1)}</td>
                <td>{speedup.toFixed(1)}×</td>
                <td>{Math.round(efficiency * 100)}%</td>
                <td>{run.p50.toFixed(0)} ms</td>
                <td>{run.p95.toFixed(0)} ms</td>
                <td>{run.cold === undefined ? '–' : `${run.cold.toFixed(0)} ms`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {runs.some(run => run.hidden) && <p className="note">* The tab was hidden during this run, which slows it down.</p>}
    </div>
  );
}
