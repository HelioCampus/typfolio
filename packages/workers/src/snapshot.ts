import type { PdfRequest } from '@typfolio/core';
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

export function isSnapshot(request: unknown): boolean {
  return typeof request === 'object' && request !== null && snapshots.has(request);
}

export function snapshotRequest(request: PdfRequest<unknown>): PdfRequest<unknown> {
  try {
    inspectCloneable(request, new Set(), 'request');
    const snapshot = structuredClone(request);
    snapshots.add(snapshot);
    return snapshot;
  } catch (cause) {
    throw new TypfolioWorkerError('INVALID_REQUEST', 'The PDF request cannot cross the worker boundary', [], { cause });
  }
}

/**
 * The buffers of a snapshot's assets that `postMessage` can transfer, each once. Buffers that cannot be
 * transferred (a `SharedArrayBuffer`, which structured clone shares instead of copying, or one that is already
 * detached) are left out and travel by the ordinary clone. Only call this with a snapshot: transferring detaches
 * the buffers, which would break a caller's request.
 */
export function transferableBuffers(snapshot: PdfRequest<unknown>): ArrayBuffer[] {
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
