import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ViewerToolbar } from './chrome.tsx';

interface StaticViewerProps {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly aspect: number;
  readonly maxWidth: number;
  readonly onPages?: (pages: number) => void;
}

/**
 * Viewer chrome around a finished PDF: every page is rasterised by pdf.js and
 * stacked vertically on a gray backdrop (multi-page flipbooks scroll).
 */
export default function StaticViewer({ bytes, name, aspect, maxWidth, onPages }: StaticViewerProps) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitPx, setFitPx] = useState(0);
  const backdropRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (backdrop === null) return;
    const observe = (): void => setFitPx(Math.min(maxWidth, Math.max(120, backdrop.clientWidth - 48)));
    observe();
    const observer = new ResizeObserver(observe);
    observer.observe(backdrop);
    return () => observer.disconnect();
  }, [maxWidth]);

  useEffect(() => {
    let cancelled = false;
    const worker = new pdfjs.PDFWorker({ port: new Worker(pdfjsWorkerUrl, { type: 'module' }) as unknown as null });
    const task = pdfjs.getDocument({ data: bytes.slice(), worker, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    void (async () => {
      const document = await task.promise;
      if (cancelled) return;
      setPages(document.numPages);
      onPagesRef.current?.(document.numPages);
      // Canvases for every page exist after this state update; paint them on the next frame.
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (let index = 1; index <= document.numPages && !cancelled; index++) {
        const pdfPage = await document.getPage(index);
        const canvas = canvases.current[index - 1];
        if (canvas === null || canvas === undefined) continue;
        const viewport = pdfPage.getViewport({ scale: 2 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await pdfPage.render({ canvas, viewport }).promise;
      }
    })().catch(error => {
      if (!cancelled) console.error('Could not render the PDF', error);
    });
    return () => {
      cancelled = true;
      void task.destroy().finally(() => worker.destroy());
    };
  }, [bytes]);

  const onScroll = (): void => {
    const backdrop = backdropRef.current;
    if (backdrop === null) return;
    const middle = backdrop.getBoundingClientRect().top + backdrop.clientHeight / 2;
    let best = 1;
    canvases.current.forEach((canvas, index) => {
      if (canvas !== null && canvas !== undefined && canvas.getBoundingClientRect().top <= middle) best = index + 1;
    });
    setPage(best);
  };

  return (
    <div className="preview preview--viewer">
      <ViewerToolbar name={name} onZoom={setZoom} page={page} pages={Math.max(1, pages)} zoom={zoom} />
      <div className="viewer-backdrop viewer-backdrop--on viewer-backdrop--stack" onScroll={onScroll} ref={backdropRef}>
        {Array.from({ length: pages }, (_, index) => (
          <div className="pdf-frame sheet" key={index} style={{ aspectRatio: String(aspect), width: fitPx * zoom }}>
            <canvas
              aria-label={`PDF page ${index + 1}`}
              className="live-canvas"
              ref={node => {
                canvases.current[index] = node;
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
