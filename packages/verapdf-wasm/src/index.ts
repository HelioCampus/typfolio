/**
 * veraPDF's validator as WebAssembly. `createValidator` starts one instance from the binary you pass; `validate` is
 * synchronous and can take from milliseconds to seconds, so in a browser run it in a worker.
 *
 * A report says whether the file passes the machine-checkable rules of one flavour as veraPDF implements them. A
 * pass does not establish that a document is accessible.
 */

/** Why a call failed: the request was wrong, the image could not be started, or veraPDF could not read the file. */
export type VerapdfErrorCode = 'INVALID_REQUEST' | 'INITIALIZATION' | 'VALIDATION';

export class VerapdfError extends Error {
  readonly code: VerapdfErrorCode;
  constructor(code: VerapdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerapdfError';
    this.code = code;
  }
}

/** The flavours the validation profiles in the image cover, by veraPDF's ids. */
export const flavours = ['1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'ua1', 'ua2', 'wt1a', 'wt1r'] as const;
export type Flavour = (typeof flavours)[number];

export interface FailedRule {
  /** The specification the rule comes from, for example `ISO 14289-1:2014`. */
  specification: string;
  clause: string;
  /** The number of the test within the clause. */
  test: number;
  /** How many checks of this rule failed. */
  failedChecks: number;
  /** veraPDF's description of the rule. */
  message: string;
  /** Where the first failed check was, as a path in veraPDF's model of the file. */
  context: string;
}

export interface ValidationReport {
  flavour: Flavour;
  compliant: boolean;
  /** How many checks veraPDF ran, passed and failed together. */
  totalAssertions: number;
  /** One entry per rule with at least one failed check; empty when `compliant`. */
  failedRules: FailedRule[];
}

export interface Validator {
  /**
   * Validates one PDF against one flavour. Throws a `VerapdfError`: `INVALID_REQUEST` for input that is not bytes or
   * a flavour that is not in `flavours`, `VALIDATION` when veraPDF cannot read the file as a PDF.
   */
  validate(pdf: Uint8Array, options: { flavour: Flavour }): ValidationReport;
}

export interface ValidatorOptions {
  /** The binary, `@typfolio/verapdf-wasm/verapdf.wasm`: its bytes or a compiled module. There is no default location. */
  wasm: BufferSource | WebAssembly.Module;
}

type Entry = (pdf: string, flavour: string) => unknown;
type Raw = Partial<ValidationReport> & { error?: string; trace?: string };

// One UTF-16 code unit per byte: the form the image takes (see java/WasmMain.java). In chunks, because
// String.fromCharCode takes its input as arguments.
function byteString(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return text;
}

/** Starts a validator. Each call starts an instance of its own; an instance is freed when nothing refers to it. */
export async function createValidator(options: ValidatorOptions): Promise<Validator> {
  const wasm = options?.wasm;
  if (!(wasm instanceof WebAssembly.Module) && !(wasm instanceof ArrayBuffer) && !ArrayBuffer.isView(wasm)) {
    throw new VerapdfError('INVALID_REQUEST', 'createValidator needs `wasm`: the bytes of verapdf.wasm or a compiled WebAssembly.Module');
  }
  let entry: Entry;
  try {
    // Not a string literal for the type checker, which would otherwise need the generated file to exist; bundlers
    // and Node still see the literal.
    const loader: { instantiate(wasm: BufferSource | WebAssembly.Module): Promise<Entry> } = await import('../generated/verapdf.js' as string);
    entry = await loader.instantiate(wasm);
  } catch (cause) {
    throw new VerapdfError('INITIALIZATION', `The veraPDF image could not be started: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return {
    validate(pdf, options) {
      if (!(pdf instanceof Uint8Array)) throw new VerapdfError('INVALID_REQUEST', 'validate takes the PDF as a Uint8Array');
      const flavour = options?.flavour;
      if (!(flavours as readonly string[]).includes(flavour)) {
        throw new VerapdfError('INVALID_REQUEST', `Unknown flavour ${JSON.stringify(flavour)}; the flavours are ${flavours.join(', ')}`);
      }
      const raw: Raw = JSON.parse(String(entry(byteString(pdf), flavour)));
      if (raw.error !== undefined) throw new VerapdfError('VALIDATION', `veraPDF could not validate the file: ${raw.error}`, { cause: raw.trace });
      // The image reports the flavour it validated against; a different one would be a wrong answer, not a detail.
      if (raw.flavour !== flavour) throw new VerapdfError('VALIDATION', `veraPDF validated against ${JSON.stringify(raw.flavour)}, not ${flavour}`);
      return { flavour, compliant: raw.compliant === true, totalAssertions: raw.totalAssertions ?? 0, failedRules: raw.failedRules ?? [] };
    },
  };
}
