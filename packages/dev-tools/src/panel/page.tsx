import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Read } from './read.js';
import type { TreeIndex, TreeNode } from './tree.js';

// The part of a pdf.js page (`PDFPageProxy`) the page view uses.
interface PdfJsViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}
interface PdfJsPage {
  getViewport(options: { scale: number }): PdfJsViewport;
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }): { promise: Promise<unknown>; cancel(): void };
}

/** A tag's box on the page, as fractions of the page's width and height from its top left corner. */
interface Placed {
  node: TreeNode;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Sheet {
  page: PdfJsPage;
  /** The page's size in PDF units, as it is shown (after its rotation). */
  width: number;
  height: number;
  /** The tags drawn on the page, parents before children. */
  placed: Placed[];
}

/** The innermost tag at a point of the page: the smallest box that holds it, the deeper of two of the same size. */
export function tagAt(placed: readonly Placed[], x: number, y: number): TreeNode | undefined {
  let found: Placed | undefined;
  for (const each of placed) {
    if (x < each.left || x > each.left + each.width || y < each.top || y > each.top + each.height) continue;
    if (!found || each.width * each.height <= found.width * found.height) found = each;
  }
  return found?.node;
}

const percent = (value: number) => `${(value * 100).toFixed(3)}%`;
const boxStyle = ({ left, top, width, height }: Placed) => ({ left: percent(left), top: percent(top), width: percent(width), height: percent(height) });

export interface PageViewProps {
  read: Read;
  index: TreeIndex;
  /** The page shown, from 1. */
  page: number;
  /** The path of the tag selected in the tree, and of the one the pointer is on. */
  selected?: string;
  hovered?: string;
  onPage: (page: number) => void;
  onHover: (node: TreeNode | undefined) => void;
  onPick: (node: TreeNode) => void;
}

/**
 * A page of the PDF, drawn by the page's pdf.js, with the selected tag marked on it. Moving over the page marks the
 * tag under the pointer, and a click selects it. A tag's box is the extent of its text (or a figure's own box): the
 * lines and fills around it belong to no tag.
 */
export function PageView({ read, index, page, selected, hovered, onPage, onHover, onPick }: PageViewProps) {
  const [sheet, setSheet] = useState<Sheet>();
  const [failed, setFailed] = useState<string>();
  const [width, setWidth] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const nodes = useMemo(() => index.pages.find(each => each.page === page)?.nodes ?? [], [index, page]);

  useEffect(() => {
    let current = true;
    setFailed(undefined);
    (async () => {
      try {
        const loaded = await read.document.getPage(page) as unknown as PdfJsPage;
        if (typeof loaded?.getViewport !== 'function' || typeof loaded.render !== 'function') throw new TypeError('not a pdf.js page');
        const viewport = loaded.getViewport({ scale: 1 });
        const placed: Placed[] = [];
        const walk = (node: TreeNode) => {
          const box = read.boxes.get(node.element);
          if (box) {
            const [x1, y1] = viewport.convertToViewportPoint(box[0], box[1]);
            const [x2, y2] = viewport.convertToViewportPoint(box[2], box[3]);
            placed.push({
              node,
              left: Math.min(x1, x2) / viewport.width,
              top: Math.min(y1, y2) / viewport.height,
              width: Math.abs(x2 - x1) / viewport.width,
              height: Math.abs(y2 - y1) / viewport.height,
            });
          }
          node.children.forEach(walk);
        };
        nodes.forEach(walk);
        if (current) setSheet({ page: loaded, width: viewport.width, height: viewport.height, placed });
      } catch (error) {
        // Such as a PDF replaced while its page loads: the next one draws.
        if (current) setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { current = false; };
  }, [read, page, nodes]);

  // The width to draw at, kept up with the panel's size.
  useEffect(() => {
    const element = frame.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!element || !Observer) return;
    const observer = new Observer(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    setWidth(Math.round(element.clientWidth));
    return () => observer.disconnect();
  }, [sheet !== undefined]);

  useEffect(() => {
    const target = canvas.current;
    if (!sheet || !target || width <= 0) return;
    const context = target.getContext('2d');
    if (!context) return;
    const ratio = Math.min(target.ownerDocument.defaultView?.devicePixelRatio ?? 1, 2);
    const viewport = sheet.page.getViewport({ scale: width / sheet.width * ratio });
    target.width = Math.floor(viewport.width);
    target.height = Math.floor(viewport.height);
    const task = sheet.page.render({ canvas: target, canvasContext: context, viewport });
    // A cancelled drawing, or one of a PDF since replaced, is not a failure to show.
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [sheet, width]);

  const selectedBox = sheet?.placed.find(each => each.node.path === selected);
  const hoveredBox = hovered === selected ? undefined : sheet?.placed.find(each => each.node.path === hovered);
  useEffect(() => {
    mark.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedBox?.node.path, sheet]);

  const at = (event: PointerEvent<HTMLDivElement>): TreeNode | undefined => {
    if (!sheet) return undefined;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return undefined;
    return tagAt(sheet.placed, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  };

  const pages = read.pages.length;
  return (
    <section className="tf-page" aria-label="Page">
      <div className="tf-page-bar">
        <button type="button" className="tf-page-step" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
        <span>Page {page} of {pages}</span>
        <button type="button" className="tf-page-step" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button>
      </div>
      {failed !== undefined ? (
        <p className="tf-hint tf-page-note">The page could not be drawn: {failed}</p>
      ) : sheet ? (
        <div className="tf-page-scroll">
          <div
            ref={frame}
            className="tf-sheet"
            style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}
            onPointerMove={event => onHover(at(event))}
            onPointerLeave={() => onHover(undefined)}
            onClick={event => {
              const node = at(event as unknown as PointerEvent<HTMLDivElement>);
              if (node) onPick(node);
            }}
          >
            <canvas ref={canvas} aria-hidden="true" />
            {hoveredBox ? <div className="tf-box" data-kind="hovered" style={boxStyle(hoveredBox)} /> : null}
            {selectedBox ? (
              <div ref={mark} className="tf-box" data-kind="selected" data-role={selectedBox.node.element.role} style={boxStyle(selectedBox)} />
            ) : null}
          </div>
          {selected !== undefined && !selectedBox && index.byPath.get(selected)?.page === page ? (
            <p className="tf-hint tf-page-note">The selected tag draws nothing on this page.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
