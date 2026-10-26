// Random-data check of the line breaker: every slot clips, which is what Typst does with overflow too, so the
// exporter's fuzz samples (`--fuzz-references`) compare cleanly whatever the random text does. `wide` and `right`
// are justified (M11), `narrow` and `centered` ragged.
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 200mm, margin: 15mm)
#set text(font: "Libertinus Serif", size: 10pt, lang: "en")
#set par(leading: 0.6em)
#set document(title: "Wrapping slots, random data")

#slot("wide", data.wide, width: 100%, lines: 4, overflow: "clip", max-length: 1000, justify: true)
#v(3mm)
#slot("narrow", data.narrow, width: 40mm, lines: 6, overflow: "clip", max-length: 1000, size: 9pt)
#v(3mm)
#slot("centered", data.centered, width: 120mm, lines: 3, align: center, overflow: "clip", max-length: 1000, size: 12pt)
#v(3mm)
#slot("right", data.right, width: 80mm, lines: 3, align: right, overflow: "clip", max-length: 1000, justify: true)
