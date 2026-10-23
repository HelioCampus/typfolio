#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./report.schema.json"))

#let ink = rgb("17211b")
#let muted = rgb("66736c")
#let accent = rgb("2f6f4f")
#let rule = rgb("c9d2cb")

#set document(title: "Progress report " + data.term + ": " + data.student.name)
#set page(paper: "a4", margin: (x: 22mm, y: 20mm), footer: context [
  #set text(size: 8pt, fill: muted)
  Report #str(data.number) #h(1fr) Synthetic data, generated in the browser
])
#set text(font: "Libertinus Serif", size: 10.5pt, fill: ink, lang: "en")
#set par(leading: 0.7em, justify: true)

#text(size: 8pt, fill: muted, tracking: 0.08em)[TYPFOLIO / PROGRESS REPORT]
#v(6mm)

= #data.student.name
#text(fill: muted)[#data.student.programme · Student #data.student.studentId · #data.term]
#v(4mm)
#line(length: 100%, stroke: 0.6pt + rule)
#v(4mm)

#let average = calc.round(data.courses.map(c => c.score).sum() / data.courses.len())
#grid(columns: (1fr, 1fr, 1fr), gutter: 8pt,
  ..(("Average score", str(average)), ("Courses", str(data.courses.len())), ("Attendance", str(data.attendance) + "%"))
    .map(((label, value)) => block(fill: rgb("eef2ed"), inset: 10pt, radius: 4pt, width: 100%)[
      #text(size: 8pt, fill: muted)[#label] \
      #text(size: 18pt, weight: "bold", fill: accent)[#value]
    ]))

== Courses
#table(
  columns: (auto, 1fr, auto, auto, 32mm),
  stroke: none,
  inset: (x: 6pt, y: 5pt),
  align: (left, left, right, center, left),
  fill: (_, row) => if row > 0 and calc.even(row) { rgb("f5f7f4") },
  table.header(..([Code], [Title], [Score], [Grade], [Score bar]).map(h => text(size: 8.5pt, fill: muted, h))),
  ..data.courses.map(c => (
    c.code, c.title, str(c.score), strong(c.grade),
    box(width: 100%, height: 7pt, fill: rgb("e3e8e4"), radius: 2pt,
      box(width: c.score * 1%, height: 7pt, fill: accent, radius: 2pt)),
  )).flatten(),
)

== Tutor comment
#data.comment
