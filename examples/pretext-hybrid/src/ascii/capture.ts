import type { PdfRequest } from '@typfolio/core';
import {
  ART_PADDING,
  COLS,
  FONT_SIZE,
  LINE_HEIGHT,
  ROWS,
  STAGE_H,
  STAGE_W,
  TARGET_ROW_W,
  rowWidth,
  type Frame,
} from './engine.ts';

/** Palette colours shared by the live stage (CSS) and the Typst template. */
export const COLORS = { background: '#07070c', ink: '#c4a35a' } as const;

/** Merged space cells: `{t:"g"}` is a horizontal gap, `{t:"c"}` a placed glyph. */
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
  frames: { lines: { padLeft: number; cells: JsonCell[] }[] }[];
  /** Benchmark knob: iterations of a pure Typst script loop (no visual effect). */
  burn: number;
}

/** Round to 1/1000 px: enough for sub-pixel parity, keeps the JSON compact. */
const r3 = (value: number): number => Math.round(value * 1000) / 1000;

function frameLines(frame: Frame, spaceWidth: number): AsciiFrameInput['frames'][number] {
  return {
    lines: frame.rows.map(cells => {
      const out: JsonCell[] = [];
      for (const cell of cells) {
        if (cell === null) {
          const last = out[out.length - 1];
          if (last?.t === 'g') last.w = r3(last.w + spaceWidth);
          else out.push({ t: 'g', w: r3(spaceWidth) });
        } else {
          out.push({ t: 'c', c: cell.entry.char, fw: cell.entry.weight, a: cell.alphaIndex / 10 });
        }
      }
      return {
        // Same centering as the live panel: (maxW - rowW) / 2, from measured widths.
        padLeft: r3((TARGET_ROW_W - rowWidth(cells, spaceWidth)) / 2),
        cells: out,
      };
    }),
  };
}

export function framesToInput(
  frames: readonly Frame[],
  spaceWidth: number,
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
    frames: frames.map(frame => frameLines(frame, spaceWidth)),
    burn,
  };
}

/**
 * Pretext decided the widths and the row offsets in JS. Typst does no line
 * breaking and no centering: it receives absolute coordinates and draws.
 *
 * Kerning and ligatures are disabled to match the live panel, where every
 * cell advance is the sum of independently measured glyph widths.
 */
export const asciiTemplate = String.raw`
#let input = json("/input.json")
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
  for (index, row) in frame.lines.enumerate() {
    place(
      top + left,
      dx: (input.padding + row.padLeft) * 1pt,
      dy: (input.padding + index * input.lineHeight + input.baseline) * 1pt,
      row-content(row),
    )
  }
}
`;

export function makeAsciiRequest(input: AsciiFrameInput): PdfRequest<AsciiFrameInput> {
  return {
    template: asciiTemplate,
    input,
  };
}
