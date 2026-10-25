#import "paramdoc.typ": paged, slot, band, repeat, overlay, choice
#let data = json("/data.json")

#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: false)
#set document(title: "Academic transcript")
#show: paged.with(margin: 25mm, footer: overlay[
  #set text(size: 9pt)
  #h(1fr) Page #slot("page-number", "1", width: 2em, align: right) of #slot("page-count", "1", width: 2em)
])

#align(center, text(size: 20pt, weight: "bold")[Academic transcript])
#v(6mm)
Student: #slot("student", data.student, width: 80mm, weight: "bold", max-length: 40) \
Programme: #slot("programme", data.programme, width: 80mm, max-length: 50)
#v(6mm)

#let cols = (28mm, 1fr, 22mm, 18mm)
#band("course-header", repeat-on-break: true)[
  #table(columns: cols, inset: 4pt, stroke: none, fill: luma(230), table.header([*Code*], [*Course*], align(right)[*Credits*], align(center)[*Grade*]))
]
// Rows are as tall as their title needs, one to three lines: three variants picked by the title's line count.
#repeat("courses", data.courses, (row, v) => table(
  columns: cols, inset: 4pt, stroke: (bottom: 0.3pt + luma(180)),
  slot("code", row.code, width: 100%, max-length: 10),
  slot("title", row.title, width: 100%, lines: auto, max-length: 200, overflow: "ellipsis"),
  slot("credits", str(row.credits), width: 100%, align: right, max-length: 3),
  slot("grade", row.grade, width: 100%, align: center, max-length: 2),
), variants: 3, select: ("lines", "title"))
#v(6mm)
Total credits: #slot("total_credits", str(data.total_credits), width: 12mm, align: right, max-length: 4)
#h(1em) GPA: #slot("gpa", str(data.gpa), width: 12mm, max-length: 4)

// An optional block: present when the data says `honours`, otherwise nothing, not even its height.
#choice("honours", if data.at("honours", default: false) { 1 } else { 2 }, which => if which == 1 [
  #v(4mm)
  *Awarded with honours.*
], select: ("flag", "honours"))

#v(12mm)
#line(length: 60mm, stroke: 0.5pt)
Registrar
