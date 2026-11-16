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

/** One failed check: where it was, and what was wrong there. */
export interface FailedCheck {
  /**
   * A path in veraPDF's model of the file, with PDF object numbers where it has them: `…/pages[0](14 0 obj PDPage)/…`.
   * A glyph is named by, among other things, a number that changes from call to call
   * (`usedGlyphs[0](Font Font 1 0 234952919 0 true)`), so two reports on the same file can differ there.
   */
  context: string;
  /** What was wrong at this place, with the values found: `The "part" property … is 1 instead of 2`. Empty when veraPDF gives none. */
  error: string;
}

export interface FailedRule {
  /** The specification the rule comes from, for example `ISO 14289-1:2014`. */
  specification: string;
  clause: string;
  /** The number of the test within the clause. */
  test: number;
  /** How many checks of this rule failed: exact, also when `checks` lists fewer. */
  failedChecks: number;
  /** veraPDF's description of the rule: what the standard requires. */
  message: string;
  /** Where the first failed check was: `checks[0].context`. */
  context: string;
  /** The kind of object in veraPDF's model that the rule is checked on, for example `SETable` or `PDFont`. */
  object: string;
  /** The expression over that object that has to hold, in veraPDF's profile language. */
  condition: string;
  /** veraPDF's topics for the rule, sorted: `structure`, `table`, `font`, `metadata`, `alt-text` and so on. */
  tags: string[];
  /** The failed checks, in the order veraPDF met them, up to `maxChecksPerRule`. */
  checks: FailedCheck[];
}

export interface ValidationReport {
  flavour: Flavour;
  compliant: boolean;
  /** How many checks veraPDF ran, passed and failed together. */
  totalAssertions: number;
  /** The validation profile that was applied: its name, what it validates against, and how many rules it has. */
  profile: { name: string; description: string; rules: number };
  /** One entry per rule with at least one failed check, ordered by specification, clause and test; empty when `compliant`. */
  failedRules: FailedRule[];
}

export interface ValidateOptions {
  flavour: Flavour;
  /**
   * How many failed checks of one rule to list in `checks`, from 1 to 10000. Defaults to 20: a file with untagged
   * content fails one rule thousands of times. `failedChecks` is exact whatever this is.
   */
  maxChecksPerRule?: number;
}

export interface Validator {
  /**
   * Validates one PDF against one flavour. Throws a `VerapdfError`: `INVALID_REQUEST` for input that is not bytes, a
   * flavour that is not in `flavours` or a `maxChecksPerRule` out of range, `VALIDATION` when veraPDF cannot read the
   * file as a PDF.
   */
  validate(pdf: Uint8Array, options: ValidateOptions): ValidationReport;
}

export interface ValidatorOptions {
  /** The binary, `@typfolio/verapdf-wasm/verapdf.wasm`: its bytes or a compiled module. There is no default location. */
  wasm: BufferSource | WebAssembly.Module;
}

type Entry = (request: { pdf: string; flavour: string; maxChecksPerRule: number }) => unknown;
type Raw = Partial<ValidationReport> & { error?: string; trace?: string };

// One UTF-16 code unit per byte: the form the image takes (see java/WasmMain.java). In chunks, because
// String.fromCharCode takes its input as arguments.
function byteString(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return text;
}

// veraPDF keeps failed rules in a hash map, and their order differs between JavaScript engines for the same file.
// Clauses are compared part by part, numbers as numbers: 7.2 before 7.10, and before "Table 5. P-TR".
const collator = new Intl.Collator('en', { numeric: true });
const byRule = (a: FailedRule, b: FailedRule) =>
  collator.compare(a.specification, b.specification) || collator.compare(a.clause, b.clause) || a.test - b.test;

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
      const maxChecksPerRule = options.maxChecksPerRule ?? 20;
      if (!Number.isInteger(maxChecksPerRule) || maxChecksPerRule < 1 || maxChecksPerRule > 10000) {
        throw new VerapdfError('INVALID_REQUEST', 'maxChecksPerRule must be a whole number from 1 to 10000');
      }
      const raw: Raw = JSON.parse(String(entry({ pdf: byteString(pdf), flavour, maxChecksPerRule })));
      if (raw.error !== undefined) throw new VerapdfError('VALIDATION', `veraPDF could not validate the file: ${raw.error}`, { cause: raw.trace });
      // The image reports the flavour it validated against; a different one would be a wrong answer, not a detail.
      if (raw.flavour !== flavour) throw new VerapdfError('VALIDATION', `veraPDF validated against ${JSON.stringify(raw.flavour)}, not ${flavour}`);
      return {
        flavour,
        compliant: raw.compliant === true,
        totalAssertions: raw.totalAssertions ?? 0,
        profile: raw.profile ?? { name: '', description: '', rules: 0 },
        failedRules: (raw.failedRules ?? []).sort(byRule),
      };
    },
  };
}
