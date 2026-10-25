// paramdoc runtime in TypeScript: fills an exported parametric document with data and writes a tagged PDF.
// A port of ../runtime/src/lib.rs with the same contract: no typesetter, no shaper, slots filled through the
// font's cmap and advances, flow documents composed page by page, structure tree assembled per document.
// Fonts arrive subset by the exporter with their metrics, advances and character map in the document, so no
// font file is parsed here. The font programs are compressed once per runtime with the platform's
// CompressionStream (so creation is asynchronous); the small per-document streams are written uncompressed,
// because CompressionStream costs milliseconds per call in browsers. Erasable TypeScript only, so Node can run it
// with `--experimental-strip-types` and a bundler can ship it to a browser unchanged.

export const IR_VERSION = 6;

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
  | { kind: 'image'; x: number; y: number; width: number; height: number; format: string; sha256: string; node?: number };
export interface Node { role: string; parent: number | null; alt?: string; scope?: string }
export interface Slot {
  name: string; page: number; x: number; y: number; width: number; height: number; baseline: number; descent: number;
  pen_x: number; font: number; size: number; fill: Color; align: string; overflow: string; max_length?: number | null; lines?: number; pitch?: number; auto_lines?: number | null;
  sample: string; node?: number;
}
export interface Fragment { x: number; y: number; width: number; height: number; items: Item[]; slots: Slot[]; nodes: Node[] }
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
export interface Document { version: number; title?: string | null; lang?: string | null; fonts: FontRef[]; pages: Page[]; slots: Slot[]; flow?: Flow | null }

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
export interface ReferenceSlot { name: string; baseline: number; size: number; glyphs: ReferenceGlyph[] }
interface Filled { slot: Slot; items: (Item & { kind: 'text' })[]; trace: ReferenceSlot; node?: number }

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`cannot render ${JSON.stringify(value)} as text`);
}

function fillSlot(slot: Slot, text: string, font: Font, traceName: string): Filled {
  const length = [...text].length;
  if (slot.max_length != null && length > slot.max_length) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} has ${length} characters, max-length is ${slot.max_length}`);
  if ((slot.lines ?? 1) > 1) return fillLines(slot, text, font, traceName);
  const shape = (s: string, size: number): [Glyph[], number] => {
    const glyphs: Glyph[] = [];
    let width = 0;
    for (const c of s) {
      const id = font.glyph(c);
      if (id === undefined) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) is not in the slot's repertoire; declare it with \`charset:\` in the template`);
      const advance = font.advance(id) * size;
      glyphs.push({ id, x_advance: advance, x_offset: 0, y_offset: 0 });
      width += advance;
    }
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
  return {
    slot,
    items: [{ kind: 'text', x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs }],
    trace: { name: traceName, baseline: slot.baseline, size, glyphs: traceGlyphs },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Wrapping slots: Typst's simple line breaker (typst-layout 0.15, inline/linebreak.rs) over UAX #14 break
// opportunities, for the character classes a Latin repertoire contains. The dialect switches hyphenation and
// justification off inside wrapping slots, so greedy first fit over advance widths reproduces Typst's lines.

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
};
/** Digits are the ASCII ones and combining marks the main combining blocks, in both runtimes alike. */
const lineBreakClass = (c: string): LB => LB_CLASS[c] ?? (/^[0-9]$/.test(c) ? 'NU' : /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]$/.test(c) ? 'CM' : 'AL');
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
  const out: { end: number; mandatory: boolean }[] = [];
  for (let i = 1; i < n; i++) if (allow(i)) out.push({ end: i, mandatory: raw[i - 1] === 'BK' });
  out.push({ end: n, mandatory: true });
  return out;
}

/** A line of a wrapping slot: `layoutEnd` excludes the trailing whitespace that does not count for the width;
 *  `shapingEnd` includes it (Typst draws those glyphs at zero advance). */
interface BrokenLine { start: number; layoutEnd: number; shapingEnd: number; width: number }
/** A line as drawn: the first `kept` glyphs count for the width, the rest are trimmed trailing whitespace at zero advance. */
interface LineRun { ids: number[]; advances: number[]; text: string; width: number; kept: number }
const isSpaceGlyph = (c: string): boolean => c === ' ' || c === '\u00a0' || c === '\u3000';

/** Typst's simple breaker: greedy first fit, a mandatory break or a line that does not fit even on its own
 *  committed as it is (an overlong word overflows, as in Typst). */
function breakLines(chars: string[], widthOf: (from: number, to: number) => number, fits: (width: number) => boolean): BrokenLine[] {
  const line = (start: number, end: number, mandatory: boolean): BrokenLine => {
    let shapingEnd = end, layoutEnd = end;
    if (mandatory) { while (shapingEnd > start && isMandatoryBreak(chars[shapingEnd - 1]!)) shapingEnd--; layoutEnd = shapingEnd; }
    else while (layoutEnd > start && (isWhitespace(chars[layoutEnd - 1]!) || isDefaultIgnorable(chars[layoutEnd - 1]!))) layoutEnd--;
    return { start, layoutEnd, shapingEnd, width: widthOf(start, layoutEnd) };
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

function fillLines(slot: Slot, text: string, font: Font, traceName: string): Filled {
  const lines = slot.lines!, pitch = slot.pitch ?? 0, size = slot.size;
  if (!(pitch > 0)) throw new Error(`slot \`${traceName}\`: a wrapping slot without a line pitch; export the document again`);
  if (slot.overflow === 'shrink') throw new Error(`slot \`${traceName}\`: \`shrink\` is not an overflow policy for a wrapping slot`);
  if (text.includes('://') || text.includes('www.')) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} contains a web address, which Typst breaks by rules this runtime does not have yet`);
  const chars = [...text];
  const glyphOf = (c: string): number => {
    const id = font.glyph(c);
    if (id === undefined) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) is not in the slot's repertoire; declare it with \`charset:\` in the template`);
    return id;
  };
  const ids: (number | undefined)[] = new Array<number | undefined>(chars.length);
  const idAt = (i: number): number => (ids[i] ??= glyphOf(chars[i]!));
  const widthOf = (from: number, to: number): number => { let w = 0; for (let i = from; i < to; i++) w += font.advance(idAt(i)) * size; return w; };
  const fits = (width: number): boolean => slot.width + 1e-4 >= width; // Typst's `Abs::fits`
  const run = (cs: string[], kept: number): LineRun => {
    const ids = cs.map(glyphOf);
    const advances = ids.map((id, i) => (i < kept ? font.advance(id) * size : 0));
    let width = advances.reduce((w, a) => w + a, 0);
    if (!fits(width)) {
      // Typst shrinks the spaces of a line that does not fit by up to a third of their width (`par.justification-limits`,
      // spacing min 2/3) before letting it overflow; it does so for ragged lines too.
      const shrinkable = advances.map((a, i) => (i < kept && isSpaceGlyph(cs[i]!) ? Math.min(a / 3, a * 0.75) : 0));
      const shrinkability = shrinkable.reduce((w, a) => w + a, 0);
      if (shrinkability > 0) {
        const ratio = Math.max((slot.width - width) / shrinkability, -1);
        for (let i = 0; i < advances.length; i++) advances[i]! += ratio * shrinkable[i]!;
        width = advances.reduce((w, a) => w + a, 0);
      }
    }
    return { ids, advances, text: cs.join(''), width, kept };
  };
  const render = (l: BrokenLine): LineRun => run(chars.slice(l.start, l.shapingEnd), l.layoutEnd - l.start);
  const ellipsize = (l: BrokenLine): LineRun => {
    const ellipsis = [...(font.glyph('…') !== undefined ? '…' : '...')];
    const kept = chars.slice(l.start, l.layoutEnd);
    const trimmed = (): string[] => { while (kept.length && isWhitespace(kept[kept.length - 1]!)) kept.pop(); return kept; };
    let shown = run([...trimmed(), ...ellipsis], kept.length + ellipsis.length);
    while (!fits(shown.width) && kept.length) { kept.pop(); shown = run([...trimmed(), ...ellipsis], kept.length + ellipsis.length); }
    return shown;
  };

  const broken = breakLines(chars, widthOf, fits);
  let runs = broken.map(render);
  // Lines stack as Typst stacks them: a line is as tall as the line height, except that a line of nothing but
  // trimmed whitespace has no height; `leading` separates lines. The first baseline is the slot's.
  const lineHeight = slot.baseline - slot.y, leading = pitch - lineHeight;
  const baselines = (rs: LineRun[]): number[] => { let y = slot.y; return rs.map((r, k) => { const h = r.ids.length > 0 && r.kept === 0 ? 0 : lineHeight; if (k > 0) y += leading; y += h; return y; }); };
  const bottom = slot.y + slot.height + 1e-6;
  const visible = baselines(runs).filter(b => b <= bottom).length;
  const overlong = runs.findIndex(r => !fits(r.width));
  if (overlong >= 0 || visible < runs.length) switch (slot.overflow) {
    case 'error':
      if (overlong >= 0) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(runs[overlong]!.text)} is ${runs[overlong]!.width.toFixed(2)} pt wide but the slot is ${slot.width.toFixed(2)} pt; declare an overflow policy or a smaller max-length`);
      throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} needs ${runs.length} lines but the slot holds ${lines}; declare an overflow policy or a smaller max-length`);
    case 'clip': runs = runs.slice(0, visible); break; // overlong lines stay, clipped by the box as in Typst
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
    const glyphs: Glyph[] = line.ids.map((id, i) => { traceGlyphs.push({ id, x: pen, y }); pen += line.advances[i]!; return { id, x_advance: line.advances[i]!, x_offset: 0, y_offset: 0 }; });
    if (glyphs.length) items.push({ kind: 'text', x, y, font: slot.font, size, fill: slot.fill, text: line.text, glyphs });
  });
  // The trace reports the first line's baseline as Typst's frame has it: at the box top when that line is whitespace.
  return { slot, items, trace: { name: traceName, baseline: ys[0] ?? slot.baseline, size, glyphs: traceGlyphs } };
}

// ---------------------------------------------------------------------------------------------------------
// Structure

type Kid = { node: number } | { page: number; mcid: number };
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
      alive[i] = this.nodes[i]!.kids.some(k => 'mcid' in k || alive[k.node]!);
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

interface Composed { width: number; height: number; items: Item[]; fills: Filled[] }
type Attach = { kind: 'document' } | { kind: 'artifact' } | { kind: 'table'; table: number };

class Scope {
  private readonly data: unknown;
  private readonly counters: [number, number] | undefined;
  constructor(data: unknown, counters?: [number, number]) { this.data = data; this.counters = counters; }
  text(name: string): string {
    if (this.counters) {
      if (name === 'page-number') return String(this.counters[0]);
      if (name === 'page-count') return String(this.counters[1]);
    }
    const record = this.data as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || !(name in record)) throw new Error(`data has no value for slot \`${name}\``);
    return textOf(record[name]);
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
    const filled = fillSlot(absolute, scope.text(slot.name), fonts[slot.font]!, `${prefix}${slot.name}`);
    filled.node = slot.node == null ? undefined : map[slot.node];
    page.fills.push(filled);
  }
}

function composeFixed(doc: Document, data: unknown, fonts: Font[], structure: Structure): Composed[] {
  const scope = new Scope(data);
  return doc.pages.map((page, index) => {
    const map = structure.instantiate(page.nodes ?? [], 0, false);
    const composed: Composed = { width: page.width, height: page.height, items: remap(page.items, map), fills: [] };
    for (const slot of doc.slots.filter(s => s.page === index)) {
      const filled = fillSlot(slot, scope.text(slot.name), fonts[slot.font]!, slot.name);
      filled.node = slot.node == null ? undefined : map[slot.node];
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
  if (text.includes('://') || text.includes('www.')) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} contains a web address, which Typst breaks by rules this runtime does not have yet`);
  const chars = [...text];
  const ids = chars.map(c => {
    if (isMandatoryBreak(c)) return 0;
    const id = font.glyph(c);
    if (id === undefined) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) is not in the slot's repertoire; declare it with \`charset:\` in the template`);
    return id;
  });
  const widthOf = (from: number, to: number): number => { let w = 0; for (let i = from; i < to; i++) w += font.advance(ids[i]!) * size; return w; };
  const broken = breakLines(chars, widthOf, width => slot.width + 1e-4 >= width);
  const lineHeight = slot.baseline - slot.y, leading = pitch - lineHeight;
  let y = 0;
  broken.forEach((l, k) => { const h = l.shapingEnd > l.start && l.layoutEnd === l.start ? 0 : lineHeight; if (k > 0) y += leading; y += h; });
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
  const newPage = (): Composed => ({ width: flow.page_width, height: flow.page_height, items: [], fills: [] });
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
  private warnedImages = false;
  private readonly fonts: Font[];
  private readonly structure: Structure;
  private readonly page: number;

  constructor(fonts: Font[], structure: Structure, page: number) { this.fonts = fonts; this.structure = structure; this.page = page; }

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
        case 'image':
          if (!this.warnedImages) { console.warn('warning: images are not drawn yet'); this.warnedImages = true; }
          break;
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

async function writePdf(doc: Document, fonts: Font[], fontStreams: Uint8Array[], pages: Composed[], structure: Structure): Promise<Uint8Array> {
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

  // Pages with marked content; each page's parent-tree array is written after the structure elements exist.
  const pageParents: number[][] = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const builder = new ContentBuilder(fonts, structure, index);
    builder.emit([{ kind: 'group', x: 0, y: 0, transform: [1, 0, 0, -1, 0, page.height], items: page.items }]);
    for (const fill of page.fills) {
      builder.emit([{ kind: 'group', x: 0, y: 0, transform: [1, 0, 0, -1, 0, page.height], clip: [{ op: 'move', to: [fill.slot.x, fill.slot.y] }, { op: 'line', to: [fill.slot.x + fill.slot.width, fill.slot.y] }, { op: 'line', to: [fill.slot.x + fill.slot.width, fill.slot.y + fill.slot.height] }, { op: 'line', to: [fill.slot.x, fill.slot.y + fill.slot.height] }, { op: 'close' }], items: fill.items.map(item => ({ ...item, node: fill.node })) }]);
    }
    builder.close();
    pageParents.push(builder.parents);
    const contentId = pdf.alloc();
    pdf.setStream(contentId, '', builder.bytes());
    pdf.set(pageIds[index]!, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentId} 0 R /StructParents ${index} /Resources << /Font << ${fontRefs.map((r, i) => `/F${i} ${r} 0 R`).join(' ')} >> >> >>`);
  }

  // Structure tree: only nodes with content below them.
  const alive = structure.alive();
  const nodeRefs = alive.map(a => (a ? pdf.alloc() : undefined));
  const parentArrays = pages.map(() => pdf.alloc());
  pdf.set(structRoot, `<< /Type /StructTreeRoot /K [${nodeRefs[0]} 0 R] /ParentTree << /Nums [${parentArrays.map((r, i) => `${i} ${r} 0 R`).join(' ')}] >> /ParentTreeNextKey ${pages.length} >>`);
  pageParents.forEach((parents, i) => pdf.set(parentArrays[i]!, `[${parents.map(g => `${nodeRefs[g]} 0 R`).join(' ')}]`));
  structure.nodes.forEach((node, id) => {
    const ref = nodeRefs[id];
    if (!ref) return;
    const parent = node.parent == null ? structRoot : nodeRefs[node.parent]!;
    const kids = node.kids.map(k => 'mcid' in k ? `<< /Type /MCR /Pg ${pageIds[k.page]} 0 R /MCID ${k.mcid} >>` : nodeRefs[k.node] ? `${nodeRefs[k.node]} 0 R` : '').filter(Boolean);
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
  private constructor(document: Document, fonts: Font[], fontStreams: Uint8Array[]) { this.document = document; this.fonts = fonts; this.fontStreams = fontStreams; }

  /** `fonts` are the font files in the document's order; their hashes are checked. */
  static async create(docJson: string | Uint8Array, fonts: Uint8Array[]): Promise<Runtime> {
    const doc: Document = JSON.parse(typeof docJson === 'string' ? docJson : new TextDecoder().decode(docJson));
    if (doc.version !== IR_VERSION) throw new Error(`the document is IR version ${doc.version}, this runtime reads ${IR_VERSION}`);
    if (fonts.length !== doc.fonts.length) throw new Error(`the document lists ${doc.fonts.length} font(s) but ${fonts.length} were supplied`);
    const parsed: Font[] = [];
    for (let i = 0; i < fonts.length; i++) {
      const sha = await sha256Hex(fonts[i]!);
      if (sha !== doc.fonts[i]!.sha256) throw new Error(`${doc.fonts[i]!.file}: sha256 ${sha} does not match the document's ${doc.fonts[i]!.sha256}`);
      parsed.push(new Font(doc.fonts[i]!, fonts[i]!));
    }
    return new Runtime(doc, parsed, await Promise.all(parsed.map(f => deflate(f.data))));
  }

  async fill(data: unknown): Promise<Output> {
    const structure = new Structure();
    const pages = this.document.flow ? composeFlow(this.document.flow, data, this.fonts, structure) : composeFixed(this.document, data, this.fonts, structure);
    const pdf = await writePdf(this.document, this.fonts, this.fontStreams, pages, structure);
    return { pdf, trace: pages.flatMap(p => p.fills.map(f => f.trace)), pages: pages.length };
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
