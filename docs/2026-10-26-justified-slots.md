# Justified wrapping slots (M11)

Same experiment as `2026-10-26-refusals.md` (`experiments/paramdoc`): a browser runtime fills holes in a document
Typst laid out once. This note records how wrapping slots became justifiable on 2026-10-26.
`experiments/paramdoc/PLAN.md` (M11) has the plan, written the day before and built as written.

## The problem

Every template in this repository justifies its paragraphs, and every wrapping slot was ragged right, which
shows. Full justification in Typst means the optimized breaker and hyphenation, both heavy to port and both
excluded by the decisions of M12. But Typst justifies in two independent steps, choosing the breaks and
stretching each chosen line's spaces, and the slot dialect already pins the simple breaker and `hyphenate:
false`, which the runtimes port. So justification inside a slot is only the second step.

## What was built

- **Dialect.** `slot(..., justify: true)` carries a `justify` flag into the slot's metadata and sets
  `par(justify: justify)` inside a wrapping slot and in the `lines: auto` measurement, next to the pinned
  `linebreaks: "simple"` and `hyphenate: false`. Single-line slots ignore it. The breaks do not move: Typst's
  simple breaker never consults `justify`.
- **IR v9.** `Slot.justify`, false by default and left out of the JSON when false.
- **Runtimes.** Both port the arithmetic of Typst's `commit` (typst-layout 0.15.1 `line.rs`) with the default
  justification limits. Kept spaces (not the trailing whitespace Typst trims) may shrink by a third of their
  advance and stretch by half of it; no other glyph adjusts. If the line is wider than the slot, its spaces
  shrink by the ratio of the deficit to their shrinkability, down to minus one, justified or not; this was
  already ported, now under Typst's exact `remaining < 0` test instead of a tolerance. Otherwise, if the line is
  justified, its spaces stretch by the ratio of the remaining width to their stretchability, up to one, and
  whatever is still left is shared equally among them. A line is justified when the slot says so and the line
  does not end at a hard break or at the end of the text. A line without a space keeps its width and the slot's
  alignment. The ellipsized line of the `ellipsis` policy is the runtime's own and is never stretched.
- **Exporter.** The flag passes through; the shaping check of M12, which refuses a glyph whose advance is not the
  font's, allows a justified slot's spaces any width.

## Verification

| Check | Result |
|---|---|
| `fixtures/justify`: the `wrap` template with every wrapping slot justified (left, centre, right, a table cell; ellipsis, clip and error policies), eight data cases | both runtimes identical to Typst in glyphs and pixels, every case |
| `fixtures/wrapfuzz`, `wide` and `right` justified, 40 random texts of the default repertoire | both runtimes identical to Typst in glyphs and pixels |
| `fixtures/charset`, `narrow` justified, the sample and 20 random Turkish, Greek and Cyrillic texts | both runtimes identical to Typst in glyphs and pixels |
| `./check.sh` | 157 checks, 0 failed |
| Sizes | wasm 691,343 B raw / 243,464 B gzip, up 1,602 B / 568 B from M12 (689,741 / 242,896); worker bundle 37,080 B / 14,319 B gzip, up 237 B / 116 B from M12 (36,843 / 14,203), measured by building the pretext-hybrid demo with each commit's `runtime.ts` |

The random texts cover what the plan listed: single-word lines (nothing stretches), lines ending in `\n`,
whitespace-only lines, no-break spaces (a space for justification, not a break opportunity), lines that shrink
and lines that stretch, and right- and centre-aligned justified slots whose last line keeps the alignment.

## What this is and is not

Web quality: a justified slot looks like a browser's `text-align: justify`, with the greedy breaks of the simple
breaker and no hyphenation. A justified paragraph outside a slot is set by Typst's optimized breaker with
hyphenation, so a narrow justified slot can show looser lines than the paragraph around it. The optimized breaker
is `GAPS.md` G3; hyphenation is G2, off by the decision of M12, with soft hyphens from the data (G44) as the cheap
route when someone needs it.

## How to run

```sh
cd experiments/paramdoc
./check.sh
cargo run -p paramdoc-export -- fixtures/justify --fuzz 30 --reference fixtures/justify/data.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/justify --data fixtures/justify/data.json --out /tmp/justify.pdf --expect ../../.build/paramdoc/justify/reference.json
```
