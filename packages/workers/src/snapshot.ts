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

export function snapshotRequest(request: PdfRequest<unknown>): PdfRequest<unknown> {
  try {
    inspectCloneable(request, new Set(), 'request');
    return structuredClone(request);
  } catch (cause) {
    throw new TypfolioWorkerError('INVALID_REQUEST', 'The PDF request cannot cross the worker boundary', [], { cause });
  }
}
