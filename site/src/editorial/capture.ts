import { defineTemplate, type TemplateDefinition } from '@typfolio/core';
import type { EditorialLayout, PositionedLine } from './engine.ts';

/** Colours shared by the live stage (CSS) and the Typst template. */
export const COLORS = {
  bgInner: '#0f0f14',
  bgOuter: '#0a0a0c',
  body: '#e8e4dc',
  headline: '#ffffff',
  dropCap: '#c4a35a',
  quote: '#b8a070',
  quoteRule: '#6b5a3d',
} as const;

/** Background used by the live stage; it matches the PDF page fill (see template). */
export const STAGE_BACKGROUND = `radial-gradient(ellipse 75% 75% at 50% 40%, ${COLORS.bgInner} 0%, ${COLORS.bgOuter} 100%)`;

/** Baselines the browser chose for each text style, in px from the line-box top. */
export interface Baselines {
  readonly headline: number;
  readonly body: number;
  readonly dropCap: number;
  readonly quote: number;
}

const r2 = (value: number): number => Math.round(value * 100) / 100;
const lineJson = (line: PositionedLine) => ({ x: line.x, y: line.y, text: line.text });

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * The live orbs carry two CSS box-shadows (blur 60 spread 15 alpha .18, blur 120
 * spread 40 alpha .07). Typst has no blur, so the glow is sampled here as an
 * alpha falloff over the distance `d` outside the orb's edge (Gaussian edge
 * profile, sigma = blur / 2) and drawn as a radial gradient.
 */
function glowStops(): [number, number][] {
  const shadows = [
    { blur: 60, spread: 15, alpha: 0.18 },
    { blur: 120, spread: 40, alpha: 0.07 },
  ];
  const distances = [0, 8, 16, 28, 42, 58, 78, 100, 130, 165];
  return distances.map(d => {
    let transparency = 1;
    for (const shadow of shadows) {
      const sigma = shadow.blur / 2;
      transparency *= 1 - shadow.alpha * normalCdf((shadow.spread - d) / sigma);
    }
    return [d, Math.round((1 - transparency) * 1000) / 1000];
  });
}

/** The data of the editorial template: the layout, positioned and serialisable as JSON. */
export type EditorialInput = ReturnType<typeof layoutToInput>;

export function layoutToInput(layout: EditorialLayout, baselines: Baselines, burn = 0) {
  const glow = glowStops();
  return {
    w: layout.stage.width,
    h: layout.stage.height,
    columns: layout.columnCount,
    burn,
    colors: { ...COLORS },
    headline: {
      fontSize: layout.headline.fontSize,
      letterSpacing: layout.headline.letterSpacing,
      baseline: r2(baselines.headline),
      lines: layout.headline.lines.map(lineJson),
    },
    body: {
      fontSize: layout.body.fontSize,
      baseline: r2(baselines.body),
      lines: layout.body.lines.map(lineJson),
    },
    dropCap: {
      text: layout.dropCap.text,
      fontSize: layout.dropCap.fontSize,
      baseline: r2(baselines.dropCap),
      x: layout.dropCap.x,
      y: layout.dropCap.y,
    },
    pullquotes: {
      fontSize: layout.pullquotes.fontSize,
      baseline: r2(baselines.quote),
      boxes: layout.pullquotes.boxes.map(box => ({ ...box })),
      lines: layout.pullquotes.lines.map(lineJson),
    },
    orbs: layout.orbs.map(orb => ({
      cx: r2(orb.cx),
      cy: r2(orb.cy),
      r: orb.r,
      color: [...orb.color],
      opacity: orb.paused ? 0.45 : 1,
      glow,
    })),
  };
}

/**
 * Pretext already broke every line and decided every position, so the template
 * contains no flow layout: each text line is one absolutely placed `text`.
 * `top-edge`/`bottom-edge: "baseline"` makes each placed box zero-height with
 * its top at the baseline, so `y + baseline` (measured from the DOM) lands the
 * text exactly where the browser drew it.
 */
const editorialSource = String.raw`
#let input = json("/layout.json")
#let c = input.colors

#set page(
  width: input.w * 1pt,
  height: input.h * 1pt,
  margin: 0pt,
  fill: gradient.radial(rgb(c.bgInner), rgb(c.bgOuter), center: (50%, 40%), radius: 75%, space: rgb),
)
#set text(
  font: "Libertinus Serif",
  top-edge: "baseline",
  bottom-edge: "baseline",
)
#set par(leading: 0pt, spacing: 0pt, justify: false)
#set document(title: "The editorial engine")

// Synthetic load for the live-mode benchmark: pure script work, no visual effect.
#let burn = range(input.burn).fold(0, (acc, n) => acc + calc.sin(n))

#let put(x, y, body) = place(top + left, dx: x * 1pt, dy: y * 1pt, body)
#let put-line(l, baseline, size, fill, ..args) = put(
  l.x,
  l.y + baseline,
  text(size: size * 1pt, fill: fill, ..args)[#l.text],
)
#let tint(color, alpha) = rgb(color.at(0), color.at(1), color.at(2), alpha * 100%)

// Body text, then the headline and drop cap above it, as in the live stage.
#for l in input.body.lines {
  put-line(l, input.body.baseline, input.body.fontSize, rgb(c.body))
}
#for l in input.headline.lines {
  put-line(l, input.headline.baseline, input.headline.fontSize, rgb(c.headline), weight: 700, tracking: input.headline.letterSpacing * 1pt)
}
#put(
  input.dropCap.x,
  input.dropCap.y + input.dropCap.baseline,
  text(size: input.dropCap.fontSize * 1pt, fill: rgb(c.dropCap), weight: 700)[#input.dropCap.text],
)
#for b in input.pullquotes.boxes {
  put(b.x, b.y, rect(width: 3pt, height: b.h * 1pt, fill: rgb(c.quoteRule)))
}
#for l in input.pullquotes.lines {
  put-line(l, input.pullquotes.baseline, input.pullquotes.fontSize, rgb(c.quote), style: "italic")
}

// Orbs last (they sit on top, translucent). Glow approximates the CSS box-shadows.
#for orb in input.orbs {
  let outer = orb.r + orb.glow.last().at(0)
  let glow-stops = (
    (tint(orb.color, 0), 0%),
    (tint(orb.color, 0), (orb.r - 0.01) / outer * 100%),
    ..orb.glow.map(g => (tint(orb.color, g.at(1) * orb.opacity), (orb.r + g.at(0)) / outer * 100%)),
  )
  put(
    orb.cx - outer,
    orb.cy - outer,
    circle(radius: outer * 1pt, fill: gradient.radial(..glow-stops, center: (50%, 50%), radius: 50%, space: rgb)),
  )
  put(
    orb.cx - orb.r,
    orb.cy - orb.r,
    circle(
      radius: orb.r * 1pt,
      fill: gradient.radial(
        (tint(orb.color, 0.35 * orb.opacity), 0%),
        (tint(orb.color, 0.12 * orb.opacity), 55%),
        (tint(orb.color, 0), 72%),
        (tint(orb.color, 0), 100%),
        center: (35%, 35%),
        radius: 91.9%,
        space: rgb,
      ),
    ),
  )
}
`;

/**
 * The editorial template: `editorialTemplate(layoutToInput(...))` is the document to compile. It has
 * no schema, so `EditorialInput` types the call and nothing checks the data. The source is a string,
 * not an editor-authored file, so it reads its data with plain `json()` at the path `schemaPath`
 * mounts it, and needs no JSON Schema file for an editor sample.
 */
export const editorialTemplate: TemplateDefinition<EditorialInput> = defineTemplate({
  files: { 'main.typ': editorialSource },
  schemaPath: 'layout.json',
});
