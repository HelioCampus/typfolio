import { percentile, type BatchRun } from './batch.ts';

/** A finished run, kept for comparison. Stored in this browser only. */
export interface RunRecord {
  readonly id: number;
  /** ISO time the run finished. */
  readonly at: string;
  readonly workers: number;
  readonly total: number;
  readonly ua: boolean;
  readonly seconds: number;
  /** PDFs per second. */
  readonly rate: number;
  readonly p50: number;
  readonly p95: number;
  /** Median compile time of each worker's first job, and of the rest. */
  readonly cold?: number;
  readonly warm?: number;
  /** The tab was hidden at some point; browsers slow hidden tabs down, so the numbers are not comparable. */
  readonly hidden: boolean;
  /** `navigator.hardwareConcurrency` when the run finished. */
  readonly cores: number;
  /** Percent complete over time, thinned to at most 120 points. */
  readonly progress: readonly { readonly t: number; readonly percent: number }[];
}

const storageKey = 'typfolio-performance-runs-v1';
const keep = 40;

export function loadRuns(): RunRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(parsed) ? parsed as RunRecord[] : [];
  } catch {
    return [];
  }
}

export function saveRuns(runs: readonly RunRecord[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(runs.slice(-keep)));
  } catch {
    // Private windows and blocked storage: the history then lasts until the page closes.
  }
}

/** Builds the record for a run that rendered every document, or returns undefined. */
export function recordRun(run: BatchRun, id: number): RunRecord | undefined {
  const { total, workers, ua } = run.settings;
  if (run.done !== total || run.aborted || run.error || run.endedAt === undefined) return undefined;
  const seconds = run.elapsed();
  const cold = run.rows.filter(row => row.cold && row.ms !== undefined).map(row => row.ms!);
  const warm = run.rows.filter(row => !row.cold && row.ms !== undefined).map(row => row.ms!);
  const step = Math.max(1, Math.ceil(run.samples.length / 120));
  const progress = run.samples
    .filter((_, i) => i % step === 0 || i === run.samples.length - 1)
    .map(sample => ({ t: round(sample.t, 3), percent: round((sample.settled / total) * 100, 2) }));
  return {
    id,
    at: new Date().toISOString(),
    workers,
    total,
    ua,
    seconds: round(seconds, 3),
    rate: round(run.done / seconds, 1),
    p50: round(percentile(run.durations, 0.5) ?? 0, 1),
    p95: round(percentile(run.durations, 0.95) ?? 0, 1),
    cold: cold.length ? round(percentile(cold, 0.5)!, 1) : undefined,
    warm: warm.length ? round(percentile(warm, 0.5)!, 1) : undefined,
    hidden: run.hidden,
    cores: navigator.hardwareConcurrency || 0,
    progress,
  };
}

/** Worker counts for a sweep: powers of two up to the core count, plus the core count itself. */
export function sweepWorkers(max: number): number[] {
  const counts = [1, 2, 4, 8, 16].filter(count => count <= max);
  if (!counts.includes(max)) counts.push(max);
  return counts;
}

/** Median of the runs' rates for each worker count, in worker order. */
export function medianRates(runs: readonly RunRecord[]): { readonly workers: number; readonly rate: number }[] {
  const byWorkers = new Map<number, number[]>();
  for (const run of runs) byWorkers.set(run.workers, [...(byWorkers.get(run.workers) ?? []), run.rate]);
  return [...byWorkers].sort(([a], [b]) => a - b).map(([workers, rates]) => ({ workers, rate: median(rates) }));
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * A colour per worker count, so a worker count looks the same in every chart and every run. Slots follow the
 * original batch chart palette; counts above 8 share a neutral colour.
 */
export function workerPaint(workers: number): string {
  return workers >= 1 && workers <= 8 ? `var(--series-${workers})` : 'var(--chart-muted)';
}
