#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 297mm, margin: 25mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: false)
#set document(title: "Certificate of completion")

#align(center, text(size: 22pt, weight: "bold")[Certificate of completion])
#v(1cm)

#align(center)[
  This certifies that \
  #slot("recipient", data.recipient, width: 120mm, height: 9mm, align: center, overflow: "shrink", max-length: 40, size: 18pt, weight: "bold") \
  has completed the course \
  #slot("course", data.course, width: 120mm, height: 7mm, align: center, overflow: "ellipsis", max-length: 60, style: "italic") \
]
#v(5mm)

Issued on #slot("date", data.date, width: 26mm, height: 1.2em, overflow: "clip", max-length: 10) with a final score of
#slot("score", str(data.score), width: 9mm, height: 1.2em, align: right, max-length: 3) out of 100.

#v(2cm)
#line(length: 60mm, stroke: 0.5pt)
Registrar
