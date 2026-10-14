import type { Diagnostic, PdfRequest, PdfResult } from '@typfolio/core';
import type { WorkerCompilerOptions, WorkerErrorCode, WorkerWasmSource } from './types.js';

export const protocolVersion = 1;

export type HostMessage =
  | { readonly protocol: 1; readonly type: 'initialize'; readonly compiler: WorkerCompilerOptions }
  | { readonly protocol: 1; readonly type: 'compile'; readonly id: number; readonly request: PdfRequest<unknown> };

export interface SerializedError {
  readonly code: WorkerErrorCode;
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type RuntimeMessage =
  | { readonly protocol: 1; readonly type: 'ready' }
  | { readonly protocol: 1; readonly type: 'result'; readonly id: number; readonly result: PdfResult }
  | { readonly protocol: 1; readonly type: 'failure'; readonly id?: number; readonly error: SerializedError };

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function wasmSource(value: unknown): WorkerWasmSource {
  if (typeof value === 'string' || value instanceof ArrayBuffer || value instanceof Uint8Array || value instanceof WebAssembly.Module) {
    return value;
  }
  throw new TypeError('compiler.wasm cannot cross the worker boundary');
}

function compilerOptions(value: unknown): WorkerCompilerOptions {
  const options = record(value, 'compiler');
  if (!Array.isArray(options.fonts) || options.fonts.some(font => !(font instanceof Uint8Array))) {
    throw new TypeError('compiler.fonts must contain Uint8Array values');
  }
  return { wasm: wasmSource(options.wasm), fonts: options.fonts.map(font => new Uint8Array(font)) };
}

export function decodeHostMessage(value: unknown): HostMessage {
  const message = record(value, 'worker message');
  if (message.protocol !== protocolVersion) throw new TypeError('Unsupported Typfolio worker protocol');
  if (message.type === 'initialize') {
    return { protocol: protocolVersion, type: 'initialize', compiler: compilerOptions(message.compiler) };
  }
  if (message.type === 'compile' && Number.isSafeInteger(message.id)) {
    const request = record(message.request, 'request') as unknown as PdfRequest<unknown>;
    return { protocol: protocolVersion, type: 'compile', id: Number(message.id), request };
  }
  throw new TypeError('Unknown Typfolio worker message');
}

function diagnostic(value: unknown): Diagnostic {
  const item = record(value, 'diagnostic');
  if (typeof item.severity !== 'string' || typeof item.message !== 'string') throw new TypeError('Invalid worker diagnostic');
  return {
    severity: item.severity,
    message: item.message,
    path: typeof item.path === 'string' ? item.path : undefined,
    range: typeof item.range === 'string' ? item.range : undefined,
    package: typeof item.package === 'string' ? item.package : undefined,
  };
}

function serializedError(value: unknown): SerializedError {
  const error = record(value, 'worker error');
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !Array.isArray(error.diagnostics)) {
    throw new TypeError('Invalid worker error');
  }
  const codes: readonly WorkerErrorCode[] = [
    'INITIALIZATION', 'INVALID_REQUEST', 'UNSUPPORTED_OPTION', 'BUSY', 'DISPOSED',
    'ABORTED', 'COMPILATION', 'ENGINE', 'WORKER', 'TIMEOUT', 'QUEUE_FULL',
  ];
  const code = codes.find(candidate => candidate === error.code);
  if (!code) throw new TypeError('Invalid worker error code');
  return {
    code,
    message: error.message,
    diagnostics: error.diagnostics.map(diagnostic),
  };
}

function result(value: unknown): PdfResult {
  const item = record(value, 'worker result');
  const bytes = item.bytes instanceof Uint8Array
    ? item.bytes
    : item.bytes instanceof ArrayBuffer ? new Uint8Array(item.bytes) : undefined;
  if (!bytes || !Array.isArray(item.diagnostics)) throw new TypeError('Invalid worker PDF result');
  const metadata = record(item.metadata, 'worker result metadata');
  if (metadata.title !== undefined && typeof metadata.title !== 'string') throw new TypeError('Invalid worker PDF title');
  return {
    bytes,
    diagnostics: item.diagnostics.map(diagnostic),
    metadata: { title: metadata.title },
  };
}

export function decodeRuntimeMessage(value: unknown): RuntimeMessage {
  const message = record(value, 'runtime message');
  if (message.protocol !== protocolVersion) throw new TypeError('Unsupported Typfolio worker protocol');
  if (message.type === 'ready') return { protocol: protocolVersion, type: 'ready' };
  if (message.type === 'result' && Number.isSafeInteger(message.id)) {
    return { protocol: protocolVersion, type: 'result', id: Number(message.id), result: result(message.result) };
  }
  if (message.type === 'failure' && (message.id === undefined || Number.isSafeInteger(message.id))) {
    return {
      protocol: protocolVersion,
      type: 'failure',
      id: message.id === undefined ? undefined : Number(message.id),
      error: serializedError(message.error),
    };
  }
  throw new TypeError('Unknown Typfolio runtime message');
}
