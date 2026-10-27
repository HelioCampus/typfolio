// Clickable links: static links in a paragraph (the first wraps onto a second line) and in every band row, and
// link slots whose destination comes from the data, one single-line and one wrapping. check.sh exports a Typst
// reference, compares both runtimes' glyphs, link rectangles and pixels with it, counts the annotations, and runs
// veraPDF (PDF/UA-1) on the output, which checks that every annotation sits in a Link structure element.
#import "paramdoc.typ": paged, slot, band, repeat, overlay
#let data = json("/data.json")

#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(leading: 0.65em)
#show link: set text(fill: rgb("1a4d8f"))
#set document(title: "Links")
#show: paged.with(margin: 25mm, footer: overlay[
  #set text(size: 9pt)
  #h(1fr) Page #slot("page-number", "1", width: 2em, align: right) of #slot("page-count", "1", width: 2em)
])

= Links

The handbook is published as #link("https://example.org/handbook/2026/assessment-policy")[the assessment policy for the academic year 2026, with its appendices on appeals and deadlines], and there is a short address: #link("https://example.org")[example.org].

Portal: #slot("portal", data.portal, width: 70mm, max-length: 60) \
Notes: \
#slot("notes", data.notes, width: 90mm, lines: 3, max-length: 300)

#let cols = (40mm, 1fr, 36mm)
#band("course-header", repeat-on-break: true)[
  #table(columns: cols, inset: 4pt, stroke: none, fill: luma(230), table.header([*Course*], [*Resource*], [*Catalogue*]))
]
#repeat("courses", data.courses, (row, v) => table(
  columns: cols, inset: 4pt, stroke: (bottom: 0.3pt + luma(180)),
  slot("title", row.title, width: 100%, max-length: 40),
  slot("resource", row.resource, width: 100%, max-length: 60),
  link("https://example.org/catalogue")[Catalogue entry],
))
