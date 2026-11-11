#import "@local/typfolio:0.1.0": input
#import "../common/header.typ": report-header
#let data = input(json.with("./outcomes.schema.json"))
#set page(paper: "a4", margin: (x: 22mm, y: 20mm))
#set text(font: "Libertinus Serif", size: 10.5pt, fill: rgb("17211b"))
#set par(leading: 0.72em, justify: true)
#set document(title: data.title)

#report-header()
#v(4mm)

= #data.title
#text(size: 9pt, fill: rgb("66736c"))[Generated #data.generatedAt]
#v(6mm)

== Students per level
// Each outcome names its row: pdf.header-cell (Typst's a11y-extras) tags it TH with scope Row, so a screen reader
// reads a count as "Proficient, Written communication, 12". The summary says what the table is about.
#pdf.table-summary(
  summary: "Students per level for each outcome",
  table(
    columns: (1fr,) + (auto,) * data.levels.len(),
    align: (x, _) => if x == 0 { left } else { right },
    stroke: 0.4pt + rgb("c9d2cb"),
    table.header([*Outcome*], ..data.levels.map(level => [*#level*])),
    ..data.outcomes.map(outcome => (pdf.header-cell(scope: "row")[#outcome.name], ..outcome.students.map(count => [#count]))).flatten(),
  ),
)
#v(4mm)

#for outcome in data.outcomes [
  == #outcome.name
  #outcome.summary
  // Drawn by usePdf at 480 × 160 px; render() returned the path.
  #image(outcome.chart, width: 100%, alt: outcome.chartAlt)
  #v(4mm)
]
