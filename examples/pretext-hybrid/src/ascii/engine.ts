/**
 * Variable typographic ASCII engine.
 *
 * Ported from pretext's MIT-licensed demo `pages/demos/variable-typographic-ascii.ts`
 * (https://github.com/chenglou/pretext). The particle simulation, brightness field
 * and palette search follow the original; the differences are deliberate:
 *
 * - the font is the registered Libertinus Serif FontFace (weights 400 and 700,
 *   normal style) instead of Georgia at three weights plus italics, so the
 *   measurements match the font bytes that Typst receives;
 * - nothing here touches the DOM except offscreen canvases: the live PDF
 *   pipeline and static captures consume the same `Frame` data.
 */
import { prepareWithSegments } from '@chenglou/pretext';

export const COLS = 50;
export const ROWS = 28;
export const FONT_SIZE = 14;
export const LINE_HEIGHT = 16;
export const TARGET_ROW_W = 440;
export const CELL_WIDTH = TARGET_ROW_W / COLS;
export const ART_PADDING = 14;
export const STAGE_W = TARGET_ROW_W + ART_PADDING * 2;
export const STAGE_H = ROWS * LINE_HEIGHT + ART_PADDING * 2;
export const WEIGHTS = [400, 700] as const;
export const CHARSET = ' .,:;!+-=*#@%&abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const FIELD_OVERSAMPLE = 2;
const FIELD_COLS = COLS * FIELD_OVERSAMPLE;
const FIELD_ROWS = ROWS * FIELD_OVERSAMPLE;
export const CANVAS_W = 220;
export const CANVAS_H = Math.round(CANVAS_W * ((ROWS * LINE_HEIGHT) / TARGET_ROW_W));
const FIELD_SCALE_X = FIELD_COLS / CANVAS_W;
const FIELD_SCALE_Y = FIELD_ROWS / CANVAS_H;
const PARTICLE_N = 120;
const SPRITE_R = 14;
const ATTRACTOR_R = 12;
const LARGE_ATTRACTOR_R = 30;
const ATTRACTOR_FORCE_1 = 0.22;
const ATTRACTOR_FORCE_2 = 0.05;
const FIELD_DECAY = 0.82;

export type Weight = (typeof WEIGHTS)[number];

export interface PaletteEntry {
  readonly char: string;
  readonly weight: Weight;
  readonly font: string;
  /** Advance width in px, measured by pretext through canvas. */
  readonly width: number;
  /** 0..1 after normalization. */
  readonly brightness: number;
}

/** A filled grid cell: which glyph, and which of the ten alpha steps (1..10). */
export interface GlyphCell {
  readonly entry: PaletteEntry;
  readonly alphaIndex: number;
}

/** A grid cell below the brightness threshold leaves its full grid slot empty. */
export type Cell = GlyphCell | null;

export interface Frame {
  readonly rows: readonly (readonly Cell[])[];
  /** Time spent producing this grid (simulation, brightness field, glyph lookup), in ms. */
  readonly layoutMs: number;
}

/** Map the full artwork rectangle to the uniformly sampled source field. */
export function pointerToSource(
  position: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, (position.x - ART_PADDING) / TARGET_ROW_W)) * CANVAS_W,
    y: Math.max(0, Math.min(1, (position.y - ART_PADDING) / (ROWS * LINE_HEIGHT))) * CANVAS_H,
  };
}

export interface PaletteInfo {
  readonly entries: number;
  readonly distinctGlyphs: number;
}

export interface AsciiEngine {
  /** Live particle field used as the ASCII reference thumbnail. */
  readonly sourceCanvas: HTMLCanvasElement;
  readonly paletteInfo: PaletteInfo;
  /** Pointer position in stage px (or `null`): acts as an extra particle attractor. */
  setPointer(position: { x: number; y: number } | null): void;
  /** Advances the simulation one step and returns the new grid. */
  step(now: number): Frame;
}

interface FieldStamp {
  readonly radiusX: number;
  readonly radiusY: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly values: Float32Array;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function fontString(weight: number, family: string): string {
  return `${weight} ${FONT_SIZE}px "${family}"`;
}

function requireContext(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', options);
  if (context === null) throw new Error('2D canvas context is not available');
  return context;
}

function spriteAlphaAt(normalizedDistance: number): number {
  if (normalizedDistance >= 1) return 0;
  if (normalizedDistance <= 0.35) return 0.45 + (0.15 - 0.45) * (normalizedDistance / 0.35);
  return 0.15 * (1 - (normalizedDistance - 0.35) / 0.65);
}

function createFieldStamp(radiusPx: number): FieldStamp {
  const fieldRadiusX = radiusPx * FIELD_SCALE_X;
  const fieldRadiusY = radiusPx * FIELD_SCALE_Y;
  const radiusX = Math.ceil(fieldRadiusX);
  const radiusY = Math.ceil(fieldRadiusY);
  const sizeX = radiusX * 2 + 1;
  const sizeY = radiusY * 2 + 1;
  const values = new Float32Array(sizeX * sizeY);
  for (let y = -radiusY; y <= radiusY; y++) {
    for (let x = -radiusX; x <= radiusX; x++) {
      const normalizedDistance = Math.sqrt((x / fieldRadiusX) ** 2 + (y / fieldRadiusY) ** 2);
      values[(y + radiusY) * sizeX + x + radiusX] = spriteAlphaAt(normalizedDistance);
    }
  }
  return { radiusX, radiusY, sizeX, sizeY, values };
}

/**
 * Builds the glyph palette. Call only after the Libertinus FontFaces are
 * registered and loaded: both pretext widths and canvas brightness depend on it.
 */
export function createAsciiEngine(family: string): AsciiEngine {
  const brightnessCanvas = document.createElement('canvas');
  brightnessCanvas.width = 28;
  brightnessCanvas.height = 28;
  const bCtx = requireContext(brightnessCanvas, { willReadFrequently: true });

  const estimateBrightness = (ch: string, font: string): number => {
    const size = 28;
    bCtx.clearRect(0, 0, size, size);
    bCtx.font = font;
    bCtx.fillStyle = '#fff';
    bCtx.textBaseline = 'middle';
    bCtx.fillText(ch, 1, size / 2);
    const data = bCtx.getImageData(0, 0, size, size).data;
    let sum = 0;
    for (let index = 3; index < data.length; index += 4) sum += data[index]!;
    return sum / (255 * size * size);
  };

  const measureWidth = (ch: string, font: string): number => {
    const prepared = prepareWithSegments(ch, font);
    return prepared.widths.length > 0 ? prepared.widths[0]! : 0;
  };

  const unsorted: PaletteEntry[] = [];
  for (const weight of WEIGHTS) {
    const font = fontString(weight, family);
    for (const ch of CHARSET) {
      if (ch === ' ') continue;
      const width = measureWidth(ch, font);
      if (width <= 0) continue;
      unsorted.push({ char: ch, weight, font, width, brightness: estimateBrightness(ch, font) });
    }
  }
  const maxBrightness = Math.max(...unsorted.map(entry => entry.brightness));
  const palette: PaletteEntry[] = unsorted
    .map(entry => ({ ...entry, brightness: maxBrightness > 0 ? entry.brightness / maxBrightness : 0 }))
    .sort((a, b) => a.brightness - b.brightness);

  const findBest = (targetBrightness: number): PaletteEntry => {
    let lo = 0;
    let hi = palette.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (palette[mid]!.brightness < targetBrightness) lo = mid + 1;
      else hi = mid;
    }
    let bestScore = Infinity;
    let best = palette[lo]!;
    const start = Math.max(0, lo - 15);
    const end = Math.min(palette.length, lo + 15);
    for (let index = start; index < end; index++) {
      const entry = palette[index]!;
      const brightnessError = Math.abs(entry.brightness - targetBrightness) * 2.5;
      const widthError = Math.abs(entry.width - CELL_WIDTH) / CELL_WIDTH;
      const score = brightnessError + widthError;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  };

  const brightnessLookup: Cell[] = [];
  for (let brightnessByte = 0; brightnessByte < 256; brightnessByte++) {
    const brightness = brightnessByte / 255;
    if (brightness < 0.03) {
      brightnessLookup.push(null);
      continue;
    }
    const entry = findBest(brightness);
    const alphaIndex = Math.max(1, Math.min(10, Math.round(brightness * 10)));
    brightnessLookup.push({ entry, alphaIndex });
  }

  // --- particle simulation, unchanged from the original ---
  const particles: Particle[] = [];
  for (let index = 0; index < PARTICLE_N; index++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 40 + 20;
    particles.push({
      x: CANVAS_W / 2 + Math.cos(angle) * radius,
      y: CANVAS_H / 2 + Math.sin(angle) * radius,
      vx: (Math.random() - 0.5) * 0.8,
      vy: (Math.random() - 0.5) * 0.8,
    });
  }

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = CANVAS_W;
  sourceCanvas.height = CANVAS_H;
  const sCtx = requireContext(sourceCanvas, { willReadFrequently: true });
  const brightnessField = new Float32Array(FIELD_COLS * FIELD_ROWS);

  const spriteCache = new Map<number, HTMLCanvasElement>();
  const getSpriteCanvas = (radius: number): HTMLCanvasElement => {
    const cached = spriteCache.get(radius);
    if (cached !== undefined) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = radius * 2;
    canvas.height = radius * 2;
    const context = requireContext(canvas);
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.15)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, radius * 2, radius * 2);
    spriteCache.set(radius, canvas);
    return canvas;
  };

  const splatFieldStamp = (centerX: number, centerY: number, stamp: FieldStamp): void => {
    const gridCenterX = Math.round(centerX * FIELD_SCALE_X);
    const gridCenterY = Math.round(centerY * FIELD_SCALE_Y);
    for (let y = -stamp.radiusY; y <= stamp.radiusY; y++) {
      const gridY = gridCenterY + y;
      if (gridY < 0 || gridY >= FIELD_ROWS) continue;
      const fieldRowOffset = gridY * FIELD_COLS;
      const stampRowOffset = (y + stamp.radiusY) * stamp.sizeX;
      for (let x = -stamp.radiusX; x <= stamp.radiusX; x++) {
        const gridX = gridCenterX + x;
        if (gridX < 0 || gridX >= FIELD_COLS) continue;
        const stampValue = stamp.values[stampRowOffset + x + stamp.radiusX]!;
        if (stampValue === 0) continue;
        const fieldIndex = fieldRowOffset + gridX;
        brightnessField[fieldIndex] = Math.min(1, brightnessField[fieldIndex]! + stampValue);
      }
    }
  };

  const particleFieldStamp = createFieldStamp(SPRITE_R);
  const largeAttractorFieldStamp = createFieldStamp(LARGE_ATTRACTOR_R);
  const smallAttractorFieldStamp = createFieldStamp(ATTRACTOR_R);

  let pointer: { x: number; y: number } | null = null;
  const POINTER_FORCE = 0.3;

  const step = (now: number): Frame => {
    const startedAt = performance.now();
    const attractor1X = Math.cos(now * 0.0007) * CANVAS_W * 0.25 + CANVAS_W / 2;
    const attractor1Y = Math.sin(now * 0.0011) * CANVAS_H * 0.3 + CANVAS_H / 2;
    const attractor2X = Math.cos(now * 0.0013 + Math.PI) * CANVAS_W * 0.2 + CANVAS_W / 2;
    const attractor2Y = Math.sin(now * 0.0009 + Math.PI) * CANVAS_H * 0.25 + CANVAS_H / 2;

    // Empty and filled cells occupy the same fixed grid in the PDF and source.
    const sourcePointer = pointer === null ? undefined : pointerToSource(pointer);
    const pointerX = sourcePointer?.x ?? NaN;
    const pointerY = sourcePointer?.y ?? NaN;

    for (const particle of particles) {
      const d1x = attractor1X - particle.x;
      const d1y = attractor1Y - particle.y;
      const d2x = attractor2X - particle.x;
      const d2y = attractor2Y - particle.y;
      const dist1 = d1x * d1x + d1y * d1y;
      const dist2 = d2x * d2x + d2y * d2y;
      let ax = dist1 < dist2 ? d1x : d2x;
      let ay = dist1 < dist2 ? d1y : d2y;
      let nearest = Math.min(dist1, dist2);
      let force = dist1 < dist2 ? ATTRACTOR_FORCE_1 : ATTRACTOR_FORCE_2;
      if (pointer !== null) {
        const dpx = pointerX - particle.x;
        const dpy = pointerY - particle.y;
        const distP = dpx * dpx + dpy * dpy;
        if (distP < nearest * 2.5) {
          ax = dpx;
          ay = dpy;
          nearest = distP;
          force = POINTER_FORCE;
        }
      }
      const dist = Math.sqrt(nearest) + 1;
      particle.vx += ax / dist * force;
      particle.vy += ay / dist * force;
      particle.vx += (Math.random() - 0.5) * 0.25;
      particle.vy += (Math.random() - 0.5) * 0.25;
      particle.vx *= 0.97;
      particle.vy *= 0.97;
      particle.x += particle.vx;
      particle.y += particle.vy;

      if (particle.x < -SPRITE_R) particle.x += CANVAS_W + SPRITE_R * 2;
      if (particle.x > CANVAS_W + SPRITE_R) particle.x -= CANVAS_W + SPRITE_R * 2;
      if (particle.y < -SPRITE_R) particle.y += CANVAS_H + SPRITE_R * 2;
      if (particle.y > CANVAS_H + SPRITE_R) particle.y -= CANVAS_H + SPRITE_R * 2;
    }

    sCtx.fillStyle = 'rgba(0,0,0,0.18)';
    sCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    sCtx.globalCompositeOperation = 'lighter';
    const particleSprite = getSpriteCanvas(SPRITE_R);
    for (const particle of particles) {
      sCtx.drawImage(particleSprite, particle.x - SPRITE_R, particle.y - SPRITE_R);
    }
    sCtx.drawImage(getSpriteCanvas(LARGE_ATTRACTOR_R), attractor1X - LARGE_ATTRACTOR_R, attractor1Y - LARGE_ATTRACTOR_R);
    sCtx.drawImage(getSpriteCanvas(ATTRACTOR_R), attractor2X - ATTRACTOR_R, attractor2Y - ATTRACTOR_R);
    if (pointer !== null) sCtx.drawImage(getSpriteCanvas(ATTRACTOR_R), pointerX - ATTRACTOR_R, pointerY - ATTRACTOR_R);
    sCtx.globalCompositeOperation = 'source-over';

    for (let index = 0; index < brightnessField.length; index++) {
      brightnessField[index] = brightnessField[index]! * FIELD_DECAY;
    }
    for (const particle of particles) splatFieldStamp(particle.x, particle.y, particleFieldStamp);
    splatFieldStamp(attractor1X, attractor1Y, largeAttractorFieldStamp);
    splatFieldStamp(attractor2X, attractor2Y, smallAttractorFieldStamp);
    if (pointer !== null) splatFieldStamp(pointerX, pointerY, smallAttractorFieldStamp);

    const rows: Cell[][] = [];
    for (let row = 0; row < ROWS; row++) {
      const cells: Cell[] = [];
      const fieldRowStart = row * FIELD_OVERSAMPLE * FIELD_COLS;
      for (let col = 0; col < COLS; col++) {
        const fieldColStart = col * FIELD_OVERSAMPLE;
        let brightness = 0;
        for (let sampleY = 0; sampleY < FIELD_OVERSAMPLE; sampleY++) {
          const sampleRowOffset = fieldRowStart + sampleY * FIELD_COLS + fieldColStart;
          for (let sampleX = 0; sampleX < FIELD_OVERSAMPLE; sampleX++) {
            brightness += brightnessField[sampleRowOffset + sampleX]!;
          }
        }
        const brightnessByte = Math.min(255, ((brightness / (FIELD_OVERSAMPLE * FIELD_OVERSAMPLE)) * 255) | 0);
        cells.push(brightnessLookup[brightnessByte]!);
      }
      rows.push(cells);
    }
    return { rows, layoutMs: performance.now() - startedAt };
  };

  return {
    sourceCanvas,
    paletteInfo: {
      entries: palette.length,
      distinctGlyphs: new Set(palette.map(entry => entry.char)).size,
    },
    setPointer(position) {
      pointer = position;
    },
    step,
  };
}
