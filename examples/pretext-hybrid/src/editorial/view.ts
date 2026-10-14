/**
 * Imperative DOM renderer for the live editorial stage. Like the original demo
 * it keeps pools of absolutely positioned elements and only touches the ones
 * whose content changed. It is also the source of truth for baselines: the
 * PDF capture asks this view where the browser puts each baseline.
 */
import type { EditorialLayout, PositionedLine } from './engine.ts';

type Rgb = readonly [number, number, number];

export function orbBackground([r, g, b]: Rgb): string {
  return `radial-gradient(circle at 35% 35%, rgba(${r},${g},${b},0.35), rgba(${r},${g},${b},0.12) 55%, transparent 72%)`;
}

export function orbShadow([r, g, b]: Rgb): string {
  return `0 0 60px 15px rgba(${r},${g},${b},0.18), 0 0 120px 40px rgba(${r},${g},${b},0.07)`;
}

interface PooledLine {
  readonly element: HTMLSpanElement;
  key: string;
}

export class EditorialView {
  private readonly body: PooledLine[] = [];
  private readonly headline: PooledLine[] = [];
  private readonly quotes: PooledLine[] = [];
  private readonly boxes: HTMLDivElement[] = [];
  private readonly orbs: HTMLDivElement[] = [];
  private readonly dropCap: HTMLDivElement;
  private dropCapKey = '';
  private readonly baselines = new Map<string, number>();

  constructor(private readonly stage: HTMLElement) {
    this.dropCap = document.createElement('div');
    this.dropCap.className = 'ed-dropcap';
    stage.appendChild(this.dropCap);
  }

  /**
   * Distance from the top of a line box to its baseline, measured from a probe
   * element styled exactly like the real lines (a zero-size inline-block sits
   * on the baseline). Cached per font/line-height/letter-spacing.
   */
  baseline(font: string, lineHeight: number, letterSpacing = 0): number {
    const key = `${font}|${lineHeight}|${letterSpacing}`;
    const cached = this.baselines.get(key);
    if (cached !== undefined) return cached;
    const span = document.createElement('span');
    span.className = 'ed-line';
    span.style.visibility = 'hidden';
    span.style.font = font;
    span.style.letterSpacing = `${letterSpacing}px`;
    span.style.lineHeight = `${lineHeight}px`;
    span.innerHTML = 'H<i class="ed-probe"></i>';
    this.stage.appendChild(span);
    const probe = span.querySelector('.ed-probe') as HTMLElement;
    const value = probe.getBoundingClientRect().bottom - span.getBoundingClientRect().top;
    span.remove();
    // getBoundingClientRect is in screen px; undo any CSS scale on the stage.
    const scale = this.stage.getBoundingClientRect().width / this.stage.offsetWidth;
    const result = value / (scale || 1);
    this.baselines.set(key, result);
    return result;
  }

  private sync<T extends HTMLElement>(pool: T[], count: number, create: () => T): void {
    while (pool.length < count) {
      const element = create();
      this.stage.appendChild(element);
      pool.push(element);
    }
    pool.forEach((element, index) => {
      element.style.display = index < count ? '' : 'none';
    });
  }

  private syncLines(
    pool: PooledLine[],
    lines: readonly PositionedLine[],
    className: string,
    font: string,
    lineHeight: number,
    letterSpacing: number,
  ): void {
    while (pool.length < lines.length) {
      const element = document.createElement('span');
      element.className = className;
      this.stage.appendChild(element);
      pool.push({ element, key: '' });
    }
    pool.forEach((entry, index) => {
      const line = lines[index];
      if (line === undefined) {
        entry.element.style.display = 'none';
        return;
      }
      const key = `${line.text}|${line.x}|${line.y}|${font}|${lineHeight}`;
      entry.element.style.display = '';
      if (entry.key === key) return;
      entry.key = key;
      entry.element.textContent = line.text;
      entry.element.style.left = `${line.x}px`;
      entry.element.style.top = `${line.y}px`;
      entry.element.style.font = font;
      entry.element.style.letterSpacing = `${letterSpacing}px`;
      entry.element.style.lineHeight = `${lineHeight}px`;
    });
  }

  render(layout: EditorialLayout): void {
    this.syncLines(this.headline, layout.headline.lines, 'ed-line ed-headline', layout.headline.font, layout.headline.lineHeight, layout.headline.letterSpacing);
    this.syncLines(this.body, layout.body.lines, 'ed-line ed-body', layout.body.font, layout.body.lineHeight, 0);
    this.syncLines(this.quotes, layout.pullquotes.lines, 'ed-line ed-quote', layout.pullquotes.font, layout.pullquotes.lineHeight, 0);

    const drop = layout.dropCap;
    const dropKey = `${drop.text}|${drop.font}|${drop.x}|${drop.y}`;
    if (dropKey !== this.dropCapKey) {
      this.dropCapKey = dropKey;
      this.dropCap.textContent = drop.text;
      this.dropCap.style.font = drop.font;
      this.dropCap.style.letterSpacing = '0px';
      this.dropCap.style.lineHeight = `${drop.fontSize}px`;
      this.dropCap.style.left = `${drop.x}px`;
      this.dropCap.style.top = `${drop.y}px`;
    }

    this.sync(this.boxes, layout.pullquotes.boxes.length, () => {
      const element = document.createElement('div');
      element.className = 'ed-quote-box';
      return element;
    });
    layout.pullquotes.boxes.forEach((box, index) => {
      const element = this.boxes[index]!;
      element.style.left = `${box.x}px`;
      element.style.top = `${box.y}px`;
      element.style.width = `${box.w}px`;
      element.style.height = `${box.h}px`;
    });

    this.sync(this.orbs, layout.orbs.length, () => {
      const element = document.createElement('div');
      element.className = 'ed-orb';
      return element;
    });
    layout.orbs.forEach((orb, index) => {
      const element = this.orbs[index]!;
      element.style.background = orbBackground(orb.color);
      element.style.boxShadow = orbShadow(orb.color);
      element.style.left = `${orb.cx - orb.r}px`;
      element.style.top = `${orb.cy - orb.r}px`;
      element.style.width = `${orb.r * 2}px`;
      element.style.height = `${orb.r * 2}px`;
      element.style.opacity = orb.paused ? '0.45' : '1';
    });
  }
}
