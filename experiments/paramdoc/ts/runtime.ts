// paramdoc runtime in TypeScript: fills an exported parametric document with data and writes a tagged PDF.
// A port of ../runtime/src/lib.rs with the same contract: no typesetter, no shaper, slots filled through the
// font's cmap and advances, flow documents composed page by page, structure tree assembled per document.
// Fonts arrive subset by the exporter with their metrics, advances and character map in the document, so no
// font file is parsed here. The font programs are compressed once per runtime with the platform's
// CompressionStream (so creation is asynchronous); the small per-document streams are written uncompressed,
// because CompressionStream costs milliseconds per call in browsers. Erasable TypeScript only, so Node can run it
// with `--experimental-strip-types` and a bundler can ship it to a browser unchanged.

export const IR_VERSION = 9;

// ---------------------------------------------------------------------------------------------------------
// IR (mirrors ../ir/src/lib.rs; serde writes `None` as null unless skipped)

export interface Color { r: number; g: number; b: number; a: number }
export interface Glyph { id: number; x_advance: number; x_offset: number; y_offset: number; chars?: string }
export type PathOp =
  | { op: 'move'; to: [number, number] } | { op: 'line'; to: [number, number] }
  | { op: 'cubic'; c1: [number, number]; c2: [number, number]; to: [number, number] } | { op: 'close' };
export type Geometry =
  | { kind: 'line'; to: [number, number] } | { kind: 'rect'; width: number; height: number } | { kind: 'path'; ops: PathOp[] };
export interface Stroke { paint: Color; thickness: number; cap: string; join: string; dash?: { array: number[]; phase: number } | null; miter_limit: number }
export type Item =
  | { kind: 'group'; x: number; y: number; transform: number[]; clip?: PathOp[] | null; items: Item[] }
  | { kind: 'text'; x: number; y: number; font: number; size: number; fill: Color; text: string; glyphs: Glyph[]; node?: number }
  | { kind: 'shape'; x: number; y: number; geometry: Geometry; fill?: Color | null; stroke?: Stroke | null; node?: number }
  /** `sha256` names an entry of the document's `image_files`, or the runtime's own key for data-supplied bytes. */
  | { kind: 'image'; x: number; y: number; width: number; height: number; format: string; sha256: string; node?: number };
export interface Node { role: string; parent: number | null; alt?: string; scope?: string }
export interface Slot {
  name: string; page: number; x: number; y: number; width: number; height: number; baseline: number; descent: number;
  pen_x: number; font: number; size: number; fill: Color; align: string; overflow: string; max_length?: number | null; lines?: number; pitch?: number; auto_lines?: number | null;
  sample: string; node?: number;
  /** Set for a link slot: where each line's clickable rectangle sits around its baseline (points above and below). */
  link?: SlotLink | null;
  /** A wrapping slot whose lines are justified: every line but the last and lines before a hard break stretch their
   *  spaces to the slot's width, as Typst does with the simple breaker (M11). */
  justify?: boolean;
}
export interface SlotLink { above: number; below: number }
/** A clickable link in the static content: Typst's rectangles for one link element (one per line), the URL, Typst's
 *  description of the destination and the Link structure node the link's text belongs to. */
export interface Link { page: number; rects: [number, number, number, number][]; url: string; alt?: string | null; node?: number }
/** A bar hole: one filled rectangle, `value / max` of the hole's width (clamped to 0..1), as tall as the hole, rounded by `radius`. */
export interface Bar { name: string; page: number; x: number; y: number; width: number; height: number; max: number; fill: Color; radius: number; node?: number; sample: number }
/** An image hole: a fixed box the data fills with a PNG or JPEG, placed as Typst's `image` with `fit` places it. */
export interface ImageSlot { name: string; page: number; x: number; y: number; width: number; height: number; fit: string; alt?: string | null; node?: number; sample: string }
/** A raster image the static content draws, shipped next to the document like a font. */
export interface ImageFile { sha256: string; file: string; format: string; width: number; height: number }
export interface Fragment { x: number; y: number; width: number; height: number; items: Item[]; slots: Slot[]; bars?: Bar[]; images?: ImageSlot[]; links?: Link[]; nodes: Node[] }
/** How a band's variant is picked for an instance: by row parity, by a `true` in the data, or by the lines a wrapping slot needs. */
export type Select = { kind: 'parity' } | { kind: 'flag'; path: string } | { kind: 'lines'; slot: string };
/** Variant k of a band is `fragments[k - 1]`; a plain band has one. */
export interface Band { name: string; repeat_on_break: boolean; fragments: Fragment[]; select?: Select | null }
export type Block =
  | { kind: 'static'; fragment: Fragment }
  | { kind: 'repeat'; band: string; header: string | null; header_gap: number; gap: number; sample_rows: number }
  | { kind: 'choice'; band: string };
export interface Flow {
  page_width: number; page_height: number; area: { x: number; y: number; width: number; height: number };
  blocks: Block[]; bands: Band[]; overlays: Fragment[];
}
export interface Page { width: number; height: number; items: Item[]; nodes: Node[] }
export interface FontRef {
  family: string; index: number; sha256: string; source_sha256: string; file: string;
  /** "cff" (a bare CFF table), "opentype-cff" or "truetype". */
  program: string;
  units_per_em: number; ascender: number; descender: number; cap_height: number; bbox: [number, number, number, number];
  italic_angle: number; italic: boolean;
  /** Advance per glyph id, in font units. */
  advances: number[];
  /** Character to glyph id, for the slot repertoire and the static text. */
  cmap: Record<string, number>;
}
export interface Document {
  version: number; title?: string | null; lang?: string | null; fonts: FontRef[]; image_files?: ImageFile[];
  pages: Page[]; slots: Slot[]; bars?: Bar[]; images?: ImageSlot[]; links?: Link[]; flow?: Flow | null;
}

// ---------------------------------------------------------------------------------------------------------
// Geometry the runtime regenerates from data, ported from typst-layout 0.15.1 (the same port as
// ../ir/src/lib.rs `geometry`), so that what it draws equals Typst's own layout. The exporter checks these ports
// against Typst on every sample it compiles.

/** A filled rectangle with a uniform corner radius and no stroke, as `styled_rect` builds it: a plain rectangle
 *  for radius 0, otherwise the fill curve of `segmented_rect` (radius capped at half the shorter side, arcs as
 *  the cubic Béziers of `bezier_arc_control`). */
export function roundedRect(width: number, height: number, radius: number): Geometry {
  if (radius === 0) return { kind: 'rect', width, height };
  const r = Math.min(radius, Math.min(Math.abs(width), Math.abs(height)) / 2);
  const sx = Object.is(width, -0) || width < 0 ? -1 : 1, sy = Object.is(height, -0) || height < 0 ? -1 : 1;
  const rotate = (corner: number, px: number, py: number): [number, number] =>
    corner === 0 ? [sx * px, sy * py] : corner === 1 ? [width - sx * py, sy * px] : corner === 2 ? [width - sx * px, height - sy * py] : [sx * py, height - sy * px];
  const ops: PathOp[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const center = rotate(corner, r, r);
    if (r > 0) {
      const start = rotate(corner, 0, r), end = rotate(corner, r, 0);
      ops.push(corner === 0 ? { op: 'move', to: start } : { op: 'line', to: start });
      const [c1, c2] = bezierArcControl(start, center, end);
      ops.push({ op: 'cubic', c1, c2, to: end });
    } else {
      ops.push(corner === 0 ? { op: 'move', to: center } : { op: 'line', to: center });
    }
  }
  ops.push({ op: 'close' });
  return { kind: 'path', ops };
}

function bezierArcControl(start: [number, number], center: [number, number], end: [number, number]): [[number, number], [number, number]] {
  const a = [start[0] - center[0], start[1] - center[1]], b = [end[0] - center[0], end[1] - center[1]];
  const q1 = a[0]! * a[0]! + a[1]! * a[1]!;
  const q2 = q1 + a[0]! * b[0]! + a[1]! * b[1]!;
  const k2 = (4 / 3) * (Math.sqrt(2 * q1 * q2) - q2) / (a[0]! * b[1]! - a[1]! * b[0]!);
  return [[center[0] + a[0]! - k2 * a[1]!, center[1] + a[1]! + k2 * a[0]!], [center[0] + b[0]! + k2 * b[1]!, center[1] + b[1]! - k2 * b[0]!]];
}

/** A geometry as absolute path operations, for comparing shapes: a rectangle becomes its four sides. */
export function opsOf(geometry: Geometry, x: number, y: number): PathOp[] {
  const shift = (p: [number, number]): [number, number] => [p[0] + x, p[1] + y];
  if (geometry.kind === 'rect') {
    return [{ op: 'move', to: [x, y] }, { op: 'line', to: [x + geometry.width, y] }, { op: 'line', to: [x + geometry.width, y + geometry.height] }, { op: 'line', to: [x, y + geometry.height] }, { op: 'close' }];
  }
  if (geometry.kind === 'line') return [{ op: 'move', to: [x, y] }, { op: 'line', to: shift(geometry.to) }];
  return geometry.ops.map(op => op.op === 'move' || op.op === 'line' ? { op: op.op, to: shift(op.to) } : op.op === 'cubic' ? { op: 'cubic', c1: shift(op.c1), c2: shift(op.c2), to: shift(op.to) } : op);
}

export function sameOps(a: PathOp[], b: PathOp[], eps: number): boolean {
  const close = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;
  return a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    if (x.op !== y.op) return false;
    if (x.op === 'close') return true;
    if (x.op === 'cubic') return y.op === 'cubic' && close(x.c1, y.c1) && close(x.c2, y.c2) && close(x.to, y.to);
    return close(x.to, (y as { to: [number, number] }).to);
  });
}

/** Where `layout_image` puts an image of `pxW` × `pxH` pixels into a box with both sides forced: `[x, y, w, h]`
 *  relative to the box. `cover` and `contain` keep the aspect ratio and centre the image; `stretch` fills the box. */
export function fitImage(fit: string, width: number, height: number, pxW: number, pxH: number): [number, number, number, number] {
  const pxRatio = pxW / pxH;
  const wide = pxRatio > width / height;
  let w: number, h: number;
  if (fit === 'cover' || fit === 'contain') { if (wide === (fit === 'contain')) { w = width; h = width / pxRatio; } else { w = height * pxRatio; h = height; } }
  else if (fit === 'stretch') { w = width; h = height; }
  else throw new Error(`unknown image fit ${JSON.stringify(fit)} (cover, contain or stretch)`);
  return [(width - w) / 2, (height - h) / 2, w, h];
}

// ---------------------------------------------------------------------------------------------------------
// Fonts: as exported, nothing is parsed from the file

export class Font {
  readonly data: Uint8Array;
  readonly meta: FontRef;
  readonly name: string;
  private readonly cmap = new Map<string, number>();
  /** Glyph id to the characters it stands for, for the ToUnicode map. */
  readonly reverseCmap = new Map<number, string>();

  constructor(meta: FontRef, data: Uint8Array) {
    if (!meta.advances?.length || !(meta.units_per_em > 0)) throw new Error(`${meta.file}: the document carries no font metrics; export it again`);
    this.meta = meta;
    this.data = data;
    this.name = 'PARAMD+' + meta.file.replace(/[^A-Za-z0-9]/g, '');
    for (const [text, gid] of Object.entries(meta.cmap)) {
      this.cmap.set(text, gid);
      if (!this.reverseCmap.has(gid)) this.reverseCmap.set(gid, text);
    }
  }

  /** Advance of a glyph in em. */
  advance(gid: number): number { return (this.meta.advances[gid] ?? 0) / this.meta.units_per_em; }
  /** Glyph for a character, or undefined when it is not in the exported repertoire. */
  glyph(c: string): number | undefined { return this.cmap.get(c); }
}

// ---------------------------------------------------------------------------------------------------------
// Slot filling

export interface ReferenceGlyph { id: number; x: number; y?: number }
/** For a text slot, its glyphs; for a bar (`<name>#bar`), the absolute path drawn (`ops`) and its box (`rect`);
 *  for an image slot (`<name>#image`), the rectangle the image was placed in (`rect`). */
export interface ReferenceSlot { name: string; baseline: number; size: number; glyphs: ReferenceGlyph[]; ops?: PathOp[]; rect?: [number, number, number, number]; rects?: [number, number, number, number][] }
/** A filled hole: the items to draw, clipped to `rect` (the hole's box), and what was drawn, for the reference check.
 *  An image slot carries the image's bytes under the key its item refers to, and its alternative text. */
interface Filled { rect: [number, number, number, number]; items: Item[]; trace: ReferenceSlot; node?: number; image?: { key: string; bytes: Uint8Array }; alt?: string; link?: LinkFill }
/** A link slot's clickable area: one rectangle per drawn line, the destination and its description. */
interface LinkFill { rects: [number, number, number, number][]; url: string; alt?: string }
/** A destination the data gives a slot: the `href` (and `alt`) of a `{ text, href, alt? }` value. */
type Href = { url: string; alt?: string } | undefined;

/** The clickable rectangles of a link slot: each drawn line's box (x, baseline, width) extended above and below the
 *  baseline as Typst extends a link's text frame. A link slot needs an `href`, a plain slot refuses one, so the runtime
 *  never renders a value Typst would have styled differently (`show link` rules). */
/** `scale` is the text's size relative to the slot's (the `shrink` policy), which the rectangle's height follows. */
function linkFill(slot: Slot, href: Href, lines: [number, number, number][], scale: number, traceName: string): LinkFill | undefined {
  const g = slot.link;
  if (!href && !g) return undefined;
  if (!href) throw new Error(`slot \`${traceName}\` is a link slot (its sample value had an \`href\`) but the data gives none`);
  if (!g) throw new Error(`slot \`${traceName}\`: the data gives an \`href\` but the slot was exported without a link; give its sample value an \`href\` too`);
  return { rects: lines.map(([x, y, w]) => [x, y - g.above * scale, w, (g.above + g.below) * scale]), url: href.url, alt: href.alt };
}

/** A soft hyphen: no glyph of its own (Typst removes default ignorables when shaping), a break opportunity after it, and
 *  the font's hyphen drawn where a line ends on one (typst-layout 0.15.1 `line.rs`: `full.ends_with(SHY)`,
 *  `ShapedText::hyphen`). The exporter maps it to the hyphen glyph in the character map when a repertoire admits it. */
const SHY = '\u00ad';
/** The middle dot is CJK centre-aligned punctuation to Typst (`shaping.rs`, `is_cjk_center_aligned_punctuation`): on an
 *  overfull line it shrinks by a quarter of its advance on each side, and it counts as justifiable. */
const isMiddleDot = (c: string): boolean => c === '\u00b7';

/** The glyph of a character in the slot's repertoire, or the refusal naming it. */
function glyphOrRefuse(font: Font, c: string, traceName: string): number {
  const id = font.glyph(c);
  if (id === undefined) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) is not in the slot's repertoire; declare it with \`charset:\` in the template`);
  return id;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  // Typst's `str()` and this formatting agree on integers, not on every float (`1e21`, `1e-7`).
  if (typeof value === 'number' && !Number.isInteger(value)) throw new Error(`${value} is not an integer; format numbers with a fraction as strings in the application`);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A link slot's value: `{ text, href }`.
  if (value && typeof value === 'object' && 'text' in value) return textOf((value as { text: unknown }).text);
  throw new Error(`cannot render ${JSON.stringify(value)} as text`);
}

function fillSlot(slot: Slot, text: string, href: Href, font: Font, traceName: string): Filled {
  const length = [...text].length;
  if (slot.max_length != null && length > slot.max_length) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} has ${length} characters, max-length is ${slot.max_length}`);
  // A link's text must not end on a soft hyphen: Typst appends the hyphen outside the link's tag range and typst-pdf
  // 0.15.1 cannot write that PDF (G52), so there is no compiler fallback for such data.
  if (href && text.endsWith(SHY)) throw new Error(`slot \`${traceName}\`: a link's text must not end on a soft hyphen (U+00AD); Typst cannot export it (the hyphen falls outside the link), strip it`);
  if ((slot.lines ?? 1) > 1) return fillLines(slot, text, href, font, traceName);
  const shape = (s: string, size: number): [Glyph[], number] => {
    const glyphs: Glyph[] = [];
    let width = 0;
    const push = (id: number): void => { const advance = font.advance(id) * size; glyphs.push({ id, x_advance: advance, x_offset: 0, y_offset: 0 }); width += advance; };
    // A soft hyphen draws nothing; a text ending on one ends with the font's hyphen, as Typst's line does.
    for (const c of s) if (c !== SHY) push(glyphOrRefuse(font, c, traceName));
    if (s.endsWith(SHY)) push(glyphOrRefuse(font, SHY, traceName));
    return [glyphs, width];
  };
  let size = slot.size;
  let [glyphs, width] = shape(text, size);
  let shown = text;
  if (width > slot.width + 1e-6) {
    switch (slot.overflow) {
      case 'error': throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} is ${width.toFixed(2)} pt wide but the slot is ${slot.width.toFixed(2)} pt; declare an overflow policy or a smaller max-length`);
      case 'clip': break;
      case 'shrink': {
        const factor = slot.width / width;
        if (factor < 0.5) throw new Error(`slot \`${traceName}\`: shrinking ${JSON.stringify(text)} to fit would need ${factor.toFixed(2)}x; the limit is 0.5x`);
        size *= factor;
        [glyphs, width] = shape(text, size);
        break;
      }
      case 'ellipsis': {
        const ellipsis = font.glyph('…') !== undefined ? '…' : '...';
        const chars = [...text];
        do {
          chars.pop();
          shown = chars.join('') + ellipsis;
          [glyphs, width] = shape(shown, size);
        } while (width > slot.width && chars.length > 0);
        break;
      }
      default: throw new Error(`slot \`${traceName}\`: unknown overflow policy ${JSON.stringify(slot.overflow)}`);
    }
  }
  let x: number;
  switch (slot.align) {
    case 'left': x = slot.x; break;
    case 'center': x = slot.x + (slot.width - width) / 2; break;
    case 'right': x = slot.x + slot.width - width; break;
    default: throw new Error(`slot \`${traceName}\`: unknown alignment ${JSON.stringify(slot.align)}`);
  }
  let pen = x;
  const traceGlyphs = glyphs.map(g => { const at = pen; pen += g.x_advance; return { id: g.id, x: at, y: slot.baseline }; });
  // A link slot: Typst's hyphen is a text run of its own, with its own link rectangle.
  const runs: [number, number, number][] = [[x, slot.baseline, width]];
  const last = glyphs[glyphs.length - 1];
  if (shown.endsWith(SHY) && last) { runs[0]![2] -= last.x_advance; runs.push([x + runs[0]![2], slot.baseline, last.x_advance]); }
  return {
    rect: [slot.x, slot.y, slot.width, slot.height],
    items: [{ kind: 'text', x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs }],
    trace: { name: traceName, baseline: slot.baseline, size, glyphs: traceGlyphs },
    link: linkFill(slot, href, runs, size / slot.size, traceName),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Wrapping slots: Typst's simple line breaker (typst-layout 0.15, inline/linebreak.rs) over UAX #14 break
// opportunities, for the character classes a Latin repertoire contains. The dialect switches hyphenation and
// justification off inside wrapping slots, so greedy first fit over advance widths reproduces Typst's lines; web
// addresses break where Typst's own rules for them say.

type LB = 'AL' | 'NU' | 'SP' | 'BA' | 'BB' | 'B2' | 'HY' | 'CL' | 'CP' | 'OP' | 'QU' | 'EX' | 'IS' | 'SY' | 'PR' | 'PO' | 'IN' | 'GL' | 'ZW' | 'WJ' | 'BK' | 'CM' | 'NS';

const LB_CLASS: Record<string, LB> = {
  '\n': 'BK', '\r': 'BK', '\v': 'BK', '\f': 'BK', '\u0085': 'BK', '\u2028': 'BK', '\u2029': 'BK',
  '\t': 'BA', ' ': 'SP', '!': 'EX', '"': 'QU', '$': 'PR', '%': 'PO', "'": 'QU', '(': 'OP', ')': 'CP', '+': 'PR', ',': 'IS', '-': 'HY',
  '.': 'IS', '/': 'SY', ':': 'IS', ';': 'IS', '?': 'EX', '[': 'OP', '\\': 'PR', ']': 'CP', '{': 'OP', '|': 'BA', '}': 'CL',
  '\u00a0': 'GL', '¡': 'OP', '¢': 'PO', '£': 'PR', '¤': 'PR', '¥': 'PR', '«': 'QU', '\u00ad': 'BA', '°': 'PO', '±': 'PR', '´': 'BB', '»': 'QU', '¿': 'OP',
  '\u2000': 'BA', '\u2001': 'BA', '\u2002': 'BA', '\u2003': 'BA', '\u2004': 'BA', '\u2005': 'BA', '\u2006': 'BA', '\u2007': 'GL', '\u2008': 'BA', '\u2009': 'BA', '\u200a': 'BA',
  '\u200b': 'ZW', '\u2010': 'BA', '\u2011': 'GL', '\u2012': 'BA', '\u2013': 'BA', '\u2014': 'B2', '\u2018': 'QU', '\u2019': 'QU', '\u201a': 'OP', '\u201b': 'QU',
  '\u201c': 'QU', '\u201d': 'QU', '\u201e': 'OP', '\u201f': 'QU', '\u2026': 'IN', '\u202f': 'GL', '\u2032': 'PO', '\u2033': 'PO', '\u2039': 'QU', '\u203a': 'QU',
  '\u2044': 'IS', '\u2060': 'WJ', '\u20ac': 'PR', '\u2212': 'PR',
  '\u037e': 'IS', '\u2024': 'IN', '\u2025': 'IN', '\u2027': 'BA', '\u2030': 'PO', '\u2031': 'PO', '\u20a7': 'PO', '\u20b6': 'PO', '\u20bb': 'PO', '\u20be': 'PO',
};
/** Digits are the ASCII ones and combining marks the main combining blocks, in both runtimes alike. */
const lineBreakClass = (c: string): LB => LB_CLASS[c] ?? (/^[0-9]$/.test(c) ? 'NU' : /^[\u20a0-\u20c0]$/.test(c) ? 'PR' : /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]$/.test(c) ? 'CM' : 'AL');
const isInitialQuote = (c: string): boolean => '«‘“‹‛‟'.includes(c);
const isFinalQuote = (c: string): boolean => '»’”›'.includes(c);
const isMandatoryBreak = (c: string): boolean => LB_CLASS[c] === 'BK';
/** Unicode White_Space, as Rust's `char::is_whitespace`. */
const isWhitespace = (c: string): boolean => /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(c);
/** Unicode Default_Ignorable_Code_Point, which Typst trims at a line end as it trims spaces. */
const isDefaultIgnorable = (c: string): boolean => /^[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]$/.test(c) || /^[\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]$/u.test(c);

/** UAX #14 line break opportunities as Typst 0.15 gets them from icu4x's default line segmenter: the Unicode 15.1
 *  rules with LB15a and LB15b, but without LB15c and LB20a and with the pair-table form of LB25 (each checked
 *  against Typst on random data), East Asian and Hebrew cases left out. `end` is where the next line would start,
 *  `mandatory` after a hard break and at the end. */
function breakpoints(chars: string[]): { end: number; mandatory: boolean }[] {
  const n = chars.length;
  if (n === 0) return [{ end: 0, mandatory: true }];
  const raw = chars.map(lineBreakClass);
  // LB9, LB10: a combining mark takes its base's class and never separates from it; after a space, a break
  // or at the start it is a letter.
  const eff: LB[] = [], attached: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const c = raw[i]!;
    if (c === 'CM' && i > 0 && eff[i - 1] !== 'BK' && eff[i - 1] !== 'SP' && eff[i - 1] !== 'ZW') { eff.push(eff[i - 1]!); attached.push(true); }
    else { eff.push(c === 'CM' ? 'AL' : c); attached.push(false); }
  }
  const is = (k: number, ...classes: LB[]): boolean => k >= 0 && k < n && classes.includes(eff[k]!);
  const allow = (i: number): boolean => {
    const b = eff[i - 1]!, a = eff[i]!;
    if (attached[i]) return false;                                                                   // LB9
    if (b === 'BK') return !(chars[i - 1] === '\r' && chars[i] === '\n');                           // LB4, LB5
    if (a === 'BK' || a === 'SP' || a === 'ZW') return false;                                        // LB6, LB7
    let p = i - 1;
    while (p >= 0 && eff[p] === 'SP') p--;                                                           // the last non-space before i
    if (is(p, 'ZW')) return true;                                                                    // LB8
    if (a === 'WJ' || b === 'WJ' || b === 'GL') return false;                                        // LB11, LB12
    if (a === 'GL' && b !== 'SP' && b !== 'BA' && b !== 'HY') return false;                          // LB12a
    if (a === 'CL' || a === 'CP' || a === 'EX' || a === 'IS' || a === 'SY') return false;             // LB13
    if (is(p, 'OP')) return false;                                                                   // LB14
    if (is(p, 'QU') && isInitialQuote(chars[p]!) && (p === 0 || is(p - 1, 'BK', 'OP', 'QU', 'GL', 'SP', 'ZW'))) return false; // LB15a
    if (a === 'QU' && isFinalQuote(chars[i]!) && (i + 1 === n || is(i + 1, 'SP', 'GL', 'WJ', 'CL', 'QU', 'CP', 'EX', 'IS', 'SY', 'BK'))) return false; // LB15b
    if (is(p, 'CL', 'CP') && a === 'NS') return false;                                               // LB16
    if (is(p, 'B2') && a === 'B2') return false;                                                     // LB17
    if (b === 'SP') return true;                                                                     // LB18
    if (a === 'QU' || b === 'QU') return false;                                                      // LB19, LB19a without East Asian text
    if (a === 'BA' || a === 'HY' || a === 'NS' || b === 'BB') return false;                          // LB21
    if (a === 'IN') return false;                                                                    // LB22
    if ((b === 'AL' && a === 'NU') || (b === 'NU' && a === 'AL')) return false;                      // LB23
    if (((b === 'PR' || b === 'PO') && a === 'AL') || (b === 'AL' && (a === 'PR' || a === 'PO'))) return false; // LB24
    if ((b === 'CL' || b === 'CP' || b === 'NU') && (a === 'PO' || a === 'PR')) return false;         // LB25, pair-table form
    if ((b === 'PO' || b === 'PR') && (a === 'OP' || a === 'NU')) return false;
    if ((b === 'HY' || b === 'IS' || b === 'NU' || b === 'SY') && a === 'NU') return false;
    if (b === 'AL' && a === 'AL') return false;                                                      // LB28
    if (b === 'IS' && a === 'AL') return false;                                                      // LB29
    if ((b === 'AL' || b === 'NU') && a === 'OP') return false;                                      // LB30
    if (b === 'CP' && (a === 'AL' || a === 'NU')) return false;
    return true;                                                                                     // LB31
  };
  // Typst walks the segmenter's opportunities with `last`, the previous one, and at each step first looks for a
  // web address at `last` (UAX #14 breaks one badly): after `://` or before `www.`, the address's own
  // opportunities (`linebreakLink`) replace the segmenter's inside it. The trigger is positional: a `://` with
  // no opportunity right after it starts no address.
  const out: { end: number; mandatory: boolean }[] = [];
  let last = 0, next = 1;
  for (;;) {
    if ((last >= 3 && chars[last - 3] === ':' && chars[last - 2] === '/' && chars[last - 1] === '/') || (chars[last] === 'w' && chars[last + 1] === 'w' && chars[last + 2] === 'w' && chars[last + 3] === '.')) {
      const len = linkPrefix(chars, last);
      linebreakLink(chars.slice(last, last + len), k => out.push({ end: last + k, mandatory: false }));
      last += len;
      next = Math.max(next, last);
    }
    while (next < n && !allow(next)) next++; // the next UAX #14 opportunity; the end of the text is one
    if (next > n) break;
    const point = next++;
    out.push({ end: point, mandatory: point === n || raw[point - 1] === 'BK' });
    last = point;
  }
  return out;
}

/** How much of the text from `from` is a web address, as typst-syntax's `link_prefix` eats it: ASCII letters, digits
 *  and URL punctuation, brackets while they balance, minus trailing punctuation that is more likely prose. */
function linkPrefix(chars: string[], from: number): number {
  const brackets: string[] = [];
  let len = 0;
  for (let i = from; i < chars.length; i++) {
    const c = chars[i]!;
    let eat: boolean;
    if (/^[0-9a-zA-Z!#$%&*+,\-./:;=?@_~']$/.test(c)) eat = true;
    else if (c === '[' || c === '(') { brackets.push(c); eat = true; }
    else if (c === ']') eat = brackets.pop() === '[';
    else if (c === ')') eat = brackets.pop() === '(';
    else eat = false;
    if (!eat) break;
    len++;
  }
  while (len > 0 && /^[!,.:;?']$/.test(chars[from + len - 1]!)) len--;
  return len;
}

/** Typst's break opportunities inside a web address (`linebreak_link`): where the character class changes between
 *  letters, digits and the rest, or between two punctuation marks, never right after `(` or `[`; a run of 16 or more
 *  characters since the last opportunity (a hash) may break after every character. The address is ASCII
 *  (`linkPrefix` eats nothing else), so Typst's byte offsets are character offsets. */
function linebreakLink(link: string[], f: (end: number) => void): void {
  type Class = 'alphabetic' | 'digit' | 'open' | 'other';
  const classOf = (c: string): Class => (/^[a-zA-Z]$/.test(c) ? 'alphabetic' : /^[0-9]$/.test(c) ? 'digit' : c === '(' || c === '[' ? 'open' : 'other');
  let offset = 0, prev: Class = 'other';
  link.forEach((c, end) => {
    const cls = classOf(c);
    if (end > 0 && prev !== 'open' && (cls === 'other' ? prev === 'other' : cls !== prev)) {
      const piece = end - offset;
      if (piece < 16) { offset = end; f(offset); } else for (let k = 0; k < piece; k++) { offset++; f(offset); }
    }
    prev = cls;
  });
}

/** A glyph of a shaped text as Typst's `calculate_adjustability` (typst-layout 0.15.1 `shaping.rs`) leaves it: `advance`
 *  and `offset` after the adjustment of consecutive punctuation, `shrink` what `commit` may still take from each side, `c`
 *  the glyph's character to Typst (the soft hyphen for the glyph after soft hyphens that open the text), `at` the index of
 *  its character in the text that was shaped. */
interface Shaped { id: number; advance: number; offset: number; shrink: [number, number]; c: string; at: number }

/** Shapes a text as Typst shapes a paragraph's (or a reshaped line's) text: one glyph per character but soft hyphens and
 *  hard breaks, the character map's glyph at the font's advance; the glyph after soft hyphens that open the text takes
 *  their cluster (rustybuzz merges a leading default ignorable forward), so to Typst its character is the soft hyphen and
 *  it has no adjustability. Then `base_adjustability` with the default `par.justification-limits`: a space may shrink by a
 *  third of its advance (min(a / 3, 0.75 a)) on its right, a middle dot (CJK centre-aligned punctuation to Typst) by a
 *  quarter on each side; nothing else adjusts. Then consecutive CJK punctuation is pulled together (Chinese Layout
 *  Requirements 3.1.6.1): where two dots meet and their facing shrinkabilities reach half the first one's advance, the first
 *  gives up to a quarter on its right and the second the rest on its left (its glyph moving left), in text order, each pair
 *  seeing the state the previous one left. Same arithmetic as the Rust runtime's `shape_text`. */
function shapeText(cs: string[], font: Font, size: number, traceName: string): Shaped[] {
  let leading = 0; while (leading < cs.length && cs[leading] === SHY) leading++;
  const out: Shaped[] = [];
  cs.forEach((c, i) => {
    if (c === SHY || isMandatoryBreak(c)) return;
    const id = glyphOrRefuse(font, c, traceName);
    const a = font.advance(id) * size;
    const eff = i === leading && leading > 0 ? SHY : c;
    const shrink: [number, number] = isSpaceGlyph(eff) ? [0, Math.min(a / 3, a * 0.75)] : isMiddleDot(eff) ? [a / 4, a / 4] : [0, 0];
    out.push({ id, advance: a, offset: 0, shrink, c: eff, at: i });
  });
  for (let k = 0; k + 1 < out.length; k++) {
    const g = out[k]!, next = out[k + 1]!;
    if (!(isMiddleDot(g.c) && isMiddleDot(next.c))) continue;
    const delta = g.advance / 2;
    if (g.shrink[1] + next.shrink[0] >= delta) {
      const leftDelta = Math.min(g.shrink[1], delta);
      g.advance -= leftDelta; g.shrink[1] -= leftDelta;
      const amount = delta - leftDelta;
      next.offset -= amount; next.advance -= amount; next.shrink[0] -= amount;
    }
  }
  return out;
}

/** The shaping of a slot's whole text, which Typst does once; a line is a slice of it, except that a line starting on a
 *  soft hyphen inside the text is shaped again by Typst (no glyph starts at the hyphen, so the slice is not safe to break)
 *  and so gets its own adjustments. */
class Shaping {
  private readonly chars: string[];
  private readonly font: Font;
  private readonly size: number;
  private readonly traceName: string;
  private readonly whole: Shaped[];
  private readonly glyphAt: (number | undefined)[];
  constructor(chars: string[], font: Font, size: number, traceName: string) {
    this.chars = chars; this.font = font; this.size = size; this.traceName = traceName;
    this.whole = shapeText(chars, font, size, traceName);
    this.glyphAt = new Array<number | undefined>(chars.length);
    this.whole.forEach((g, k) => { this.glyphAt[g.at] = k; });
  }
  reshaped(from: number): boolean { return from > 0 && from < this.chars.length && this.chars[from] === SHY; }
  /** The glyphs of the line `from..to`, `at` relative to `from`. */
  line(from: number, to: number): Shaped[] {
    if (this.reshaped(from)) return shapeText(this.chars.slice(from, to), this.font, this.size, this.traceName);
    return this.whole.filter(g => g.at >= from && g.at < to).map(g => ({ ...g, shrink: [g.shrink[0], g.shrink[1]], at: g.at - from }));
  }
  /** The natural width of `from..to`, as the breaker measures a line. */
  widthOf(from: number, to: number): number {
    if (this.reshaped(from)) { let w = 0; for (const g of this.line(from, to)) w += g.advance; return w; }
    let w = 0; for (let i = from; i < to; i++) { const k = this.glyphAt[i]; if (k !== undefined) w += this.whole[k]!.advance; } return w;
  }
}

/** A line of a wrapping slot: `layoutEnd` excludes the trailing whitespace and soft hyphens that do not count for the
 *  width; `shapingEnd` includes them (Typst draws the whitespace glyphs at zero advance).
 *  `mandatory`: the line ends at a hard break or at the end of the text, so it is never justified.
 *  `hyphen`: the line's full text ends on a soft hyphen, so the font's hyphen is drawn after it (its width counted). */
interface BrokenLine { start: number; layoutEnd: number; shapingEnd: number; width: number; mandatory: boolean; hyphen: boolean }
/** A line as drawn: `kept` glyphs count for the width (the hyphen among them), the rest are trimmed trailing whitespace
 *  at zero advance; `hyphenWidth` is the drawn hyphen's advance, 0 without one. */
interface LineRun { ids: number[]; advances: number[]; offsets: number[]; text: string; width: number; kept: number; hyphenWidth: number }
const isSpaceGlyph = (c: string): boolean => c === ' ' || c === '\u00a0' || c === '\u3000';

/** Typst's simple breaker: greedy first fit, a mandatory break or a line that does not fit even on its own
 *  committed as it is (an overlong word overflows, as in Typst). */
function breakLines(chars: string[], widthOf: (from: number, to: number) => number, fits: (width: number) => boolean, hyphenWidth: number): BrokenLine[] {
  const line = (start: number, end: number, mandatory: boolean): BrokenLine => {
    let shapingEnd = end, layoutEnd = end;
    if (mandatory) { while (shapingEnd > start && isMandatoryBreak(chars[shapingEnd - 1]!)) shapingEnd--; layoutEnd = shapingEnd; }
    else while (layoutEnd > start && (isWhitespace(chars[layoutEnd - 1]!) || isDefaultIgnorable(chars[layoutEnd - 1]!))) layoutEnd--;
    // Typst appends the font's hyphen when the line's full text ends on a soft hyphen (`line.rs`, `Dash::Soft`), at the
    // end of the text too; its width counts for the fit.
    const hyphen = end > start && chars[end - 1] === SHY;
    return { start, layoutEnd, shapingEnd, width: widthOf(start, layoutEnd) + (hyphen ? hyphenWidth : 0), mandatory, hyphen };
  };
  const lines: BrokenLine[] = [];
  let start = 0;
  let last: { line: BrokenLine; end: number } | undefined;
  for (const { end, mandatory } of breakpoints(chars)) {
    let attempt = line(start, end, mandatory);
    if (!fits(attempt.width) && last) { lines.push(last.line); start = last.end; attempt = line(start, end, mandatory); }
    if (mandatory || !fits(attempt.width)) { lines.push(attempt); start = end; last = undefined; }
    else last = { line: attempt, end };
  }
  if (last) lines.push(last.line);
  return lines;
}

function fillLines(slot: Slot, text: string, href: Href, font: Font, traceName: string): Filled {
  const lines = slot.lines!, pitch = slot.pitch ?? 0, size = slot.size;
  if (!(pitch > 0)) throw new Error(`slot \`${traceName}\`: a wrapping slot without a line pitch; export the document again`);
  if (slot.overflow === 'shrink') throw new Error(`slot \`${traceName}\`: \`shrink\` is not an overflow policy for a wrapping slot`);
  const chars = [...text];
  const shaping = new Shaping(chars, font, size, traceName);
  // A line ending on a soft hyphen gets the font's hyphen, whose width counts for the break.
  const hyphenId = chars.includes(SHY) ? glyphOrRefuse(font, SHY, traceName) : undefined;
  const hyphenWidth = hyphenId === undefined ? 0 : font.advance(hyphenId) * size;
  const widthOf = (from: number, to: number): number => shaping.widthOf(from, to);
  const fits = (width: number): boolean => slot.width + 1e-4 >= width; // Typst's `Abs::fits`
  // Typst's `commit` (typst-layout 0.15.1 `line.rs`) over the shaped glyphs (`shapeText`): `remaining < 0`: the line does
  // not fit and its glyphs shrink (ragged lines too), each by `ratio` of what it may still give on each side, down to -1,
  // the glyph moving left by its left share. Otherwise a justified line stretches its spaces by `ratio` of their
  // stretchability (half a space each), up to 1, and shares what is still left equally among the justifiable glyphs
  // (`extra`: spaces and middle dots); a line without one keeps its width and is aligned as the slot says. Trimmed
  // trailing whitespace has no advance and no adjustability; the hyphen neither. Same arithmetic as the Rust runtime's `run`.
  const sum = (xs: number[]): number => xs.reduce((w, a) => w + a, 0);
  const run = (glyphs: Shaped[], kept: number, justify: boolean, hyphenated: boolean, text: string): LineRun => {
    const ids: number[] = [], advances: number[] = [], offsets: number[] = [], shrink: [number, number][] = [], charsOf: string[] = [], isKept: boolean[] = [];
    for (const g of glyphs) { const k = g.at < kept; ids.push(g.id); advances.push(k ? g.advance : 0); offsets.push(k ? g.offset : 0); shrink.push(k ? g.shrink : [0, 0]); charsOf.push(g.c); isKept.push(k); }
    const drawnHyphen = hyphenated && hyphenId !== undefined;
    if (drawnHyphen) { ids.push(hyphenId); advances.push(hyphenWidth); offsets.push(0); shrink.push([0, 0]); charsOf.push('-'); isKept.push(true); }
    const n = ids.length;
    const justifiable = charsOf.map((c, i) => isKept[i]! && (isSpaceGlyph(c) || isMiddleDot(c)));
    let width = sum(advances);
    const remaining = slot.width - width;
    const shrinkability = sum(shrink.map(([l, r]) => l + r));
    if (remaining < 0 && shrinkability > 0) {
      const ratio = Math.max(remaining / shrinkability, -1);
      for (let i = 0; i < n; i++) { const [l, r] = shrink[i]!; offsets[i]! += l * ratio; advances[i]! += (l + r) * ratio; }
      width = sum(advances);
    } else if (justify) {
      const stretch = advances.map((a, i) => (isKept[i] && isSpaceGlyph(charsOf[i]!) ? a * 0.5 : 0));
      const stretchability = sum(stretch);
      let ratio = 0, left = remaining;
      if (stretchability > 0) { ratio = Math.min(remaining / stretchability, 1); left = Math.max(remaining - stretchability, 0); }
      // Typst's `Line::justifiables`: a middle dot that ends the line is not counted (it still takes the share).
      let justifiables = justifiable.filter(j => j).length;
      const lastKept = isKept.lastIndexOf(true);
      if (lastKept >= 0 && isMiddleDot(charsOf[lastKept]!)) justifiables--;
      const extra = justifiables > 0 && left > 0 ? left / justifiables : 0;
      for (let i = 0; i < n; i++) advances[i]! += ratio * stretch[i]! + (justifiable[i] ? extra : 0);
      width = sum(advances);
    }
    return { ids, advances, offsets, text, width, kept: isKept.filter(k => k).length, hyphenWidth: drawnHyphen ? hyphenWidth : 0 };
  };
  // Every line but the last and lines before a hard break are justified (`line.rs`: `config.justify && breakpoint !=
  // Mandatory`; the end of the text is a mandatory break too).
  const render = (l: BrokenLine): LineRun => run(shaping.line(l.start, l.shapingEnd), l.layoutEnd - l.start, slot.justify === true && !l.mandatory, l.hyphen, chars.slice(l.start, l.shapingEnd).join(''));
  const ellipsize = (l: BrokenLine): LineRun => {
    const ellipsis = [...(font.glyph('…') !== undefined ? '…' : '...')];
    const kept = chars.slice(l.start, l.layoutEnd);
    const trimmed = (): string[] => { while (kept.length && (isWhitespace(kept[kept.length - 1]!) || kept[kept.length - 1] === SHY)) kept.pop(); return kept; };
    // The ellipsized line is the runtime's own and the last one shown: never stretched, never hyphenated.
    const shape = (): LineRun => { const cs = [...trimmed(), ...ellipsis]; return run(shapeText(cs, font, size, traceName), cs.length, false, false, cs.join('')); };
    let shown = shape();
    while (!fits(shown.width) && kept.length) { kept.pop(); shown = shape(); }
    return shown;
  };

  const broken = breakLines(chars, widthOf, fits, hyphenWidth);
  let runs = broken.map(render);
  // Lines stack as Typst stacks them: a line is as tall as the line height, except that a line of nothing but
  // trimmed whitespace (no kept glyph, no hyphen) has no height; `leading` separates lines. The first baseline is the slot's.
  const lineHeight = slot.baseline - slot.y, leading = pitch - lineHeight;
  const baselines = (rs: LineRun[]): number[] => { let y = slot.y; return rs.map((r, k) => { const h = r.ids.length > 0 && r.kept === 0 ? 0 : lineHeight; if (k > 0) y += leading; y += h; return y; }); };
  const bottom = slot.y + slot.height + 1e-6;
  const visible = baselines(runs).filter(b => b <= bottom).length;
  const overlong = runs.findIndex(r => !fits(r.width));
  if (overlong >= 0 || visible < runs.length) switch (slot.overflow) {
    case 'error':
      if (overlong >= 0) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(runs[overlong]!.text)} is ${runs[overlong]!.width.toFixed(2)} pt wide but the slot is ${slot.width.toFixed(2)} pt; declare an overflow policy or a smaller max-length`);
      throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} needs ${runs.length} lines but the slot holds ${lines}; declare an overflow policy or a smaller max-length`);
    // Every line is drawn and the box clips, as in Typst: a line whose baseline is below the box may still show its
    // top (after a whitespace-only line, which has no height, the lines sit one line height up).
    case 'clip': break;
    case 'ellipsis': {
      const cut = Math.min(overlong >= 0 ? overlong : visible - 1, visible - 1);
      runs = runs.slice(0, cut + 1);
      runs[cut] = ellipsize(broken[cut]!);
      break;
    }
    default: throw new Error(`slot \`${traceName}\`: unknown overflow policy ${JSON.stringify(slot.overflow)}`);
  }

  const items: (Item & { kind: 'text' })[] = [];
  const traceGlyphs: ReferenceGlyph[] = [];
  const drawn: [number, number, number][] = [];
  const ys = baselines(runs);
  runs.forEach((line, k) => {
    const y = ys[k]!;
    let x: number;
    switch (slot.align) {
      case 'left': x = slot.x; break;
      case 'center': x = slot.x + (slot.width - line.width) / 2; break;
      case 'right': x = slot.x + slot.width - line.width; break;
      default: throw new Error(`slot \`${traceName}\`: unknown alignment ${JSON.stringify(slot.align)}`);
    }
    let pen = x;
    const glyphs: Glyph[] = line.ids.map((id, i) => { const advance = line.advances[i]!, offset = line.offsets[i]!; traceGlyphs.push({ id, x: pen + offset, y }); pen += advance; return { id, x_advance: advance, x_offset: offset, y_offset: 0 }; });
    if (glyphs.length) {
      items.push({ kind: 'text', x, y, font: slot.font, size, fill: slot.fill, text: line.text, glyphs });
      // A link slot: Typst's hyphen is a text run of its own, with its own link rectangle.
      const textWidth = line.width - line.hyphenWidth;
      drawn.push([x, y, textWidth]);
      if (line.hyphenWidth > 0) drawn.push([x + textWidth, y, line.hyphenWidth]);
    }
  });
  // The trace reports the first line's baseline as Typst's frame has it: at the box top when that line is whitespace.
  return { rect: [slot.x, slot.y, slot.width, slot.height], items, trace: { name: traceName, baseline: ys[0] ?? slot.baseline, size, glyphs: traceGlyphs }, link: linkFill(slot, href, drawn, 1, traceName) };
}

// ---------------------------------------------------------------------------------------------------------
// Structure

// ---------------------------------------------------------------------------------------------------------
// Bars and image slots

/** A bar: the value's share of `max` (clamped to 0..1) of the hole's width, as Typst's rounded rectangle. */
function fillBar(bar: Bar, value: number, traceName: string): Filled {
  const width = Math.min(Math.max(value / bar.max, 0), 1) * bar.width;
  const geometry = roundedRect(width, bar.height, bar.radius);
  return {
    rect: [bar.x, bar.y, bar.width, bar.height],
    items: [{ kind: 'shape', x: bar.x, y: bar.y, geometry, fill: bar.fill, stroke: null }],
    trace: { name: `${traceName}#bar`, baseline: 0, size: 0, glyphs: [], ops: opsOf(geometry, bar.x, bar.y), rect: [bar.x, bar.y, width, bar.height] },
  };
}

/** An image slot: the data's PNG or JPEG, placed as Typst's `image` places it. Only the header is read here;
 *  decoding happens when the PDF is written, once per distinct image. */
function fillImage(slot: ImageSlot, bytes: Uint8Array, alt: string | undefined, traceName: string): Filled {
  const [pxW, pxH, format] = imageSize(bytes, traceName);
  const [dx, dy, w, h] = fitImage(slot.fit, slot.width, slot.height, pxW, pxH);
  const key = `data:${quickHash(bytes)}`;
  const shown = alt ?? slot.alt ?? undefined;
  if (!shown) throw new Error(`image slot \`${traceName}\`: no alternative text; PDF/UA needs one: give the value as {src, alt} or the template an \`alt:\``);
  return {
    rect: [slot.x, slot.y, slot.width, slot.height],
    items: [{ kind: 'image', x: slot.x + dx, y: slot.y + dy, width: w, height: h, format, sha256: key }],
    trace: { name: `${traceName}#image`, baseline: 0, size: 0, glyphs: [], rect: [slot.x + dx, slot.y + dy, w, h] },
    image: { key, bytes }, alt: shown,
  };
}

/** The bytes and alternative text of an image the data supplies: a `data:image/…;base64,…` URL or the bytes
 *  themselves, or `{ src: <either>, alt: "…" }`. */
function imageValue(value: unknown, name: string): { bytes: Uint8Array; alt?: string } {
  let src: unknown = value, alt: string | undefined;
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const record = value as { src?: unknown; alt?: unknown };
    src = record.src; alt = typeof record.alt === 'string' ? record.alt : undefined;
  }
  if (src instanceof Uint8Array) return { bytes: src, alt };
  if (typeof src !== 'string') throw new Error(`image slot \`${name}\`: cannot read an image from ${JSON.stringify(value)?.slice(0, 60)}`);
  const comma = src.indexOf(',');
  const header = comma < 0 ? '' : src.slice(0, comma);
  if (!header.startsWith('data:image/') || !header.endsWith(';base64')) throw new Error(`image slot \`${name}\`: the image must be a base64 data URL (data:image/png;base64,…) or bytes, not ${JSON.stringify(src.slice(0, 40))}`);
  const text = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return { bytes, alt };
}

/** A cheap content key for caching decoded images and sharing one XObject between equal images: two 32-bit
 *  FNV-1a hashes with different seeds plus the length. */
function quickHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x7f4a7c15;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i]!, 0x01000193) ^ (h2 >>> 15);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}${bytes.length.toString(16)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Images: PNG and JPEG, decoded as far as a PDF needs. Typst's PDF writer (krilla) embeds them the same way:
// 8-bit grey or RGB samples deflated, the alpha channel as a soft mask when any pixel is not opaque, JPEG data
// as it is. Inflating and deflating go through the platform's streams, so decoding is asynchronous.

/** An image ready for an image XObject: `data` is the stream (deflated samples, or the JPEG file), `smask` the
 *  deflated 8-bit alpha when the image has transparency. */
interface Decoded { width: number; height: number; gray: boolean; dct: boolean; data: Uint8Array; smask?: Uint8Array }

const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const isPng = (b: Uint8Array): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
const isJpeg = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;

function pngChunks(bytes: Uint8Array): { kind: string; data: Uint8Array }[] {
  const chunks: { kind: string; data: Uint8Array }[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const len = be32(bytes, at);
    const kind = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const start = at + 8, end = start + len;
    if (end + 4 > bytes.length) throw new Error(`truncated PNG chunk ${kind}`);
    chunks.push({ kind, data: bytes.subarray(start, end) });
    if (kind === 'IEND') break;
    at = end + 4;
  }
  return chunks;
}

/** Pixel size and format ("png" or "jpg") from the header: enough to lay the image out before decoding it. */
function imageSize(bytes: Uint8Array, what: string): [number, number, string] {
  if (isPng(bytes)) {
    const ihdr = pngChunks(bytes).find(c => c.kind === 'IHDR')?.data;
    if (!ihdr || ihdr.length < 13) throw new Error(`${what}: PNG without a valid IHDR`);
    return [be32(ihdr, 0), be32(ihdr, 4), 'png'];
  }
  if (isJpeg(bytes)) { const [w, h] = jpegHeader(bytes); return [w, h, 'jpg']; }
  throw new Error(`${what}: not a PNG or JPEG (the file starts with ${[...bytes.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ')})`);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 8-bit, non-interlaced PNGs of every colour type; palettes are expanded, a tRNS chunk becomes alpha. */
async function decodePng(bytes: Uint8Array): Promise<Decoded> {
  const chunks = pngChunks(bytes);
  const ihdr = chunks.find(c => c.kind === 'IHDR')?.data;
  if (!ihdr || ihdr.length < 13) throw new Error('PNG without a valid IHDR');
  const width = be32(ihdr, 0), height = be32(ihdr, 4), depth = ihdr[8]!, colorType = ihdr[9]!, interlace = ihdr[12]!;
  if (depth !== 8) throw new Error(`PNG with ${depth}-bit samples is not supported (8-bit only); re-encode it`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported; re-encode it without interlacing');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`);
  const palette = chunks.find(c => c.kind === 'PLTE')?.data;
  const trns = chunks.find(c => c.kind === 'tRNS')?.data;
  const idats = chunks.filter(c => c.kind === 'IDAT').map(c => c.data);
  const idat = new Uint8Array(idats.reduce((n, d) => n + d.length, 0));
  idats.reduce((at, d) => { idat.set(d, at); return at + d.length; }, 0);
  const raw = await inflate(idat);
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG image data is ${raw.length} bytes, expected ${(stride + 1) * height}`);
  // Undo the per-row filters (filter method 0: none, sub, up, average, Paeth).
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowAt = y * (stride + 1) + 1, outAt = y * stride, prevAt = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[outAt + i - channels]! : 0;
      const b = y > 0 ? pixels[prevAt + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[prevAt + i - channels]! : 0;
      const x = raw[rowAt + i]!;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`PNG row ${y} uses unknown filter ${filter}`);
      pixels[outAt + i] = v & 0xff;
    }
  }
  const n = width * height;
  let color: Uint8Array, alpha: Uint8Array | undefined, gray = false;
  if (colorType === 0) {
    gray = true; color = pixels;
    if (trns && trns.length >= 2) { const key = trns[1]!; alpha = new Uint8Array(n); for (let i = 0; i < n; i++) alpha[i] = pixels[i] === key ? 0 : 255; }
  } else if (colorType === 2) {
    color = pixels;
    if (trns && trns.length >= 6) { const k = [trns[1], trns[3], trns[5]]; alpha = new Uint8Array(n); for (let i = 0; i < n; i++) alpha[i] = pixels[i * 3] === k[0] && pixels[i * 3 + 1] === k[1] && pixels[i * 3 + 2] === k[2] ? 0 : 255; }
  } else if (colorType === 3) {
    if (!palette) throw new Error('palette PNG without PLTE');
    color = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { const at = pixels[i]! * 3; if (at + 3 > palette.length) throw new Error('PNG palette index out of range'); color[i * 3] = palette[at]!; color[i * 3 + 1] = palette[at + 1]!; color[i * 3 + 2] = palette[at + 2]!; }
    if (trns) { alpha = new Uint8Array(n); for (let i = 0; i < n; i++) alpha[i] = pixels[i]! < trns.length ? trns[pixels[i]!]! : 255; }
  } else if (colorType === 4) {
    gray = true; color = new Uint8Array(n); alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) { color[i] = pixels[i * 2]!; alpha[i] = pixels[i * 2 + 1]!; }
  } else {
    color = new Uint8Array(n * 3); alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) { color[i * 3] = pixels[i * 4]!; color[i * 3 + 1] = pixels[i * 4 + 1]!; color[i * 3 + 2] = pixels[i * 4 + 2]!; alpha[i] = pixels[i * 4 + 3]!; }
  }
  const transparent = alpha !== undefined && alpha.some(a => a !== 255);
  const [data, smask] = await Promise.all([deflate(color), transparent ? deflate(alpha!) : Promise.resolve(undefined)]);
  return { width, height, gray, dct: false, data, smask };
}

/** Width, height and component count from a JPEG's frame header. */
function jpegHeader(bytes: Uint8Array): [number, number, number] {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(`malformed JPEG: expected a marker at byte ${at}`);
    const code = bytes[at + 1]!;
    if (code === 0xff) { at += 1; continue; }
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) { at += 2; continue; }
    const len = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (code === 0xc0 || code === 0xc1 || code === 0xc2) {
      if (at + 10 > bytes.length) throw new Error('truncated JPEG frame header');
      if (bytes[at + 4] !== 8) throw new Error(`JPEG with ${bytes[at + 4]}-bit samples is not supported`);
      return [(bytes[at + 7]! << 8) | bytes[at + 8]!, (bytes[at + 5]! << 8) | bytes[at + 6]!, bytes[at + 9]!];
    }
    if (code === 0xc3 || (code >= 0xc5 && code <= 0xc7) || (code >= 0xc9 && code <= 0xcb) || (code >= 0xcd && code <= 0xcf)) throw new Error(`JPEG frame type 0x${code.toString(16)} (lossless, hierarchical or arithmetic coding) is not supported`);
    // Typst rotates a photo by its EXIF orientation; the runtimes draw it as stored, so they refuse it.
    if (code === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === 'Exif\0\0') {
      const o = exifOrientation(bytes.subarray(at + 10, Math.min(at + 2 + len, bytes.length)));
      if (o !== undefined && o !== 1) throw new Error(`JPEG with EXIF orientation ${o}: rotate the image before sending it (Typst would rotate it, the runtimes draw it as stored)`);
    }
    if (code === 0xd9 || code === 0xda) break;
    at += 2 + len;
  }
  throw new Error('JPEG without a frame header');
}

/** The EXIF orientation tag (0x0112 in IFD0) of a TIFF-structured EXIF block, if present. */
function exifOrientation(tiff: Uint8Array): number | undefined {
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0);
  if (order !== 'MM' && order !== 'II') return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength), little = order === 'II';
  const u16 = (at: number): number | undefined => at + 2 <= tiff.length ? view.getUint16(at, little) : undefined;
  const u32 = (at: number): number | undefined => at + 4 <= tiff.length ? view.getUint32(at, little) : undefined;
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd === undefined) return undefined;
  const count = u16(ifd) ?? 0;
  for (let i = 0; i < count; i++) { const e = ifd + 2 + 12 * i; if (u16(e) === 0x0112) return u16(e + 8); }
  return undefined;
}

/** Baseline and progressive JPEGs pass through as DCT-encoded data, as in Typst's PDFs. */
function decodeJpeg(bytes: Uint8Array): Decoded {
  const [width, height, components] = jpegHeader(bytes);
  if (components !== 1 && components !== 3) throw new Error(`JPEG with ${components} components (CMYK?) is not supported`);
  return { width, height, gray: components === 1, dct: true, data: bytes };
}

async function decodeImage(bytes: Uint8Array): Promise<Decoded> {
  return isPng(bytes) ? decodePng(bytes) : decodeJpeg(bytes);
}

/** The image files a document ships (by hash) and a cache of decoded images by key, so that an image used in
 *  many documents is decoded once per runtime. */
class Images {
  private readonly cache = new Map<string, Promise<Decoded>>();
  private readonly files: Map<string, Uint8Array>;
  constructor(files: Map<string, Uint8Array>) { this.files = files; }

  /** `bytes` are the image's own bytes for a data-supplied image; a static image is looked up by its hash. */
  decoded(key: string, bytes?: Uint8Array): Promise<Decoded> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const source = bytes ?? this.files.get(key);
    if (!source) return Promise.reject(new Error(`the document draws image ${key}, which was not supplied; pass the files under images/`));
    const pending = decodeImage(source).catch(error => { this.cache.delete(key); throw new Error(`decoding image ${key.slice(0, 24)}: ${error instanceof Error ? error.message : error}`); });
    if (this.cache.size >= 256) this.cache.clear();
    this.cache.set(key, pending);
    return pending;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Structure

type Kid = { node: number } | { page: number; mcid: number } | { page: number; annot: number };
interface GNode { role: string; parent: number | null; alt?: string; scope?: string; kids: Kid[] }

class Structure {
  readonly nodes: GNode[] = [{ role: 'Document', parent: null, kids: [] }];

  add(role: string, parent: number, alt?: string, scope?: string): number {
    this.nodes.push({ role, parent, alt, scope, kids: [] });
    const id = this.nodes.length - 1;
    this.nodes[parent]!.kids.push({ node: id });
    return id;
  }

  /** Local nodes of a fragment under `attach`; with `unwrapTables`, top Table/THead/TBody wrappers are skipped. */
  instantiate(local: Node[], attach: number, unwrapTables: boolean): (number | undefined)[] {
    const map: (number | undefined)[] = [];
    const effective: number[] = [];
    for (const node of local) {
      const parentGlobal = node.parent == null ? attach : effective[node.parent]!;
      const atTop = node.parent == null || map[node.parent] === undefined;
      if (unwrapTables && atTop && (node.role === 'Table' || node.role === 'THead' || node.role === 'TBody')) {
        map.push(undefined); effective.push(parentGlobal);
      } else {
        const id = this.add(node.role, parentGlobal, node.alt, node.scope);
        map.push(id); effective.push(id);
      }
    }
    return map;
  }

  alive(): boolean[] {
    const alive = new Array<boolean>(this.nodes.length).fill(false);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      alive[i] = this.nodes[i]!.kids.some(k => 'mcid' in k || 'annot' in k || alive[k.node]!);
    }
    alive[0] = true;
    return alive;
  }
}

function remap(items: Item[], map: (number | undefined)[]): Item[] {
  return items.map(item => {
    if (item.kind === 'group') return { ...item, items: remap(item.items, map) };
    const node = item.node == null ? undefined : map[item.node];
    return { ...item, node };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Composition

interface Composed { width: number; height: number; items: Item[]; fills: Filled[]; annots: Annot[] }
/** A link annotation: rectangles in page coordinates (y down), the URL, the /Contents description and its Link node. */
interface Annot { rects: [number, number, number, number][]; url: string; contents: string; node?: number }

/** Adds a filled slot's link, if any, to the page; the Link node takes the data's description. */
function addSlotLink(filled: Filled, page: Composed, structure: Structure): void {
  if (!filled.link) return;
  const contents = filled.link.alt ?? filled.link.url;
  if (filled.node !== undefined) structure.nodes[filled.node]!.alt = contents;
  page.annots.push({ rects: filled.link.rects, url: filled.link.url, contents, node: filled.node });
}
type Attach = { kind: 'document' } | { kind: 'artifact' } | { kind: 'table'; table: number };

class Scope {
  private readonly data: unknown;
  private readonly counters: [number, number] | undefined;
  constructor(data: unknown, counters?: [number, number]) { this.data = data; this.counters = counters; }
  private value(name: string): unknown {
    const record = this.data as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || !(name in record)) throw new Error(`data has no value for slot \`${name}\``);
    return record[name];
  }
  text(name: string): string {
    if (this.counters) {
      if (name === 'page-number') return String(this.counters[0]);
      if (name === 'page-count') return String(this.counters[1]);
    }
    return textOf(this.value(name));
  }
  number(name: string): number {
    const value = this.value(name);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`bar \`${name}\`: ${JSON.stringify(value)} is not a number`);
    return value;
  }
  image(name: string): { bytes: Uint8Array; alt?: string } { return imageValue(this.value(name), name); }
  /** The `href` (and `alt`) of a `{ text, href, alt? }` value; undefined for any other value. */
  href(name: string): Href {
    const record = this.data as Record<string, unknown> | null;
    const value = record && typeof record === 'object' ? record[name] : undefined;
    if (!value || typeof value !== 'object' || !('href' in value)) return undefined;
    const { href, alt } = value as { href: unknown; alt?: unknown };
    if (href == null) return undefined;
    if (typeof href !== 'string' || !href) throw new Error(`slot \`${name}\`: \`href\` ${JSON.stringify(href)} is not a non-empty string`);
    return { url: href, alt: typeof alt === 'string' ? alt : undefined };
  }
}

const clipOps = (w: number, h: number): PathOp[] => [{ op: 'move', to: [0, 0] }, { op: 'line', to: [w, 0] }, { op: 'line', to: [w, h] }, { op: 'line', to: [0, h] }, { op: 'close' }];

function place(fragment: Fragment, top: number, scope: Scope, fonts: Font[], prefix: string, clip: boolean, page: Composed, structure: Structure, attach: Attach): void {
  const map = attach.kind === 'artifact' ? fragment.nodes.map(() => undefined)
    : attach.kind === 'document' ? structure.instantiate(fragment.nodes, 0, false)
    : structure.instantiate(fragment.nodes, attach.table, true);
  page.items.push({ kind: 'group', x: fragment.x, y: top, transform: [1, 0, 0, 1, 0, 0], clip: clip ? clipOps(fragment.width, fragment.height) : null, items: remap(fragment.items, map) });
  for (const slot of fragment.slots) {
    const absolute: Slot = { ...slot, x: slot.x + fragment.x, pen_x: slot.pen_x + fragment.x, y: slot.y + top, baseline: slot.baseline + top };
    const filled = fillSlot(absolute, scope.text(slot.name), scope.href(slot.name), fonts[slot.font]!, `${prefix}${slot.name}`);
    filled.node = slot.node == null ? undefined : map[slot.node];
    addSlotLink(filled, page, structure);
    page.fills.push(filled);
  }
  for (const link of fragment.links ?? []) {
    const node = link.node == null ? undefined : map[link.node];
    if (node === undefined) throw new Error(`a link to ${link.url} in ${prefix} would be placed as an artifact (a repeated table header or an overlay); PDF/UA forbids links there`);
    page.annots.push({ rects: link.rects.map(([x, y, w, h]) => [x + fragment.x, y + top, w, h]), url: link.url, contents: link.alt ?? link.url, node });
  }
  for (const bar of fragment.bars ?? []) {
    const filled = fillBar({ ...bar, x: bar.x + fragment.x, y: bar.y + top }, scope.number(bar.name), `${prefix}${bar.name}`);
    filled.node = bar.node == null ? undefined : map[bar.node];
    page.fills.push(filled);
  }
  for (const image of fragment.images ?? []) {
    const { bytes, alt } = scope.image(image.name);
    const filled = fillImage({ ...image, x: image.x + fragment.x, y: image.y + top }, bytes, alt, `${prefix}${image.name}`);
    filled.node = image.node == null ? undefined : map[image.node];
    if (filled.node !== undefined && filled.alt) structure.nodes[filled.node]!.alt = filled.alt;
    page.fills.push(filled);
  }
}

function composeFixed(doc: Document, data: unknown, fonts: Font[], structure: Structure): Composed[] {
  const scope = new Scope(data);
  return doc.pages.map((page, index) => {
    const map = structure.instantiate(page.nodes ?? [], 0, false);
    const composed: Composed = { width: page.width, height: page.height, items: remap(page.items, map), fills: [], annots: [] };
    for (const slot of doc.slots.filter(s => s.page === index)) {
      const filled = fillSlot(slot, scope.text(slot.name), scope.href(slot.name), fonts[slot.font]!, slot.name);
      filled.node = slot.node == null ? undefined : map[slot.node];
      addSlotLink(filled, composed, structure);
      composed.fills.push(filled);
    }
    for (const link of (doc.links ?? []).filter(l => l.page === index)) {
      composed.annots.push({ rects: link.rects, url: link.url, contents: link.alt ?? link.url, node: link.node == null ? undefined : map[link.node] });
    }
    for (const bar of (doc.bars ?? []).filter(b => b.page === index)) {
      const filled = fillBar(bar, scope.number(bar.name), bar.name);
      filled.node = bar.node == null ? undefined : map[bar.node];
      composed.fills.push(filled);
    }
    for (const image of (doc.images ?? []).filter(i => i.page === index)) {
      const { bytes, alt } = scope.image(image.name);
      const filled = fillImage(image, bytes, alt, image.name);
      filled.node = image.node == null ? undefined : map[image.node];
      if (filled.node !== undefined && filled.alt) structure.nodes[filled.node]!.alt = filled.alt;
      composed.fills.push(filled);
    }
    return composed;
  });
}

/** How many lines a wrapping slot would give `text`, measured as the dialect's `lines: auto` measures it in Typst:
 *  from the stacked height of the broken lines, so a line of nothing but whitespace counts for nothing. */
function neededLines(slot: Slot, text: string, font: Font, traceName: string): number {
  const pitch = slot.pitch ?? 0, size = slot.size;
  if (!(pitch > 0)) throw new Error(`slot \`${traceName}\`: a wrapping slot without a line pitch; export the document again`);
  const chars = [...text];
  const shaping = new Shaping(chars, font, size, traceName);
  const hyphenWidth = chars.includes(SHY) ? font.advance(glyphOrRefuse(font, SHY, traceName)) * size : 0;
  const widthOf = (from: number, to: number): number => shaping.widthOf(from, to);
  const broken = breakLines(chars, widthOf, width => slot.width + 1e-4 >= width, hyphenWidth);
  const lineHeight = slot.baseline - slot.y, leading = pitch - lineHeight;
  let y = 0;
  broken.forEach((l, k) => { const h = l.shapingEnd > l.start && l.layoutEnd === l.start && !l.hyphen ? 0 : lineHeight; if (k > 0) y += leading; y += h; });
  return Math.max(0, Math.round((y - lineHeight) / pitch)) + 1;
}

/** The variant of a band for one instance: `data` is the row (or the document for a choice block), `index` the row number. */
function pick(band: Band, data: unknown, index: number, fonts: Font[]): Fragment {
  const n = band.fragments.length;
  const select = band.select;
  if (n <= 1 || !select) return band.fragments[0]!;
  let k: number;
  if (select.kind === 'parity') k = index % 2;
  else if (select.kind === 'flag') k = (data as Record<string, unknown> | null)?.[select.path] === true ? 0 : 1;
  else {
    // A wrapping variant carries the line metrics; the slot has the same width in every variant.
    const measure = band.fragments[1]!.slots.find(s => s.name === select.slot);
    if (!measure) throw new Error(`band \`${band.name}\`: no slot \`${select.slot}\` to pick the variant by`);
    k = neededLines(measure, new Scope(data).text(select.slot), fonts[measure.font]!, `${band.name}.${select.slot}`) - 1;
  }
  return band.fragments[Math.min(Math.max(k, 0), n - 1)]!;
}

function composeFlow(flow: Flow, data: unknown, fonts: Font[], structure: Structure): Composed[] {
  const EPS = 1e-6;
  const area = flow.area, bottom = area.y + area.height;
  const band = (name: string): Band => { const b = flow.bands.find(b => b.name === name); if (!b) throw new Error(`unknown band \`${name}\``); return b; };
  const newPage = (): Composed => ({ width: flow.page_width, height: flow.page_height, items: [], fills: [], annots: [] });
  const scope = new Scope(data);
  const pages: Composed[] = [newPage()];
  let cursor = area.y;
  const last = () => pages[pages.length - 1]!;
  for (const block of flow.blocks) {
    if (block.kind === 'static' || block.kind === 'choice') {
      const b = block.kind === 'choice' ? band(block.band) : undefined;
      const f = b ? pick(b, data, 0, fonts) : (block as { fragment: Fragment }).fragment;
      if (cursor + f.height > bottom + EPS && cursor > area.y + EPS) { pages.push(newPage()); cursor = area.y; }
      place(f, cursor, scope, fonts, b ? `${b.name}.` : '', b !== undefined, last(), structure, { kind: 'document' });
      cursor += f.height;
    } else {
      const record = data as Record<string, unknown>;
      const rows = record?.[block.band];
      if (!Array.isArray(rows)) throw new Error(`data has no array \`${block.band}\` for the repeat region`);
      const rowBand = band(block.band);
      const headerBand = block.header ? band(block.header) : undefined;
      const header = headerBand?.fragments[0];
      const fragments = rows.map((row, i) => pick(rowBand, row, i, fonts));
      const headerHeight = header ? header.height + block.header_gap : 0;
      const firstRow = fragments.length ? fragments[0]!.height : 0;
      if (cursor + headerHeight + firstRow > bottom + EPS && cursor > area.y + EPS) { pages.push(newPage()); cursor = area.y; }
      const table = structure.add('Table', 0);
      if (header) { place(header, cursor, scope, fonts, `${headerBand!.name}.`, true, last(), structure, { kind: 'table', table }); cursor += headerHeight; }
      rows.forEach((row, i) => {
        const f = fragments[i]!;
        if (cursor + f.height > bottom + EPS) {
          pages.push(newPage()); cursor = area.y;
          if (header) { place(header, cursor, scope, fonts, `${headerBand!.name}.`, true, last(), structure, { kind: 'artifact' }); cursor += headerHeight; }
        }
        place(f, cursor, new Scope(row), fonts, `${block.band}[${i}].`, true, last(), structure, { kind: 'table', table });
        cursor += f.height;
        if (i + 1 < rows.length) cursor += block.gap;
      });
    }
  }
  pages.forEach((page, index) => {
    const s = new Scope(data, [index + 1, pages.length]);
    for (const overlay of flow.overlays) place(overlay, overlay.y, s, fonts, `page[${index}].`, true, page, structure, { kind: 'artifact' });
  });
  return pages;
}

// ---------------------------------------------------------------------------------------------------------
// PDF writing

const encoder = new TextEncoder();

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const num = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
const pdfString = (s: string): string => '(' + s.replace(/[\\()]/g, m => '\\' + m).replace(/[\r\n]/g, ' ') + ')';
const textString = (s: string): string => {
  // UTF-16BE with BOM, as a hex string, so any title or alt text survives.
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex}>`;
};
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class PdfWriter {
  private readonly objects: (Uint8Array | undefined)[] = [];
  alloc(): number { this.objects.push(undefined); return this.objects.length; }
  set(id: number, body: string): void { this.objects[id - 1] = encoder.encode(body); }
  setStream(id: number, dict: string, data: Uint8Array): void {
    const head = encoder.encode(`<< /Length ${data.length} ${dict} >>\nstream\n`);
    const tail = encoder.encode('\nendstream');
    const out = new Uint8Array(head.length + data.length + tail.length);
    out.set(head, 0); out.set(data, head.length); out.set(tail, head.length + data.length);
    this.objects[id - 1] = out;
  }
  finish(catalog: number, info: number): Uint8Array {
    const parts: Uint8Array[] = [encoder.encode('%PDF-1.7\n%âãÏÓ\n')];
    const offsets: number[] = [];
    let length = parts[0]!.length;
    this.objects.forEach((object, i) => {
      if (!object) throw new Error(`object ${i + 1} was allocated but never written`);
      offsets.push(length);
      const head = encoder.encode(`${i + 1} 0 obj\n`), tail = encoder.encode('\nendobj\n');
      parts.push(head, object, tail);
      length += head.length + object.length + tail.length;
    });
    const xref = length;
    let table = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) table += `${String(offset).padStart(10, '0')} 00000 n \n`;
    table += `trailer\n<< /Size ${this.objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    parts.push(encoder.encode(table));
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/** Builds one page's content stream with marked content around every item. */
class ContentBuilder {
  private ops: string[] = [];
  private open: number | null | undefined = undefined; // undefined: nothing open; null: artifact; number: node
  readonly parents: number[] = [];
  private readonly fonts: Font[];
  private readonly structure: Structure;
  private readonly page: number;
  /** Image XObject resource name per image key. */
  private readonly imageNames: Map<string, string>;

  constructor(fonts: Font[], structure: Structure, page: number, imageNames: Map<string, string>) { this.fonts = fonts; this.structure = structure; this.page = page; this.imageNames = imageNames; }

  private ensure(node: number | undefined): void {
    const want = node ?? null;
    if (this.open === want) return;
    this.close();
    if (want === null) this.ops.push('/Artifact BMC');
    else {
      const mcid = this.parents.length;
      this.parents.push(want);
      this.ops.push(`/${this.structure.nodes[want]!.role} << /MCID ${mcid} >> BDC`);
      this.structure.nodes[want]!.kids.push({ page: this.page, mcid });
    }
    this.open = want;
  }

  close(): void { if (this.open !== undefined) { this.ops.push('EMC'); this.open = undefined; } }

  private path(ops: PathOp[]): void {
    for (const op of ops) {
      if (op.op === 'move') this.ops.push(`${num(op.to[0])} ${num(op.to[1])} m`);
      else if (op.op === 'line') this.ops.push(`${num(op.to[0])} ${num(op.to[1])} l`);
      else if (op.op === 'cubic') this.ops.push(`${num(op.c1[0])} ${num(op.c1[1])} ${num(op.c2[0])} ${num(op.c2[1])} ${num(op.to[0])} ${num(op.to[1])} c`);
      else this.ops.push('h');
    }
  }

  emit(items: Item[]): void {
    for (const item of items) {
      switch (item.kind) {
        case 'group': {
          this.close();
          this.ops.push('q', `1 0 0 1 ${num(item.x)} ${num(item.y)} cm`);
          const t = item.transform;
          if (!(t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0)) this.ops.push(`${t.map(num).join(' ')} cm`);
          if (item.clip) { this.path(item.clip); this.ops.push('W n'); }
          this.emit(item.items);
          this.close();
          this.ops.push('Q');
          break;
        }
        case 'text': this.ensure(item.node); this.text(item); break;
        case 'shape': {
          this.ensure(item.node);
          this.ops.push('q', `1 0 0 1 ${num(item.x)} ${num(item.y)} cm`);
          if (item.fill) this.ops.push(`${num(item.fill.r)} ${num(item.fill.g)} ${num(item.fill.b)} rg`);
          const s = item.stroke;
          if (s) {
            this.ops.push(`${num(s.paint.r)} ${num(s.paint.g)} ${num(s.paint.b)} RG`, `${num(s.thickness)} w`,
              `${s.cap === 'round' ? 1 : s.cap === 'square' ? 2 : 0} J`, `${s.join === 'round' ? 1 : s.join === 'bevel' ? 2 : 0} j`, `${num(s.miter_limit)} M`);
            if (s.dash) this.ops.push(`[${s.dash.array.map(num).join(' ')}] ${num(s.dash.phase)} d`);
          }
          const g = item.geometry;
          if (g.kind === 'line') this.ops.push('0 0 m', `${num(g.to[0])} ${num(g.to[1])} l`);
          else if (g.kind === 'rect') this.ops.push(`0 0 ${num(g.width)} ${num(g.height)} re`);
          else this.path(g.ops);
          this.ops.push(item.fill && s ? 'B' : item.fill ? 'f' : s ? 'S' : 'n', 'Q');
          break;
        }
        case 'image': {
          this.ensure(item.node);
          const name = this.imageNames.get(item.sha256);
          if (!name) throw new Error(`image ${item.sha256} was not registered before the page was written`);
          // The page CTM flips y; this matrix flips the unit square back so the first row is at the top.
          this.ops.push('q', `${num(item.width)} 0 0 ${num(-item.height)} ${num(item.x)} ${num(item.y + item.height)} cm`, `/${name} Do`, 'Q');
          break;
        }
      }
    }
  }

  /** The page CTM flips y; the text matrix flips it back. TJ adjustments make the pen follow the exported advances. */
  private text(item: Item & { kind: 'text' }): void {
    const font = this.fonts[item.font]!;
    this.ops.push(`${num(item.fill.r)} ${num(item.fill.g)} ${num(item.fill.b)} rg`, 'BT', `/F${item.font} ${num(item.size)} Tf`, `1 0 0 -1 ${num(item.x)} ${num(item.y)} Tm`);
    let tj = '[';
    let pending = 0;
    for (const glyph of item.glyphs) {
      const shift = pending + glyph.x_offset;
      if (Math.abs(shift) > 1e-6) tj += `${num(-shift * 1000 / item.size)} `;
      tj += `<${glyph.id.toString(16).padStart(4, '0')}> `;
      pending = glyph.x_advance - glyph.x_offset - font.advance(glyph.id) * item.size;
    }
    this.ops.push(tj.trimEnd() + '] TJ', 'ET');
  }

  bytes(): Uint8Array { return encoder.encode(this.ops.join('\n')); }
}

function toUnicodeCmap(entries: [number, string][]): string {
  let out = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Custom def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    out += `${chunk.length} beginbfchar\n`;
    for (const [gid, text] of chunk) {
      let hex = '';
      for (let k = 0; k < text.length; k++) hex += text.charCodeAt(k).toString(16).padStart(4, '0');
      out += `<${gid.toString(16).padStart(4, '0')}> <${hex}>\n`;
    }
    out += 'endbfchar\n';
  }
  return out + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}

function xmp(title: string | undefined): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title ?? '')}</rdf:li></rdf:Alt></dc:title><pdf:Producer>paramdoc</pdf:Producer><pdfuaid:part>1</pdfuaid:part></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}

function usedGlyphs(items: Item[], used: Set<number>[], multi: Map<string, string>): void {
  for (const item of items) {
    if (item.kind === 'group') usedGlyphs(item.items, used, multi);
    else if (item.kind === 'text') for (const g of item.glyphs) { used[item.font]!.add(g.id); if (g.chars && !multi.has(`${item.font}:${g.id}`)) multi.set(`${item.font}:${g.id}`, g.chars); }
  }
}

function imageKeys(items: Item[], out: string[]): void {
  for (const item of items) {
    if (item.kind === 'group') imageKeys(item.items, out);
    else if (item.kind === 'image') out.push(item.sha256);
  }
}

async function writePdf(doc: Document, fonts: Font[], fontStreams: Uint8Array[], images: Images, pages: Composed[], structure: Structure): Promise<Uint8Array> {
  const pdf = new PdfWriter();
  const catalog = pdf.alloc(), pagesId = pdf.alloc(), info = pdf.alloc(), metadata = pdf.alloc(), structRoot = pdf.alloc();
  const fontRefs = fonts.map(() => pdf.alloc());
  const pageIds = pages.map(() => pdf.alloc());
  const title = doc.title ?? 'Document';
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /Metadata ${metadata} 0 R /StructTreeRoot ${structRoot} 0 R /MarkInfo << /Marked true >> /Lang ${pdfString(doc.lang ?? 'en')} /ViewerPreferences << /DisplayDocTitle true >> >>`);
  pdf.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pdf.set(info, `<< /Title ${textString(title)} /Producer (paramdoc) >>`);
  pdf.setStream(metadata, '/Type /Metadata /Subtype /XML', encoder.encode(xmp(doc.title ?? undefined)));

  // Fonts, embedded whole; ToUnicode from the glyph's characters (ligatures) or the font's cmap.
  const used = fonts.map(() => new Set<number>());
  const multi = new Map<string, string>();
  for (const page of pages) { usedGlyphs(page.items, used, multi); usedGlyphs(page.fills.flatMap(f => f.items), used, multi); }
  for (let i = 0; i < fonts.length; i++) {
    const font = fonts[i]!, meta = font.meta;
    const cid = pdf.alloc(), descriptor = pdf.alloc(), file = pdf.alloc(), toUnicode = pdf.alloc();
    const name = font.name;
    const truetype = meta.program === 'truetype';
    const scale = 1000 / meta.units_per_em;
    pdf.set(fontRefs[i]!, `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
    const widths = meta.advances.map(a => num(Math.round(a * scale * 1000) / 1000));
    pdf.set(cid, `<< /Type /Font /Subtype /${truetype ? 'CIDFontType2' : 'CIDFontType0'} /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 0 /W [0 [${widths.join(' ')}]]${truetype ? ' /CIDToGIDMap /Identity' : ''} >>`);
    const flags = 2 | 32 | (meta.italic ? 64 : 0);
    pdf.set(descriptor, `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [${meta.bbox.map(v => num(v * scale)).join(' ')}] /ItalicAngle ${num(meta.italic_angle)} /Ascent ${num(meta.ascender * scale)} /Descent ${num(meta.descender * scale)} /CapHeight ${num(meta.cap_height * scale)} /StemV 80 /${truetype ? 'FontFile2' : 'FontFile3'} ${file} 0 R >>`);
    const fileDict = truetype ? ` /Length1 ${font.data.length}` : meta.program === 'opentype-cff' ? ' /Subtype /OpenType' : ' /Subtype /CIDFontType0C';
    pdf.setStream(file, `/Filter /FlateDecode${fileDict}`, fontStreams[i]!);
    const entries: [number, string][] = [];
    for (const gid of [...used[i]!].sort((a, b) => a - b)) {
      const chars = multi.get(`${i}:${gid}`) ?? font.reverseCmap.get(gid);
      if (chars) entries.push([gid, chars]);
    }
    pdf.setStream(toUnicode, '', encoder.encode(toUnicodeCmap(entries)));
  }

  // Image XObjects: the static images by file, the images the data supplied by content; each written once.
  const wanted = new Map<string, Uint8Array | undefined>();
  for (const page of pages) {
    const keys: string[] = [];
    imageKeys(page.items, keys);
    for (const key of keys) if (!wanted.has(key)) wanted.set(key, undefined);
    for (const fill of page.fills) if (fill.image && !wanted.has(fill.image.key)) wanted.set(fill.image.key, fill.image.bytes);
  }
  const imageNames = new Map<string, string>();
  const imageRefs: [string, number][] = [];
  const decodedAll = await Promise.all([...wanted].map(async ([key, bytes]) => [key, await images.decoded(key, bytes)] as const));
  for (const [key, decoded] of decodedAll) {
    const id = pdf.alloc();
    let mask = '';
    if (decoded.smask) {
      const maskId = pdf.alloc();
      pdf.setStream(maskId, `/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, decoded.smask);
      mask = ` /SMask ${maskId} 0 R`;
    }
    pdf.setStream(id, `/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /${decoded.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /${decoded.dct ? 'DCTDecode' : 'FlateDecode'}${mask}`, decoded.data);
    const name = `Im${imageRefs.length}`;
    imageRefs.push([name, id]);
    imageNames.set(key, name);
  }
  const xobjects = imageRefs.length ? ` /XObject << ${imageRefs.map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >>` : '';

  // Link annotations: one object per link (several rectangles become quad points, as typst-pdf writes them for PDF/UA),
  // listed in the page's /Annots, keyed into the parent tree after the pages and referenced from their Link structure
  // element through an OBJR.
  const annotRefs = pages.map(page => page.annots.map(() => pdf.alloc()));
  const annotParents: [number, number][] = [];
  let nextKey = pages.length;
  pages.forEach((page, index) => page.annots.forEach((a, i) => {
    const h = page.height;
    const boxes = a.rects.map(([x, y, w, hh]) => [x, h - y - hh, x + w, h - y] as const); // left, bottom, right, top
    const l = Math.min(...boxes.map(b => b[0])), b = Math.min(...boxes.map(b => b[1])), r = Math.max(...boxes.map(b => b[2])), t = Math.max(...boxes.map(b => b[3]));
    let body = `<< /Type /Annot /Subtype /Link /Rect [${[l, b, r, t].map(num).join(' ')}] /P ${pageIds[index]} 0 R`;
    if (boxes.length > 1) body += ` /QuadPoints [${boxes.map(([l, b, r, t]) => [l, t, r, t, l, b, r, b].map(num).join(' ')).join(' ')}]`;
    body += ` /Border [0 0 0] /F 4 /Contents ${textString(a.contents)} /A << /Type /Action /S /URI /URI ${pdfString(a.url)} >>`;
    if (a.node !== undefined) { body += ` /StructParent ${nextKey}`; annotParents.push([nextKey, a.node]); nextKey++; }
    pdf.set(annotRefs[index]![i]!, body + ' >>');
  }));

  // Pages with marked content; each page's parent-tree array is written after the structure elements exist.
  const pageParents: number[][] = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const builder = new ContentBuilder(fonts, structure, index, imageNames);
    builder.emit([{ kind: 'group', x: 0, y: 0, transform: [1, 0, 0, -1, 0, page.height], items: page.items }]);
    // A hole's content is clipped to its box, exactly as Typst clips the box in the baseline document.
    for (const fill of page.fills) {
      const [x, y, w, h] = fill.rect;
      builder.emit([{ kind: 'group', x: 0, y: 0, transform: [1, 0, 0, -1, 0, page.height], clip: [{ op: 'move', to: [x, y] }, { op: 'line', to: [x + w, y] }, { op: 'line', to: [x + w, y + h] }, { op: 'line', to: [x, y + h] }, { op: 'close' }], items: fill.items.map(item => (item.kind === 'group' ? item : { ...item, node: fill.node })) }]);
    }
    builder.close();
    pageParents.push(builder.parents);
    const contentId = pdf.alloc();
    pdf.setStream(contentId, '', builder.bytes());
    const annots = annotRefs[index]!.length ? ` /Annots [${annotRefs[index]!.map(r => `${r} 0 R`).join(' ')}] /Tabs /S` : '';
    pdf.set(pageIds[index]!, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentId} 0 R /StructParents ${index}${annots} /Resources << /Font << ${fontRefs.map((r, i) => `/F${i} ${r} 0 R`).join(' ')} >>${xobjects} >> >>`);
  }

  // Structure tree: only nodes with content below them. Annotations are kids of their Link node.
  pages.forEach((page, index) => page.annots.forEach((a, i) => { if (a.node !== undefined) structure.nodes[a.node]!.kids.push({ page: index, annot: i }); }));
  const alive = structure.alive();
  const nodeRefs = alive.map(a => (a ? pdf.alloc() : undefined));
  const parentArrays = pages.map(() => pdf.alloc());
  const nums = [...parentArrays.map((r, i) => `${i} ${r} 0 R`), ...annotParents.map(([k, n]) => `${k} ${nodeRefs[n]} 0 R`)];
  pdf.set(structRoot, `<< /Type /StructTreeRoot /K [${nodeRefs[0]} 0 R] /ParentTree << /Nums [${nums.join(' ')}] >> /ParentTreeNextKey ${nextKey} >>`);
  pageParents.forEach((parents, i) => pdf.set(parentArrays[i]!, `[${parents.map(g => `${nodeRefs[g]} 0 R`).join(' ')}]`));
  structure.nodes.forEach((node, id) => {
    const ref = nodeRefs[id];
    if (!ref) return;
    const parent = node.parent == null ? structRoot : nodeRefs[node.parent]!;
    const kids = node.kids.map(k => 'mcid' in k ? `<< /Type /MCR /Pg ${pageIds[k.page]} 0 R /MCID ${k.mcid} >>` : 'annot' in k ? `<< /Type /OBJR /Obj ${annotRefs[k.page]![k.annot]} 0 R /Pg ${pageIds[k.page]} 0 R >>` : nodeRefs[k.node] ? `${nodeRefs[k.node]} 0 R` : '').filter(Boolean);
    let body = `<< /Type /StructElem /S /${node.role} /P ${parent} 0 R /K [${kids.join(' ')}]`;
    if (node.alt) body += ` /Alt ${textString(node.alt)}`;
    if (node.role === 'TH') body += ` /A << /O /Table /Scope /${node.scope === 'row' ? 'Row' : node.scope === 'both' ? 'Both' : 'Column'} >>`;
    pdf.set(ref, body + ' >>');
  });
  return pdf.finish(catalog, info);
}

// ---------------------------------------------------------------------------------------------------------
// Entry points

export interface Output { pdf: Uint8Array; trace: ReferenceSlot[]; pages: number }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Runtime {
  readonly document: Document;
  private readonly fonts: Font[];
  /** The font programs, compressed once: they are the same in every output. */
  private readonly fontStreams: Uint8Array[];
  private readonly images: Images;
  private constructor(document: Document, fonts: Font[], fontStreams: Uint8Array[], images: Images) { this.document = document; this.fonts = fonts; this.fontStreams = fontStreams; this.images = images; }

  /** `fonts` are the font files in the document's order; their hashes are checked. `images` are the document's
   *  image files (any order, matched by hash), needed only when the static content draws images. */
  static async create(docJson: string | Uint8Array, fonts: Uint8Array[], images: Uint8Array[] = []): Promise<Runtime> {
    const doc: Document = JSON.parse(typeof docJson === 'string' ? docJson : new TextDecoder().decode(docJson));
    if (doc.version !== IR_VERSION) throw new Error(`the document is IR version ${doc.version}, this runtime reads ${IR_VERSION}`);
    if (fonts.length !== doc.fonts.length) throw new Error(`the document lists ${doc.fonts.length} font(s) but ${fonts.length} were supplied`);
    const parsed: Font[] = [];
    for (let i = 0; i < fonts.length; i++) {
      const sha = await sha256Hex(fonts[i]!);
      if (sha !== doc.fonts[i]!.sha256) throw new Error(`${doc.fonts[i]!.file}: sha256 ${sha} does not match the document's ${doc.fonts[i]!.sha256}`);
      parsed.push(new Font(doc.fonts[i]!, fonts[i]!));
    }
    const byHash = new Map<string, Uint8Array>();
    for (const bytes of images) byHash.set(await sha256Hex(bytes), bytes);
    const files = new Map<string, Uint8Array>();
    for (const file of doc.image_files ?? []) {
      const bytes = byHash.get(file.sha256);
      if (!bytes) throw new Error(`the document needs image file ${file.file} (sha256 ${file.sha256}), which was not supplied`);
      files.set(file.sha256, bytes);
    }
    return new Runtime(doc, parsed, await Promise.all(parsed.map(f => deflate(f.data))), new Images(files));
  }

  async fill(data: unknown): Promise<Output> {
    const structure = new Structure();
    const pages = this.document.flow ? composeFlow(this.document.flow, data, this.fonts, structure) : composeFixed(this.document, data, this.fonts, structure);
    const pdf = await writePdf(this.document, this.fonts, this.fontStreams, this.images, pages, structure);
    const trace = pages.flatMap(p => p.fills.flatMap(f => f.link ? [f.trace, { name: `${f.trace.name}#link`, baseline: 0, size: 0, glyphs: [], rects: f.link.rects }] : [f.trace]));
    return { pdf, trace, pages: pages.length };
  }
}

/** Differences between what the runtime drew and a reference layout (Typst's, or the Rust runtime's trace). */
export function compare(trace: ReferenceSlot[], reference: ReferenceSlot[]): string[] {
  const problems: string[] = [];
  const byName = new Map(reference.map(s => [s.name, s]));
  for (const slot of trace) {
    const expected = byName.get(slot.name);
    if (!expected) { problems.push(`${slot.name}: not in the reference`); continue; }
    if (Math.abs(slot.baseline - expected.baseline) > 1e-3) problems.push(`${slot.name}: baseline ${slot.baseline.toFixed(3)} vs ${expected.baseline.toFixed(3)}`);
    if (expected.glyphs.length && Math.abs(slot.size - expected.size) > 1e-3) problems.push(`${slot.name}: size ${slot.size.toFixed(3)} vs ${expected.size.toFixed(3)}`); // an empty value shows no size
    if (expected.rect) {
      if (!slot.rect) problems.push(`${slot.name}: the reference has a box, the runtime drew none`);
      else if (!slot.rect.every((v, i) => Math.abs(v - expected.rect![i]!) <= 1e-3)) problems.push(`${slot.name}: box [${slot.rect.map(num).join(', ')}] vs [${expected.rect.map(num).join(', ')}]`);
    }
    if (expected.rects) {
      if (!slot.rects) problems.push(`${slot.name}: the reference has link rectangles, the runtime drew none`);
      else if (slot.rects.length !== expected.rects.length || !slot.rects.every((r, i) => r.every((v, j) => Math.abs(v - expected.rects![i]![j]!) <= 1e-3))) problems.push(`${slot.name}: link rectangles ${JSON.stringify(slot.rects.map(r => r.map(num)))} vs ${JSON.stringify(expected.rects.map(r => r.map(num)))}`);
    }
    if (expected.ops && !(slot.ops && sameOps(slot.ops, expected.ops, 1e-3))) problems.push(`${slot.name}: shape ${JSON.stringify(slot.ops)} vs ${JSON.stringify(expected.ops)}`);
    const ours = slot.glyphs.map(g => g.id).join(','), theirs = expected.glyphs.map(g => g.id).join(',');
    if (ours !== theirs) { problems.push(`${slot.name}: glyphs [${ours}] vs [${theirs}]`); continue; }
    for (let i = 0; i < slot.glyphs.length; i++) {
      const ours = slot.glyphs[i]!, theirs = expected.glyphs[i]!;
      if (Math.abs(ours.x - theirs.x) > 1e-3) { problems.push(`${slot.name}: glyph ${i} at x ${ours.x.toFixed(4)} vs ${theirs.x.toFixed(4)}`); break; }
      if (ours.y !== undefined && theirs.y !== undefined && Math.abs(ours.y - theirs.y) > 1e-3) { problems.push(`${slot.name}: glyph ${i} at y ${ours.y.toFixed(4)} vs ${theirs.y.toFixed(4)}`); break; }
    }
  }
  for (const expected of reference) if (!trace.some(s => s.name === expected.name)) problems.push(`${expected.name}: in the reference but not drawn`);
  return problems;
}
