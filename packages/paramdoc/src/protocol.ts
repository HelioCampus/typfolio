// What crosses the boundary between the client and a worker, and the checks on it: a message is data from another
// realm, read field by field. Bytes travel by structured clone (the document and its fonts into every worker) or
// by transfer (each PDF back).
import type { ParamdocErrorCode } from './errors.js';

export const protocolVersion = 1;

export type HostMessage =
  | {
      readonly protocol: 1;
      readonly type: 'open';
      readonly document: Uint8Array | string;
      readonly fonts: readonly Uint8Array[];
      readonly images: readonly Uint8Array[];
    }
  | { readonly protocol: 1; readonly type: 'fill'; readonly id: number; readonly data: unknown };

export interface SerializedError {
  readonly code: ParamdocErrorCode;
  readonly message: string;
}

export type WorkerMessage =
  | { readonly protocol: 1; readonly type: 'ready' }
  | { readonly protocol: 1; readonly type: 'result'; readonly id: number; readonly pdf: Uint8Array; readonly pages: number }
  | { readonly protocol: 1; readonly type: 'failure'; readonly id?: number; readonly error: SerializedError };

const codes: readonly ParamdocErrorCode[] = ['document', 'fill', 'worker', 'timeout', 'queue-full', 'aborted', 'disposed'];

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function bytesList(value: unknown, at: string): Uint8Array[] {
  if (!Array.isArray(value) || value.some(item => !(item instanceof Uint8Array))) throw new TypeError(`${at} must be a list of Uint8Array`);
  return value as Uint8Array[];
}

export function decodeHostMessage(value: unknown): HostMessage {
  const message = record(value, 'paramdoc worker message');
  if (message.protocol !== protocolVersion) throw new TypeError('Unsupported paramdoc worker protocol');
  if (message.type === 'open') {
    if (!(message.document instanceof Uint8Array) && typeof message.document !== 'string') throw new TypeError('document must be a Uint8Array or a string');
    return {
      protocol: protocolVersion,
      type: 'open',
      document: message.document,
      fonts: bytesList(message.fonts, 'fonts'),
      images: bytesList(message.images, 'images'),
    };
  }
  if (message.type === 'fill' && Number.isSafeInteger(message.id)) {
    return { protocol: protocolVersion, type: 'fill', id: Number(message.id), data: message.data };
  }
  throw new TypeError('Unknown paramdoc worker message');
}

function serializedError(value: unknown): SerializedError {
  const error = record(value, 'paramdoc worker error');
  const code = codes.find(candidate => candidate === error.code);
  if (!code || typeof error.message !== 'string') throw new TypeError('Invalid paramdoc worker error');
  return { code, message: error.message };
}

export function decodeWorkerMessage(value: unknown): WorkerMessage {
  const message = record(value, 'paramdoc runtime message');
  if (message.protocol !== protocolVersion) throw new TypeError('Unsupported paramdoc worker protocol');
  if (message.type === 'ready') return { protocol: protocolVersion, type: 'ready' };
  if (message.type === 'result' && Number.isSafeInteger(message.id)) {
    if (!(message.pdf instanceof Uint8Array) || !Number.isSafeInteger(message.pages)) throw new TypeError('Invalid paramdoc worker result');
    return { protocol: protocolVersion, type: 'result', id: Number(message.id), pdf: message.pdf, pages: Number(message.pages) };
  }
  if (message.type === 'failure' && (message.id === undefined || Number.isSafeInteger(message.id))) {
    return {
      protocol: protocolVersion,
      type: 'failure',
      id: message.id === undefined ? undefined : Number(message.id),
      error: serializedError(message.error),
    };
  }
  throw new TypeError('Unknown paramdoc runtime message');
}
