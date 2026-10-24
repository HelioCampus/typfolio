// The paramdoc engine of the batch demo, from the experiment in experiments/paramdoc: Typst typeset the report
// once at export time into a document with slots (`doc.json` and two subset fonts, checked in under
// experiments/paramdoc/documents/report), and a runtime of about 16 kB fills the slots and writes each PDF in a
// Web Worker without a compiler. Its output is tagged PDF/UA-1. The exported report is the slot dialect's version
// of ./report/main.typ: the same text, boxes and table, but a static title, a tutor comment of up to three lines, no score
// bars and no row stripes.
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

type Reply = { type: 'ready' } | { type: 'done'; pdf: Uint8Array } | { type: 'error'; message: string };

/** One worker holding one runtime. `fill` renders one document at a time; the first call waits for the start. */
export class ParamdocWorker {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private pending: { resolve: (pdf: Uint8Array) => void; reject: (error: Error) => void } | undefined;

  constructor(exported: ParamdocDocument) {
    this.worker = new Worker(new URL('./paramdoc.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<Reply>) => {
      const pending = this.pending;
      this.pending = undefined;
      const reply = event.data;
      if (reply.type === 'error') pending?.reject(new Error(reply.message));
      else pending?.resolve(reply.type === 'done' ? reply.pdf : new Uint8Array());
    });
    this.worker.addEventListener('error', event => {
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(new Error(event.message || 'The paramdoc worker failed'));
    });
    this.ready = new Promise<Uint8Array>((resolve, reject) => { this.pending = { resolve, reject }; }).then(() => undefined);
    this.ready.catch(() => undefined);
    this.worker.postMessage({ type: 'init', doc: exported.doc, fonts: exported.fonts });
  }

  async fill(data: ParamdocReport): Promise<Uint8Array> {
    await this.ready;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage({ type: 'fill', data });
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.pending?.reject(new Error('The worker was terminated'));
    this.pending = undefined;
  }
}
