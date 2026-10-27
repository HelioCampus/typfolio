// Experimental slot dialect.
// A slot is a fixed-size, clipped box whose content comes from data. Everything outside slots must lay out
// identically for every valid input; the exporter checks that by fuzzing the data and diffing the frames.
// Lengths in `em` are relative to the slot's own text size (after `text-args`).
// Inside a slot, kerning, ligatures and contextual alternates (`calt`: Libertinus swaps in a short f before i) are
// off, so the runtime can place glyphs from advance widths alone; direction, tracking, spacing, stroke and
// CJK-Latin spacing are pinned too, so a template's own `set text` rules cannot reach a slot's text (M12).
// The band a slot sits in (set by `band`, below) and the variant a compile forces, for `lines: auto` slots.
#let band-state = state("paramdoc-band", none)
#let forced-variant(name) = {
  let v = sys.inputs.at("paramdoc-variant", default: none)
  if v == none { none } else { let parts = v.split("="); if parts.at(0) == name { int(parts.at(1)) } else { none } }
}
#let variant(name, natural) = { let f = forced-variant(name); if f == none { natural } else { f } }

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
  lines: 1,           // more than 1: a wrapping slot of exactly this many lines, aligned to the top;
                      // `auto`: as many as the text needs, inside a band with `variants` (one layout per count)
  justify: false,     // a wrapping slot stretches the spaces of every line but the last and lines before a hard
                      // break, as Typst's `par(justify: true)` does with the simple breaker; single lines ignore it
  ..text-args,        // text arguments applied inside the slot: size, weight, style, fill
) = text(..text-args.named(), context {
  let d = descent.to-absolute()
  // A link slot: the value is `(text: …, href: …)`, optionally with `alt`; the text is shown as a `link` to `href`
  // and the runtime adds the clickable area (one rectangle per line, as Typst's). The sample decides: a slot whose
  // sample value has an `href` is a link slot and needs one in every input; any other slot refuses one, because a
  // `show link` rule may style the two differently.
  let href = if type(value) == dictionary { value.at("href", default: none) } else { none }
  let shown = if type(value) == dictionary { value.text } else { value }
  let shown = if type(shown) in (str, content) { shown } else { str(shown) }
  let body = if href == none { shown } else { link(href, shown) }
  let meta = (name: name, align: repr(align), overflow: overflow, max-length: max-length, charset: charset, descent: d.pt(), link: href != none, justify: justify)
  let line-height = measure({ set text(bottom-edge: "baseline"); [x] }).height
  let leading = par.leading.to-absolute()
  let pitch = line-height + leading
  // One line: the box baseline is pinned (`at: bottom`, shifted up by the descent) so content cannot move the line.
  let single(meta) = box(width: width, height: height, clip: true, inset: (bottom: d), baseline: (at: bottom, shift: d))[
    #metadata(meta) <paramdoc-slot>
    #set text(kerning: false, ligatures: false, features: (calt: 0), overhang: false, bottom-edge: "baseline", dir: ltr, tracking: 0pt, spacing: 100%, stroke: none, cjk-latin-spacing: none)
    #std.align(align + bottom, body)
  ]
  // Several lines: they break as Typst's simple breaker does, without hyphenation or justification, so the
  // runtime can reproduce them from advance widths alone. The box is exactly `n` lines tall under these rules;
  // the first baseline sits one line height below the box top.
  let wrapping(n, meta) = box(width: width, height: n * line-height + (n - 1) * leading + d, clip: true, inset: (bottom: d))[
    #metadata(meta + (lines: n, line-height: line-height.pt(), pitch: pitch.pt())) <paramdoc-slot>
    #set par(justify: justify, linebreaks: "simple", first-line-indent: 0pt, hanging-indent: 0pt)
    #set text(hyphenate: false, kerning: false, ligatures: false, features: (calt: 0), overhang: false, bottom-edge: "baseline", dir: ltr, tracking: 0pt, spacing: 100%, stroke: none, cjk-latin-spacing: none)
    #std.align(align + top, body)
  ]
  if lines == 1 { single(meta) } else if lines != auto { wrapping(lines, meta) } else {
    // `lines: auto`: in the sample compile, as many lines as the text needs (measured, capped by the band's
    // variant count); in a variant compile, the forced count. Laid out as a block, to know its width.
    let band = band-state.get()
    if band == none { panic("slot `" + name + "`: `lines: auto` needs a band with `variants`") }
    layout(size => {
      let w = if type(width) == ratio { width * size.width } else if type(width) == relative { width.length.to-absolute() + width.ratio * size.width } else { width.to-absolute() }
      let forced = forced-variant(band.name)
      let n = if forced != none { forced } else {
        let h = measure(box(width: w, {
          set par(justify: justify, linebreaks: "simple", first-line-indent: 0pt, hanging-indent: 0pt)
          set text(hyphenate: false, kerning: false, ligatures: false, features: (calt: 0), overhang: false, bottom-edge: "baseline", dir: ltr, tracking: 0pt, spacing: 100%, stroke: none, cjk-latin-spacing: none)
          body
        })).height
        calc.clamp(int(calc.round((h - line-height) / pitch)) + 1, 1, band.variants)
      }
      let meta = meta + (auto-lines: band.variants)
      if n == 1 { single(meta) } else { wrapping(n, meta) }
    })
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

// ---- Variants (M8) -------------------------------------------------------------------------------------
// A band can exist in several layouts, its variants: the exporter lays the band out once per variant (it
// compiles the fixture again with `sys.inputs.paramdoc-variant` set to "<band>=<k>", which forces every
// instance of that band to variant k) and the runtime picks one per instance by the band's selector:
//   ("parity",)      variant 1 for the 1st, 3rd, 5th row, variant 2 for the others (row stripes)
//   ("flag", key)    variant 1 when the data's `key` is true, variant 2 otherwise (an optional block)
//   ("lines", slot)  variant k when the wrapping slot `slot` (declared `lines: auto`) needs k lines
// In the sample compile `variant(name, natural)` returns `natural`, what the data says for this instance, so the
// sample is what the runtime would render for the sample data; in a variant compile it returns the forced k.

// A band: a block the exporter extracts as a fragment with its own slots. Instances of one name are the rows
// of a repeat region; `repeat-on-break: true` marks a band repeated at the top of continuation pages. `variant`
// records which variant this instance renders (`auto` when only the layout can tell, as for `lines`).
#let band(name, body, repeat-on-break: false, variants: 1, select: none, variant: auto, single: false) = block(width: 100%, clip: true, breakable: false, above: 0pt, below: 0pt)[
  #metadata((name: name, repeat-on-break: repeat-on-break, variants: variants, select: select, variant: variant, single: single)) <paramdoc-band>
  #band-state.update((name: name, variants: variants))
  #body
  #band-state.update(none)
]

// The variant the data calls for, where the template can tell: the row's parity or a flag; `auto` for `lines`.
#let natural-variant(select, row, i) = if select == none { 1 } else if select.at(0) == "parity" { calc.rem(i, 2) + 1 } else if select.at(0) == "flag" { if row.at(select.at(1), default: false) == true { 1 } else { 2 } } else { auto }

// The sample rows of a repeat region: one band instance per row of the sample data; `make(row, v)` builds a
// row as variant `v` (1 without variants).
#let repeat(name, rows, make, variants: 1, select: none) = for (i, row) in rows.enumerate() {
  let v = variant(name, natural-variant(select, row, i))
  band(name, make(row, v), variants: variants, select: select, variant: v)
}

// A single block that exists in `variants` layouts: `natural` is the variant the data calls for (1-based),
// `make(v)` builds variant v, and `select` is how the runtime picks, for example ("flag", "honours").
#let choice(name, natural, make, variants: 2, select: none) = { let v = variant(name, natural); band(name, make(v), variants: variants, select: select, variant: v, single: true) }

// Per-page content (a footer): drawn on every page; slots named `page-number` and `page-count` are counters.
#let overlay(body) = box(width: 100%, clip: true)[#metadata((:)) <paramdoc-overlay> #body]

// ---- Parametric geometry and image slots (M9) ----------------------------------------------------------
// A bar is a hole whose content is one filled rectangle: `value / max` of the hole's width (clamped to 0..1),
// as tall as the hole, rounded by `radius`. The track is the hole's own fill, static content the exporter keeps;
// the runtime regenerates the bar's shape with Typst's own rounded-rectangle construction. The bar is
// decorative (an artifact): print the value as text as well.
#let bar(name, value, max: 100, width: 100%, height: 7pt, fill: black, track: none, radius: 0pt) = context {
  let r = radius.to-absolute()
  let ratio = calc.clamp(float(value) / float(max), 0, 1)
  box(width: width, height: height, fill: track, radius: r, clip: true)[
    #metadata((name: name, value: float(value), max: float(max), radius: r.pt())) <paramdoc-bar>
    #place(top + left, rect(width: ratio * 100%, height: height, fill: fill, radius: r, stroke: none))
  ]
}

// An image slot: a fixed box the data fills with a PNG or JPEG, given as a data URL (`data:image/png;base64,…`)
// or as `(src: …, alt: …)`; the exporter turns data URLs into files for Typst. The image is placed as Typst's
// `image` with `fit` places it and clipped to the box, and tagged as a Figure with `alt` (the data's `alt` wins),
// which PDF/UA requires.
#let image-slot(name, value, width: auto, height: auto, alt: none, fit: "cover") = {
  // The metadata carries the template's `alt` only; the data's is what Typst shows, and what the runtime shows.
  let src = if type(value) == dictionary { value.src } else { value }
  let shown-alt = if type(value) == dictionary { value.at("alt", default: alt) } else { alt }
  box(width: width, height: height, clip: true)[
    #metadata((name: name, fit: fit, alt: alt)) <paramdoc-image>
    #image(src, width: 100%, height: 100%, fit: fit, alt: shown-alt)
  ]
}
