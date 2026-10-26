// A wrapping slot that clips, under a leading so small that the top of a line Typst clips would show inside the
// box while the runtimes drop the whole line: the exporter must refuse it (M12, G9; check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(leading: 0.15em)
#set document(title: "Too little leading")

#slot("notes", data.notes, width: 80mm, lines: 3, overflow: "clip", max-length: 400)
