# Wrapping slots: multi-line text without the compiler

Implementation notes for the first expressiveness milestone (M7) of the paramdoc experiment on `feat/paramdoc`.
The experiment asks whether a browser can finish a document that Typst already laid out, filling declared holes
from data, so that the 24 MB compiler is not shipped. Its design, status log and open items live in
`experiments/paramdoc/PLAN.md` and `HANDOVER.md`; this file records one step of it: what problem it solved, how,
what the oracle forced us to copy from Typst, and what is still open.

## The problem

Until this step a slot was one line in a fixed, clipped box: text wider than the box was an error, clipped,
shrunk or cut with an ellipsis, and the demo report's tutor comment was a single line ending in "…". Every
template in this repository wraps paragraphs from data (summaries, comments, addresses), so the dialect covered
few real documents.

The open question was not whether a runtime can wrap text, but whether it can wrap it *exactly as Typst does*
with no typesetter, no shaper and no access to Typst at run time. The experiment's guarantee is that a runtime
PDF equals Typst's own layout of the same data, glyph for glyph, and that guarantee is checked by compiling the
same data with Typst and comparing. If wrapped text could only be "plausible, not identical", the trust story
would change for the most common field in any document. This was the biggest unknown on the list.

## What was built

- **Dialect** (`fixtures/*/paramdoc.typ`): `slot(..., lines: n)`. For `n > 1` the box is made exactly `n` lines
  tall (`n · line-height + (n − 1) · leading + descent`, both measured in Typst with `measure` and `par.leading`),
  the paragraph is aligned to the top, and inside it `justify: false`, `linebreaks: "simple"`,
  `hyphenate: false`, `first-line-indent: 0pt`, `hanging-indent: 0pt`, kerning, ligatures, contextual
  alternates and overhang off. The metadata carries `lines`, `line-height` and `pitch`.
- **IR v5** (`ir/`): slots carry `lines` and `pitch`; a wrapping slot's `baseline` is the first line's, one line
  height below the box top. Reference glyphs carry `y`.
- **Exporter** (`export/`): records each line of the sample, checks the sample's baselines sit on the line grid,
  rejects `shrink` on wrapping slots, accepts several `--reference` data files (`reference-<stem>.json`), and with
  `--fuzz-references K` writes K random data samples together with Typst's layout of each, so the runtimes can be
  checked on random text. The fuzzer's alphabet now includes the repertoire's punctuation and quotes.
- **Runtimes** (`runtime/src/lib.rs`, `ts/runtime.ts`, the same code twice): UAX #14 break opportunities for the
  classes a Latin repertoire contains, Typst's simple breaker (greedy first fit; trailing whitespace outside the
  width but drawn at zero advance; an overlong word placed uncut), Typst's line stacking, the space shrinking of
  overlong lines, and the `error`, `clip` and `ellipsis` policies for text that needs more lines than the slot
  has. One marked-content sequence covers all lines of a slot, so tagging is unchanged.
- **Fixtures**: `wrap` (a left, a centred, a right-aligned and a table-cell slot, with data cases for hard
  newlines, punctuation, spaces, an overlong word, empty values, exactly full slots, overflow under each policy
  and a document the runtime must refuse) and `wrapfuzz` (every slot clips, so random text compares cleanly).
  The report's tutor comment is a three-line slot; `documents/report` was re-exported for the demo page.
- **Proof** (`check.sh`): 74 checks, all passing on 2026-10-25; the new ones compare both runtimes with Typst on
  every `wrap` case and on 40 random samples, by glyph positions and by pixels, check the two overflow policies
  and the refusal, and run veraPDF on the new PDFs.

## What Typst does, and what had to be copied

Read from `typst-layout 0.15.1` (`inline/linebreak.rs`, `line.rs`, `shaping.rs`, `flow/collect.rs`) and then
corrected by the oracle. The plan had the breaker right and four things wrong; each was found by a single
diverging sample, fixed, and re-checked against all of them.

1. **Contextual alternates.** `ligatures: false` leaves the `calt` feature on, and Libertinus Serif substitutes a
   short f before i. The reference showed a glyph id the subset did not have. This affected single-line slots
   too and had gone unnoticed because no fixture sample contained "fi". Slots now set `features: (calt: 0)`.
2. **The segmenter's rule set.** Typst uses icu4x's default line segmenter, which does not behave as plain
   Unicode 15.1: the quote rules LB15a and LB15b apply (no break after an opening quote plus spaces; none before
   a closing quote followed by space or punctuation), the decimal rule LB15c and the word-initial-hyphen rule
   LB20a do not, and the number rule LB25 is the older pair-table form (no break between a slash and a digit, or
   between a currency sign and an opening bracket, whatever follows). Both runtimes encode exactly this.
3. **Whitespace-only lines have no height.** When a line consists of trimmed spaces only, Typst measures no kept
   glyph, so the line is zero height and the next line sits one leading, not one pitch, below the box top. An
   empty line from two consecutive newlines, by contrast, has full height.
4. **Overlong lines shrink their spaces.** Before a line is allowed to overflow, Typst shrinks every space on it by
   up to a third of its width (`par.justification-limits`, spacing minimum 2/3), ragged or justified. A line
   that fits after shrinking is not an overflow.

Two more details matter for an exact trace: trailing spaces at a normal break are drawn at zero advance at the
line end, while a space before a hard newline, or at the end of the text, keeps its advance; and an overlong word
is placed uncut and centred or right-aligned with its negative remainder, so it starts left of the box.

## Verification

Three oracles, as for everything in the experiment: Typst's own layout of the same data (glyph ids, x and now y,
within 1e-3 pt), rasterised pages at 150 dpi compared pixel by pixel, and the Rust runtime's trace against the
TypeScript runtime's. Results on 2026-10-25:

| Check | Result |
|---|---|
| `wrap`, 7 data cases, both runtimes | glyph-identical and pixel-identical to Typst |
| report with a three-line comment, both runtimes | glyph-identical; 1 pixel differs (the report's known one) |
| `wrapfuzz`, 300 random texts with punctuation and quotes, both runtimes | 300 of 300 glyph-identical and pixel-identical |
| overflow case | `ellipsis` cuts the last visible line with "…", `clip` drops the rest, `error` refuses |
| veraPDF PDF/UA-1 on the new PDFs | PASS |
| `check.sh` | 73 passed, 0 failed, 1 skipped (the demo step without a server) |
| demo page, paramdoc engine, 200 reports on 4 workers | all rendered |

## Covered now, with examples

Everything below was impossible or wrong before this step; each is a data case of `fixtures/wrap` or appears in
the random samples, and matches Typst exactly.

- A comment that runs to three lines, left-aligned; the same text centred or right-aligned, each line aligned on
  its own trimmed width.
- Hard newlines in the data: `First line\n\nThird line after an empty one` gives three lines with an empty one in
  the middle; a trailing newline adds no line; `Space before the break \nthen more` keeps the space's width on
  the first line.
- Hyphens and dashes: `state-of-the-art` may break after any hyphen; `2019–2024` may break after the en dash;
  `— like this one —` may break on either side of an em dash.
- Slashes and numbers: `12/05/2026`, `1,000.50`, `50%`, `$5`, `€5`, `−3` never split.
- Quotes and brackets: `“curly quotes”`, `‘single ones’`, `(parentheses)`, `[brackets]` stay attached to their
  words; no break after `“` plus spaces, none before `”` when a space or punctuation follows.
- Spaces: `Double  spaces` stay two glyphs; seventeen trailing spaces at a break do not move the line; leading
  spaces widen the first line; spaces at the very end keep their width.
- A word longer than the box is placed uncut and overflows the clip, as in Typst, with the line's other spaces
  shrunk by a third.
- Empty values and a single space as a value.
- A slot that fills exactly its three lines, with nothing left over.
- Text needing more lines than the slot has: cut with an ellipsis on the last visible line, clipped, or refused,
  by the slot's policy.

## Open

What is left of the item, and why each piece is not in this step. On links first, because two different things
go by that name and neither renders incorrectly: a web address as *text* inside a wrapping slot is refused with
an error, while a clickable *hyperlink* is simply not produced, in any slot, because the exporter drops Typst's
link items today (the handover used to say they were recorded; they are not). Both are listed below.

- **Variable-height rows.** A wrapping slot inside a band still gives the band one fixed height. Letting a row be
  as tall as its text needs is the next milestone (M8, variants): the exporter lays the band out once per line
  count and the runtime picks, which is the same mechanism optional blocks and row stripes need, so it is built
  once for all three.
- **Justified text.** Every template in the repository sets `justify: true`; wrapping slots are ragged right. Typst
  justifies with its optimized breaker (a cost-minimising line breaker) and then stretches or shrinks spaces per
  line. Reproducing that means porting the breaker and its justification arithmetic, not a rule table. It is a
  separate milestone if ragged slots are not acceptable.
- **Hyphenation.** Off inside slots. With `justify: false` Typst's default is off too, so this costs nothing
  today; turning it on would mean shipping the language's hyphenation patterns to the runtime.
- **Web addresses in a wrapping slot.** Text containing `://` or starting a segment with `www.` is refused with
  an error. Typst breaks such text with a function of its own (`linebreak_link`: after slashes, between character
  classes) instead of UAX #14. The function is small; it is not ported because it needs its own data cases, and
  an address in a comment is rare. The failure is loud, not a wrong layout.
- **Hyperlinks** (clickable PDF annotations) are a different matter from the point above and are not part of
  this step at all: the exporter drops Typst's link items today, in single-line and wrapping slots alike. They
  belong to the images-and-links item, together with the PDF/UA rules annotations bring.
- **Scripts.** The runtimes have no shaper, so Arabic, Hebrew and Indic text were never in scope; the breaker also
  leaves out the East Asian and Hebrew rules, treats digits outside ASCII as letters and knows the main combining
  blocks only. Latin, Greek and Cyrillic repertoires are covered; a template declares the characters with
  `charset:`.
- **`shrink`** is refused for wrapping slots: shrinking the text size changes the line pitch, which the layout
  contract fixes at export time.
- **One edge of the clip.** Lines beyond the slot's last line are dropped by the runtime and clipped by Typst. If a
  template set `leading` smaller than the slot's `descent`, the top of the first dropped line would peek into the
  box in Typst's output and not in the runtime's. No fixture does this; it is documented in the notes.
- **One style per slot.** A slot has one font, size and colour, as before; mixed styles inside a value are not
  supported.

## How to run it

```sh
cd experiments/paramdoc && ./check.sh             # the whole proof; FUZZ=20 ./check.sh is quicker
cargo run -p paramdoc-export -- fixtures/wrapfuzz --fuzz 300 --fuzz-references 300 --reference fixtures/wrapfuzz/data.json
node --experimental-strip-types ts/cli.ts ../../.build/paramdoc/wrapfuzz --data ../../.build/paramdoc/wrapfuzz/fuzz-7.json \
  --out /tmp/x.pdf --expect ../../.build/paramdoc/wrapfuzz/reference-fuzz-7.json
```
