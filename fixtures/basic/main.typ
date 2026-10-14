#import "partials/layout.typ": report
#let input = json("/input.json")
#set document(title: input.title, author: "Typst PDF compiler fixture", date: auto)
#set text(font: "Libertinus Serif", lang: "en", size: 11pt)
#show: report

= #input.title

This report was compiled from a Typst template and separate JSON input.

#table(
  columns: (1fr, 1fr),
  inset: 8pt,
  table.header([Outcome], [Status]),
  ..input.rows.map(row => (row.name, row.status)).flatten(),
)

#image("/assets/chart.svg", width: 120pt, alt: "A blue bar representing the completed outcome.")
