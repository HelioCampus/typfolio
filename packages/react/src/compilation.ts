import type { AnyPdfRequest, Diagnostic, PdfClient, PdfResult } from '@typfolio/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export type PdfCompilationStatus = 'idle' | 'compiling' | 'success' | 'error' | 'cancelled';

export interface PdfCompilationState {
  readonly status: PdfCompilationStatus;
  readonly result?: PdfResult;
  readonly error?: unknown;
}

export interface PdfCompilationCallbacks {
  readonly onSuccess?: (result: PdfResult, request: AnyPdfRequest) => void;
  readonly onError?: (error: unknown, request: AnyPdfRequest) => void;
  readonly onCancel?: (error: Error, request: AnyPdfRequest) => void;
  readonly onSettled?: (
    result: PdfResult | undefined,
    error: unknown | undefined,
    request: AnyPdfRequest,
  ) => void;
}

export interface PdfCompilationOptions extends PdfCompilationCallbacks {
  readonly signal?: AbortSignal;
}

export interface UsePdfCompilationOptions extends PdfCompilationCallbacks {
  readonly client: PdfClient;
}

export interface PdfCompilation extends PdfCompilationState {
  readonly diagnostics: readonly Diagnostic[];
  readonly isIdle: boolean;
  readonly isCompiling: boolean;
  readonly isRecompiling: boolean;
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly isCancelled: boolean;
  readonly compile: (request: AnyPdfRequest, options?: PdfCompilationOptions) => Promise<PdfResult>;
  readonly cancel: (reason?: unknown) => void;
  readonly reset: () => void;
}

interface ActiveCompilation {
  readonly controller: AbortController;
  readonly request: AnyPdfRequest;
  readonly options: PdfCompilationOptions;
}

const emptyDiagnostics: readonly Diagnostic[] = Object.freeze([]);
const idleState: PdfCompilationState = Object.freeze({ status: 'idle' });

function cancellationError(message: string, reason?: unknown): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason });
}

function abortActive(active: ActiveCompilation | undefined, message: string, reason?: unknown): void {
  if (active !== undefined && !active.controller.signal.aborted) {
    active.controller.abort(cancellationError(message, reason));
  }
}

function notify<Args extends readonly unknown[]>(
  callback: ((...args: Args) => void) | undefined,
  ...args: Args
): void {
  if (callback === undefined) return;
  try {
    callback(...args);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

function notifySuccess(
  hookCallbacks: PdfCompilationCallbacks,
  callCallbacks: PdfCompilationCallbacks,
  result: PdfResult,
  request: AnyPdfRequest,
): void {
  notify(hookCallbacks.onSuccess, result, request);
  notify(callCallbacks.onSuccess, result, request);
  notify(hookCallbacks.onSettled, result, undefined, request);
  notify(callCallbacks.onSettled, result, undefined, request);
}

function notifyError(
  hookCallbacks: PdfCompilationCallbacks,
  callCallbacks: PdfCompilationCallbacks,
  error: unknown,
  request: AnyPdfRequest,
): void {
  notify(hookCallbacks.onError, error, request);
  notify(callCallbacks.onError, error, request);
  notify(hookCallbacks.onSettled, undefined, error, request);
  notify(callCallbacks.onSettled, undefined, error, request);
}

function notifyCancellation(
  hookCallbacks: PdfCompilationCallbacks,
  callCallbacks: PdfCompilationCallbacks,
  error: Error,
  request: AnyPdfRequest,
): void {
  notify(hookCallbacks.onCancel, error, request);
  notify(callCallbacks.onCancel, error, request);
  notify(hookCallbacks.onSettled, undefined, error, request);
  notify(callCallbacks.onSettled, undefined, error, request);
}

/**
 * Owns one logical compilation at a time. Starting a new call cancels the
 * previous call, and stale calls can never replace newer state.
 */
export function usePdfCompilation(options: UsePdfCompilationOptions): PdfCompilation {
  const { client } = options;
  const clientRef = useRef<PdfClient>(client);
  const optionsRef = useRef(options);
  const activeRef = useRef<ActiveCompilation | undefined>(undefined);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [state, setState] = useState<PdfCompilationState>(idleState);
  clientRef.current = client;
  optionsRef.current = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const active = activeRef.current;
      activeRef.current = undefined;
      abortActive(active, 'PDF compilation was cancelled because its consumer was removed');
    };
  }, [client]);

  const cancel = useCallback((reason?: unknown): void => {
    const active = activeRef.current;
    if (active === undefined) return;
    activeRef.current = undefined;
    generationRef.current += 1;
    const error = cancellationError('PDF compilation was cancelled', reason);
    active.controller.abort(error);
    if (mountedRef.current) {
      setState(previous => ({ status: 'cancelled', result: previous.result }));
    }
    notifyCancellation(optionsRef.current, active.options, error, active.request);
  }, []);

  const reset = useCallback((): void => {
    const active = activeRef.current;
    activeRef.current = undefined;
    generationRef.current += 1;
    abortActive(active, 'PDF compilation was reset');
    if (mountedRef.current) setState(idleState);
  }, []);

  const compile = useCallback(async (
    request: AnyPdfRequest,
    options: PdfCompilationOptions = {},
  ): Promise<PdfResult> => {
    const previous = activeRef.current;
    abortActive(previous, 'PDF compilation was superseded by a newer request');

    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeRef.current = { controller, request, options };
    if (mountedRef.current) {
      setState(previous => ({ status: 'compiling', result: previous.result }));
    }

    const externalSignal = options.signal;
    const relayAbort = (): void => {
      controller.abort(cancellationError('PDF compilation was cancelled', externalSignal?.reason));
    };
    if (externalSignal?.aborted) relayAbort();
    else externalSignal?.addEventListener('abort', relayAbort, { once: true });

    try {
      const result = await clientRef.current.compile(request, { signal: controller.signal });
      if (controller.signal.aborted) {
        throw cancellationError('PDF compilation was cancelled', controller.signal.reason);
      }
      if (mountedRef.current && generationRef.current === generation) {
        if (activeRef.current?.controller === controller) activeRef.current = undefined;
        setState({ status: 'success', result });
        notifySuccess(optionsRef.current, options, result, request);
      }
      return result;
    } catch (error) {
      if (mountedRef.current && generationRef.current === generation) {
        if (activeRef.current?.controller === controller) activeRef.current = undefined;
        if (controller.signal.aborted) {
          const cancellation = cancellationError(
            'PDF compilation was cancelled',
            controller.signal.reason,
          );
          setState(previous => ({ status: 'cancelled', result: previous.result }));
          notifyCancellation(optionsRef.current, options, cancellation, request);
          throw cancellation;
        } else {
          setState(previous => ({ status: 'error', result: previous.result, error }));
          notifyError(optionsRef.current, options, error, request);
        }
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', relayAbort);
      if (activeRef.current?.controller === controller) activeRef.current = undefined;
    }
  }, []);

  return {
    ...state,
    diagnostics: state.result?.diagnostics ?? emptyDiagnostics,
    isIdle: state.status === 'idle',
    isCompiling: state.status === 'compiling',
    isRecompiling: state.status === 'compiling' && state.result !== undefined,
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
    isCancelled: state.status === 'cancelled',
    compile,
    cancel,
    reset,
  };
}
