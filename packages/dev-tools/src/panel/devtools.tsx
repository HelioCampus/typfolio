import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useStructure, type PanelPdfJs, type ReadState } from './read.js';
import { plural, StructureView } from './view.js';

export type Theme = 'system' | 'light' | 'dark';
export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type Side = 'bottom' | 'top' | 'left' | 'right';

interface PanelProps {
  pdfjs: PanelPdfJs;
  bytes?: Uint8Array;
  theme: Theme;
}

export function EmbeddedPanel({ pdfjs, bytes, theme }: PanelProps) {
  const state = useStructure(pdfjs, bytes);
  return (
    <div className="tf tf-embedded" data-theme={theme}>
      <StructureView state={state} hasBytes={bytes !== undefined} />
    </div>
  );
}

/** What the button shows beside its label, and says to a screen reader. */
function badge({ read, error }: ReadState, hasBytes: boolean): { tone: string; text: string; label: string } {
  if (error !== undefined) return { tone: 'error', text: '!', label: 'the tags could not be read' };
  if (!read) return hasBytes ? { tone: 'quiet', text: '…', label: 'reading' } : { tone: 'quiet', text: '–', label: 'no PDF yet' };
  if (!read.tagged) return { tone: 'error', text: '!', label: 'the PDF is not tagged' };
  const count = read.warnings.length;
  return count > 0 ? { tone: 'warn', text: String(count), label: plural(count, 'problem') } : { tone: 'ok', text: '✓', label: 'no problems found' };
}

const sides: readonly Side[] = ['bottom', 'top', 'left', 'right'];
// Docked along the left or right edge, the panel is sized by its width; along the top or bottom, by its height.
const axisOf = (side: Side) => side === 'left' || side === 'right' ? 'width' : 'height';
const minSize = { width: 280, height: 140 };
// The arrow keys that move the panel's inner edge away from its side, and back.
const growKey: Record<Side, string> = { bottom: 'ArrowUp', top: 'ArrowDown', left: 'ArrowRight', right: 'ArrowLeft' };
const shrinkKey: Record<Side, string> = { bottom: 'ArrowDown', top: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight' };

/** A box with the edge the panel docks to filled in. */
function SideIcon({ side }: { side: Side }) {
  const edge = { bottom: { x: 1, y: 9, width: 12, height: 4 }, top: { x: 1, y: 1, width: 12, height: 4 }, left: { x: 1, y: 1, width: 4, height: 12 }, right: { x: 9, y: 1, width: 4, height: 12 } }[side];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="0.5" y="0.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" />
      <rect {...edge} rx="1" fill="currentColor" />
    </svg>
  );
}

interface DevtoolsProps extends PanelProps {
  buttonPosition: Corner;
  position: Side;
  initialIsOpen: boolean;
}

/**
 * A button in a corner of the page, with the number of problems in the PDF, that opens the panel along a side of the
 * page; the panel's toolbar moves it to another side. The PDF is read while the panel is closed too, for the count.
 */
export function Devtools({ pdfjs, bytes, theme, buttonPosition, position, initialIsOpen }: DevtoolsProps) {
  const state = useStructure(pdfjs, bytes);
  const [open, setOpen] = useState(initialIsOpen);
  const [side, setSide] = useState(position);
  // Each axis keeps its own size, so moving the panel to the other axis and back keeps both.
  const [sizes, setSizes] = useState<{ width?: number; height?: number }>({});
  const toggle = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLElement>(null);
  const wasOpen = useRef(open);
  const stopResizing = useRef<() => void>(undefined);
  // A position given to update moves the panel; one chosen in the toolbar stays until then.
  useEffect(() => setSide(position), [position]);
  useEffect(() => {
    // Focus follows the panel: into it when it opens, back to the button when it closes.
    if (open !== wasOpen.current) (open ? dock.current : toggle.current)?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => () => stopResizing.current?.(), []);

  const axis = axisOf(side);
  const size = sizes[axis];
  const view = () => dock.current?.ownerDocument.defaultView ?? window;
  // The page's visible size, without its scrollbars: the panel docks to the inside of them.
  const visible = (target: Window) => {
    const { clientWidth, clientHeight } = target.document.documentElement;
    return { width: clientWidth || target.innerWidth, height: clientHeight || target.innerHeight };
  };
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, minSize[axis]), visible(view())[axis] - 40));
  const resize = (value: number) => setSizes(previous => ({ ...previous, [axis]: clamp(value) }));
  const startResizing = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = view();
    // The distance from the side the panel is docked to, to the pointer.
    const move = ({ clientX, clientY }: globalThis.PointerEvent) => {
      const { width, height } = visible(target);
      resize({ bottom: height - clientY, top: clientY, left: clientX, right: width - clientX }[side]);
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      stopResizing.current = undefined;
    };
    stopResizing.current?.();
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    stopResizing.current = stop;
  };
  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === growKey[side] ? 40 : event.key === shrinkKey[side] ? -40 : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = size ?? (axis === 'width' ? dock.current?.offsetWidth : dock.current?.offsetHeight) ?? minSize[axis];
    resize(current + step);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    // Escape in a filter with text clears the filter instead.
    const target = event.target as HTMLInputElement;
    if (event.key !== 'Escape' || (target.type === 'search' && target.value)) return;
    setOpen(false);
  };

  const { tone, text, label } = badge(state, bytes !== undefined);
  const sidePicker = (
    <div className="tf-sides" role="group" aria-label="Move the panel">
      {sides.map(each => (
        <button key={each} type="button" className="tf-side" aria-label={`Dock to the ${each}`} aria-pressed={side === each} title={`Dock to the ${each}`} onClick={() => setSide(each)}>
          <SideIcon side={each} />
        </button>
      ))}
    </div>
  );
  return (
    <div className="tf" data-theme={theme}>
      <button ref={toggle} type="button" className="tf-toggle" data-position={buttonPosition} hidden={open} aria-label={`Open the PDF tags panel: ${label}`} onClick={() => setOpen(true)}>
        PDF tags <span className="tf-badge" data-tone={tone} aria-hidden="true">{text}</span>
      </button>
      <section ref={dock} className="tf-dock" data-side={side} hidden={!open} aria-label="PDF tags panel" tabIndex={-1} style={size === undefined ? undefined : { [axis]: size }} onKeyDown={closeOnEscape}>
        <div
          className="tf-resize"
          role="separator"
          aria-orientation={axis === 'height' ? 'horizontal' : 'vertical'}
          aria-label="Resize the panel"
          aria-valuenow={size}
          tabIndex={0}
          onPointerDown={startResizing}
          onKeyDown={resizeWithKeys}
        />
        <StructureView state={state} hasBytes={bytes !== undefined} tools={sidePicker} onClose={() => setOpen(false)} />
      </section>
    </div>
  );
}
