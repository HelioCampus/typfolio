import type { PdfDocument, PdfResult } from '@typfolio/core';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { snapshotRequest } from './snapshot.js';
import {
  TypfolioWorkerError,
  type PdfBatchJob,
  type PdfBatchOptions,
  type PdfBatchOutcome,
  type PdfBatchProgress,
  type PdfWorkerClient,
} from './types.js';

interface CapturedJob<Id> {
  readonly id: Id;
  readonly index: number;
  readonly request?: ReturnType<typeof snapshotRequest>;
  /** Data that failed its schema: this job's outcome is this error, and the rest of the batch runs. */
  readonly rejected?: TypfolioWorkerError;
  readonly timeoutMs?: number;
}

function capture<Id>(job: PdfBatchJob<Id>, index: number): CapturedJob<Id> {
  try {
    return { id: job.id, index, request: snapshotRequest(job.document, job), timeoutMs: job.timeoutMs };
  } catch (error) {
    if (error instanceof TypfolioWorkerError && error.code === 'INVALID_INPUT') return { id: job.id, index, rejected: error };
    throw error;
  }
}

function cancelled<Id>(job: CapturedJob<Id>): PdfBatchOutcome<Id> {
  return { id: job.id, index: job.index, status: 'cancelled' };
}

function normalizeError(error: unknown): TypfolioWorkerError {
  return error instanceof TypfolioWorkerError
    ? error
    : new TypfolioWorkerError('WORKER', error instanceof Error ? error.message : String(error), [], { cause: error });
}

const run = Effect.fnUntraced(function*<Id>(
  client: PdfWorkerClient,
  job: CapturedJob<Id>,
  batchSignal?: AbortSignal,
): Effect.fn.Return<PdfBatchOutcome<Id>> {
  if (batchSignal?.aborted) return cancelled(job);
  if (job.request === undefined) return { id: job.id, index: job.index, status: 'error', error: job.rejected! };
  const request = job.request;
  return yield* Effect.tryPromise({
    try: effectSignal => {
      const controller = new AbortController();
      const abortFromEffect = (): void => controller.abort(effectSignal.reason);
      const abortFromBatch = (): void => controller.abort(batchSignal?.reason);
      effectSignal.addEventListener('abort', abortFromEffect, { once: true });
      batchSignal?.addEventListener('abort', abortFromBatch, { once: true });
      if (effectSignal.aborted) abortFromEffect();
      if (batchSignal?.aborted) abortFromBatch();
      // A snapshot, not a document: the client compiles it as it is, without resolving or copying it again.
      return client.compile(request as unknown as PdfDocument, {
        signal: controller.signal,
        timeoutMs: job.timeoutMs,
      }).finally(() => {
        effectSignal.removeEventListener('abort', abortFromEffect);
        batchSignal?.removeEventListener('abort', abortFromBatch);
      });
    },
    catch: normalizeError,
  }).pipe(Effect.match({
    onFailure: error => error.code === 'ABORTED'
      ? cancelled(job)
      : { id: job.id, index: job.index, status: 'error' as const, error },
    onSuccess: (result: PdfResult) => ({
      id: job.id,
      index: job.index,
      status: 'success' as const,
      result,
    }),
  }));
});

function initialProgress<Id>(total: number): PdfBatchProgress<Id> {
  return { total, completed: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

function advance<Id>(progress: PdfBatchProgress<Id>, outcome: PdfBatchOutcome<Id>): PdfBatchProgress<Id> {
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
 * Compiles a batch with at most `client.workerCount` submitted jobs at once.
 * Events are yielded in completion order and results are not retained here.
 */
export function compileBatch<Id>(
  client: PdfWorkerClient,
  jobs: readonly PdfBatchJob<Id>[],
  options: PdfBatchOptions<Id> = {},
): AsyncIterable<PdfBatchOutcome<Id>> {
  const captured: CapturedJob<Id>[] = jobs.map(capture);

  return (async function* stream(): AsyncGenerator<PdfBatchOutcome<Id>> {
    let progress = initialProgress<Id>(captured.length);
    options.onProgress?.(progress);
    const outcomes = Stream.fromIterable(captured).pipe(
      Stream.mapEffect(job => run(client, job, options.signal), {
        concurrency: client.workerCount,
        unordered: true,
      }),
      Stream.tap(outcome => Effect.sync(() => {
        progress = advance(progress, outcome);
        options.onProgress?.(progress);
        options.onItemSettled?.(outcome, progress);
      })),
    );
    for await (const outcome of Stream.toAsyncIterable(outcomes)) {
      yield outcome;
    }
  })();
}

/** Collects batch events into input order. Prefer `compileBatch` for large outputs. */
export async function collectBatch<Id>(
  client: PdfWorkerClient,
  jobs: readonly PdfBatchJob<Id>[],
  options: PdfBatchOptions<Id> = {},
): Promise<readonly PdfBatchOutcome<Id>[]> {
  const outcomes = new Array<PdfBatchOutcome<Id>>(jobs.length);
  for await (const outcome of compileBatch(client, jobs, options)) outcomes[outcome.index] = outcome;
  return outcomes;
}
