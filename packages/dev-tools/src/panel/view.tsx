import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { headingLevel, type PdfStructureElement, type PdfStructureWarning, type PdfStructureWarningKind } from '../structure.js';
import { PageView } from './page.js';
import type { ReadState } from './read.js';
import { ancestors, filterTree, indexPages, type TreeIndex, type TreeNode } from './tree.js';

const marks: Record<PdfStructureWarningKind, string> = {
  'untagged': 'Not tagged',
  'no-headings': 'No headings',
  'heading-skips-level': 'Skips a level',
  'figure-without-alt': 'No alt text',
  'table-without-headers': 'No header cells',
};

// Elements that start closed: their rows and items are many, and the line above them says enough.
const startsClosed = new Set(['Table', 'L', 'TOC', 'Index']);

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const isHeading = (element: PdfStructureElement) => headingLevel(element.role) !== undefined;

/** The text of a table's `TH` cells that label columns, not counting those of a table nested in it. */
function columns(element: PdfStructureElement): string[] {
  return element.children.flatMap(child => child.role === 'TH' ? (child.scope === 'Row' ? [] : [child.text]) : child.role === 'Table' ? [] : columns(child));
}

const scopes = { Row: 'Row: labels the cells of its row', Column: 'Column: labels the cells of its column', Both: 'Both: labels the cells of its row and of its column' };

/** Something to read in it: text, alt text, or a figure. */
const hasContent = (element: PdfStructureElement): boolean =>
  element.text !== '' || element.alt !== undefined || element.role === 'Figure' || element.children.some(hasContent);

/** The one line an element gets beside its role. */
function summary({ element, continues }: TreeNode): { text: string; quiet: boolean } | undefined {
  if (element.role === 'Figure') return element.alt?.trim() ? { text: `Alt: ${element.alt}`, quiet: true } : undefined;
  if (continues !== undefined) return { text: `Continued from page ${continues}`, quiet: true };
  if (element.role === 'Table') {
    const names = columns(element);
    const parts = [...(names.length > 0 ? [`Columns: ${names.join(', ')}`] : []), ...(element.summary?.trim() ? [`Summary: ${element.summary}`] : [])];
    return parts.length > 0 ? { text: parts.join(' · '), quiet: true } : undefined;
  }
  // Such as a table's row drawn on another page: pdf.js lists all of a table's rows on each of its pages.
  if (!hasContent(element)) return { text: 'No text on this page', quiet: true };
  if (!element.text) return undefined;
  // A container's text is its children's, which are listed under it.
  return { text: element.text, quiet: element.children.length > 0 && !isHeading(element) };
}

/** Copies text to the clipboard; says so for a moment. Shown in a tag's row when the pointer or focus is on it. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean>();
  useEffect(() => {
    if (copied === undefined) return;
    const timer = setTimeout(() => setCopied(undefined), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="tf-copy"
      data-copied={copied !== undefined}
      aria-label={label}
      title={label}
      onClick={event => {
        const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator.clipboard;
        // No clipboard, as on a page not served over HTTPS, or permission refused.
        (clipboard ? clipboard.writeText(text) : Promise.reject()).then(() => setCopied(true), () => setCopied(false));
      }}
    >
      <span aria-live="polite">{copied === undefined ? 'Copy' : copied ? 'Copied' : 'Not copied'}</span>
    </button>
  );
}

/** What there is to copy from a tag: a figure's alt text, any other tag's text. */
const copyable = (element: PdfStructureElement) => (element.role === 'Figure' ? element.alt?.trim() : element.text) || undefined;

function Details({ node, index, warnings }: { node: TreeNode; index: TreeIndex; warnings: readonly PdfStructureWarning[] }) {
  const { element } = node;
  const children = new Map<string, number>();
  for (const child of element.children) children.set(child.role, (children.get(child.role) ?? 0) + 1);
  const text = element.text.length > 2000 ? `${element.text.slice(0, 2000)}…` : element.text;
  return (
    <>
      <h2>
        <span className="tf-role" data-heading={isHeading(element)}>{element.role}</span>
        Page {node.page}
      </h2>
      <dl>
        <dt>Path</dt>
        <dd>{[...ancestors(node), node].map(each => each.element.role).join(' › ')}</dd>
        <dt>Text</dt>
        <dd>{text || 'None'}{element.text ? <CopyButton text={element.text} label="Copy the text" /> : null}</dd>
        {element.alt !== undefined || element.role === 'Figure' ? (
          <>
            <dt>Alt text</dt>
            <dd>{element.alt?.trim() ? <>{element.alt}<CopyButton text={element.alt} label="Copy the alt text" /></> : 'None'}</dd>
          </>
        ) : null}
        {element.lang ? (
          <>
            <dt>Language</dt>
            <dd>{element.lang}</dd>
          </>
        ) : null}
        {node.continues !== undefined ? (
          <>
            <dt>Continues</dt>
            <dd>The table at the end of page {node.continues}</dd>
          </>
        ) : null}
        {element.role === 'Table' ? (
          <>
            <dt>Columns</dt>
            <dd>{columns(element).join(', ') || 'None: no TH cells'}</dd>
            <dt>Summary</dt>
            <dd>{element.summary?.trim() ? element.summary : 'None'}</dd>
          </>
        ) : null}
        {element.role === 'TH' ? (
          <>
            <dt>Scope</dt>
            <dd>{element.scope ? scopes[element.scope] : 'None'}</dd>
          </>
        ) : null}
        {element.role === 'TH' || element.role === 'TD' ? (
          <>
            <dt>Headers</dt>
            {/* A header cell without text, or one the tree does not have, is named by its id. */}
            <dd>{element.headers?.length ? element.headers.map(id => index.byId.get(id)?.element.text || id).join(', ') : 'None'}</dd>
          </>
        ) : null}
        {children.size > 0 ? (
          <>
            <dt>Children</dt>
            <dd>{[...children].map(([role, count]) => `${count} ${role}`).join(', ')}</dd>
          </>
        ) : null}
      </dl>
      {warnings.map((warning, index) => <p key={index} className="tf-problem-note">{warning.message}</p>)}
    </>
  );
}

type Pane = 'tree' | 'page' | 'details';
// The share of the panel each view starts with.
const startShares: Record<Pane, number> = { tree: 5, page: 4, details: 3 };
// The least a view is dragged down to, in pixels, and the step of an arrow key as a part of the two views' size.
const minPane = 60;
const keyStep = 0.05;
// Under this width the views stack, as the panel docked to the left or right does.
const stackUnder = 560;

export interface StructureViewProps {
  state: ReadState;
  /** Whether the page gave a PDF to read. */
  hasBytes: boolean;
  /** Controls of the panel's own, shown in its toolbar before the close button. */
  tools?: ReactNode;
  /** Shows a close button that calls it. */
  onClose?: () => void;
}

/**
 * The tags of the PDF, page by page in reading order, and what a screen reader user would trip over: each problem
 * opens the tag it is about. Which tags are open, the selection and the filter are kept by position, so they stay
 * across a new compile of the same template.
 */
export function StructureView({ state, hasBytes, tools, onClose }: StructureViewProps) {
  const { read, reading, error } = state;
  const index = useMemo(() => read && indexPages(read.pages), [read]);
  const [selected, setSelected] = useState<string>();
  const [toggled, setToggled] = useState(() => new Map<string, boolean>());
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState(0);
  // The page view: whether it shows, its page, and the tag the pointer is on, in the tree or on the page.
  const [showPage, setShowPage] = useState(true);
  const [page, setPage] = useState(1);
  const [hovered, setHovered] = useState<string>();
  const tree = useRef<HTMLDivElement>(null);
  // The views side by side, or stacked in a narrow panel, and the share of the room each has: the dividers move it.
  const main = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const [shares, setShares] = useState(startShares);
  const stopDragging = useRef<() => void>(undefined);
  const filter = useMemo(() => index && filterTree(index, query), [index, query]);
  const warningsAt = useMemo(() => {
    const byPath = new Map<string, PdfStructureWarning[]>();
    for (const warning of read?.warnings ?? []) {
      const node = warning.element && index?.byElement.get(warning.element);
      if (node) byPath.set(node.path, [...byPath.get(node.path) ?? [], warning]);
    }
    return byPath;
  }, [read, index]);

  useEffect(() => {
    if (revealed === 0 || selected === undefined) return;
    tree.current?.querySelector(`[data-path="${selected}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [revealed]);

  const tagged = read?.tagged === true && index !== undefined && error === undefined;
  useEffect(() => {
    const element = main.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!element || !Observer) return;
    const observer = new Observer(() => setStacked(element.clientWidth < stackUnder));
    observer.observe(element);
    return () => observer.disconnect();
  }, [tagged]);
  useEffect(() => () => stopDragging.current?.(), []);

  const extent = (pane: Pane) => {
    const bounds = main.current?.querySelector(`[data-pane="${pane}"]`)?.getBoundingClientRect();
    return bounds ? (stacked ? bounds.height : bounds.width) : 0;
  };
  /** Gives `before` the size asked for, in pixels, out of the room it and `after` have together. */
  const divide = (before: Pane, after: Pane, total: number, size: number) => {
    if (!(total > 0)) return;
    const least = Math.min(minPane, total / 2);
    const part = Math.min(Math.max(size, least), total - least) / total;
    setShares(previous => {
      const sum = previous[before] + previous[after];
      return { ...previous, [before]: sum * part, [after]: sum * (1 - part) };
    });
  };
  const divider = (before: Pane, after: Pane) => {
    const startDragging = (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const view = event.currentTarget.ownerDocument.defaultView ?? window;
      const start = stacked ? event.clientY : event.clientX;
      const size = extent(before);
      const total = size + extent(after);
      const move = ({ clientX, clientY }: globalThis.PointerEvent) => divide(before, after, total, size + (stacked ? clientY : clientX) - start);
      const stop = () => {
        view.removeEventListener('pointermove', move);
        view.removeEventListener('pointerup', stop);
        stopDragging.current = undefined;
      };
      stopDragging.current?.();
      view.addEventListener('pointermove', move);
      view.addEventListener('pointerup', stop);
      stopDragging.current = stop;
    };
    const moveWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === (stacked ? 'ArrowDown' : 'ArrowRight') ? 1 : event.key === (stacked ? 'ArrowUp' : 'ArrowLeft') ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const sum = shares[before] + shares[after];
      // Without a layout to measure, the shares stand in for the sizes.
      const total = extent(before) + extent(after) || sum * 1000;
      divide(before, after, total, total * (shares[before] / sum + step * keyStep));
    };
    return (
      <div
        className="tf-split"
        role="separator"
        aria-orientation={stacked ? 'horizontal' : 'vertical'}
        aria-label={`Resize the ${before === 'tree' ? 'tags' : before} and the ${after === 'details' ? 'selected tag' : after}`}
        aria-valuenow={Math.round(shares[before] / (shares[before] + shares[after]) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        onPointerDown={startDragging}
        onKeyDown={moveWithKeys}
        onDoubleClick={() => setShares(previous => ({ ...previous, [before]: startShares[before], [after]: startShares[after] }))}
      />
    );
  };
  const pane = (name: Pane) => ({ className: 'tf-pane', 'data-pane': name, style: { flexGrow: shares[name] } });

  // The page view follows the selection.
  const selectedPage = selected === undefined ? undefined : index?.byPath.get(selected)?.page;
  useEffect(() => {
    if (selectedPage !== undefined) setPage(selectedPage);
  }, [selected, selectedPage]);
  const shownPage = Math.min(Math.max(page, 1), Math.max(read?.pages.length ?? 1, 1));

  const reveal = (node: TreeNode) => {
    setToggled(previous => {
      const next = new Map(previous);
      for (const parent of ancestors(node)) next.set(parent.path, true);
      return next;
    });
    if (filter && !filter.shown.has(node.path)) setQuery('');
    setSelected(node.path);
    setRevealed(count => count + 1);
  };

  const renderNode = (node: TreeNode): ReactNode => {
    const { element } = node;
    const children = filter ? node.children.filter(child => filter.shown.has(child.path)) : node.children;
    const open = children.length > 0 && (toggled.get(node.path) ?? (filter ? true : !startsClosed.has(element.role) && hasContent(element)));
    const line = summary(node);
    const mark = warningsAt.get(node.path)?.[0];
    return (
      <li key={node.path}>
        <div
          className="tf-row"
          data-path={node.path}
          data-selected={selected === node.path}
          data-hovered={hovered === node.path}
          data-found={filter?.found.has(node.path) ?? false}
          onMouseEnter={() => setHovered(node.path)}
          onMouseLeave={() => setHovered(current => current === node.path ? undefined : current)}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className="tf-twist"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${element.role}`}
              onClick={() => setToggled(previous => new Map(previous).set(node.path, !open))}
            >▶</button>
          ) : <span className="tf-twist-space" />}
          <button type="button" className="tf-select" aria-current={selected === node.path || undefined} onClick={() => setSelected(node.path)}>
            <span className="tf-role" data-heading={isHeading(element)}>{element.role}</span>
            {element.lang ? <span className="tf-text" data-quiet="true">lang {element.lang}</span> : null}
            {element.scope ? <span className="tf-text" data-quiet="true">scope {element.scope}</span> : null}
            {line ? <span className="tf-text" data-quiet={line.quiet}>{line.text}</span> : null}
            {mark ? <span className="tf-mark">{marks[mark.kind]}</span> : null}
          </button>
          {copyable(element) ? <CopyButton text={copyable(element)!} label={`Copy the ${element.role === 'Figure' ? 'alt text' : 'text'} of this ${element.role}`} /> : null}
        </div>
        {open ? renderList(children) : null}
      </li>
    );
  };

  // Nothing to read: no text, no alt text and no problem, like a table's row drawn on another page.
  const isBlank = ({ element, path }: TreeNode) => !hasContent(element) && !warningsAt.has(path);
  /** The nodes, with a run of blank ones of the same role on one line, unless the filter picked them. */
  const renderList = (nodes: readonly TreeNode[]): ReactNode => {
    const items: ReactNode[] = [];
    for (let start = 0; start < nodes.length;) {
      let end = start + 1;
      if (!filter && isBlank(nodes[start])) {
        while (end < nodes.length && isBlank(nodes[end]) && nodes[end].element.role === nodes[start].element.role) end += 1;
      }
      if (end - start < 2) items.push(renderNode(nodes[start]));
      else {
        items.push(
          <li key={nodes[start].path}>
            <div className="tf-row">
              <span className="tf-twist-space" />
              <span className="tf-select">
                <span className="tf-role">{nodes[start].element.role}</span>
                <span className="tf-text" data-quiet="true">× {end - start} with no text on this page</span>
              </span>
            </div>
          </li>,
        );
      }
      start = end;
    }
    return <ul>{items}</ul>;
  };

  const problems = read?.tagged ? read.warnings : [];
  const node = selected === undefined ? undefined : index?.byPath.get(selected);
  return (
    <div className="tf-panel">
      <div className="tf-bar">
        <h2 className="tf-title">PDF tags</h2>
        {read && index ? (
          <span className="tf-counts">
            {[plural(read.pages.length, 'page'), plural(index.counts.headings, 'heading'), plural(index.counts.tables, 'table'), plural(index.counts.figures, 'figure')].join(' · ')}
          </span>
        ) : null}
        {reading && read ? <span className="tf-reading" role="status">Reading the new PDF…</span> : null}
        {read?.tagged ? (
          <input
            type="search"
            className="tf-filter"
            placeholder="Filter by role or text"
            aria-label="Filter the tags by role or text"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        ) : null}
        {read?.tagged ? (
          <button type="button" className="tf-side tf-page-toggle" aria-pressed={showPage} title="Show the page beside the tags" onClick={() => setShowPage(shown => !shown)}>Page</button>
        ) : null}
        {tools}
        {onClose ? <button type="button" className="tf-close" aria-label="Close the PDF tags panel" onClick={onClose}>×</button> : null}
      </div>
      {error !== undefined ? (
        <p className="tf-banner" data-tone="error" role="alert">The tags could not be read: {describe(error)}</p>
      ) : !read ? (
        <p className="tf-banner" data-tone="quiet" role="status">{hasBytes ? 'Reading the PDF’s tags…' : 'No PDF yet: the tags show once there is one.'}</p>
      ) : !read.tagged ? (
        <p className="tf-banner" data-tone="error">{read.warnings[0]?.message}</p>
      ) : problems.length === 0 ? (
        <p className="tf-banner" data-tone="ok">
          No problems found in the headings, figure alt text or table headers. Whether the reading order and wording make sense still needs a person.
        </p>
      ) : (
        <section className="tf-problems" aria-label="Problems">
          <h2>{plural(problems.length, 'problem')} a screen reader user would hit</h2>
          <ul>
            {problems.map((warning, position) => {
              const at = warning.element && index?.byElement.get(warning.element);
              const content = <>{warning.page === undefined ? null : <><span className="tf-problem-page">Page {warning.page}:</span>{' '}</>}{warning.message}</>;
              return (
                <li key={position}>
                  {at ? <button type="button" className="tf-problem" onClick={() => reveal(at)}>{content}</button> : <p className="tf-problem">{content}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {read?.tagged && index && error === undefined ? (
        <div className="tf-main" ref={main} data-stacked={stacked}>
          <div {...pane('tree')}>
          <div className="tf-tree" ref={tree} role="region" aria-label="Tags in reading order">
            {index.pages.map(({ page, nodes }) => {
              const shown = filter ? nodes.filter(each => filter.shown.has(each.path)) : nodes;
              if (filter && shown.length === 0) return null;
              return (
                <section key={page} aria-label={`Page ${page}`}>
                  <h3 className="tf-page-title">Page {page}</h3>
                  {shown.length > 0 ? renderList(shown) : <p className="tf-banner" data-tone="quiet">No tags on this page.</p>}
                </section>
              );
            })}
            {filter && filter.found.size === 0 ? <p className="tf-banner" data-tone="quiet">No tag matches “{query.trim()}”.</p> : null}
          </div>
          </div>
          {showPage && read ? divider('tree', 'page') : null}
          {showPage && read ? (
            <div {...pane('page')}>
            <PageView
              read={read}
              index={index}
              page={shownPage}
              selected={selected}
              hovered={hovered}
              onPage={setPage}
              onHover={at => setHovered(at?.path)}
              onPick={reveal}
            />
            </div>
          ) : null}
          {divider(showPage && read ? 'page' : 'tree', 'details')}
          <div {...pane('details')}>
          <aside className="tf-details" aria-label="Selected tag">
            {node ? <Details node={node} index={index} warnings={warningsAt.get(node.path) ?? []} /> : <p className="tf-hint">Select a tag, in the list or on the page, to see its text, alt text and language, and for a table cell its scope and headers.</p>}
          </aside>
          </div>
        </div>
      ) : null}
    </div>
  );
}
