// Three ways to draw charts for a PDF away from what the user sees. Each draws every chart at a
// fixed size, waits until each has an SVG with a size, and serializes them with computed styles.
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { ThemeProvider, type Theme } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

export type StageMode = 'iframe' | 'div' | 'div-contain';
export const stageModes: readonly StageMode[] = ['iframe', 'div', 'div-contain'];

export interface StageTiming {
  mode: StageMode;
  charts: number;
  /** Rendering and committing every chart (flushSync), effects included. */
  drawMs: number;
  /** Polling until every slot holds a sized SVG. */
  waitMs: number;
  /** Cloning each SVG with its computed styles and serializing it. */
  serializeMs: number;
  totalMs: number;
  bytes: number;
}

const fontFamily = 'Georgia';
const offscreen = { position: 'fixed', top: '0', left: '-100000px', width: '800px', border: '0', pointerEvents: 'none' };

interface Stage {
  doc: Document;
  container: HTMLElement;
  wrap: (children: ReactElement) => ReactElement;
  remove: () => void;
}

function iframeStage(theme: Theme): Stage {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.tabIndex = -1;
  Object.assign(iframe.style, offscreen, { height: '600px' });
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  const style = doc.createElement('style');
  style.textContent = `svg text, svg tspan { font-family: "${fontFamily}" !important; }`;
  doc.head.append(style);
  const container = doc.createElement('div');
  doc.body.append(container);
  const cache = createCache({ key: 'bench-iframe', container: doc.head });
  return {
    doc,
    container,
    wrap: children => (
      <CacheProvider value={cache}>
        <ThemeProvider theme={theme}>{children}</ThemeProvider>
      </CacheProvider>
    ),
    remove: () => iframe.remove(),
  };
}

function divStage(theme: Theme, contain: boolean): Stage {
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.setAttribute('inert', '');
  container.dataset.stage = '';
  Object.assign(container.style, offscreen, contain ? { height: '600px', overflow: 'hidden', contain: 'strict' } : {});
  const style = document.createElement('style');
  style.textContent = `[data-stage] svg text, [data-stage] svg tspan { font-family: "${fontFamily}" !important; }`;
  document.head.append(style);
  document.body.append(container);
  return {
    doc: document,
    container,
    wrap: children => <ThemeProvider theme={theme}>{children}</ThemeProvider>,
    remove: () => {
      container.remove();
      style.remove();
    },
  };
}

const svgStyles = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'visibility', 'display', 'color',
];

function serialize(svg: SVGSVGElement): string {
  const view = svg.ownerDocument.defaultView!;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((node, index) => {
    const copy = copies[index] as SVGElement;
    const computed = view.getComputedStyle(node);
    for (const property of svgStyles) {
      const value = computed.getPropertyValue(property);
      if (value && 'style' in copy) copy.style.setProperty(property, value);
    }
  });
  clone.querySelectorAll('script, foreignObject, .highcharts-tooltip').forEach(node => node.remove());
  const { width, height } = svg.getBoundingClientRect();
  clone.removeAttribute('xmlns');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  return new XMLSerializer().serializeToString(clone);
}

function sizedSvg(slot: HTMLElement | null): SVGSVGElement | null {
  // The chart's own SVG: MUI X also renders small SVGs for its legend, so take the largest.
  let best: SVGSVGElement | null = null;
  let area = 0;
  for (const svg of slot?.querySelectorAll('svg') ?? []) {
    const box = svg.getBoundingClientRect();
    if (box.width * box.height > area) {
      best = svg;
      area = box.width * box.height;
    }
  }
  return best;
}

async function waitForSvgs(slots: (HTMLElement | null)[], timeoutMs = 30000): Promise<SVGSVGElement[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const svgs = slots.map(sizedSvg);
    if (svgs.every(Boolean)) return svgs as SVGSVGElement[];
    if (performance.now() > deadline) throw new Error('Charts did not draw in time');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export async function drawOffscreen(mode: StageMode, charts: ReactElement[], theme: Theme): Promise<StageTiming> {
  const stage = mode === 'iframe' ? iframeStage(theme) : divStage(theme, mode === 'div-contain');
  const root = createRoot(stage.container);
  const slots: (HTMLDivElement | null)[] = [];
  try {
    const start = performance.now();
    flushSync(() =>
      root.render(
        stage.wrap(
          <>
            {charts.map((chart, index) => (
              <div key={index} ref={slot => { slots[index] = slot; }}>
                {chart}
              </div>
            ))}
          </>,
        ),
      ),
    );
    const drawn = performance.now();
    const svgs = await waitForSvgs(slots);
    const waited = performance.now();
    const markup = svgs.map(serialize);
    const done = performance.now();
    return {
      mode,
      charts: charts.length,
      drawMs: drawn - start,
      waitMs: waited - drawn,
      serializeMs: done - waited,
      totalMs: done - start,
      bytes: markup.reduce((sum, text) => sum + text.length, 0),
    };
  } finally {
    root.unmount();
    stage.remove();
  }
}
