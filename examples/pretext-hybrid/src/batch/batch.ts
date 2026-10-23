import { defineTemplate, type TemplateDefinition } from '@typfolio/core';
import { compileBatch, createWorkerClient, type PdfBatchJob, type PdfWorkerClient } from '@typfolio/workers';
import { fontUrls, loadWasm } from '../assets.ts';
import template from './report/main.typ?raw';
import { fileName, reportInput, type ReportInput } from './data.ts';

const report: TemplateDefinition<ReportInput> = defineTemplate({
  files: { 'main.typ': template },
  schemaPath: 'report.schema.json',
});

export type DocState = 'queued' | 'rendering' | 'done' | 'error' | 'cancelled';

/** One document. A row object is replaced, never mutated, so memoized views re-render only what changed. */
export interface DocRow {
  readonly index: number;
  readonly file: string;
  readonly student: string;
  readonly state: DocState;
  /** Time from handing the job to a worker until its PDF came back. */
  readonly ms?: number;
  readonly bytes?: number;
  /** The first job on its worker: its time includes the one-time worker start. */
  readonly cold: boolean;
  readonly error?: string;
}

export interface BatchSettings {
  readonly total: number;
  readonly workers: number;
  readonly ua: boolean;
  readonly keep: boolean;
}

/** How often a running batch tells its views to redraw. Charts rebuild their scene on every notification. */
const notifyMs = 100;

/**
 * One batch run, as an external store for `useSyncExternalStore`. The run mutates its counters and replaces
 * changed rows, then bumps `version` at most every `notifyMs`.
 */
export class BatchRun {
  readonly settings: BatchSettings;
  readonly rows: DocRow[];
  readonly pdfs: (Uint8Array | undefined)[] = [];
  /** Compile times in completion order. */
  readonly durations: number[] = [];
  /** (seconds since the start, settled count), sampled at each notification, for the progress chart. */
  readonly samples: { readonly t: number; readonly settled: number }[] = [{ t: 0, settled: 0 }];
  startedAt = 0;
  firstAt?: number;
  endedAt?: number;
  done = 0;
  failed = 0;
  cancelled = 0;
  bytes = 0;
  error?: string;
  /** The tab was hidden at some point during the run, which slows it down. */
  hidden = false;
  version = 0;

  private readonly inputs: readonly ReportInput[];
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(settings: BatchSettings) {
    this.settings = settings;
    // Inputs and rows are built before the clock starts: the metrics cover rendering only.
    this.inputs = Array.from({ length: settings.total }, (_, index) => reportInput(index + 1));
    this.rows = this.inputs.map((input, index) => ({
      index, file: fileName(index + 1), student: input.student.name, state: 'queued', cold: false,
    }));
  }

  get settled(): number {
    return this.done + this.failed + this.cancelled;
  }

  get running(): boolean {
    return this.startedAt > 0 && this.endedAt === undefined;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  elapsed(now = performance.now()): number {
    return this.startedAt ? ((this.endedAt ?? now) - this.startedAt) / 1000 : 0;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  cancel(): void {
    this.controller.abort('Cancelled by the user');
  }

  async start(): Promise<void> {
    if (this.startedAt > 0 || this.aborted) return;
    const { workers, ua, keep } = this.settings;
    const pdf = ua ? { standards: ['ua-1' as const] } : undefined;
    // Keep runtime schema validation outside the performance measurement.
    const jobs: PdfBatchJob<number>[] = this.inputs.map((input, index) => ({
      id: index,
      document: report(input),
      pdf,
      validate: false,
    }));
    let client: PdfWorkerClient | undefined;
    // Cancelling this run must not cancel the shared module needed by other demos.
    let cancelStartup!: () => void;
    const cancelledStartup = new Promise<undefined>(resolve => { cancelStartup = () => resolve(undefined); });
    this.controller.signal.addEventListener('abort', cancelStartup, { once: true });
    const onVisibility = (): void => { if (document.hidden) this.hidden = true; };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    this.startedAt = performance.now();
    this.notify(true);
    try {
      // Include the initial download/module compilation in the run's elapsed time.
      const wasm = await Promise.race([loadWasm(), cancelledStartup]);
      this.controller.signal.removeEventListener('abort', cancelStartup);
      if (wasm === undefined || this.aborted) {
        this.cancelled = this.rows.length;
        for (const row of this.rows) this.rows[row.index] = { ...row, state: 'cancelled' };
        return;
      }
      client = createWorkerClient({
        compiler: { wasm, fonts: fontUrls.slice(0, 2) },
        workerCount: workers,
        timeoutMs: 60_000,
      });
      for await (const outcome of compileBatch(this.tracked(client), jobs, { signal: this.controller.signal })) {
        const row = this.rows[outcome.index]!;
        if (outcome.status === 'success') {
          this.firstAt ??= performance.now();
          this.done++;
          this.bytes += outcome.result.bytes.length;
          if (keep) this.pdfs[outcome.index] = outcome.result.bytes;
          this.rows[outcome.index] = { ...row, state: 'done', bytes: outcome.result.bytes.length };
        } else if (outcome.status === 'error') {
          this.failed++;
          this.rows[outcome.index] = { ...row, state: 'error', error: outcome.error.message };
          console.error(row.file, outcome.error);
        } else {
          this.cancelled++;
          this.rows[outcome.index] = { ...row, state: 'cancelled' };
        }
        this.notify();
      }
    } catch (error) {
      this.error = String((error as Error).stack ?? error);
    } finally {
      this.endedAt = performance.now();
      this.controller.signal.removeEventListener('abort', cancelStartup);
      document.removeEventListener('visibilitychange', onVisibility);
      await client?.dispose();
      this.notify(true);
    }
  }

  /**
   * Wraps the client to see when each job is handed to a worker: `compileBatch` submits at most `workerCount`
   * jobs at a time, so a call here means "now rendering". Workers start lazily, one per concurrent job, so the
   * first `workerCount` calls each land on a fresh worker and carry its start cost.
   */
  private tracked(client: PdfWorkerClient): PdfWorkerClient {
    let started = 0;
    return {
      workerCount: client.workerCount,
      dispose: () => client.dispose(),
      compile: (request, options) => {
        // The batch submits these valid jobs in input order and yields in completion order.
        // Track the submission index without inspecting the worker's private request snapshot.
        const index = started++;
        const cold = index < client.workerCount;
        const at = performance.now();
        this.rows[index] = { ...this.rows[index]!, state: 'rendering', cold };
        this.notify();
        return client.compile(request, options).then(result => {
          const ms = performance.now() - at;
          this.durations.push(ms);
          this.rows[index] = { ...this.rows[index]!, ms };
          return result;
        });
      },
    };
  }

  private notify(now = false): void {
    if (now) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, notifyMs);
    }
  }

  private flush(): void {
    const t = this.elapsed();
    if (this.samples.at(-1)!.t !== t) this.samples.push({ t, settled: this.settled });
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
