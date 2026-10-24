// The structure panel: a PDF's tags as a screen reader gets them, and what a screen reader user would trip over,
// shown in the page. It is written in React, and React is bundled into this entry, so a page shows it without
// React of its own and a React page's React is not involved. It loads no pdf.js: the page passes its own.
import { TypstPdfError } from '@typfolio/core';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { PdfStructureSource } from './structure.js';
import { Devtools, EmbeddedPanel } from './panel/devtools.js';
import { css } from './panel/styles.js';

/**
 * The part of pdf.js the panel uses: the module the page imports (`import * as pdfjs from 'pdfjs-dist'`), with its
 * worker set up (`GlobalWorkerOptions.workerSrc`). The panel opens each PDF with it and frees it once read.
 */
export interface StructurePanelPdfJs {
  getDocument(source: { data: Uint8Array; verbosity?: number; isEvalSupported?: boolean; disableFontFace?: boolean; useSystemFonts?: boolean }): {
    promise: Promise<PdfStructureSource & { getMarkInfo(): Promise<unknown> }>;
    destroy(): Promise<void>;
  };
}

export interface StructurePanelOptions {
  readonly pdfjs: StructurePanelPdfJs;
  /**
   * The PDF to show, such as `usePdf`'s `result?.bytes`; absent until there is one. Each new one is read in place of
   * the last, which stays on show until it is; the bytes themselves are left as they are.
   */
  readonly bytes?: Uint8Array;
  /** `'system'` follows the page's colour scheme preference. Defaults to `'system'`. */
  readonly theme?: 'system' | 'light' | 'dark';
}

export interface StructureDevtoolsOptions extends StructurePanelOptions {
  /** The side of the page the panel opens along. Its toolbar moves it to another. Defaults to `'bottom'`. */
  readonly position?: 'bottom' | 'top' | 'left' | 'right';
  /** The corner the button sits in. Defaults to `'bottom-right'`. */
  readonly buttonPosition?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Whether the panel starts open. Defaults to false. */
  readonly initialIsOpen?: boolean;
}

export interface MountedStructurePanel<Options> {
  /** Changes the options given, such as `{ bytes }` for a new PDF; the others stay as they are. */
  update(options: Partial<Options>): void;
  /** Removes the panel. Later calls of `update` and `unmount` do nothing. */
  unmount(): void;
}

const themes = new Set(['system', 'light', 'dark']);
const sides = new Set(['bottom', 'top', 'left', 'right']);
const corners = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left']);

function checked<Options extends StructureDevtoolsOptions>(caller: string, options: Options): Options {
  const invalid = (message: string) => new TypstPdfError('INVALID_REQUEST', `${caller}: ${message}`);
  if (typeof options !== 'object' || options === null) throw invalid('options must be an object');
  if (typeof options.pdfjs?.getDocument !== 'function') throw invalid('pdfjs must be pdf.js, such as `import * as pdfjs from \'pdfjs-dist\'`');
  if (options.bytes !== undefined && !(options.bytes instanceof Uint8Array)) throw invalid('bytes must be the PDF as a Uint8Array');
  if (options.theme !== undefined && !themes.has(options.theme)) throw invalid('theme must be \'system\', \'light\' or \'dark\'');
  if (options.position !== undefined && !sides.has(options.position)) throw invalid('position must be \'bottom\', \'top\', \'left\' or \'right\'');
  if (options.buttonPosition !== undefined && !corners.has(options.buttonPosition)) throw invalid('buttonPosition must be \'bottom-right\', \'bottom-left\', \'top-right\' or \'top-left\'');
  if (options.initialIsOpen !== undefined && typeof options.initialIsOpen !== 'boolean') throw invalid('initialIsOpen must be a boolean');
  return options;
}

function mount<Options extends StructureDevtoolsOptions>(caller: string, parent: Element, initial: Options, render: (options: Options) => ReactElement): MountedStructurePanel<Options> {
  let options = checked(caller, initial);
  // A shadow root keeps the page's styles out of the panel and the panel's out of the page.
  const host = parent.ownerDocument.createElement('div');
  host.setAttribute('data-typfolio-panel', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = parent.ownerDocument.createElement('style');
  style.textContent = css;
  const container = parent.ownerDocument.createElement('div');
  container.style.height = '100%';
  shadow.append(style, container);
  parent.append(host);
  const root = createRoot(container);
  root.render(render(options));
  let mounted = true;
  return {
    update(next) {
      if (!mounted) return;
      options = checked(caller, { ...options, ...next });
      root.render(render(options));
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount();
      host.remove();
    },
  };
}

/**
 * Shows the panel inside `element`, filling it: for a page of its own, or a tab beside a PDF preview. Give the element
 * a height. Throws `INVALID_REQUEST` for options it cannot use.
 */
export function mountStructurePanel(element: Element, options: StructurePanelOptions): MountedStructurePanel<StructurePanelOptions> {
  if (element?.nodeType !== 1) throw new TypstPdfError('INVALID_REQUEST', 'mountStructurePanel: element must be the DOM element to show the panel in');
  return mount('mountStructurePanel', element, options, ({ pdfjs, bytes, theme = 'system' }) =>
    createElement(EmbeddedPanel, { pdfjs, bytes, theme }));
}

/**
 * Adds a button to a corner of the page that opens the panel along a side of it, like a devtools panel; the button
 * shows the number of problems found. The PDF is read while the panel is closed too. Throws `INVALID_REQUEST` for
 * options it cannot use.
 */
export function mountStructureDevtools(options: StructureDevtoolsOptions): MountedStructurePanel<StructureDevtoolsOptions> {
  return mount('mountStructureDevtools', document.body, options, ({ pdfjs, bytes, theme = 'system', position = 'bottom', buttonPosition = 'bottom-right', initialIsOpen = false }) =>
    createElement(Devtools, { pdfjs, bytes, theme, position, buttonPosition, initialIsOpen }));
}
