// Wrapping slots: a multi-line slot per alignment and one in a table cell. Every `data*.json` next to this file
// is a case the runtime must break exactly as Typst does (check.sh exports a Typst reference for each).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(leading: 0.65em, justify: true) // justified outside the slots; the slots force ragged right
#set document(title: "Wrapping slots")

= Wrapping slots

Left, three lines, ellipsis: \
#slot("left", data.left, width: 90mm, lines: 3, max-length: 400, overflow: "ellipsis")

Centre, three lines, clipped: \
#slot("center", data.center, width: 90mm, lines: 3, align: center, max-length: 400, overflow: "clip")

Right, two lines, error: \
#slot("right", data.right, width: 60mm, lines: 2, align: right, max-length: 200)

#table(columns: (30mm, 1fr), inset: 4pt, stroke: 0.3pt + luma(160),
  [Note], slot("note", data.note, width: 100%, lines: 2, max-length: 300, size: 9pt, overflow: "ellipsis"),
)
