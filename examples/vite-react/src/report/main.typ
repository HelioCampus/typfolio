#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./report.schema.json"))
#set page(paper: "a4", margin: (x: 24mm, y: 22mm))
#set text(font: "Libertinus Serif", size: 10.5pt, fill: rgb("17211b"))
#set par(leading: 0.72em, justify: true)
#set document(title: data.title)

#align(right)[
  #text(size: 8pt, fill: rgb("66736c"))[TYPFOLIO / BROWSER REPORT]
]
#v(18mm)

= #data.title
#text(size: 9pt, fill: rgb("66736c"))[Generated #data.generatedAt]
#v(8mm)
#line(length: 100%, stroke: 0.6pt + rgb("c9d2cb"))
#v(8mm)

== Brief
#data.summary

== Runtime profile
- #data.runtimeLineOne
- #data.runtimeLineTwo
- #data.runtimeLineThree

#v(12mm)
#block(fill: rgb("eef2ed"), inset: 12pt, radius: 4pt)[
  *#data.runtimeEmphasis* #data.runtimeNote
]
