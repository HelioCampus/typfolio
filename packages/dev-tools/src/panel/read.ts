import { useEffect, useState } from 'react';
import type { StructurePanelPdfJs as PanelPdfJs } from '../panel.js';
import { readDocument, type PdfMarkInfo, type PdfStructurePage, type PdfStructureSource, type PdfStructureWarning } from '../structure.js';

export type { PanelPdfJs };

export interface Read {
  tagged: boolean;
  pages: PdfStructurePage[];
  warnings: PdfStructureWarning[];
}

export interface ReadState {
  /** The newest PDF read; kept while a newer one is read. */
  read?: Read;
  reading: boolean;
  /** Why the newest PDF could not be read. */
  error?: unknown;
}

/**
 * The tags of `bytes`, read with the page's pdf.js, and their warnings. A new PDF is read in place of the one being
 * read, whose result is dropped; pdf.js gets a copy of the bytes, as it detaches the buffer it is given.
 */
export function useStructure(pdfjs: PanelPdfJs, bytes: Uint8Array | undefined): ReadState {
  const [state, setState] = useState<ReadState>({ reading: bytes !== undefined });
  useEffect(() => {
    if (bytes === undefined) {
      setState({ reading: false });
      return;
    }
    setState(previous => ({ read: previous.read, reading: true }));
    let current = true;
    let task: ReturnType<PanelPdfJs['getDocument']> | undefined;
    let destroyed = false;
    const destroy = () => {
      if (destroyed || !task) return;
      destroyed = true;
      task.destroy().catch(() => {});
    };
    (async () => {
      try {
        task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
        const document = await task.promise;
        const read = await readDocument(document as PdfStructureSource & { getMarkInfo(): Promise<PdfMarkInfo> });
        if (current) setState({ read, reading: false });
      } catch (error) {
        if (current) setState({ reading: false, error });
      } finally {
        destroy();
      }
    })();
    return () => {
      current = false;
      destroy();
    };
  }, [pdfjs, bytes]);
  return state;
}
