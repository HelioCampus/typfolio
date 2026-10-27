// @typfolio/paramdoc: fills a parametric document (exported from a Typst template in the slot dialect by
// @typfolio/paramdoc-export) with data and writes a tagged PDF/UA-1, without a compiler. The runtime only does
// what Typst's own layout was ported and proven for; anything else is refused with a message, so that its
// output is the compiler's, never an approximation of it. No dependencies; runs in browsers, workers and Node.
import { IR_VERSION, Runtime, type Document } from './runtime.js';

export { IR_VERSION, type Document };

/** What the exporter wrote: `doc.json` and the font files in the document's order (their hashes are checked);
 *  `images` are the document's own image files, needed only when the static content draws images. */
export interface DocumentInput {
  readonly document: Uint8Array | string;
  readonly fonts: readonly Uint8Array[];
  readonly images?: readonly Uint8Array[];
}

export interface FillResult {
  /** The PDF, tagged PDF/UA-1. */
  readonly pdf: Uint8Array;
  readonly pages: number;
}

export interface ParamdocRuntime {
  /** The parsed document, for inspection: its slots, bands and fonts. */
  readonly document: Document;
  /** The document format version this runtime reads. */
  readonly version: number;
  /** The names the data binds to: every slot, bar and image slot, the bands whose rows come from an array. */
  readonly names: readonly string[];
  /** Fills the document with `data` and writes a PDF. Throws `ParamdocError` with `code: 'fill'` when the data
   *  cannot be laid out as Typst would lay it out: the message names the slot, the reason and the fix. */
  fill(data: unknown): Promise<FillResult>;
}

export type ParamdocErrorCode =
  /** The document, its fonts or its images cannot be used: a format version this runtime does not read, a font
   *  whose hash is not the document's, a missing image file. */
  | 'document'
  /** The data cannot be laid out as Typst would lay it out: a character outside a slot's repertoire, text that
   *  does not fit under the slot's policy, a value of the wrong shape. */
  | 'fill';

export class ParamdocError extends Error {
  override readonly name = 'ParamdocError';
  readonly code: ParamdocErrorCode;
  constructor(code: ParamdocErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function names(document: Document): string[] {
  const out = new Set<string>();
  const fragment = (f: { slots: { name: string }[]; bars?: { name: string }[]; images?: { name: string }[] }) => {
    for (const s of f.slots) out.add(s.name);
    for (const b of f.bars ?? []) out.add(b.name);
    for (const i of f.images ?? []) out.add(i.name);
  };
  fragment(document);
  if (document.flow) {
    for (const block of document.flow.blocks) {
      if (block.kind === 'static') fragment(block.fragment);
      else out.add(block.band);
    }
    for (const band of document.flow.bands) for (const f of band.fragments) fragment(f);
    for (const overlay of document.flow.overlays) fragment(overlay);
  }
  return [...out];
}

/** Creates a runtime for one document. Parsing and compressing the fonts happens here, once; every `fill`
 *  reuses it, so keep the runtime for the document's lifetime (in a worker, one per worker). Throws
 *  `ParamdocError` with `code: 'document'`. */
export async function createRuntime(input: DocumentInput): Promise<ParamdocRuntime> {
  let runtime: Runtime;
  try {
    runtime = await Runtime.create(input.document, [...input.fonts], [...(input.images ?? [])]);
  } catch (error) {
    throw new ParamdocError('document', message(error), { cause: error });
  }
  const document = runtime.document;
  const bound = names(document);
  return {
    document,
    version: IR_VERSION,
    names: bound,
    async fill(data) {
      try {
        const { pdf, pages } = await runtime.fill(data);
        return { pdf, pages };
      } catch (error) {
        throw new ParamdocError('fill', message(error), { cause: error });
      }
    },
  };
}
