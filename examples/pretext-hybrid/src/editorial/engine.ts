/**
 * Editorial engine: the pure layout and simulation half of the demo.
 *
 * Ported from pretext's MIT-licensed `pages/demos/editorial-engine.ts`
 * (https://github.com/chenglou/pretext). `carveTextLineSlots`,
 * `circleIntervalForBand`, `layoutColumn`, `fitHeadline`, the orb physics and
 * the page geometry follow the original. Differences are deliberate:
 *
 * - the stage has a fixed logical size instead of the viewport, so the same
 *   numbers can size a PDF page (1 px = 1 pt);
 * - the font is the registered Libertinus Serif family (Regular, Bold, Italic);
 * - the narrow-viewport mode and text-selection handling are left out;
 * - nothing here touches the DOM: `layout()` returns plain data that both the
 *   live renderer and the Typst JSON capture consume.
 */
import {
  layoutNextLine,
  layoutWithLines,
  prepareWithSegments,
  walkLineRanges,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '@chenglou/pretext';
import { BODY_TEXT, PULLQUOTE_TEXTS } from './text.ts';

export const BODY_FONT_SIZE = 19;
export const BODY_LINE_HEIGHT = 30;
export const HEADLINE_TEXT = 'THE FUTURE OF TEXT LAYOUT IS NOT CSS';
export const HEADLINE_LETTER_SPACING = -0.5;
export const PQ_FONT_SIZE = 20;
export const PQ_LINE_HEIGHT = 27;
export const DROP_CAP_LINES = 3;
const GUTTER = 48;
const COL_GAP = 40;
const BOTTOM_GAP = 20;
const MIN_SLOT_WIDTH = 50;

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export const STAGE_PRESETS = {
  wide: { label: 'Wide · 3 columns', width: 1200, height: 760 },
  compact: { label: 'Compact · 2 columns', width: 860, height: 760 },
} as const;
export type StagePresetId = keyof typeof STAGE_PRESETS;

export interface Interval {
  left: number;
  right: number;
}

export interface PositionedLine {
  x: number;
  y: number;
  width: number;
  text: string;
}

interface CircleObstacle {
  cx: number;
  cy: number;
  r: number;
  hPad: number;
  vPad: number;
}

interface RectObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

type OrbColor = readonly [number, number, number];

interface OrbDefinition {
  readonly fx: number;
  readonly fy: number;
  readonly r: number;
  readonly vx: number;
  readonly vy: number;
  readonly color: OrbColor;
}

export interface Orb {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  paused: boolean;
  readonly color: OrbColor;
}

const ORB_DEFINITIONS: readonly OrbDefinition[] = [
  { fx: 0.52, fy: 0.22, r: 110, vx: 24, vy: 16, color: [196, 163, 90] },
  { fx: 0.18, fy: 0.48, r: 85, vx: -19, vy: 26, color: [100, 140, 255] },
  { fx: 0.74, fy: 0.58, r: 95, vx: 16, vy: -21, color: [232, 100, 130] },
  { fx: 0.38, fy: 0.72, r: 75, vx: -26, vy: -14, color: [80, 200, 140] },
  { fx: 0.86, fy: 0.18, r: 65, vx: -13, vy: 19, color: [150, 100, 220] },
];

export interface PullquoteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything one frame needs, as plain data. All y values are line-box tops. */
export interface EditorialLayout {
  readonly stage: StageSize;
  readonly columnCount: number;
  readonly headline: {
    readonly font: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly letterSpacing: number;
    readonly lines: readonly PositionedLine[];
  };
  readonly body: {
    readonly font: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly lines: readonly PositionedLine[];
  };
  readonly dropCap: {
    readonly text: string;
    readonly font: string;
    readonly fontSize: number;
    readonly x: number;
    readonly y: number;
  };
  readonly pullquotes: {
    readonly font: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly boxes: readonly PullquoteBox[];
    readonly lines: readonly PositionedLine[];
  };
  readonly orbs: readonly {
    readonly cx: number;
    readonly cy: number;
    readonly r: number;
    readonly color: OrbColor;
    readonly paused: boolean;
  }[];
}

export function carveTextLineSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots = [base];
  for (const interval of blocked) {
    const next: Interval[] = [];
    for (const slot of slots) {
      if (interval.right <= slot.left || interval.left >= slot.right) {
        next.push(slot);
        continue;
      }
      if (interval.left > slot.left) next.push({ left: slot.left, right: interval.left });
      if (interval.right < slot.right) next.push({ left: interval.right, right: slot.right });
    }
    slots = next;
  }
  return slots.filter(slot => slot.right - slot.left >= MIN_SLOT_WIDTH);
}

export function circleIntervalForBand(
  cx: number,
  cy: number,
  r: number,
  bandTop: number,
  bandBottom: number,
  hPad: number,
  vPad: number,
): Interval | null {
  const top = bandTop - vPad;
  const bottom = bandBottom + vPad;
  if (top >= cy + r || bottom <= cy - r) return null;
  const minDy = cy >= top && cy <= bottom ? 0 : cy < top ? top - cy : cy - bottom;
  if (minDy >= r) return null;
  const maxDx = Math.sqrt(r * r - minDy * minDy);
  return { left: cx - maxDx - hPad, right: cx + maxDx + hPad };
}

export function layoutColumn(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  lineHeight: number,
  circleObstacles: readonly CircleObstacle[],
  rectObstacles: readonly RectObstacle[],
): { lines: PositionedLine[]; cursor: LayoutCursor } {
  let cursor = startCursor;
  let lineTop = regionY;
  const lines: PositionedLine[] = [];
  let textExhausted = false;

  while (lineTop + lineHeight <= regionY + regionH && !textExhausted) {
    const bandTop = lineTop;
    const bandBottom = lineTop + lineHeight;
    const blocked: Interval[] = [];

    for (const obstacle of circleObstacles) {
      const interval = circleIntervalForBand(
        obstacle.cx, obstacle.cy, obstacle.r, bandTop, bandBottom, obstacle.hPad, obstacle.vPad,
      );
      if (interval !== null) blocked.push(interval);
    }
    for (const rect of rectObstacles) {
      if (bandBottom <= rect.y || bandTop >= rect.y + rect.h) continue;
      blocked.push({ left: rect.x, right: rect.x + rect.w });
    }

    const slots = carveTextLineSlots({ left: regionX, right: regionX + regionW }, blocked);
    if (slots.length === 0) {
      lineTop += lineHeight;
      continue;
    }

    // Fill every viable slot left to right: text flows on both sides of an orb.
    for (const slot of [...slots].sort((a, b) => a.left - b.left)) {
      const line = layoutNextLine(prepared, cursor, slot.right - slot.left);
      if (line === null) {
        textExhausted = true;
        break;
      }
      lines.push({ x: Math.round(slot.left), y: Math.round(lineTop), text: line.text, width: line.width });
      cursor = line.end;
    }
    lineTop += lineHeight;
  }
  return { lines, cursor };
}

export interface EditorialEngine {
  readonly stage: StageSize;
  readonly orbs: readonly Orb[];
  /** Advances the orb simulation to timestamp `now` (ms). */
  step(now: number): void;
  /** Starts a drag when the pointer (stage coordinates) hits an orb. */
  pointerDown(x: number, y: number): boolean;
  pointerMove(x: number, y: number): void;
  /** Ends a drag; a click without movement toggles the orb's pause. */
  pointerUp(x: number, y: number): void;
  hoveredOrb(x: number, y: number): boolean;
  layout(): EditorialLayout;
}

interface DragState {
  orbIndex: number;
  startPointerX: number;
  startPointerY: number;
  startOrbX: number;
  startOrbY: number;
}

/**
 * Prepares the texts and returns the engine. Call only after the Libertinus
 * FontFaces (Regular, Bold, Italic) are registered: preparation measures them.
 */
export function createEditorialEngine(family: string, stage: StageSize): EditorialEngine {
  const quoted = `"${family}"`;
  const bodyFont = `${BODY_FONT_SIZE}px ${quoted}`;
  const pullquoteFont = `italic ${PQ_FONT_SIZE}px ${quoted}`;
  const preparedBody = prepareWithSegments(BODY_TEXT, bodyFont);
  const preparedPullquotes = PULLQUOTE_TEXTS.map(text => prepareWithSegments(text, pullquoteFont));
  const pullquoteSpecs = [
    { prepared: preparedPullquotes[0]!, colIdx: 0, yFrac: 0.48, wFrac: 0.52, side: 'right' as const },
    { prepared: preparedPullquotes[1]!, colIdx: 1, yFrac: 0.32, wFrac: 0.5, side: 'left' as const },
  ];

  const dropCapSize = BODY_LINE_HEIGHT * DROP_CAP_LINES - 4;
  const dropCapFont = `700 ${dropCapSize}px ${quoted}`;
  const dropCapText = BODY_TEXT[0]!;
  const preparedDropCap = prepareWithSegments(dropCapText, dropCapFont);
  let dropCapWidth = 0;
  walkLineRanges(preparedDropCap, 9999, line => {
    dropCapWidth = line.width;
  });
  const dropCapTotalW = Math.ceil(dropCapWidth) + 10;

  const orbs: Orb[] = ORB_DEFINITIONS.map(definition => ({
    x: definition.fx * stage.width,
    y: definition.fy * stage.height,
    r: definition.r,
    vx: definition.vx,
    vy: definition.vy,
    paused: false,
    color: definition.color,
  }));

  let drag: DragState | null = null;
  let lastFrameTime: number | null = null;

  // --- headline: binary search for the largest size that breaks no word ---
  let headlineCache: { width: number; height: number; maxSize: number; size: number; lines: PositionedLine[] } | undefined;
  const fitHeadline = (maxWidth: number, maxHeight: number, maxSize: number) => {
    if (
      headlineCache !== undefined &&
      headlineCache.width === maxWidth &&
      headlineCache.height === maxHeight &&
      headlineCache.maxSize === maxSize
    ) {
      return { fontSize: headlineCache.size, lines: headlineCache.lines };
    }
    let lo = 20;
    let hi = maxSize;
    let best = lo;
    let bestLines: PositionedLine[] = [];
    while (lo <= hi) {
      const size = Math.floor((lo + hi) / 2);
      const font = `700 ${size}px ${quoted}`;
      const lineHeight = Math.round(size * 0.93);
      const prepared = prepareWithSegments(HEADLINE_TEXT, font, { letterSpacing: HEADLINE_LETTER_SPACING });
      let breaksWord = false;
      let lineCount = 0;
      walkLineRanges(prepared, maxWidth, line => {
        lineCount++;
        if (line.end.graphemeIndex !== 0) breaksWord = true;
      });
      if (!breaksWord && lineCount * lineHeight <= maxHeight) {
        best = size;
        bestLines = layoutWithLines(prepared, maxWidth, lineHeight).lines.map((line, index) => ({
          x: 0,
          y: index * lineHeight,
          text: line.text,
          width: line.width,
        }));
        lo = size + 1;
      } else {
        hi = size - 1;
      }
    }
    headlineCache = { width: maxWidth, height: maxHeight, maxSize, size: best, lines: bestLines };
    return { fontSize: best, lines: bestLines };
  };

  const hitTest = (px: number, py: number): number => {
    for (let index = orbs.length - 1; index >= 0; index--) {
      const orb = orbs[index]!;
      const dx = px - orb.x;
      const dy = py - orb.y;
      if (dx * dx + dy * dy <= orb.r * orb.r) return index;
    }
    return -1;
  };

  const step = (now: number): void => {
    const last = lastFrameTime ?? now;
    const dt = Math.min((now - last) / 1000, 0.05);
    lastFrameTime = now;
    const draggedIndex = drag?.orbIndex ?? -1;

    for (let index = 0; index < orbs.length; index++) {
      const orb = orbs[index]!;
      if (orb.paused || index === draggedIndex) continue;
      orb.x += orb.vx * dt;
      orb.y += orb.vy * dt;
      if (orb.x - orb.r < 0) {
        orb.x = orb.r;
        orb.vx = Math.abs(orb.vx);
      }
      if (orb.x + orb.r > stage.width) {
        orb.x = stage.width - orb.r;
        orb.vx = -Math.abs(orb.vx);
      }
      if (orb.y - orb.r < GUTTER * 0.5) {
        orb.y = orb.r + GUTTER * 0.5;
        orb.vy = Math.abs(orb.vy);
      }
      if (orb.y + orb.r > stage.height - BOTTOM_GAP) {
        orb.y = stage.height - BOTTOM_GAP - orb.r;
        orb.vy = -Math.abs(orb.vy);
      }
    }

    for (let index = 0; index < orbs.length; index++) {
      const a = orbs[index]!;
      for (let otherIndex = index + 1; otherIndex < orbs.length; otherIndex++) {
        const b = orbs[otherIndex]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r + 20;
        if (dist >= minDist || dist <= 0.1) continue;
        const force = (minDist - dist) * 0.8;
        const nx = dx / dist;
        const ny = dy / dist;
        if (!a.paused && index !== draggedIndex) {
          a.vx -= nx * force * dt;
          a.vy -= ny * force * dt;
        }
        if (!b.paused && otherIndex !== draggedIndex) {
          b.vx += nx * force * dt;
          b.vy += ny * force * dt;
        }
      }
    }
  };

  const layout = (): EditorialLayout => {
    const pageWidth = stage.width;
    const pageHeight = stage.height;
    const circleObstacles: CircleObstacle[] = orbs.map(orb => ({
      cx: orb.x, cy: orb.y, r: orb.r, hPad: 14, vPad: 4,
    }));

    const headlineWidth = Math.min(pageWidth - GUTTER * 2, 1000);
    const maxHeadlineHeight = Math.floor(pageHeight * 0.24);
    const { fontSize: headlineSize, lines: headlineLines } = fitHeadline(headlineWidth, maxHeadlineHeight, 92);
    const headlineLineHeight = Math.round(headlineSize * 0.93);
    const headlineHeight = headlineLines.length * headlineLineHeight;

    const bodyTop = GUTTER + headlineHeight + 20;
    const bodyHeight = pageHeight - bodyTop - BOTTOM_GAP;
    const columnCount = pageWidth > 1000 ? 3 : pageWidth > 640 ? 2 : 1;
    const totalGutter = GUTTER * 2 + COL_GAP * (columnCount - 1);
    const maxContentWidth = Math.min(pageWidth, 1500);
    const columnWidth = Math.floor((maxContentWidth - totalGutter) / columnCount);
    const contentLeft = Math.round((pageWidth - (columnCount * columnWidth + (columnCount - 1) * COL_GAP)) / 2);
    const dropCapRect: RectObstacle = {
      x: contentLeft - 2,
      y: bodyTop - 2,
      w: dropCapTotalW,
      h: DROP_CAP_LINES * BODY_LINE_HEIGHT + 2,
    };

    const pullquoteBoxes: (PullquoteBox & { colIdx: number })[] = [];
    const pullquoteLines: PositionedLine[] = [];
    for (const spec of pullquoteSpecs) {
      if (spec.colIdx >= columnCount) continue;
      const pullquoteWidth = Math.round(columnWidth * spec.wFrac);
      const lines = layoutWithLines(spec.prepared, pullquoteWidth - 20, PQ_LINE_HEIGHT).lines;
      const pullquoteHeight = lines.length * PQ_LINE_HEIGHT + 16;
      const columnX = contentLeft + spec.colIdx * (columnWidth + COL_GAP);
      const pullquoteX = spec.side === 'right' ? columnX + columnWidth - pullquoteWidth : columnX;
      const pullquoteY = Math.round(bodyTop + bodyHeight * spec.yFrac);
      lines.forEach((line, lineIndex) => {
        pullquoteLines.push({
          x: pullquoteX + 20,
          y: pullquoteY + 8 + lineIndex * PQ_LINE_HEIGHT,
          text: line.text,
          width: line.width,
        });
      });
      pullquoteBoxes.push({ x: pullquoteX, y: pullquoteY, w: pullquoteWidth, h: pullquoteHeight, colIdx: spec.colIdx });
    }

    const bodyLines: PositionedLine[] = [];
    // The drop cap owns the first grapheme; body text resumes right after it.
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 1 };
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const columnX = contentLeft + columnIndex * (columnWidth + COL_GAP);
      const rects: RectObstacle[] = [];
      if (columnIndex === 0) rects.push(dropCapRect);
      for (const box of pullquoteBoxes) {
        if (box.colIdx === columnIndex) rects.push({ x: box.x, y: box.y, w: box.w, h: box.h });
      }
      const result = layoutColumn(
        preparedBody, cursor, columnX, bodyTop, columnWidth, bodyHeight, BODY_LINE_HEIGHT, circleObstacles, rects,
      );
      bodyLines.push(...result.lines);
      cursor = result.cursor;
    }

    return {
      stage,
      columnCount,
      headline: {
        font: `700 ${headlineSize}px ${quoted}`,
        fontSize: headlineSize,
        lineHeight: headlineLineHeight,
        letterSpacing: HEADLINE_LETTER_SPACING,
        // Lines are offset by the gutter, as the demo's headlineLeft/headlineTop.
        lines: headlineLines.map(line => ({ ...line, x: GUTTER + line.x, y: GUTTER + line.y })),
      },
      body: { font: bodyFont, fontSize: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT, lines: bodyLines },
      dropCap: { text: dropCapText, font: dropCapFont, fontSize: dropCapSize, x: contentLeft, y: bodyTop },
      pullquotes: {
        font: pullquoteFont,
        fontSize: PQ_FONT_SIZE,
        lineHeight: PQ_LINE_HEIGHT,
        boxes: pullquoteBoxes.map(({ x, y, w, h }) => ({ x, y, w, h })),
        lines: pullquoteLines,
      },
      orbs: orbs.map(orb => ({ cx: orb.x, cy: orb.y, r: orb.r, color: orb.color, paused: orb.paused })),
    };
  };

  return {
    stage,
    orbs,
    step,
    pointerDown(x, y) {
      const orbIndex = hitTest(x, y);
      if (orbIndex === -1) return false;
      const orb = orbs[orbIndex]!;
      drag = { orbIndex, startPointerX: x, startPointerY: y, startOrbX: orb.x, startOrbY: orb.y };
      return true;
    },
    pointerMove(x, y) {
      if (drag === null) return;
      const orb = orbs[drag.orbIndex]!;
      orb.x = drag.startOrbX + (x - drag.startPointerX);
      orb.y = drag.startOrbY + (y - drag.startPointerY);
    },
    pointerUp(x, y) {
      if (drag === null) return;
      const dx = x - drag.startPointerX;
      const dy = y - drag.startPointerY;
      const orb = orbs[drag.orbIndex]!;
      if (dx * dx + dy * dy < 16) {
        orb.paused = !orb.paused;
      } else {
        orb.x = drag.startOrbX + dx;
        orb.y = drag.startOrbY + dy;
      }
      drag = null;
    },
    hoveredOrb: (x, y) => hitTest(x, y) !== -1,
    layout,
  };
}
