// The structure tree, as a screen reader gets it, and the rules that read it. Internal: `@typfolio/dev-tools/pdf`
// exports the public part, and the structure panel bundles it. Nothing here loads pdf.js; callers pass a document.
import { TypstPdfError } from '@typfolio/core';

/** One structure element (tag), as a screen reader gets it. */
export interface PdfStructureElement {
  /** The role after pdf.js resolves the file's `/RoleMap`: `Document`, `H1`, `P`, `Table`, `TH`, `Figure`, … */
  role: string;
  /** The text drawn in the element and its children on this page, whitespace collapsed; empty when there is none. */
  text: string;
  /** The element's `/Alt`. */
  alt?: string;
  /** The element's `/Lang`. */
  lang?: string;
  children: PdfStructureElement[];
}

/**
 * One page's part of the structure tree: the elements with content on the page and their parents. Like pdf.js, it
 * lists every row of a table and every item of a list that has content on the page, so a screen reader knows their
 * size; a row or item drawn on another page is there with no text.
 */
export interface PdfStructurePage {
  /** The page number, from 1. */
  page: number;
  /** The top of the page's tree, usually one `Document`; empty for a page without tags. */
  elements: PdfStructureElement[];
}


export type PdfStructureWarningKind = 'untagged' | 'no-headings' | 'heading-skips-level' | 'figure-without-alt' | 'table-without-headers';

export interface PdfStructureWarning {
  kind: PdfStructureWarningKind;
  /** The page it is on; absent for a problem with the whole document. */
  page?: number;
  /** The element it is about, from the pages given; absent for a problem with the whole document. */
  element?: PdfStructureElement;
  message: string;
}

/**
 * The part of a pdf.js document (`PDFDocumentProxy`, from the Node or the browser build) that `readStructure`
 * reads, so a page that already has pdf.js can pass its own document.
 */
export interface PdfStructureSource {
  numPages: number;
  getPage(number: number): Promise<{
    getStructTree(): Promise<unknown>;
    getTextContent(options: { includeMarkedContent: boolean }): Promise<{ items: unknown[] }>;
  }>;
}

// The part of pdf.js output read here.
interface PdfJsStructNode { type?: string; id?: string; role?: string; alt?: string; lang?: string; children?: PdfJsStructNode[] }
interface PdfJsTextItem { str?: string; hasEOL?: boolean; type?: string; id?: string | null; tag?: string | null }

/** What pdf.js's `getMarkInfo()` resolves to. */
export type PdfMarkInfo = { Marked?: boolean } | Map<string, unknown> | null;

/** The catalog's `/MarkInfo /Marked` is true. */
export const isMarked = (markInfo: PdfMarkInfo): boolean =>
  (markInfo instanceof Map ? markInfo.get('Marked') : markInfo?.Marked) === true;


export const headingLevel = (role: string): number | undefined => {
  const match = /^H([1-6])?$/.exec(role);
  return match ? Number(match[1] ?? 0) : undefined;
};

/**
 * The text of each marked-content section that has an id, by id. Text goes to its innermost section with an id;
 * an artifact's text (a running header, a page number) goes to none, as a screen reader skips it.
 */
function textByContentId(items: readonly PdfJsTextItem[]): Map<string, string> {
  const byId = new Map<string, string>();
  const open: (string | null)[] = [];
  for (const item of items) {
    if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
      const own = typeof item.id === 'string' && item.id ? item.id : undefined;
      open.push(own ?? (item.tag === 'Artifact' ? null : open.at(-1) ?? null));
    } else if (item.type === 'endMarkedContent') open.pop();
    else if (typeof item.str === 'string') {
      const id = open.at(-1);
      if (id) byId.set(id, (byId.get(id) ?? '') + item.str + (item.hasEOL ? ' ' : ''));
    }
  }
  return byId;
}

// Inline roles (ISO 32000-1 14.8.4.4, and PDF 2.0's Em, Strong and Sub): their text runs on with the text around
// them, where a block element's text is a separate run.
const inlineRoles = new Set(['Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Em', 'Strong', 'Sub']);

const isElement = (node: PdfJsStructNode): boolean => typeof node.role === 'string';

function toElement(node: PdfJsStructNode, textById: Map<string, string>): { element: PdfStructureElement; raw: string } {
  const children: PdfStructureElement[] = [];
  let raw = '';
  for (const child of node.children ?? []) {
    if (isElement(child)) {
      const built = toElement(child, textById);
      children.push(built.element);
      raw += inlineRoles.has(built.element.role) ? built.raw : ` ${built.raw} `;
    } else if (child.type === 'content' && typeof child.id === 'string') raw += textById.get(child.id) ?? '';
  }
  return {
    element: {
      role: node.role as string,
      text: raw.replace(/\s+/g, ' ').trim(),
      ...(typeof node.alt === 'string' ? { alt: node.alt } : {}),
      ...(typeof node.lang === 'string' ? { lang: node.lang } : {}),
      children,
    },
    raw,
  };
}

/** A page's part of the structure tree; null when the page has none. */
export async function pageStructure(page: Awaited<ReturnType<PdfStructureSource['getPage']>>): Promise<PdfStructureElement[] | null> {
  const tree = await page.getStructTree() as PdfJsStructNode | null;
  if (!tree) return null;
  const { items } = await page.getTextContent({ includeMarkedContent: true });
  const textById = textByContentId(items as PdfJsTextItem[]);
  return (tree.children ?? []).filter(isElement).map(child => toElement(child, textById).element);
}

/** Calls `visit` on every element of every page, parents before children, in reading order. */
export function eachElement(pages: readonly PdfStructurePage[], visit: (element: PdfStructureElement, page: number) => void): void {
  const walk = (element: PdfStructureElement, page: number) => {
    visit(element, page);
    for (const child of element.children) walk(child, page);
  };
  for (const { page, elements } of pages) for (const element of elements) walk(element, page);
}

/**
 * Every page's part of the structure tree, read from a pdf.js document (`PDFDocumentProxy`) the caller already
 * has, such as one a browser page loaded with its own pdf.js. Needs nothing installed: `inspectPdf` returns the
 * same pages as `structure`.
 */
export async function readStructure(document: PdfStructureSource): Promise<PdfStructurePage[]> {
  if (!document || typeof document.getPage !== 'function' || !Number.isSafeInteger(document.numPages)) {
    throw new TypstPdfError('INVALID_REQUEST', 'readStructure takes a pdf.js document (PDFDocumentProxy)');
  }
  const pages: PdfStructurePage[] = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    pages.push({ page, elements: await pageStructure(await document.getPage(page)) ?? [] });
  }
  return pages;
}

/**
 * The elements at the top of a page that go on from the previous page. pdf.js gives each page its own part of the
 * tree, so a table that runs over a page break appears on both pages, the second time without its header row.
 * Followed down the first child here and the last child there for as long as the roles match, so a new table that
 * starts a page right after another table ended the previous one is taken for its continuation.
 */
export function continued(previous: readonly PdfStructureElement[], current: readonly PdfStructureElement[]): Set<PdfStructureElement> {
  const carried = new Set<PdfStructureElement>();
  let before = previous.at(-1);
  let after = current[0];
  while (before && after && before.role === after.role) {
    carried.add(after);
    before = before.children.at(-1);
    after = after.children[0];
  }
  return carried;
}

/** A `TH` in the table, not counting the ones of a table nested in it. */
const hasHeaderCell = (table: PdfStructureElement): boolean =>
  table.children.some(child => child.role === 'TH' || (child.role !== 'Table' && hasHeaderCell(child)));

const quote = (value: string) => `"${value.length > 60 ? `${value.slice(0, 57)}…` : value}"`;

/**
 * What a screen reader user would trip over in these pages (`inspectPdf`'s `structure`, or `readStructure`'s
 * result): several pages and no headings to move between, headings that skip a level, a figure with no alt text
 * and a table with no header cells. In reading order; empty when it finds none of these. Whether the file is
 * tagged at all is not in its pages: `checkStructure` and `inspectPdf`'s `tagged` say that.
 *
 * These are not conformance checks, and an empty result is not a verdict. A PDF/UA-1 compile already refuses
 * skipped heading levels and images without alt text; it accepts a table without header cells and a document
 * without headings, and so does a validator such as veraPDF. Whether the reading order and wording make sense
 * still needs a person.
 */
export function structureWarnings(pages: readonly PdfStructurePage[]): PdfStructureWarning[] {
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.elements))) {
    throw new TypstPdfError('INVALID_REQUEST', 'structureWarnings takes the pages of a structure tree: the structure of inspectPdf, or what readStructure returns');
  }
  const warnings: PdfStructureWarning[] = [];
  let headings = 0;
  let previousLevel = 0;
  pages.forEach(({ page, elements }, index) => {
    const carried = index === 0 ? new Set<PdfStructureElement>() : continued(pages[index - 1].elements, elements);
    eachElement([{ page, elements }], element => {
      const level = headingLevel(element.role);
      if (level !== undefined) {
        headings += 1;
        if (level === 0) return;
        if (level > previousLevel + 1) {
          warnings.push({
            kind: 'heading-skips-level',
            page,
            element,
            message: previousLevel === 0
              ? `The first heading, ${quote(element.text)}, is H${level}; headings start at H1.`
              : `${quote(element.text)} is H${level} right after an H${previousLevel}, skipping a level.`,
          });
        }
        previousLevel = level;
      } else if (element.role === 'Figure' && !element.alt?.trim()) {
        warnings.push({ kind: 'figure-without-alt', page, element, message: 'A figure has no alt text, so a screen reader cannot describe it.' });
      } else if (element.role === 'Table' && !carried.has(element) && !hasHeaderCell(element)) {
        const which = element.text ? `The table starting ${quote(element.text)}` : 'A table';
        warnings.push({ kind: 'table-without-headers', page, element, message: `${which} has no header cells (TH), so a screen reader cannot name its columns.` });
      }
    });
  });
  if (pages.length > 1 && headings === 0) {
    warnings.unshift({ kind: 'no-headings', message: `${pages.length} pages and no headings, so a screen reader user cannot move between sections.` });
  }
  return warnings;
}

/**
 * A pdf.js document's pages and their warnings: one `untagged` warning when it is not tagged, else the
 * `structureWarnings` of its pages. What `checkStructure` reports, and what the panel shows.
 */
export async function readDocument(document: PdfStructureSource & { getMarkInfo(): Promise<PdfMarkInfo> }): Promise<{ tagged: boolean; pages: PdfStructurePage[]; warnings: PdfStructureWarning[] }> {
  const tagged = isMarked(await document.getMarkInfo());
  const pages = await readStructure(document);
  const warnings: PdfStructureWarning[] = tagged
    ? structureWarnings(pages)
    : [{ kind: 'untagged', message: 'The PDF is not tagged, so a screen reader gets its text with no headings, tables or figures.' }];
  return { tagged, pages, warnings };
}
