# Soft hyphens, the middle dot and clipped lines

Same experiment as `2026-10-26-justified-slots.md` (`experiments/paramdoc`): a browser runtime fills holes in a
document Typst laid out once. This note records the two small ports M12 (`2026-10-26-refusals.md`) left open and
built on 2026-10-26 after M11, and a gap the widened fuzz found on the way. `experiments/paramdoc/GAPS.md` has
the inventory (G44, G51 and G9 closed, G52 new).

## Soft hyphens (G44)

Until now U+00AD was refused at export (in a `charset`) and at fill (in data), because Typst draws a hyphen where
a line ends on one and the runtimes did not. Now both runtimes do what typst-layout 0.15.1 does:

- A soft hyphen has no glyph of its own: Typst shapes with `REMOVE_DEFAULT_IGNORABLES`, so nothing is drawn and
  nothing advances. It is a break opportunity (UAX #14 class BA, already in the ported rules) and is trimmed at a
  line end with the whitespace.
- Where a line's full text ends on one (`line.rs`, `Dash::Soft`; at the end of the text too), Typst appends the
  font's `-` glyph after the trimmed text (`ShapedText::hyphen`) at its natural advance, not justifiable and not
  adjustable; its width counts for the fit in the simple breaker. The runtimes append the same glyph, in a
  wrapping slot and in a single-line slot. A link slot draws the hyphen inside the link with a rectangle of its
  own, as Typst's frames have it (the hyphen is a text run of its own there).
- One consequence of that shaping, found by the fuzz: when a line's text opens with soft hyphens, rustybuzz merges
  their cluster into the next glyph (and Typst reshapes a line that starts on one), so Typst takes that glyph's
  character to be the soft hyphen: a space or a middle dot right after a leading soft hyphen has no
  adjustability and is not justifiable. Both runtimes do the same.
- The exporter maps U+00AD to the hyphen glyph in the character map (so a repertoire that admits soft hyphens
  always has the glyph to draw), keeps `-` in the subset, and in the shaping check lets a glyph cover the soft
  hyphen next to it (rustybuzz drops the hyphen's cluster into the glyph before it, or into the glyph after it
  when the hyphen opens the shaped text) and recognises Typst's one-character hyphen item.

This is the cheap half of hyphenation (G2, off by decision): any hyphenation library can insert soft hyphens
server side, and the runtimes break and dash exactly as Typst does.

## The middle dot (G51)

U+00B7 is CJK centre-aligned punctuation to Typst (`shaping.rs`, `is_cjk_center_aligned_punctuation`,
`base_adjustability`): on an overfull line it shrinks by up to a quarter of its advance on each side, the glyph
moving left by the left quarter, it never stretches, and it is justifiable, so on a justified line it takes a
share of the remaining width like a space. Two more rules came with it, both found by the fuzz. Consecutive CJK
punctuation is pulled together at shaping time (`calculate_adjustability`, Chinese Layout Requirements 3.1.6.1):
where two dots meet, the first gives up to a quarter of its advance on its right and the second the rest of half
the first's advance on its left, its glyph moving left, in text order, each pair seeing what the previous one
left (so of three dots the middle one keeps half its advance); Typst shapes the whole text once and a line is a
slice of it, except a line that opens on a soft hyphen, which is shaped again, so a pair split by a soft hyphen
at a line end keeps the first dot's shrink and not the second's. And `Line::justifiables`: a dot that ends the
line is not counted among the justifiables, but still takes the share. Both runtimes model the shaped text as
Typst leaves it (advance, offset and what each side may still give) and run `commit` on that; a space's share is
what M11 ported (a third on the right, half a space of stretch).

Both characters are back in the default repertoire, so the repertoire proof and the fuzz cover them on every
export.

## Clipped lines (G9, found by the fuzz)

A random Turkish text that began with a space and a long address showed a seventh line's top inside a six-line
box in Typst's render and not in the runtimes'. A whitespace-only line has no height in Typst (ported), so the
lines after it sit one line height up, and the line after the last one can show its capitals inside the box:
M12's export check (refuse a clipping slot whose tallest glyph rises more than `pitch − descent`) assumed the
lines fill the box. The runtimes now draw every line of a `clip` slot and the box clips, exactly as Typst's
does; the reference holds every glyph Typst laid out, hidden lines included (typst-pdf places their link
rectangles too), and the leading check is gone. `fixtures/leading`, which had to fail the export, is a positive
case now: its `data-clipped.json` shows the top of the fourth line inside a three-line box, pixel-identical in
both runtimes.

## Two things about Typst's PDF, not its layout

- A link whose *text* ends on a soft hyphen: Typst appends the hyphen run outside the link's tag range, which
  changes the structure tree (the fuzz caught it as a leak) and crashes typst-pdf 0.15.1 ("expected link
  ancestor in logical tree"), so such data has no compiler fallback. Both runtimes refuse it with the message to
  strip the hyphen (G52). A soft hyphen at the end of a *line* inside a link is fine. The upstream report, with
  a plain-file reproduction, is `docs/upstream/2026-10-27-typst-pdf-link-ending-on-soft-hyphen.md`.
- Typst's PDF wraps the glyph before each soft hyphen in an `ActualText` span and re-encodes the pen position
  after it as a 32-bit float; on a justified line that can put one glyph a quarter pixel off in poppler against
  the runtimes' exact positions (54 pixels of one glyph's edges in `justify/hyphens`, channel delta 64). Glyph
  positions agree to 1e-3 pt; `check.sh` ignores channel differences up to 64 where soft hyphens meet
  justified lines and nowhere else.

## Verification

| Check | Result |
|---|---|
| `wrap` and `justify`, `data-hyphens.json`: soft hyphens inside words, before a space, opening a line, several in a row, at the end of the text | both runtimes identical to Typst in glyphs and positions; pixels identical in `wrap`, anti-aliasing only in `justify` |
| `wrap` and `justify`, `data-dots.json`: dots on lines that fit, two and three in a row, a line ending on a dot, two overfull dotted lines (dots only, pairs among them; dots and no-break spaces) that shrink | both runtimes identical to Typst in glyphs and pixels |
| `policies/data-hyphens.json` (single-line slots, one value ending on a soft hyphen), `links/data-hyphens.json` (a wrapping link with lines ending on soft hyphens, two rectangles each) | both runtimes identical to Typst in glyphs, rectangles and pixels |
| `leading/data-clipped.json` | both runtimes identical to Typst in glyphs and pixels |
| `wrapfuzz` and `charset` (U+00AD and U+00B7 in the repertoires), the sample and the random texts | both runtimes identical to Typst in glyphs and pixels |
| `./check.sh` | 191 checks, 0 failed |
| Sizes | wasm 695,746 B raw / 245,595 B gzip, up 4,403 B / 2,131 B from M11 (691,343 / 243,464); worker bundle 39,028 B / 15,085 B gzip, up 1,948 B / 766 B from M11 (37,080 / 14,319) |
| Throughput, the report on 1000 benchmark inputs × 3, one thread (M-series Mac) | TypeScript in Node 3,245 to 3,276 documents/s, median 0.29 ms per document (M10: 3,336 to 3,358 and 0.283 ms; M11: 3,267 to 3,297); Rust native 1,722 to 1,784 documents/s, median 0.55 ms (M10: 1,774 to 1,819; unchanged within noise) |

Measured the same way as the sizes, at each commit with its own checked-in report document: the first build of
this work cost the TypeScript runtime 6% per document (the breaker summed every candidate line's advances over the
new shaped-text model); a prefix sum over the shaped text brought it back to M11's level. What remains against M10
is about 2.5% in TypeScript, M11's per-glyph justification arithmetic, and nothing in Rust.

## How to run

```sh
cd experiments/paramdoc
./check.sh
# throughput, before and after a runtime change (the sizes are measured the same way, see PLAN.md):
node --disable-warning=ExperimentalWarning --experimental-strip-types notes/bench/gen-inputs.mjs 1000 ../../.build/paramdoc/bench/inputs.json
node --disable-warning=ExperimentalWarning --experimental-strip-types ts/cli.ts bench documents/report --inputs ../../.build/paramdoc/bench/inputs.json --repeat 3
cargo run --release -p paramdoc-runtime -- bench documents/report --inputs ../../.build/paramdoc/bench/inputs.json --repeat 3
cargo run -p paramdoc-export -- fixtures/wrap --fuzz 30 --reference fixtures/wrap/data.json --reference fixtures/wrap/data-hyphens.json --reference fixtures/wrap/data-dots.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/wrap --data fixtures/wrap/data-hyphens.json --out /tmp/hyphens.pdf --expect ../../.build/paramdoc/wrap/reference-data-hyphens.json
```
