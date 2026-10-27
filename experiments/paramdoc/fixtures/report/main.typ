// The worker-batch benchmark's progress report (examples/pretext-hybrid/src/batch/report/main.typ) in the slot
// dialect. Differences from the original, forced by the dialect: the title is static, the tutor comment is at
// most three ragged-right lines with an ellipsis, and columns have fixed widths. The alternating row fill is
// two band variants picked by row parity; the score bar is a `bar` hole over a static track.
#import "paramdoc.typ": paged, slot, band, repeat, overlay, bar
#let data = json("/data.json")

#let ink = rgb("17211b")
#let muted = rgb("66736c")
#let accent = rgb("2f6f4f")
#let rule = rgb("c9d2cb")

#set document(title: "Progress report")
#set text(font: "Libertinus Serif", size: 10.5pt, fill: ink, lang: "en")
#set par(leading: 0.7em, justify: false)
#show: paged.with(margin: (x: 22mm, y: 20mm), footer: overlay[
  #set text(size: 8pt, fill: muted)
  Report #slot("number", str(data.number), width: 4em, max-length: 7) #h(1fr) Synthetic data, generated in the browser
])

#text(size: 8pt, fill: muted, tracking: 0.08em)[TYPFOLIO / PROGRESS REPORT]
#v(6mm)

= #slot("name", data.name, width: 100%, height: 1.3em, max-length: 40)
#text(fill: muted)[#slot("programme", data.programme, width: 46mm, max-length: 30) · Student #slot("studentId", data.studentId, width: 13mm, max-length: 6) · #slot("term", data.term, width: 24mm, max-length: 12)]
#v(4mm)
#line(length: 100%, stroke: 0.6pt + rule)
#v(4mm)

#grid(columns: (1fr, 1fr, 1fr), gutter: 8pt,
  ..(("Average score", "average", str(data.average)), ("Courses", "course_count", str(data.course_count)), ("Attendance", "attendance", data.attendance))
    .map(((label, key, value)) => block(fill: rgb("eef2ed"), inset: 10pt, radius: 4pt, width: 100%)[
      #text(size: 8pt, fill: muted)[#label] \
      #slot(key, value, width: 100%, height: 1.3em, max-length: 5, size: 18pt, weight: "bold", fill: accent)
    ]))

== Courses
#let cols = (20mm, 1fr, 16mm, 16mm, 32mm)
#let cell-style = (stroke: none, inset: (x: 6pt, y: 5pt), align: (left, left, right, center, left + horizon))
#band("courses-header", repeat-on-break: true)[
  #table(columns: cols, ..cell-style,
    table.header(..([Code], [Title], [Score], [Grade], [Score bar]).map(h => text(size: 8.5pt, fill: muted, h))))
]
#repeat("courses", data.courses, (c, v) => table(columns: cols, ..cell-style, fill: if v == 2 { rgb("f5f7f4") },
  slot("code", c.code, width: 100%, max-length: 8),
  slot("title", c.title, width: 100%, max-length: 40, overflow: "ellipsis"),
  slot("score", str(c.score), width: 100%, align: right, max-length: 3),
  slot("grade", c.grade, width: 100%, align: center, max-length: 2, weight: "bold"),
  bar("score", c.score, max: 100, width: 100%, height: 7pt, fill: accent, track: rgb("e3e8e4"), radius: 2pt),
), variants: 2, select: ("parity",))

== Tutor comment
#slot("comment", data.comment, width: 100%, lines: 3, max-length: 300, overflow: "ellipsis")
