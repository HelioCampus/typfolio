// A wrapping slot that clips, under a leading so small that the top of the line after the last one shows inside
// the box: Typst clips it, and the runtimes draw every line and clip the box the same way (`data-clipped.json`;
// check.sh compares glyphs and pixels with Typst). Until 2026-10-26 the exporter refused this template (G9).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(leading: 0.15em)
#set document(title: "Too little leading")

#slot("notes", data.notes, width: 80mm, lines: 3, overflow: "clip", max-length: 400)
