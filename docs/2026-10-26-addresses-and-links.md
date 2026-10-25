# Web addresses and clickable links: Typst's link breaking and PDF link annotations without the compiler

Implementation notes for the links half of the fourth expressiveness item of the paramdoc experiment on
`feat/paramdoc` (the other half, justified wrapping slots, is still open; `experiments/paramdoc/PLAN.md`, section
M11, has its plan). Same experiment as the notes of 2026-10-25: a browser runtime fills a document Typst laid out once,
so the 24 MB compiler is not shipped, and every runtime PDF must equal Typst's own layout of the same data.

## The problem

Two gaps, neither of them "links render wrong". A wrapping slot refused any text containing `://` or `www.`,
because Typst does not break a web address by UAX #14 but by rules of its own, and a runtime without them would
wrap such a line differently from Typst. And a link in a template was silently dead: the exporter dropped Typst's
link items, so the text was drawn but nothing was clickable, and the structure tree had no Link elements, which
PDF/UA requires around every link annotation. Authors saw a link in Typst's preview and shipped plain text.

## What was built

- **Web addresses in wrapping slots.** Both runtimes (`runtime/src/lib.rs`, `ts/runtime.ts`) port the link case of
  Typst's `breakpoints()`: `link_prefix` from typst-syntax (what counts as the address: ASCII letters, digits, URL
  punctuation, balanced brackets, minus trailing punctuation that is more likely prose) and `linebreak_link` from
  typst-layout (where it may break: at changes between letters, digits and the rest, between two punctuation
  marks, never right after `(` or `[`; a run of 16 or more characters since the last opportunity, a hash, may break
  after every character). The refusal is gone from both runtimes and from the line counter that picks variants.
- **Dialect** (`fixtures/*/paramdoc.typ`): a slot whose value is `(text: …, href: …)` (optionally `alt: …`) is a
  link slot: the text is shown as `link(href, text)` and the runtime adds the clickable area. The sample decides:
  a slot whose sample has an `href` needs one in every input, any other slot refuses one, because a `show link`
  rule may style the two differently and the exporter only knows the sample's style.
- **IR v8** (`ir/`): `Link { page, rects, url, alt, node }` on fixed pages and fragments, Typst's rectangles for one
  link element (one per line it spans) with the Link structure node its text belongs to; `Slot.link { above,
  below }`, how far a link slot's rectangle extends above and below each line's baseline.
- **Exporter** (`export/`): a `LinkMarker` tag opens a Link node; every `FrameItem::Link` outside a hole is
  recorded under its Link node (several lines, one record); inside a slot it is the contract check: each of
  Typst's rectangles must be its text run's box extended by the same amounts above and below the baseline, on
  every compile including the fuzz samples, and those amounts become the slot's geometry. The slot's text node is
  re-pointed to the Link node. Refused with a message: links to places in the document (labels, locations,
  pages), links inside artifacts (PDF/UA forbids them), links inside a slot's content (use a link value), shapes
  inside slots (an underline from a show rule would have leaked). The fuzz puts a web address into one string in
  four and keeps every `href` a web address. Empty frames that Typst nests or inlines depending on the text are
  dropped from the export, which they were polluting as fake leaks.
- **Runtimes**: a link slot gets one rectangle per drawn line, over the line's width, from the slot's geometry;
  static links come with their fragment. Each link becomes one annotation (`/Link`, a URI action, `/Contents`
  from the data's `alt` or the URL, `/Border [0 0 0]`, printable, `/QuadPoints` when it spans several lines, as
  typst-pdf writes them for PDF/UA), the page gets `/Annots` and `/Tabs /S`, the Link element an OBJR kid, the
  parent tree a key per annotation after the pages. A link that would land in an artifact (a repeated header, an
  overlay) is refused. The trace carries `<slot>#link` rectangles and `compare` checks them against Typst's.
- **Fixtures and proof** (`check.sh`): `fixtures/wrap/data-links.json` (a long address with a query and fragment,
  `www.` addresses, one followed by a full stop, one with a port and digits after `://`, which Typst does not treat
  as a link, a 32-character hash); random addresses in `wrapfuzz`; `fixtures/links`, a flow document with a static
  link that wraps onto a second line, a short one, a single-line and a wrapping link slot, and band rows with a link
  slot and a static link each, plus a 40-row data file that paginates; `fixtures/linkbad`, an internal link the
  exporter must refuse; annotation counts, Link roles, veraPDF on every links PDF.

## What had to be learned

- **Typst's link breaking is positional.** `breakpoints()` walks the segmenter's opportunities with `last`, the
  previous one, and at each step checks whether the text before `last` ends with `://` or the text after it
  starts with `www.`. A `://` with no break opportunity right after it starts no link: `http://127.0.0.1:8080` is
  broken by UAX #14 because the segmenter allows no break between `/` and a digit. Porting a regex over the text
  would have been wrong; porting the loop was forty lines in each runtime. Addresses are ASCII, so Typst's byte
  offsets are character offsets.
- **Typst's link rectangle** is the text frame of each line's text item outset by half the paragraph leading above
  and below (`modify_text` in typst-layout), so its height is the text's edges plus the leading; one per line.
  typst-pdf joins the rectangles of one link into one annotation with quad points when it targets PDF/UA and
  writes one annotation per rectangle otherwise. The runtimes' rectangles equal those in Typst's own PDF of the
  sample to five decimals.
- **Which node a link slot's text belongs to.** The slot's metadata tag is seen before the link marker starts, so
  the node recorded there is the paragraph; when the link item arrives the slot's node becomes the Link node, and
  its alternative text is reset to nothing because the data supplies it (the sample's would have been a fake leak,
  as with image slots).
- **Typst inlines small frames and nests large ones.** A frame with at most five items is merged into its parent,
  a larger one becomes a group; a link adds items, so whether a slot's paragraph frame appeared as an (empty)
  group in the export depended on the text, and the fuzz reported it. Empty unclipped groups are now dropped at
  export; they draw nothing.
- **Empty text in a link slot** still gets a link rectangle from Typst, of no width, on the first line; the
  geometry is taken from the slot's own baseline then.
- **PDF/UA-1 and links** passed veraPDF at the first attempt with `/Contents`, `/StructParent`, the OBJR kid in
  the Link element and `/Tabs /S`; the rules the handover expected to fire did not, because the structure was
  built the way typst-pdf builds it.

## Verification

| Check | Result |
|---|---|
| `wrap`, the links case (four slots, every address rule) | glyph- and pixel-identical to Typst, both runtimes |
| `wrapfuzz`, 40 random texts, 27 of them with a random address | identical to Typst, both runtimes |
| `links`, sample: glyph positions and link rectangles (1e-3 pt) | identical to Typst, both runtimes |
| `links`, sample: pixels at 150 dpi | 0 of 2,176,714 pixels differ, both runtimes |
| `links`, annotations: 10 on the sample, 84 on 40 rows over two pages | both runtimes; rectangles equal typst-pdf's |
| `links` and `links/long`, veraPDF 1.30 PDF/UA-1 | PASS, both runtimes |
| `links`, structure | one Link element per link (10), Table/TR/TH/TD as before |
| fuzz, every fixture (30 samples of `links`) | 0 leaks |
| `linkbad` (a link to a label) | refused at export |
| `check.sh` | 116 checks: 116 passed, 0 failed, 0 skipped (with the demo server running) |
| demo page, paramdoc engine, 200 reports on 4 workers | all rendered |
| Rust runtime as wasm32 (release profile) | 688 kB raw, 242 kB gzip (was 648 / 230) |
| TypeScript runtime in the demo's worker bundle | 36 kB minified, 14 kB gzip (was 33 / 13) |

## Covered now, with examples

- A handbook address with a path, query and fragment in a three-line slot, broken where Typst breaks it.
- A `www.` address at the start of a line, one followed by a full stop that stays prose, one in parentheses.
- A commit-hash-like path segment that may break after any character.
- A static link that wraps onto a second line: one annotation with two quad-point boxes, one Link element.
- A link in every row of a table whose destination comes from the data, and one whose destination is fixed.
- A link slot of three lines: three rectangles, one annotation.

## Open

Tracked, with everything else that is open, in `experiments/paramdoc/GAPS.md`.

- **Justified wrapping slots**, M11 in `experiments/paramdoc/PLAN.md`: the plan there checks out against
  typst-layout 0.15.1 line by line and is the next step.
- **Internal destinations** (labels, locations, pages) are refused; they would need named destinations and the
  runtime's own page numbers.
- **Links in overlays and repeated headers** are refused because those are artifacts; a footer link would need
  the overlay tagged as content.
- **Rotated or skewed link text** gets the bounding box, as in typst-pdf, not a rotated quadrilateral.
- **A link slot with the `shrink` policy** keeps the sample's rectangle height while its text shrinks; the
  policy is the runtime's own and never compared with Typst.
- **`mailto:` and `tel:` links** take Typst's alternative text for static links ("mail x", localized) and the
  data's `alt` or the URL for link slots.
- **SVG images** are still refused (no renderer in the runtimes); the rest of the M9 list stands.

## How to run it

```sh
cd experiments/paramdoc && ./check.sh             # the whole proof; FUZZ=20 ./check.sh is quicker
cargo run -p paramdoc-export -- fixtures/links --fuzz 30 --reference fixtures/links/data.json
cargo run -p paramdoc-runtime -- ../../.build/paramdoc/links --data fixtures/links/data.json --out /tmp/links.pdf --expect ../../.build/paramdoc/links/reference.json
node --experimental-strip-types ts/cli.ts ../../.build/paramdoc/links --data fixtures/links/data.json --out /tmp/links-ts.pdf --expect ../../.build/paramdoc/links/reference.json
cargo run -p paramdoc-export -- fixtures/wrapfuzz --fuzz 100 --fuzz-references 40 --reference fixtures/wrapfuzz/data.json   # random texts with addresses
```
