// Justified wrapping slots (M11): the `wrap` fixture with `justify: true` on every wrapping slot, so each of its
// data cases (copied next to this file) is broken exactly as `wrap` breaks it and every line but the last and
// lines before a hard break are stretched to the slot's width as Typst stretches them (check.sh exports a Typst
// reference for each case and compares glyph positions and pixels).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(leading: 0.65em, justify: true)
#set document(title: "Justified wrapping slots")

= Justified wrapping slots

Left, three lines, ellipsis: \
#slot("left", data.left, width: 90mm, lines: 3, max-length: 400, overflow: "ellipsis", justify: true)

Centre, three lines, clipped: \
#slot("center", data.center, width: 90mm, lines: 3, align: center, max-length: 400, overflow: "clip", justify: true)

Right, two lines, error: \
#slot("right", data.right, width: 60mm, lines: 2, align: right, max-length: 200, justify: true)

#table(columns: (30mm, 1fr), inset: 4pt, stroke: 0.3pt + luma(160),
  [Note], slot("note", data.note, width: 100%, lines: 2, max-length: 300, size: 9pt, overflow: "ellipsis", justify: true),
)
