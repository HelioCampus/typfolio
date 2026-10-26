# Paramdoc gaps

The one inventory of what paramdoc cannot do yet, written for someone building an application on it: what you
cannot express, what happens if you try, the workaround, and what a fix would take. `HANDOVER.md` keeps the
*order* in which the next pieces should be built; this file keeps the *list*. When a note's "Open" section is
written, add its items here; when a gap closes, move it to the table at the end with the date and the note.
Last reconciled 2026-10-26, after the soft-hyphen, middle-dot and clipped-line ports
(`docs/2026-10-26-soft-hyphens-and-middle-dot.md`).

**Status words.** *refused at export*: the exporter stops with a message naming the element, before anything
ships. *refused at fill*: the runtime stops with a message naming the slot; the document was exportable but this
input is not. *silent*: a known difference from Typst that no check catches; these should stay rare and small,
and each is listed. *missing*: nothing breaks, the feature is not there. *rule*: a restriction of the model,
with the reason.

## Text in slots

- **G2 Hyphenation.** Status: rule (decided 2026-10-26). Not supported unless it comes without pattern tables
  (tens of kB per language) and without a port of Typst's hyphenation step into both runtimes; `hyphenate:
  false` stays pinned, and narrow justified columns will show loose lines. What is possible and cheap: soft
  hyphens supplied by the data (U+00AD), supported since 2026-10-26 (the runtimes draw the hyphen Typst draws
  where a line ends on one), so any hyphenation library can hyphenate server side.
- **G3 Optimized line breaking.** Status: missing. Slots use Typst's simple (greedy) breaker, justified ones too
  (since M11, `justify: true`); Typst's default for justified paragraphs is the optimized one, so a justified
  slot breaks like a browser, not like the paragraph around it. Fix: port `linebreak_optimized` and its cost
  function; medium.
- **G4 Scripts that need shaping.** Status: refused at export (since M12). The runtimes map one character to one
  glyph through the font's character map, which holds for Latin, Greek and Cyrillic with kerning and ligatures
  off and fails for Arabic, Hebrew, Devanagari, Thai (a shaper) and for Chinese and Japanese (other break
  rules). A `charset` may declare the default set, Latin Extended, Greek, Cyrillic, a few punctuation and
  currency ranges; anything else is refused with the reason (a script that needs a shaper, East Asian, a
  combining mark, a format or bidi control, a variation selector, emoji, private use). What is admitted is
  proven on every export: the whole repertoire goes through the real template once (the repertoire proof) and
  every glyph must be the character map's at the font's advance. Precomposed characters only (NFC). Real
  support means Typst's own shaper in the Rust runtime, large, and a product decision.
- **G5 One style per slot.** Status: rule. A slot has one font, size and colour; the data is plain text. Bold
  words, two fonts or a colour change inside a value are not expressible. Workaround: separate slots. Fix: a
  small inline markup and per-run styles in the IR; medium.
- **G6 Characters outside the repertoire.** Status: refused at fill. A slot may contain the default set
  (printable ASCII, Latin-1 minus the soft hyphen and the middle dot, common typography) or what its `charset:`
  declares; anything else stops the fill with the character named (a soft hyphen gets its own message). Emoji
  and colour fonts are out. Fix: declare the characters (within G4's whitelist); the exporter subsets the font to
  exactly that and refuses a declared character the font lacks.
- **G7 Decorated links inside slots.** Status: refused at export. A `show link: underline` rule puts a shape
  inside the slot's box, which the exporter refuses ("a slot's content must be text only"); colour is fine.
  Static links in the template may be underlined. Fix: record the underline as a parametric shape (a rectangle
  of the line's width) like a bar; small to medium.
- **G8 Overflow policies are the runtime's own.** Status: rule. `clip`, `ellipsis` and `shrink` describe what
  the runtime does when text does not fit; Typst never shows them, so they are not compared with Typst (the
  exporter's check cases skip them). `shrink` is refused for wrapping slots (it would change the line pitch).
- **G10 Line count at a rounding tie.** Status: silent, not seen in any fuzz. `lines: auto` is measured by height
  and rounded in the dialect and copied in the runtimes; a text whose first line is only whitespace lands near
  a tie, and float noise could make Typst and the runtime pick different variants. Since M12 the exporter refuses
  a sample whose measured count is not the number of lines Typst laid out; data is not checked. Fix: write the
  formula so a tie is impossible; trivial.
- **G45 Stroked text.** Status: refused at export (since M12). `text(stroke:)` on static text or inside a slot
  stops the export; the runtimes draw fills only. Fix: an IR stroke on text items and the PDF text render mode;
  small, if a template needs it.
- **G46 Colour and variable fonts.** Status: refused at export (since M12). A font with a COLR, CBDT, sbix or
  SVG table, or with variation axes (`fvar`), is refused when any text uses it, naming the table; the runtimes
  draw plain outlines at the default instance. Workaround: a static outline font.
- **G47 A second style inside a slot.** Status: refused at export (since M12). A slot has one font, size and
  colour; a `show` rule that recolours or resizes part of a slot's content (`fixtures/stylebad`) is refused
  naming both styles. G5 stays the rule.
- **G49 Non-integer numbers as slot values.** Status: refused at fill (since M12). The runtimes format numbers
  themselves, Typst's sample used `str()`; equal for integers and booleans, which the fuzz proves, not for every
  float. Workaround: format the number as a string in the application.
- **G52 A link whose text ends on a soft hyphen.** Status: refused at fill (a Typst bug). Typst appends the
  hyphen as a text run of its own after the link's tag range, which changes the structure tree (the fuzz
  caught it as a leak), and typst-pdf 0.15.1 then cannot write the PDF ("internal error: expected link ancestor
  in logical tree", `link.rs:107`), so such data has no compiler fallback; both runtimes refuse it with the
  message to strip the hyphen (`links/data-shy-error.json`). A soft hyphen at the end of a *line* inside a link
  is fine and is in `check.sh` (`links/data-hyphens.json`). Fix: upstream; the report, with a plain-file
  reproduction, is `docs/upstream/2026-10-27-typst-pdf-link-ending-on-soft-hyphen.md` (not filed yet).

## Links

- **G11 Links to places in the document.** Status: refused at export. Labels, locations, page positions,
  outlines and references are refused ("links to a place in the document"); only URLs are written. Fix: named
  destinations and the runtime's own page numbers; medium.
- **G12 Links in footers and repeated headers.** Status: refused at export and at fill. Overlays and continuation
  headers are artifacts, and PDF/UA forbids links in artifacts. Fix: tag overlays as content; small, with a
  veraPDF round.
- **G13 Rotated or skewed link text.** Status: refused at export (since M12, `fixtures/rotatedlink`). The
  annotation would be the bounding box, as in typst-pdf without PDF/UA, not Typst's quadrilateral.
- **G14 A slot that is sometimes a link.** Status: rule. The sample decides: a slot whose sample value has an
  `href` is a link slot and needs one in every input; a slot whose sample was plain text refuses one. Reason: a
  `show link` rule may colour or style links, and the exporter only knows the style of the sample. Workaround:
  always link, or a band `choice`/variant picked by a flag with a link slot in one variant and a plain slot in
  the other.
- **G15 Link slots with the `shrink` policy.** Status: rule, runtime-only (see G8). Since M12 the clickable
  rectangle shrinks with the text.
- **G16 `mailto:` and `tel:` descriptions.** Status: rule. Static links carry Typst's localized description
  ("mail x"); link slots carry the data's `alt` or the URL.

## Images and geometry

- **G17 SVG images.** Status: refused at export. A static SVG in the template (the shared header logo of the
  existing examples) can be rasterized to PNG today. Fix: convert static SVGs once at export time into a PDF
  drawing the runtime pastes in, with the converter Typst itself uses; medium. SVG arriving in the data would
  need an SVG renderer in the runtime: not planned.
- **G18 PNG and JPEG variants.** Status: refused at fill, each with a message. 16-bit, interlaced and sub-8-bit
  PNGs; CMYK, lossless, hierarchical and arithmetic-coded JPEGs. Workaround: re-encode. Fix: extend the decoders
  if a source produces them; small each.
- **G19 EXIF orientation.** Status: refused at fill (since M12). A JPEG whose orientation tag is not 1 (phone
  photos) is refused with the message to rotate it before sending; Typst would rotate it, the runtimes draw it
  as stored. Fix: read the tag and rotate at placement; small.
- **G20 `image(scaling: "smooth")`.** Status: refused at export (since M12, `fixtures/smooth`). The
  `/Interpolate` flag is not reproduced; leave `scaling` at `auto`. Fix: carry the flag in the IR and write it;
  small.
- **G21 Image slots need a fixed width and height.** Status: rule, enforced by the isolation check. An `auto`
  side leaks the image's size into the layout and the fuzz reports it.
- **G22 Image slots inside band rows are untested.** Status: missing a fixture. The code path is shared with
  slots and bars, but no fixture has an image in a repeating row. Fix: a per-row icon in a fixture; hours.
- **G23 Image decode cost.** Status: performance. Each distinct PNG costs an inflate, an unfilter and two
  deflates per runtime (cached afterwards). Fix: pass opaque PNGs' compressed rows through with a PNG predictor;
  small, a clear win for a chart per document.
- **G24 Bar shapes.** Status: refused at export (the shape check fails). Bars are left-aligned, filled,
  unstroked, with one uniform radius, as wide as the box's share. Right-aligned, stroked, thinner-than-track or
  vertical bars need more metadata and another check each; small each.
- **G25 Paints.** Status: refused at export. Only solid colours; gradients and tiling patterns are refused.

## Layout, bands and pages

- **G26 The flow sample must fit on one page.** Status: refused at export. The exporter segments a single sample
  page into blocks and regions; use fewer sample rows. Variant compiles force every row to its tallest variant
  and can push a sample over the edge.
- **G27 Bands must use `table`, not `grid`.** Status: rule. Only tables carry table semantics into the structure
  tree.
- **G28 Stripes and variable height on the same rows.** Status: refused at export (one selector per band).
  Fix: compile the product of the selectors and key fragments by the pair; small, mostly exporter. Matters for a
  striped table with a comment column.
- **G29 Nested repeats and whole-region variants.** Status: missing. Rows grouped under sections, or a different
  header for continuation pages, cannot be expressed; the flow is a sequence of static blocks, repeat regions
  and choice blocks. Workaround: flatten the data and give the band a row variant that looks like a group
  header. Fix: nested bands through exporter, IR and both runtimes' pagination; medium to large.
- **G30 An `index` selector** (the data names the variant). Status: missing; a few lines in the dialect, the IR
  and both runtimes.
- **G31 Rotated, scaled or floated holes.** Status: refused at export. A clipped group with a non-translation
  transform is refused; floats and `place` outside the dialect's own use are not handled in the frame walk.
- **G32 Footers are artifacts.** Status: rule. Overlays and continuation headers are pagination artifacts: not
  read by assistive technology, no links (G12). Counters are `page-number` and `page-count` only.

## Document, structure and PDF/UA

- **G33 Title and language come from the template.** Status: missing. The PDF's title and language are the
  sample's (`set document(title:)`, the first text run's `lang`); the data cannot set a per-document title. Fix:
  a `title` (and `lang`) in the data, written to the Info dictionary and XMP; small.
- **G34 No outline (bookmarks).** Status: missing. Typst writes an outline from the headings; the runtimes do
  not. Not required by PDF/UA-1. Fix: an outline from the H1..H6 nodes; small.
- **G35 PDF/UA-2 and WTPDF.** Status: missing, metadata only. Under the UA-2 and WTPDF profiles only the PDF 2.0
  rules fail (version, `pdfuaid:part` 2 with `rev`, the Document namespace); containment passes.
- **G36 `inspectPdf` counts roles per page.** Status: tooling, not a runtime defect. The repo's inspector sums
  one structure tree per page, so multi-page counts are inflated; veraPDF sees one of each.

## Integration, runtimes and tooling

- **G37 A reusable Worker wrapper** for the TypeScript runtime. Status: missing; the demo page has one written
  for itself (`paramdoc.worker.ts`, the pool in `batch.ts`).
- **G38 Export as a Vite plugin** fed by `defineTemplate`, with the schema's `maxLength` and `pattern` sizing
  slots and repertoires. Status: missing; this is where the experiment meets the real packages. Design with the
  maintainers first.
- **G39 The wasm C ABI takes no image files.** Status: missing. A document with static images cannot be opened
  through `paramdoc_open`; the Rust and TypeScript APIs can.
- **G40 The Rust runtime deflates every stream per document**, which makes it slower than the TypeScript one.
  Fix: write small streams uncompressed and cache the font streams; small.
- **G41 `doc.json` size.** Status: fine for now (87 kB raw, 6.5 kB gzip for the report); a compact binary form
  if it ever matters.
- **G42 A check that failed once.** Status: investigate. One `check.sh` step failed once when run alone and never
  again; run that step in a loop and look at the first failure before the next milestone. An hour.
- **G43 The report's one pixel.** Status: silent, known. The report page differs from Typst's by one pixel by one
  level at 150 dpi; every other fixture is pixel-identical.

## Closed

| Gap | Closed | Where |
|---|---|---|
| Tagged PDF and PDF/UA-1 conformance (veraPDF on every runtime PDF) | 2026-10-24 | `PLAN.md` status log |
| Wrapping text: multi-line slots breaking as Typst does | 2026-10-25 | `docs/2026-10-25-wrapping-slots.md` |
| Variants: variable-height rows, optional blocks, row stripes | 2026-10-25 | `docs/2026-10-25-variants.md` |
| Bars (parametric geometry) and image slots, static raster images | 2026-10-25 | `docs/2026-10-25-geometry-and-images.md` |
| Web addresses in wrapping slots (Typst's link breaking) | 2026-10-26 | `docs/2026-10-26-addresses-and-links.md` |
| Clickable links: static links and link slots as PDF/UA annotations | 2026-10-26 | `docs/2026-10-26-addresses-and-links.md` |
| G1 Justified text in wrapping slots (`justify: true`; the space-stretching step of Typst's `commit`, breaks unchanged) | 2026-10-26 | `docs/2026-10-26-justified-slots.md` |
| G44 Soft hyphens: no glyph, a break opportunity, the font's hyphen drawn where a line ends on one | 2026-10-26 | `docs/2026-10-26-soft-hyphens-and-middle-dot.md` |
| G51 The middle dot: shrinkable by a quarter on each side, pulled together with a neighbouring dot, justifiable, as Typst's CJK punctuation | 2026-10-26 | `docs/2026-10-26-soft-hyphens-and-middle-dot.md` |
| G9 Leading smaller than the descent: a clipping slot draws every line and the box clips, as Typst's does (`fixtures/leading`) | 2026-10-26 | `docs/2026-10-26-soft-hyphens-and-middle-dot.md` |
| G48 Shaper features, tracking, spacing and language in slots: pinned in the dialect, every glyph of every compile checked against the character map and the font's advances, the whole repertoire shaped through the template on export | 2026-10-26 | `docs/2026-10-26-refusals.md` |
| G50 The exporter warned where it should refuse (a single-line sample that wrapped, baselines off the contract or the grid, a sample taller than its box) | 2026-10-26 | `docs/2026-10-26-refusals.md` |
| A declared `charset` beyond the default: Turkish, Greek and Cyrillic under `lang: "tr"`, random texts and pixels identical to Typst (`fixtures/charset`) | 2026-10-26 | `docs/2026-10-26-refusals.md` |
