// PDF structure inspector. It reports facts about a compiled PDF so a test can assert on them; it never says
// a file conforms to anything. `pdfjs-dist` is an optional peer dependency, loaded on the first call and only
// from this entry, so the main `@typfolio/dev-tools` entry (and every bundle that uses only that) never sees it.
import { TypstPdfError } from '@typfolio/core';
import { eachElement, headingLevel, isMarked, pageStructure, readDocument, type PdfMarkInfo, type PdfStructurePage, type PdfStructureWarning } from './structure.js';

export { readStructure, structureWarnings } from './structure.js';
export type { PdfStructureElement, PdfStructurePage, PdfStructureSource, PdfStructureWarning, PdfStructureWarningKind } from './structure.js';

export interface PdfHeading {
  /** 1 to 6 for `H1`..`H6`; 0 for a plain `H`. */
  level: number;
  /** Empty when the text could not be recovered from the page content. */
  text: string;
}

export interface PdfFigure {
  /** The figure element's `/Alt`; undefined when the element has none. */
  alt?: string;
}

export interface PdfFont {
  /** The font's `/BaseFont` name, including the subset prefix of an embedded subset. */
  name: string;
  /** Whether the file carries the font program, as pdf.js sees it. */
  embedded: boolean;
}

export interface PdfInspection {
  pages: number;
  /** The catalog's `/MarkInfo /Marked` is true. */
  tagged: boolean;
  /** The catalog has a `/StructTreeRoot`. */
  structureTree: boolean;
  /** The document information title, else the XMP `dc:title`. */
  title?: string;
  /** The catalog's `/Lang`. */
  language?: string;
  creationDate?: Date;
  /** What the XMP metadata declares (`pdfuaid:part`, `pdfaid:part`, `pdfaid:conformance`). A declaration, not a verdict. */
  standard: {
    pdfUa?: number;
    /** `conformance` is absent when the XMP has no `pdfaid:conformance`. */
    pdfA?: { part: number; conformance?: string };
  };
  /** In document order, from the structure tree. */
  headings: PdfHeading[];
  figures: PdfFigure[];
  /** Number of `Table` structure elements. */
  tables: number;
  /** Fonts that page content selects, in order of first use. */
  fonts: PdfFont[];
  /** How often each structure role occurs, whatever it is. */
  structureRoles: Record<string, number>;
  /** Every page's part of the structure tree, in page order. */
  structure: PdfStructurePage[];
}

// The part of pdf.js this module uses. Declared here so the published declarations do not depend on pdfjs-dist's types.
interface PdfJsMetadata { get(name: string): unknown }
interface PdfJsInfo { Title?: unknown; Language?: unknown; CreationDate?: unknown }
interface PdfJsCommonObjs { has(id: string): boolean; get(id: string): unknown }
interface PdfJsPage {
  getStructTree(): Promise<unknown>;
  getTextContent(options: { includeMarkedContent: boolean }): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  commonObjs: PdfJsCommonObjs;
}
interface PdfJsDocument {
  numPages: number;
  getMetadata(): Promise<{ info: PdfJsInfo | null; metadata: PdfJsMetadata | null }>;
  getMarkInfo(): Promise<PdfMarkInfo>;
  getPage(number: number): Promise<PdfJsPage>;
}
interface PdfJsLoadingTask { promise: Promise<PdfJsDocument>; destroy(): Promise<void> }
interface PdfJs {
  getDocument(source: Record<string, unknown>): PdfJsLoadingTask;
  OPS: { setFont: number };
  PDFDateString: { toDateObject(input: string): Date | null };
}

let loader: Promise<PdfJs> | undefined;

/** Shared by concurrent callers, so it carries no call identity. */
class PdfJsImportError extends Error {}

async function loadPdfJs(): Promise<PdfJs> {
  let imported: unknown;
  try {
    // The Node-capable build: in Node pdf.js runs its worker code in this thread and needs no `workerSrc`.
    imported = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (cause) {
    throw new PdfJsImportError('pdfjs-dist could not be imported', { cause });
  }
  const lib = imported as Partial<PdfJs> | null;
  if (typeof lib?.getDocument !== 'function' || typeof lib.OPS?.setFont !== 'number' || typeof lib.PDFDateString?.toDateObject !== 'function') {
    throw new TypeError('pdfjs-dist did not provide the API this version of @typfolio/dev-tools reads (getDocument, OPS, PDFDateString)');
  }
  return lib as PdfJs;
}

function getPdfJs(): Promise<PdfJs> {
  loader ??= loadPdfJs().catch(cause => {
    loader = undefined;
    throw cause;
  });
  return loader;
}

async function requirePdfJs(caller: string): Promise<PdfJs> {
  try {
    return await getPdfJs();
  } catch (error) {
    if (!(error instanceof PdfJsImportError)) throw error;
    throw new TypstPdfError('INITIALIZATION', `${caller} could not load pdfjs-dist. Install pdfjs-dist (an optional peer dependency of @typfolio/dev-tools) to use @typfolio/dev-tools/pdf.`, [], { cause: error.cause });
  }
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : undefined;
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function metadataValue(metadata: PdfJsMetadata | null, name: string): unknown {
  return metadata?.get(name) ?? undefined;
}

function creationDate(pdfjs: PdfJs, info: PdfJsInfo | null, metadata: PdfJsMetadata | null): Date | undefined {
  const fromInfo = text(info?.CreationDate);
  const parsed = fromInfo === undefined ? null : pdfjs.PDFDateString.toDateObject(fromInfo);
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const fromXmp = text(metadataValue(metadata, 'xmp:createdate'));
  const date = fromXmp === undefined ? undefined : new Date(fromXmp);
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}


async function pageFonts(pdfjs: PdfJs, page: PdfJsPage, fonts: Map<string, PdfFont>): Promise<void> {
  const { fnArray, argsArray } = await page.getOperatorList();
  fnArray.forEach((fn, index) => {
    const id = fn === pdfjs.OPS.setFont ? argsArray[index]?.[0] : undefined;
    if (typeof id !== 'string' || !page.commonObjs.has(id)) return;
    const font = page.commonObjs.get(id) as { name?: unknown; loadedName?: unknown; missingFile?: unknown } | null;
    const name = text(font?.name) ?? text(font?.loadedName);
    if (name !== undefined && !fonts.has(name)) fonts.set(name, { name, embedded: font?.missingFile !== true });
  });
}

function isPdf(bytes: Uint8Array): boolean {
  // The header may follow up to 1024 bytes of leading data.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Opens the PDF in `bytes` with pdf.js, hands it to `use` and frees it. */
async function withDocument<T>(caller: string, bytes: Uint8Array, use: (pdfjs: PdfJs, doc: PdfJsDocument) => Promise<T>): Promise<T> {
  if (!(bytes instanceof Uint8Array)) throw new TypstPdfError('INVALID_REQUEST', `${caller} needs the PDF bytes as a Uint8Array`);
  if (!isPdf(bytes)) throw new TypstPdfError('INVALID_REQUEST', `${caller} input is not a PDF: no %PDF- header in the first 1024 bytes`);
  const pdfjs = await requirePdfJs(caller);
  // pdf.js takes ownership of the buffer it is given and detaches it, so give it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    let doc: PdfJsDocument;
    try {
      doc = await task.promise;
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
      throw new TypstPdfError('INVALID_REQUEST', `${caller} could not read the PDF${detail}`, [], { cause });
    }
    return await use(pdfjs, doc);
  } finally {
    await task.destroy();
  }
}

/**
 * Reads a compiled PDF and reports facts that matter for accessibility and output policy: tagging, title,
 * language, the standards its XMP metadata declares, the structure tree, headings, figure alternative text,
 * tables and fonts. It reports facts only. A tagged PDF with PDF/UA metadata and all the right-looking structure
 * is not thereby conformant; use a validator such as veraPDF for that.
 *
 * Needs `pdfjs-dist` (an optional peer dependency); rejects with a `TypstPdfError` that says so if it is missing.
 * Input that is not a readable PDF rejects with `INVALID_REQUEST`.
 */
export function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return withDocument('inspectPdf', bytes, async (pdfjs, doc) => {
    const { info, metadata } = await doc.getMetadata();
    const markInfo = await doc.getMarkInfo();
    const structure: PdfStructurePage[] = [];
    const fonts = new Map<string, PdfFont>();
    let structureTree = false;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const elements = await pageStructure(page);
      if (elements) structureTree = true;
      structure.push({ page: number, elements: elements ?? [] });
      await pageFonts(pdfjs, page, fonts);
    }
    const roles = new Map<string, number>();
    const headings: PdfHeading[] = [];
    const figures: PdfFigure[] = [];
    let tables = 0;
    eachElement(structure, element => {
      if (element.role) roles.set(element.role, (roles.get(element.role) ?? 0) + 1);
      const level = headingLevel(element.role);
      if (level !== undefined) headings.push({ level, text: element.text });
      else if (element.role === 'Figure') figures.push(element.alt === undefined ? {} : { alt: element.alt });
      else if (element.role === 'Table') tables += 1;
    });
    const part = integer(metadataValue(metadata, 'pdfaid:part'));
    const conformance = text(metadataValue(metadata, 'pdfaid:conformance'));
    return {
      pages: doc.numPages,
      tagged: isMarked(markInfo),
      structureTree,
      title: text(info?.Title) ?? text(metadataValue(metadata, 'dc:title')),
      language: text(info?.Language),
      creationDate: creationDate(pdfjs, info, metadata),
      standard: {
        pdfUa: integer(metadataValue(metadata, 'pdfuaid:part')),
        pdfA: part === undefined ? undefined : conformance === undefined ? { part } : { part, conformance },
      },
      headings,
      figures,
      tables,
      fonts: [...fonts.values()],
      structureRoles: Object.fromEntries(roles),
      structure,
    };
  });
}

/**
 * The PDF in `bytes`, read with pdf.js: one `untagged` warning when it is not tagged (`/MarkInfo /Marked`), else
 * the `structureWarnings` of its pages. The function to pass as a template check's `structure` option. Needs
 * `pdfjs-dist`, and rejects as `inspectPdf` does.
 */
export function checkStructure(bytes: Uint8Array): Promise<PdfStructureWarning[]> {
  return withDocument('checkStructure', bytes, async (_pdfjs, doc) => (await readDocument(doc)).warnings);
}
