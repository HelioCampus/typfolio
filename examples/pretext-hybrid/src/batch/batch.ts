import { defineTemplate, type TemplateDefinition } from '@typfolio/core';
import { createWorkerClient as createParamdocClient, fillBatch, type ParamdocWorkerClient } from '@typfolio/paramdoc';
import { compileBatch, createWorkerClient, type PdfBatchJob, type PdfWorkerClient } from '@typfolio/workers';
import { fontUrls, loadWasm } from '../assets.ts';
import template from './report/main.typ?raw';
import { fileName, reportInput, type ReportInput } from './data.ts';
import { loadParamdocDocument, paramdocData } from './paramdoc.ts';

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

/** What renders the documents: the Typst compiler in workers, or the experimental paramdoc runtime (see ./paramdoc.ts). */
export type Engine = 'typst' | 'paramdoc';

export interface BatchSettings {
  readonly total: number;
  readonly workers: number;
  readonly ua: boolean;
  readonly keep: boolean;
  readonly engine: Engine;
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
  /** Releases the engine's workers once the run has ended; set by the engine that started them. */
  private cleanup: (() => void | Promise<void>) | undefined;

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
      if (this.settings.engine === 'paramdoc') await this.runParamdoc(cancelledStartup);
      else await this.runTypst(cancelledStartup);
    } catch (error) {
      this.error = String((error as Error).stack ?? error);
    } finally {
      this.endedAt = performance.now();
      this.controller.signal.removeEventListener('abort', cancelStartup);
      document.removeEventListener('visibilitychange', onVisibility);
      await this.cleanup?.();
      this.notify(true);
    }
  }

  /** Every document that never started is cancelled. */
  private cancelRest(): void {
    for (const row of this.rows) {
      if (row.state !== 'queued') continue;
      this.cancelled++;
      this.rows[row.index] = { ...row, state: 'cancelled' };
    }
  }

  /** The Typst compiler in a worker pool from `@typfolio/workers`: one compile per document. */
  private async runTypst(cancelledStartup: Promise<undefined>): Promise<void> {
    const { workers, ua, keep } = this.settings;
    const pdf = ua ? { standards: ['ua-1' as const] } : undefined;
    // Keep runtime schema validation outside the performance measurement.
    const jobs: PdfBatchJob<number>[] = this.inputs.map((input, index) => ({
      id: index,
      document: report(input),
      pdf,
      validate: false,
    }));
    // Include the initial download/module compilation in the run's elapsed time.
    const wasm = await Promise.race([loadWasm(), cancelledStartup]);
    if (wasm === undefined || this.aborted) {
      this.cancelRest();
      return;
    }
    const client = createWorkerClient({
      compiler: { wasm, fonts: fontUrls.slice(0, 2) },
      workerCount: workers,
      timeoutMs: 60_000,
    });
    this.cleanup = () => client.dispose();
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
  }

  /**
   * The paramdoc runtime of `@typfolio/paramdoc` in its own worker pool, one runtime each, through the same
   * batch shape as the compiler: `fillBatch` keeps `workerCount` fills in flight and yields outcomes as they
   * settle. Workers start lazily, so a worker's first job waits for its start (the worker, then the runtime
   * with its fonts) and is the cold one, as with the compiler pool. The document and fonts download once per
   * page, like the compiler module; that time counts too.
   */
  private async runParamdoc(cancelledStartup: Promise<undefined>): Promise<void> {
    const { workers, keep } = this.settings;
    const exported = await Promise.race([loadParamdocDocument(), cancelledStartup]);
    if (exported === undefined || this.aborted) {
      this.cancelRest();
      return;
    }
    const client = createParamdocClient({
      document: { document: exported.doc, fonts: exported.fonts },
      workerCount: workers,
      timeoutMs: 60_000,
    });
    this.cleanup = () => client.dispose();
    const jobs = this.inputs.map((input, index) => ({ id: index, data: paramdocData(input) }));
    for await (const outcome of fillBatch(this.trackedParamdoc(client), jobs, { signal: this.controller.signal })) {
      const row = this.rows[outcome.index]!;
      if (outcome.status === 'success') {
        this.firstAt ??= performance.now();
        this.done++;
        this.bytes += outcome.result.pdf.length;
        if (keep) this.pdfs[outcome.index] = outcome.result.pdf;
        this.rows[outcome.index] = { ...row, state: 'done', bytes: outcome.result.pdf.length };
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
  }

  /**
   * Marks row `index` as rendering the moment its job is handed to the client, and records its time once the
   * result is back. Both batch helpers submit at most `workerCount` jobs at a time, in input order, so a call
   * here means "now rendering"; workers start lazily, one per concurrent job, so the first `workerCount` calls
   * each land on a fresh worker and carry its start cost: those are the cold ones.
   */
  private timed<T>(index: number, workerCount: number, work: () => Promise<T>): Promise<T> {
    const cold = index < workerCount;
    const at = performance.now();
    this.rows[index] = { ...this.rows[index]!, state: 'rendering', cold };
    this.notify();
    return work().then(result => {
      const ms = performance.now() - at;
      this.durations.push(ms);
      this.rows[index] = { ...this.rows[index]!, ms };
      return result;
    });
  }

  /** The compiler client, watched. The submission index is tracked here, without inspecting the worker's private request snapshot. */
  private tracked(client: PdfWorkerClient): PdfWorkerClient {
    let started = 0;
    return {
      workerCount: client.workerCount,
      dispose: () => client.dispose(),
      compile: (request, options) => this.timed(started++, client.workerCount, () => client.compile(request, options)),
    };
  }

  /** The paramdoc client, watched the same way. */
  private trackedParamdoc(client: ParamdocWorkerClient): ParamdocWorkerClient {
    let started = 0;
    return {
      workerCount: client.workerCount,
      dispose: () => client.dispose(),
      fill: (data, options) => this.timed(started++, client.workerCount, () => client.fill(data, options)),
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
