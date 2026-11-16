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
export type { PdfValidationCheck, PdfValidationFlavour, PdfValidationReport, PdfValidationRule } from './validation.js';

export interface PdfValidateOptions {
  flavour: PdfValidationFlavour;
  /** How many failed checks of one rule to list, from 1 to 10000; 20 unless given. The counts are exact either way. */
  maxChecksPerRule?: number;
}

export interface PdfValidator {
  /** Synchronous, and from milliseconds to seconds long: in a page, consider a worker. */
  validate(pdf: Uint8Array, options: PdfValidateOptions): PdfValidationReport;
  /**
   * The flavours the file declares in its metadata, as veraPDF reads them: `['2a', 'ua1']` for a file compiled as
   * PDF/A-2a and PDF/UA-1, empty when it declares none. A declaration is a claim, not a verdict.
   */
  detectFlavours(pdf: Uint8Array): PdfValidationFlavour[];
  /**
   * Validates the file against every flavour it declares: one report each, and none for a file that declares none,
   * which is not a pass.
   */
  validateDeclared(pdf: Uint8Array, options?: { maxChecksPerRule?: number }): PdfValidationReport[];
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
  const guarded = <Result>(name: string, call: () => Result): Result => {
    try {
      return call();
    } catch (error) {
      throw translated(name, error);
    }
  };
  return {
    validate: (pdf, validateOptions) => guarded('validate', () => validator.validate(pdf, validateOptions)),
    detectFlavours: pdf => guarded('detectFlavours', () => validator.detectFlavours(pdf)),
    validateDeclared: (pdf, declaredOptions) => guarded('validateDeclared', () => validator.validateDeclared(pdf, declaredOptions)),
  };
}

let shared: Promise<PdfValidator> | undefined;
function sharedValidator(wasm: PdfValidatorOptions['wasm']): Promise<PdfValidator> {
  shared ??= createPdfValidator({ wasm }).catch(cause => {
    shared = undefined;
    throw cause;
  });
  return shared;
}

/**
 * Validates one PDF against one flavour with veraPDF, for a test or a script: `(await validatePdf(bytes, { flavour:
 * 'ua1' })).compliant`. The validator is started on the first call and kept; `wasm` is used by that first call only.
 * Rejects like `createPdfValidator` and its `validate`.
 */
export async function validatePdf(bytes: Uint8Array, options: PdfValidateOptions & PdfValidatorOptions): Promise<PdfValidationReport> {
  return (await sharedValidator(options?.wasm)).validate(bytes, { flavour: options?.flavour, maxChecksPerRule: options?.maxChecksPerRule });
}

/**
 * Validates one PDF against every flavour it declares in its metadata: `const reports = await
 * validateDeclaredPdf(bytes)`. One report per declared flavour, and none for a file that declares none, so check the
 * length before `every(report => report.compliant)`. For a test that a template produces a given standard, name the
 * flavour with `validatePdf`: this only checks what the file claims. Shares `validatePdf`'s validator.
 */
export async function validateDeclaredPdf(bytes: Uint8Array, options: { maxChecksPerRule?: number } & PdfValidatorOptions = {}): Promise<PdfValidationReport[]> {
  return (await sharedValidator(options?.wasm)).validateDeclared(bytes, { maxChecksPerRule: options?.maxChecksPerRule });
}

/**
 * A report as lines of text: the verdict, then each failed rule with its clause, test, count and description, and
 * under it the failed checks that are listed, each with what was wrong and where.
 */
export function formatValidationReport(report: PdfValidationReport, name?: string): string {
  const flavour = pdfValidationFlavours[report.flavour] ?? report.flavour;
  const subject = name === undefined ? '' : `${name}: `;
  if (report.compliant) return `${subject}PASS ${flavour} (${report.totalAssertions} checks)`;
  const failed = report.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0);
  const lines = [`${subject}FAIL ${flavour}: ${report.failedRules.length} rule${report.failedRules.length === 1 ? '' : 's'}, ${failed} of ${report.totalAssertions} checks`];
  for (const rule of report.failedRules) {
    lines.push(`  ${rule.specification} ${rule.clause}, test ${rule.test} (${rule.failedChecks}x)${rule.tags.length > 0 ? ` [${rule.tags.join(', ')}]` : ''}: ${rule.message}`);
    for (const check of rule.checks) lines.push(...(check.error ? [`    ${check.error}`] : []), `      at ${check.context}`);
    if (rule.failedChecks > rule.checks.length) lines.push(`    … and ${rule.failedChecks - rule.checks.length} more`);
  }
  return lines.join('\n');
}
