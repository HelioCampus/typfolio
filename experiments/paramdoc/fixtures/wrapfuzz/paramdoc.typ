// Experimental slot dialect.
// A slot is a fixed-size, clipped box whose content comes from data. Everything outside slots must lay out
// identically for every valid input; the exporter checks that by fuzzing the data and diffing the frames.
// Lengths in `em` are relative to the slot's own text size (after `text-args`).
// Inside a slot, kerning, ligatures and contextual alternates (`calt`: Libertinus swaps in a short f before i) are
// off, so the runtime can place glyphs from advance widths alone.
#let slot(
  name,               // slot name in the manifest
  value,              // the sample or current value (string or content)
  width: auto,        // fixed width; `auto` leaks the content width into the layout (the check catches it)
  height: 1.2em,      // fixed height, descent included; a wrapping slot (`lines` > 1) sizes itself instead
  descent: 0.25em,    // room below the baseline for descenders; the baseline sits this far above the box bottom
  align: left,        // left | center | right
  overflow: "error",  // error | clip | shrink | ellipsis: what the runtime does when the text does not fit
  max-length: none,   // the schema's maxLength, informative for now
  charset: none,      // the characters the slot may contain; none means the exporter's default repertoire
  lines: 1,           // more than 1: a wrapping slot of exactly this many ragged-right lines, aligned to the top
  ..text-args,        // text arguments applied inside the slot: size, weight, style, fill
) = text(..text-args.named(), context {
  let d = descent.to-absolute()
  let meta = (name: name, align: repr(align), overflow: overflow, max-length: max-length, charset: charset, descent: d.pt())
  if lines == 1 {
    // The box baseline is pinned (`at: bottom`, shifted up by the descent) so content cannot move the line.
    box(width: width, height: height, clip: true, inset: (bottom: d), baseline: (at: bottom, shift: d))[
      #metadata(meta) <paramdoc-slot>
      #set text(kerning: false, ligatures: false, features: (calt: 0), overhang: false, bottom-edge: "baseline")
      #std.align(align + bottom, value)
    ]
  } else {
    // Lines break as Typst's simple breaker does, without hyphenation or justification, so the runtime can
    // reproduce them from advance widths alone. The box is exactly `lines` lines tall under these rules; the
    // first baseline sits one line height below the box top.
    let line-height = measure({ set text(bottom-edge: "baseline"); [x] }).height
    let leading = par.leading.to-absolute()
    box(width: width, height: lines * line-height + (lines - 1) * leading + d, clip: true, inset: (bottom: d))[
      #metadata(meta + (lines: lines, line-height: line-height.pt(), pitch: (line-height + leading).pt())) <paramdoc-slot>
      #set par(justify: false, linebreaks: "simple", first-line-indent: 0pt, hanging-indent: 0pt)
      #set text(hyphenate: false, kerning: false, ligatures: false, features: (calt: 0), overhang: false, bottom-edge: "baseline")
      #std.align(align + top, value)
    ]
  }
})

// ---- Flow documents (M3) -------------------------------------------------------------------------------
// A flow document is a sequence of blocks the runtime stacks and breaks into pages: static blocks between
// bands, and repeat regions of band instances. Wrap the document in `paged`, which records the flow area.

#let sides(margin) = if type(margin) == dictionary {
  let rest = margin.at("rest", default: 0pt)
  let x = margin.at("x", default: rest)
  let y = margin.at("y", default: rest)
  (top: margin.at("top", default: y), bottom: margin.at("bottom", default: y), left: margin.at("left", default: x), right: margin.at("right", default: x))
} else { (top: margin, bottom: margin, left: margin, right: margin) }

// Sets the page margins and records them (in points) for the runtime; `footer` is per-page content, wrap it
// in `overlay`. The record lives in the page foreground so it cannot affect the flow.
#let paged(margin: 25mm, footer: none, body) = {
  let m = sides(margin)
  set page(margin: margin, footer: footer, foreground: context {
    let pt(side) = m.at(side, default: 0pt).to-absolute().pt()
    [#metadata((top: pt("top"), bottom: pt("bottom"), left: pt("left"), right: pt("right"))) <paramdoc-pages>]
  })
  body
}

// A band: a block the exporter extracts as a fragment with its own slots. Instances of one name are the rows
// of a repeat region; `repeat-on-break: true` marks a band repeated at the top of continuation pages.
#let band(name, body, repeat-on-break: false) = block(width: 100%, clip: true, breakable: false, above: 0pt, below: 0pt)[
  #metadata((name: name, repeat-on-break: repeat-on-break)) <paramdoc-band>
  #body
]

// The sample rows of a repeat region: one band instance per row of the sample data.
#let repeat(name, rows, make) = for row in rows { band(name, make(row)) }

// Per-page content (a footer): drawn on every page; slots named `page-number` and `page-count` are counters.
#let overlay(body) = box(width: 100%, clip: true)[#metadata((:)) <paramdoc-overlay> #body]
