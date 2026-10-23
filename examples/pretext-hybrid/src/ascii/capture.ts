import { defineTemplate, type TemplateDefinition } from '@typfolio/core';
import {
  ART_PADDING,
  CELL_WIDTH,
  COLS,
  FONT_SIZE,
  LINE_HEIGHT,
  ROWS,
  STAGE_H,
  STAGE_W,
  TARGET_ROW_W,
  type Frame,
} from './engine.ts';

/** Palette colours shared by the live stage (CSS) and the Typst template. */
export const COLORS = { background: '#07070c', ink: '#c4a35a' } as const;

/** Measured placement: `{t:"g"}` is a horizontal gap, `{t:"c"}` a glyph. */
type JsonCell =
  | { t: 'g'; w: number }
  | { t: 'c'; c: string; fw: number; a: number };

export interface AsciiFrameInput {
  cols: number;
  rows: number;
  fontSize: number;
  lineHeight: number;
  pageW: number;
  pageH: number;
  padding: number;
  /** Distance from the top of a row's line box to its baseline, measured from the DOM. */
  baseline: number;
  background: string;
  ink: string;
  /** One entry per PDF page; a single capture has one, a flipbook several. */
  frames: { lines: { cells: JsonCell[] }[] }[];
  /** Benchmark knob: iterations of a pure Typst script loop (no visual effect). */
  burn: number;
}

/** Round to 1/1000 px: enough for sub-pixel parity, keeps the JSON compact. */
const r3 = (value: number): number => Math.round(value * 1000) / 1000;

function frameLines(frame: Frame): AsciiFrameInput['frames'][number] {
  return {
    lines: frame.rows.map(cells => {
      const out: JsonCell[] = [];
      let advance = 0;
      for (const [index, cell] of cells.entries()) {
        if (cell === null) continue;
        // Keep the source grid's full width even when most cells are empty.
        // Pretext's measured width centers each proportional glyph in its slot;
        // wide edge glyphs stay inside the artwork border.
        const x = Math.max(0, Math.min(
          TARGET_ROW_W - cell.entry.width,
          (index + 0.5) * CELL_WIDTH - cell.entry.width / 2,
        ));
        const gap = r3(x - advance);
        if (gap !== 0) out.push({ t: 'g', w: gap });
        out.push({ t: 'c', c: cell.entry.char, fw: cell.entry.weight, a: cell.alphaIndex / 10 });
        advance = x + cell.entry.width;
      }
      return { cells: out };
    }),
  };
}

export function framesToInput(
  frames: readonly Frame[],
  baseline: number,
  burn = 0,
): AsciiFrameInput {
  return {
    cols: COLS,
    rows: ROWS,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    pageW: STAGE_W,
    pageH: STAGE_H,
    padding: ART_PADDING,
    baseline: r3(baseline),
    background: COLORS.background,
    ink: COLORS.ink,
    frames: frames.map(frameLines),
    burn,
  };
}

/**
 * Pretext measured the glyphs; JS centers them in a fixed grid. Typst does no
 * line breaking and no centering: it receives the measured gaps and draws.
 *
 * Kerning and ligatures are disabled so each glyph retains its independently
 * measured advance.
 */
const asciiSource = String.raw`
#let input = json("/frames.json")
#let ink = rgb(input.ink)

#set page(width: input.pageW * 1pt, height: input.pageH * 1pt, margin: 0pt, fill: rgb(input.background))
#set text(
  font: "Libertinus Serif",
  size: input.fontSize * 1pt,
  kerning: false,
  ligatures: false,
  discretionary-ligatures: false,
  historical-ligatures: false,
  top-edge: "baseline",
  bottom-edge: "baseline",
)
#set par(leading: 0pt, spacing: 0pt, justify: false)
#set document(title: "Variable typographic ASCII")

// Synthetic load for the live-mode benchmark: pure script work, no visual effect.
#let burn = range(input.burn).fold(0, (acc, n) => acc + calc.sin(n))

#let row-content(row) = box({
  for cell in row.cells {
    if cell.t == "g" {
      h(cell.w * 1pt)
    } else {
      text(weight: cell.fw, fill: ink.transparentize((1 - cell.a) * 100%))[#cell.c]
    }
  }
})

#for (page, frame) in input.frames.enumerate() {
  if page > 0 { pagebreak() }
  place(
    top + left,
    dx: input.padding * 1pt,
    dy: input.padding * 1pt,
    rect(
      width: (input.pageW - 2 * input.padding) * 1pt,
      height: (input.rows * input.lineHeight) * 1pt,
      fill: none,
      stroke: (paint: ink.transparentize(40%), thickness: 1pt),
    ),
  )
  for (index, row) in frame.lines.enumerate() {
    place(
      top + left,
      dx: input.padding * 1pt,
      dy: (input.padding + index * input.lineHeight + input.baseline) * 1pt,
      row-content(row),
    )
  }
}
`;

/**
 * The ASCII template: `asciiTemplate(framesToInput(...))` is the document to compile. It has no
 * schema, so `AsciiFrameInput` types the call and nothing checks the data. The source is a string,
 * not an editor-authored file, so it reads its data with plain `json()` at the path `schemaPath`
 * mounts it, and needs no JSON Schema file for an editor sample.
 */
export const asciiTemplate: TemplateDefinition<AsciiFrameInput> = defineTemplate({
  files: { 'main.typ': asciiSource },
  schemaPath: 'frames.json',
});
