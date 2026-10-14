import { pdfStandards, TypstPdfError, type PdfRequest } from './types.js';
import { isReservedPath, reservedDirectory } from './typst-package.js';

const encoder = new TextEncoder();
const defaultEntrypoint = 'main.typ';
const invalid = (message: string): never => { throw new TypstPdfError('INVALID_REQUEST', message); };

function record(value: unknown, at: string, expected = 'a plain object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${at} must be ${expected}`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], at: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypstPdfError('UNSUPPORTED_OPTION', `Unsupported ${at}.${key}`);
  }
}

export function virtualPath(path: unknown): string {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f:]/.test(path)) invalid('File paths must be non-empty virtual paths');
  const relative = (path as string).replace(/^\//, '');
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) invalid(`Ambiguous or traversing path: ${path}`);
  return `/${relative}`;
}

// This checks JSON transport fidelity only. Business schemas belong to applications.
function jsonData(value: unknown, ancestors: Set<object>, at: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${at} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') invalid(`${at} is not JSON-compatible`);
  const object = value as object;
  if (ancestors.has(object)) invalid(`${at} contains a cycle`);
  if (Object.getOwnPropertySymbols(object).length) invalid(`${at} contains symbol keys`);
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) invalid(`${at} contains sparse or decorated arrays`);
      return Array.from(value, (item, i) => jsonData(item, ancestors, `${at}[${i}]`));
    }
    const input = record(value, at);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!('value' in descriptor)) invalid(`${at}.${key} contains an accessor`);
      result[key] = jsonData(descriptor.value, ancestors, `${at}.${key}`);
    }
    return result;
  } finally { ancestors.delete(object); }
}

export function prepareRequest(request: PdfRequest<unknown>) {
  const value = record(request, 'request');
  keys(value, ['template', 'input', 'assets', 'pdf'], 'request');
  // A string template is shorthand for { files: { 'main.typ': template } } with the default entrypoint.
  const template = typeof value.template === 'string'
    ? { files: { [defaultEntrypoint]: value.template } } as Record<string, unknown>
    : record(value.template, 'template', 'a string or a plain object');
  keys(template, ['entrypoint', 'files'], 'template');
  const entrypointDefaulted = template.entrypoint === undefined;
  const entrypoint = virtualPath(entrypointDefaulted ? defaultEntrypoint : template.entrypoint);
  const files = new Map<string, Uint8Array>();
  const put = (name: string, contents: Uint8Array) => {
    const path = virtualPath(name);
    if (path === '/input.json') invalid('/input.json is reserved for request.input');
    if (isReservedPath(path)) invalid(`${reservedDirectory}/ is reserved for core's Typst package: ${path}`);
    if (files.has(path)) invalid(`Duplicate virtual path: ${path}`);
    for (const existing of files.keys()) {
      if (path.startsWith(existing + '/') || existing.startsWith(path + '/')) invalid(`File/directory collision: ${path}`);
    }
    files.set(path, contents);
  };
  for (const [name, source] of Object.entries(record(template.files, 'template.files'))) {
    if (typeof source !== 'string') invalid(`Template ${name} must be a string`);
    put(name, encoder.encode(source as string));
  }
  if (!files.has(entrypoint)) {
    invalid(entrypointDefaulted
      ? `template.entrypoint was omitted and defaulted to ${defaultEntrypoint}, but template.files has no ${defaultEntrypoint}; add it or set template.entrypoint`
      : `Entrypoint ${entrypoint} must be a template file`);
  }
  if (value.assets !== undefined) {
    for (const [name, bytes] of Object.entries(record(value.assets, 'assets'))) {
      if (!(bytes instanceof Uint8Array)) invalid(`Asset ${name} must be a Uint8Array`);
      put(name, new Uint8Array(bytes as Uint8Array));
    }
  }
  if (Array.from(files.keys()).some(path => path.startsWith('/input.json/'))) invalid('/input.json is reserved for request.input');
  try { files.set('/input.json', encoder.encode(JSON.stringify(jsonData(value.input, new Set(), 'input')))); }
  catch (error) {
    if (error instanceof TypstPdfError) throw error;
    throw new TypstPdfError('INVALID_REQUEST', 'Could not serialize input as JSON', [], { cause: error });
  }
  const pdf = value.pdf === undefined ? {} : record(value.pdf, 'pdf');
  keys(pdf, ['standards', 'tags', 'creationTimestamp'], 'pdf');
  const standards = pdf.standards ?? [];
  if (!Array.isArray(standards) || standards.some(s => !pdfStandards.includes(s))) {
    throw new TypstPdfError('UNSUPPORTED_OPTION', 'Unsupported PDF standard');
  }
  if (standards.length > 1) throw new TypstPdfError('UNSUPPORTED_OPTION', 'This compiler binding accepts at most one PDF standard');
  if (pdf.tags !== undefined && typeof pdf.tags !== 'boolean') invalid('pdf.tags must be boolean');
  if (pdf.tags === false && ['ua-1', 'a-1a', 'a-2a', 'a-3a'].includes(standards[0])) invalid(`${standards[0]} requires PDF tags`);
  if (pdf.creationTimestamp !== undefined && !Number.isSafeInteger(pdf.creationTimestamp)) invalid('creationTimestamp must be Unix seconds as a safe integer');
  return {
    entrypoint, files,
    pdf: { pdf_standard: standards[0], pdf_tags: pdf.tags ?? true, creation_timestamp: pdf.creationTimestamp },
  };
}
