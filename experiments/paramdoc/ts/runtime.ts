// paramdoc runtime in TypeScript: fills an exported parametric document with data and writes a tagged PDF.
// A port of ../runtime/src/lib.rs with the same contract: no typesetter, no shaper, slots filled through the
// font's cmap and advances, flow documents composed page by page, structure tree assembled per document.
// Fonts arrive subset by the exporter with their metrics, advances and character map in the document, so no
// font file is parsed here. The font programs are compressed once per runtime with the platform's
// CompressionStream (so creation is asynchronous); the small per-document streams are written uncompressed,
// because CompressionStream costs milliseconds per call in browsers. Erasable TypeScript only, so Node can run it
// with `--experimental-strip-types` and a bundler can ship it to a browser unchanged.

export const IR_VERSION = 4;

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
  pen_x: number; font: number; size: number; fill: Color; align: string; overflow: string; max_length?: number | null;
  sample: string; node?: number;
}
export interface Fragment { x: number; y: number; width: number; height: number; items: Item[]; slots: Slot[]; nodes: Node[] }
export interface Band { name: string; repeat_on_break: boolean; fragment: Fragment }
export type Block =
  | { kind: 'static'; fragment: Fragment }
  | { kind: 'repeat'; band: string; header: string | null; header_gap: number; gap: number; sample_rows: number };
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

export interface ReferenceGlyph { id: number; x: number }
export interface ReferenceSlot { name: string; baseline: number; size: number; glyphs: ReferenceGlyph[] }
interface Filled { slot: Slot; item: Item & { kind: 'text' }; trace: ReferenceSlot; node?: number }

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`cannot render ${JSON.stringify(value)} as text`);
}

function fillSlot(slot: Slot, text: string, font: Font, traceName: string): Filled {
  const length = [...text].length;
  if (slot.max_length != null && length > slot.max_length) throw new Error(`slot \`${traceName}\`: ${JSON.stringify(text)} has ${length} characters, max-length is ${slot.max_length}`);
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
  const traceGlyphs = glyphs.map(g => { const at = pen; pen += g.x_advance; return { id: g.id, x: at }; });
  return {
    slot,
    item: { kind: 'text', x, y: slot.baseline, font: slot.font, size, fill: slot.fill, text: shown, glyphs },
    trace: { name: traceName, baseline: slot.baseline, size, glyphs: traceGlyphs },
  };
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
    if (block.kind === 'static') {
      const f = block.fragment;
      if (cursor + f.height > bottom + EPS && cursor > area.y + EPS) { pages.push(newPage()); cursor = area.y; }
      place(f, cursor, scope, fonts, '', false, last(), structure, { kind: 'document' });
      cursor += f.height;
    } else {
      const record = data as Record<string, unknown>;
      const rows = record?.[block.band];
      if (!Array.isArray(rows)) throw new Error(`data has no array \`${block.band}\` for the repeat region`);
      const rowBand = band(block.band);
      const headerBand = block.header ? band(block.header) : undefined;
      const headerHeight = headerBand ? headerBand.fragment.height + block.header_gap : 0;
      const firstRow = rows.length ? rowBand.fragment.height : 0;
      if (cursor + headerHeight + firstRow > bottom + EPS && cursor > area.y + EPS) { pages.push(newPage()); cursor = area.y; }
      const table = structure.add('Table', 0);
      if (headerBand) { place(headerBand.fragment, cursor, scope, fonts, `${headerBand.name}.`, true, last(), structure, { kind: 'table', table }); cursor += headerHeight; }
      rows.forEach((row, i) => {
        if (cursor + rowBand.fragment.height > bottom + EPS) {
          pages.push(newPage()); cursor = area.y;
          if (headerBand) { place(headerBand.fragment, cursor, scope, fonts, `${headerBand.name}.`, true, last(), structure, { kind: 'artifact' }); cursor += headerHeight; }
        }
        place(rowBand.fragment, cursor, new Scope(row), fonts, `${block.band}[${i}].`, true, last(), structure, { kind: 'table', table });
        cursor += rowBand.fragment.height;
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
  for (const page of pages) { usedGlyphs(page.items, used, multi); usedGlyphs(page.fills.map(f => f.item), used, multi); }
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
      builder.emit([{ kind: 'group', x: 0, y: 0, transform: [1, 0, 0, -1, 0, page.height], clip: [{ op: 'move', to: [fill.slot.x, fill.slot.y] }, { op: 'line', to: [fill.slot.x + fill.slot.width, fill.slot.y] }, { op: 'line', to: [fill.slot.x + fill.slot.width, fill.slot.y + fill.slot.height] }, { op: 'line', to: [fill.slot.x, fill.slot.y + fill.slot.height] }, { op: 'close' }], items: [{ ...fill.item, node: fill.node }] }]);
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
    if (Math.abs(slot.size - expected.size) > 1e-3) problems.push(`${slot.name}: size ${slot.size.toFixed(3)} vs ${expected.size.toFixed(3)}`);
    const ours = slot.glyphs.map(g => g.id).join(','), theirs = expected.glyphs.map(g => g.id).join(',');
    if (ours !== theirs) { problems.push(`${slot.name}: glyphs [${ours}] vs [${theirs}]`); continue; }
    for (let i = 0; i < slot.glyphs.length; i++) {
      if (Math.abs(slot.glyphs[i]!.x - expected.glyphs[i]!.x) > 1e-3) { problems.push(`${slot.name}: glyph ${i} at x ${slot.glyphs[i]!.x.toFixed(4)} vs ${expected.glyphs[i]!.x.toFixed(4)}`); break; }
    }
  }
  for (const expected of reference) if (!trace.some(s => s.name === expected.name)) problems.push(`${expected.name}: in the reference but not drawn`);
  return problems;
}
