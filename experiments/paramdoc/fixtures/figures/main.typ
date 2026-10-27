// An outcomes-style page with images: a static palette-PNG logo, a chart the application rendered to an RGBA PNG
// (transparent background) in a `cover` slot, a JPEG in a `contain` slot and a grey PNG with a transparency key in
// a `stretch` slot. Images reach the runtime as data URLs in the data; the chart's alternative text comes from
// the data as well (`(src:, alt:)`), the others use the template's.
#import "paramdoc.typ": slot, image-slot
#let data = json("/data.json")

#let ink = rgb("17211b")
#let muted = rgb("66736c")

#set document(title: "Learning outcomes")
#set page(paper: "a4", margin: (x: 22mm, y: 20mm))
#set text(font: "Libertinus Serif", size: 10.5pt, fill: ink, lang: "en")
#set par(leading: 0.7em, justify: false)

#grid(columns: (auto, 1fr), gutter: 8pt, align: horizon,
  image("logo.png", height: 9mm, alt: "Typfolio logo"),
  text(size: 8pt, fill: muted, tracking: 0.08em)[TYPFOLIO / LEARNING OUTCOMES])
#v(6mm)

= #slot("title", data.title, width: 100%, height: 1.3em, max-length: 40)
#v(4mm)

== Scores by week
#slot("summary", data.summary, width: 100%, lines: 2, max-length: 220, overflow: "ellipsis")
#v(2mm)
#image-slot("chart", data.chart, width: 100%, height: 42mm, fit: "cover")
#v(6mm)

== Cohort
#grid(columns: (50mm, 1fr), gutter: 10pt,
  image-slot("photo", data.photo, width: 50mm, height: 35mm, alt: "The cohort at the end of term", fit: "contain"),
  slot("caption", data.caption, width: 100%, lines: 3, max-length: 260, overflow: "ellipsis"))
#v(6mm)

#grid(columns: (12mm, 1fr), gutter: 8pt, align: horizon,
  image-slot("icon", data.icon, width: 12mm, height: 12mm, alt: "Completion badge", fit: "stretch"),
  slot("badge", data.badge, width: 100%, max-length: 60))
