import { TypstPdfError, type AnyPdfRequest, type DocumentsRequest, type PdfRequest } from '@typfolio/core';
import { resolveRequest } from '@typfolio/core/internal';
import { TypfolioWorkerError } from './types.js';

function inspectCloneable(value: unknown, ancestors: Set<object>, at: string): void {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${at} cannot cross the worker boundary`);
  }
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array || value instanceof ArrayBuffer) return;
  if (ancestors.has(value)) throw new TypeError(`${at} contains a cycle`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${at} must contain only plain objects, arrays, and Uint8Array assets`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${at} contains symbol keys`);
  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError(`${at}.${key} contains an accessor`);
      inspectCloneable(descriptor.value, ancestors, `${at}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

// Every request returned by snapshotRequest. The client owns these (nothing else holds their buffers), so it
// neither snapshots them again nor hesitates to transfer them.
const snapshots = new WeakSet<object>();
// A schema that validates asynchronously: its check, which the client awaits before dispatching.
const validations = new WeakMap<object, Promise<void>>();

// Errors from core (an input that fails its schema, a missing partial) as the client's own error type.
function asWorkerError(error: unknown): unknown {
  return error instanceof TypstPdfError
    ? new TypfolioWorkerError(error.code, error.message, error.diagnostics, { cause: error })
    : error;
}

/** The pending schema check of a snapshot, if its template's schemas validate asynchronously. */
export function snapshotValidation(snapshot: object): Promise<void> | undefined {
  return validations.get(snapshot);
}

export function isSnapshot(request: unknown): boolean {
  return typeof request === 'object' && request !== null && snapshots.has(request);
}

/**
 * A copy of the request the client owns. A request for a defined template is first checked against its
 * schemas and turned into its low-level form (schemas are functions and cannot cross the boundary).
 */
export function snapshotRequest(request: AnyPdfRequest): PdfRequest<unknown> | DocumentsRequest {
  let resolved: ReturnType<typeof resolveRequest>;
  try {
    resolved = resolveRequest(request);
  } catch (error) {
    throw asWorkerError(error);
  }
  let snapshot: PdfRequest<unknown> | DocumentsRequest;
  try {
    inspectCloneable(resolved.request, new Set(), 'request');
    snapshot = structuredClone(resolved.request);
    snapshots.add(snapshot);
  } catch (cause) {
    throw new TypfolioWorkerError('INVALID_REQUEST', 'The PDF request cannot cross the worker boundary', [], { cause });
  }
  if (resolved.validated) {
    const validation = resolved.validated.catch(error => { throw asWorkerError(error); });
    // A batch job may wait its turn before the client awaits this: a failure is not unhandled meanwhile.
    validation.catch(() => {});
    validations.set(snapshot, validation);
  }
  return snapshot;
}

/**
 * The buffers of a snapshot's assets that `postMessage` can transfer, each once. Buffers that cannot be
 * transferred (a `SharedArrayBuffer`, which structured clone shares instead of copying, or one that is already
 * detached) are left out and travel by the ordinary clone. Only call this with a snapshot: transferring detaches
 * the buffers, which would break a caller's request.
 */
export function transferableBuffers(snapshot: PdfRequest<unknown> | DocumentsRequest): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const bytes of Object.values(snapshot.assets ?? {})) {
    if (!ArrayBuffer.isView(bytes)) continue; // Not an asset; the worker's validation rejects it.
    const buffer: ArrayBufferLike = bytes.buffer;
    if (Object.prototype.toString.call(buffer) === '[object ArrayBuffer]' && !(buffer as { detached?: boolean }).detached) {
      buffers.add(buffer as ArrayBuffer);
    }
  }
  return [...buffers];
}
