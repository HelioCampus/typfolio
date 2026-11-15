// PDF/A and PDF/UA validation with veraPDF, compiled to WebAssembly. `@typfolio/verapdf-wasm` is an optional peer
// dependency, loaded on the first call and only from this entry, so the other entries never see it. It is a package
// of its own because its binary is not open source as a whole (see its README); nothing here bundles it.
//
// A report says whether a file passes the machine-checkable rules of one flavour as veraPDF implements them. A pass
// does not establish that a document is accessible: whether the tags, the reading order and the alternative text make
// sense still needs a person.
import { TypstPdfError } from '@typfolio/core';
import { pdfValidationFlavours, type PdfValidationFlavour, type PdfValidationReport } from './validation.js';

export { pdfValidationFlavourIds, pdfValidationFlavours } from './validation.js';
export type { PdfValidationFlavour, PdfValidationReport, PdfValidationRule } from './validation.js';

export interface PdfValidator {
  /** Synchronous, and from milliseconds to seconds long: in a page, consider a worker. */
  validate(pdf: Uint8Array, options: { flavour: PdfValidationFlavour }): PdfValidationReport;
}

export interface PdfValidatorOptions {
  /**
   * The validator's binary, `@typfolio/verapdf-wasm/verapdf.wasm`: its bytes or a compiled module. In Node it may be
   * left out, and the file is read from the installed package. A browser has to pass it.
   */
  wasm?: BufferSource | WebAssembly.Module;
}

// The part of @typfolio/verapdf-wasm this module uses, declared here so the published declarations do not depend on
// that package's types.
interface VerapdfModule {
  createValidator(options: { wasm: BufferSource | WebAssembly.Module }): Promise<PdfValidator>;
}

/** Shared by concurrent callers, so it carries no call identity. */
class VerapdfImportError extends Error {}

let module: Promise<VerapdfModule> | undefined;
function loadVerapdf(): Promise<VerapdfModule> {
  module ??= (async () => {
    let imported: unknown;
    try {
      imported = await import('@typfolio/verapdf-wasm');
    } catch (cause) {
      throw new VerapdfImportError('@typfolio/verapdf-wasm could not be imported', { cause });
    }
    if (typeof (imported as Partial<VerapdfModule> | null)?.createValidator !== 'function') {
      throw new TypeError('@typfolio/verapdf-wasm did not provide the API this version of @typfolio/dev-tools uses (createValidator)');
    }
    return imported as VerapdfModule;
  })().catch(cause => {
    module = undefined;
    throw cause;
  });
  return module;
}

async function installedBinary(caller: string): Promise<Uint8Array> {
  if (typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node !== 'string') {
    throw new TypstPdfError('INVALID_REQUEST', `${caller} needs \`wasm\` outside Node: the bytes of @typfolio/verapdf-wasm/verapdf.wasm, or a compiled WebAssembly.Module`);
  }
  // Not a literal, so that a bundler building this entry for a browser does not go looking for Node's modules.
  const fs = 'node:fs/promises';
  const { readFile }: { readFile(path: URL): Promise<Uint8Array> } = await import(/* @vite-ignore */ fs);
  return readFile(new URL(import.meta.resolve('@typfolio/verapdf-wasm/verapdf.wasm')));
}

// A veraPDF error keeps its message; its code becomes one of core's.
function translated(caller: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || error.name !== 'VerapdfError' || typeof code !== 'string') return error;
  return new TypstPdfError(code === 'INITIALIZATION' ? 'INITIALIZATION' : 'INVALID_REQUEST', `${caller}: ${error.message}`, [], { cause: error });
}

/**
 * Starts a veraPDF validator of your own, to validate many files or to run in a worker. Rejects with a
 * `TypstPdfError`: `INITIALIZATION` when `@typfolio/verapdf-wasm` is not installed or its binary cannot be started,
 * `INVALID_REQUEST` when a browser passes no `wasm`. Its `validate` throws `INVALID_REQUEST` for a flavour it does not
 * know and for bytes veraPDF cannot read as a PDF.
 */
export async function createPdfValidator(options: PdfValidatorOptions = {}): Promise<PdfValidator> {
  const caller = 'createPdfValidator';
  let verapdf: VerapdfModule;
  try {
    verapdf = await loadVerapdf();
  } catch (error) {
    if (!(error instanceof VerapdfImportError)) throw error;
    throw new TypstPdfError('INITIALIZATION', `${caller} could not load @typfolio/verapdf-wasm. Install @typfolio/verapdf-wasm (an optional peer dependency of @typfolio/dev-tools) to use @typfolio/dev-tools/validate.`, [], { cause: error.cause });
  }
  let validator: PdfValidator;
  try {
    validator = await verapdf.createValidator({ wasm: options?.wasm ?? await installedBinary(caller) });
  } catch (error) {
    throw translated(caller, error);
  }
  return {
    validate(pdf, validateOptions) {
      try {
        return validator.validate(pdf, validateOptions);
      } catch (error) {
        throw translated('validate', error);
      }
    },
  };
}

let shared: Promise<PdfValidator> | undefined;

/**
 * Validates one PDF against one flavour with veraPDF, for a test or a script: `(await validatePdf(bytes, { flavour:
 * 'ua1' })).compliant`. The validator is started on the first call and kept; `wasm` is used by that first call only.
 * Rejects like `createPdfValidator` and its `validate`.
 */
export async function validatePdf(bytes: Uint8Array, options: { flavour: PdfValidationFlavour } & PdfValidatorOptions): Promise<PdfValidationReport> {
  shared ??= createPdfValidator({ wasm: options?.wasm }).catch(cause => {
    shared = undefined;
    throw cause;
  });
  return (await shared).validate(bytes, { flavour: options?.flavour });
}

/** A report as lines of text: the verdict, then each failed rule with its clause, test, count, description and place. */
export function formatValidationReport(report: PdfValidationReport, name?: string): string {
  const flavour = pdfValidationFlavours[report.flavour] ?? report.flavour;
  const subject = name === undefined ? '' : `${name}: `;
  if (report.compliant) return `${subject}PASS ${flavour} (${report.totalAssertions} checks)`;
  const failed = report.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0);
  const lines = [`${subject}FAIL ${flavour}: ${report.failedRules.length} rule${report.failedRules.length === 1 ? '' : 's'}, ${failed} of ${report.totalAssertions} checks`];
  for (const rule of report.failedRules) {
    lines.push(`  ${rule.specification} ${rule.clause}, test ${rule.test} (${rule.failedChecks}x): ${rule.message}`, `    at ${rule.context}`);
  }
  return lines.join('\n');
}
