export type ParamdocErrorCode =
  /** The document, its fonts or its images cannot be used: a format version this runtime does not read, a font
   *  whose hash is not the document's, a missing image file. */
  | 'document'
  /** The data cannot be laid out as Typst would lay it out: a character outside a slot's repertoire, text that
   *  does not fit under the slot's policy, a value of the wrong shape. */
  | 'fill'
  /** A worker could not be created, crashed, or sent a message the client does not read. */
  | 'worker'
  /** The fill exceeded its `timeoutMs`, queue time included; its worker was terminated. */
  | 'timeout'
  /** The client's `queueLimit` of waiting fills was reached. */
  | 'queue-full'
  /** The fill's `signal` was aborted. */
  | 'aborted'
  /** The client was disposed before the fill settled. */
  | 'disposed';

export class ParamdocError extends Error {
  override readonly name = 'ParamdocError';
  readonly code: ParamdocErrorCode;
  constructor(code: ParamdocErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
