// Many documents through one client: at most `workerCount` fills in flight, outcomes in completion order, as
// `@typfolio/workers`' `compileBatch` does it.
import { ParamdocError, messageOf } from './errors.js';
import type { ParamdocWorkerClient } from './client.js';
import type { FillResult } from './runtime-api.js';

export interface FillJob<Id> {
  readonly id: Id;
  readonly data: unknown;
  /** Queue time included; overrides the client's default. */
  readonly timeoutMs?: number;
}

export type FillOutcome<Id> =
  | { readonly id: Id; readonly index: number; readonly status: 'success'; readonly result: FillResult }
  | { readonly id: Id; readonly index: number; readonly status: 'error'; readonly error: ParamdocError }
  | { readonly id: Id; readonly index: number; readonly status: 'cancelled' };

export interface FillProgress<Id> {
  readonly total: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly latestJobId?: Id;
}

export interface FillBatchOptions<Id> {
  /** Cancels the fills not yet settled: each becomes a `cancelled` outcome. */
  readonly signal?: AbortSignal;
  readonly onItemSettled?: (outcome: FillOutcome<Id>, progress: FillProgress<Id>) => void;
  readonly onProgress?: (progress: FillProgress<Id>) => void;
}

function asError(error: unknown): ParamdocError {
  return error instanceof ParamdocError ? error : new ParamdocError('worker', messageOf(error), { cause: error });
}

async function run<Id>(client: ParamdocWorkerClient, job: FillJob<Id>, index: number, signal: AbortSignal): Promise<FillOutcome<Id>> {
  if (signal.aborted) return { id: job.id, index, status: 'cancelled' };
  try {
    const result = await client.fill(job.data, { signal, timeoutMs: job.timeoutMs });
    return { id: job.id, index, status: 'success', result };
  } catch (error) {
    const failure = asError(error);
    if (failure.code === 'aborted') return { id: job.id, index, status: 'cancelled' };
    return { id: job.id, index, status: 'error', error: failure };
  }
}

function advance<Id>(progress: FillProgress<Id>, outcome: FillOutcome<Id>): FillProgress<Id> {
  return {
    total: progress.total,
    completed: progress.completed + 1,
    succeeded: progress.succeeded + (outcome.status === 'success' ? 1 : 0),
    failed: progress.failed + (outcome.status === 'error' ? 1 : 0),
    cancelled: progress.cancelled + (outcome.status === 'cancelled' ? 1 : 0),
    latestJobId: outcome.id,
  };
}

/**
 * Fills a batch with at most `client.workerCount` fills in flight. Outcomes are yielded in completion order and
 * not retained here. Leaving the loop early cancels the fills still in flight.
 */
export function fillBatch<Id>(
  client: ParamdocWorkerClient,
  jobs: readonly FillJob<Id>[],
  options: FillBatchOptions<Id> = {},
): AsyncIterable<FillOutcome<Id>> {
  return (async function* stream(): AsyncGenerator<FillOutcome<Id>> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    let progress: FillProgress<Id> = { total: jobs.length, completed: 0, succeeded: 0, failed: 0, cancelled: 0 };
    options.onProgress?.(progress);
    const inFlight = new Map<number, Promise<FillOutcome<Id>>>();
    let next = 0;
    try {
      while (next < jobs.length || inFlight.size) {
        while (inFlight.size < client.workerCount && next < jobs.length) {
          const index = next++;
          const settled = run(client, jobs[index]!, index, controller.signal).then(outcome => {
            inFlight.delete(index);
            return outcome;
          });
          inFlight.set(index, settled);
        }
        const outcome = await Promise.race(inFlight.values());
        progress = advance(progress, outcome);
        options.onProgress?.(progress);
        options.onItemSettled?.(outcome, progress);
        yield outcome;
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      controller.abort('The batch ended');
    }
  })();
}

/** Collects the outcomes into input order. Prefer `fillBatch` for large outputs. */
export async function collectBatch<Id>(
  client: ParamdocWorkerClient,
  jobs: readonly FillJob<Id>[],
  options: FillBatchOptions<Id> = {},
): Promise<readonly FillOutcome<Id>[]> {
  const outcomes = new Array<FillOutcome<Id>>(jobs.length);
  for await (const outcome of fillBatch(client, jobs, options)) outcomes[outcome.index] = outcome;
  return outcomes;
}
