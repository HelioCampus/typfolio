// The paramdoc engine of the batch demo: Typst typeset the report once at export time into a document with slots
// (`doc.json` and two subset fonts, checked in under experiments/paramdoc/documents/report), and the runtime of
// `@typfolio/paramdoc` fills the slots and writes each PDF in a pool of Web Workers without a compiler (its
// `createWorkerClient` and `fillBatch`, driven from ./batch.ts like the compiler's). Its output is tagged
// PDF/UA-1. The exported report is the slot dialect's version of ./report/main.typ: the same text, boxes, table
// and score bars, but a static title and a tutor comment of up to three lines.
import docUrl from '../../../../experiments/paramdoc/documents/report/doc.json?url';
import type { ReportInput } from './data.ts';

const fontUrls = import.meta.glob<string>('../../../../experiments/paramdoc/documents/report/fonts/*', { query: '?url', import: 'default', eager: true });

/** The exported document's bytes and its font files, in the document's order. */
export interface ParamdocDocument {
  readonly doc: Uint8Array;
  readonly fonts: readonly Uint8Array[];
  /** Bytes downloaded for the document and its fonts together. */
  readonly bytes: number;
}

async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${what}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

let documentPromise: Promise<ParamdocDocument> | undefined;

/** Downloads the document and its fonts once per page; every worker gets a copy. */
export function loadParamdocDocument(): Promise<ParamdocDocument> {
  documentPromise ??= (async () => {
    const doc = await fetchBytes(docUrl, 'the paramdoc document');
    const listed = JSON.parse(new TextDecoder().decode(doc)) as { fonts: { file: string }[] };
    const fonts = await Promise.all(listed.fonts.map(font => {
      const url = Object.entries(fontUrls).find(([path]) => path.endsWith(`/${font.file}`))?.[1];
      if (!url) throw new Error(`The paramdoc document needs ${font.file}, which is not among the exported fonts`);
      return fetchBytes(url, font.file);
    }));
    return { doc, fonts, bytes: doc.length + fonts.reduce((sum, font) => sum + font.length, 0) };
  })().catch(error => {
    documentPromise = undefined;
    throw error;
  });
  return documentPromise;
}

/** The report's data as the exported document binds it: slot names are data keys, the rows are `courses`. */
export interface ParamdocReport {
  readonly number: number;
  readonly name: string;
  readonly studentId: string;
  readonly programme: string;
  readonly term: string;
  readonly average: number;
  readonly course_count: number;
  readonly attendance: string;
  readonly courses: readonly { readonly code: string; readonly title: string; readonly score: number; readonly grade: string }[];
  readonly comment: string;
}

export function paramdocData(input: ReportInput): ParamdocReport {
  const average = Math.round(input.courses.reduce((sum, course) => sum + course.score, 0) / input.courses.length);
  return {
    number: input.number,
    name: input.student.name,
    studentId: input.student.studentId,
    programme: input.student.programme,
    term: input.term,
    average,
    course_count: input.courses.length,
    attendance: `${input.attendance}%`,
    courses: input.courses.map(course => ({ code: course.code, title: course.title, score: course.score, grade: course.grade })),
    comment: input.comment,
  };
}
