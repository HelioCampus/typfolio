import { useEffect, useRef, useState } from 'react';

/** What the proof affordances need to know about a PDF. */
export interface ProofFrame {
  readonly bytes: Uint8Array;
  readonly pages: number;
  /** `performance.now()` when the PDF was compiled, if known. */
  readonly compiledAt?: number | undefined;
}

export function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const pdfBlobUrl = (bytes: Uint8Array): string =>
  URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }));

/** Saves the exact bytes Typst produced. */
export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const url = pdfBlobUrl(bytes);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens the exact bytes in a new tab, in the browser's own PDF viewer. */
export function openPdf(bytes: Uint8Array): void {
  const url = pdfBlobUrl(bytes);
  window.open(url, '_blank');
  // The tab keeps its own reference once loaded; release ours later.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Object URL for `bytes` that is revoked when the bytes change or the component unmounts. */
export function usePdfBytesUrl(bytes: Uint8Array | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (bytes === undefined) {
      setUrl(undefined);
      return;
    }
    const next = pdfBlobUrl(bytes);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}

interface ProofBarProps {
  /** Reads the PDF being displayed right now (called on click and on a short timer). */
  readonly getFrame: () => ProofFrame | undefined;
  readonly fileName: string;
}

/**
 * "It really is a PDF": download the exact bytes, open them in a tab, and an
 * info line (size from the byte array, page count from pdf.js, frame age).
 */
export function ProofBar({ getFrame, fileName }: ProofBarProps) {
  const [info, setInfo] = useState<{ size: number; pages: number; age?: number }>();
  const seen = useRef<{ bytes: Uint8Array; at: number } | undefined>(undefined);

  useEffect(() => {
    const read = (): void => {
      const frame = getFrame();
      if (frame === undefined) {
        setInfo(undefined);
        return;
      }
      if (seen.current?.bytes !== frame.bytes) seen.current = { bytes: frame.bytes, at: frame.compiledAt ?? performance.now() };
      setInfo({ size: frame.bytes.length, pages: frame.pages, age: performance.now() - (frame.compiledAt ?? seen.current.at) });
    };
    read();
    const timer = setInterval(read, 150);
    return () => clearInterval(timer);
  }, [getFrame]);

  const act = (action: (frame: ProofFrame) => void) => () => {
    const frame = getFrame();
    if (frame !== undefined) action(frame);
  };

  return (
    <div className="proof">
      <p className="proof-info" aria-live="off">
        {info === undefined
          ? 'PDF · no frame yet'
          : `PDF · ${formatBytes(info.size)} · ${info.pages} page${info.pages === 1 ? '' : 's'} · compiled ${info.age === undefined ? '—' : info.age < 1000 ? `${Math.round(info.age)} ms` : `${(info.age / 1000).toFixed(1)} s`} ago`}
      </p>
      <div className="proof-actions">
        <button className="button button--small" disabled={info === undefined} onClick={act(frame => downloadPdf(frame.bytes, fileName))} type="button">
          Download frame
        </button>
        <button className="button button--small" disabled={info === undefined} onClick={act(frame => openPdf(frame.bytes))} type="button">
          Open in tab
        </button>
      </div>
    </div>
  );
}
