import type {
  Diagnostic,
  ErrorCode,
  PdfClient,
  PdfRequest,
  PdfResult,
} from '@typfolio/core';

/** WASM sources that the structured-clone worker protocol can carry reliably. */
export type WorkerWasmSource = string | ArrayBuffer | Uint8Array | WebAssembly.Module;

export interface WorkerCompilerOptions {
  readonly wasm: WorkerWasmSource;
  readonly fonts: readonly Uint8Array[];
}

export interface WorkerCompileOptions {
  readonly signal?: AbortSignal;
  /** Includes time spent waiting in the queue. */
  readonly timeoutMs?: number;
}

export interface PdfWorkerClient extends PdfClient {
  readonly workerCount: number;
  compile(request: PdfRequest<unknown>, options?: WorkerCompileOptions): Promise<PdfResult>;
  /** Rejects queued/active jobs and terminates all owned workers. Idempotent. */
  dispose(): Promise<void>;
}

export interface CreateWorkerClientOptions {
  readonly compiler: WorkerCompilerOptions;
  /** Maximum parallel compilations. Workers are created lazily. Defaults to one. */
  readonly workerCount?: number;
  /** Maximum number of waiting jobs, excluding the active compilation. */
  readonly queueLimit?: number;
  /** Default per-job timeout, including queue time. Omit for no timeout. */
  readonly timeoutMs?: number;
  /** Used by the built-in module-worker factory. */
  readonly workerName?: string;
  /** Test/custom-host escape hatch. The client owns and terminates each worker. */
  readonly workerFactory?: (index: number) => Worker;
}

export interface PdfBatchJob<Id> {
  readonly id: Id;
  readonly request: PdfRequest<unknown>;
  readonly timeoutMs?: number;
}

export type PdfBatchOutcome<Id> =
  | { readonly id: Id; readonly index: number; readonly status: 'success'; readonly result: PdfResult }
  | { readonly id: Id; readonly index: number; readonly status: 'error'; readonly error: TypfolioWorkerError }
  | { readonly id: Id; readonly index: number; readonly status: 'cancelled' };

export interface PdfBatchProgress<Id> {
  readonly total: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly latestJobId?: Id;
}

export interface PdfBatchOptions<Id> {
  readonly signal?: AbortSignal;
  readonly onItemSettled?: (outcome: PdfBatchOutcome<Id>, progress: PdfBatchProgress<Id>) => void;
  readonly onProgress?: (progress: PdfBatchProgress<Id>) => void;
}

export type WorkerErrorCode = ErrorCode | 'WORKER' | 'TIMEOUT' | 'QUEUE_FULL';

export class TypfolioWorkerError extends Error {
  readonly name = 'TypfolioWorkerError';

  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
