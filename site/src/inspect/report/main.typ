// The /inspect demo's document. Three switches in the data take away structure a screen reader needs, one at a
// time, so that the page can show who notices: the compiler, the structure warnings, or veraPDF.
#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./inspect.schema.json"))

#let ink = rgb("17211b")
#let muted = rgb("66736c")
#let accent = rgb("2f6f4f")

#set document(title: data.title)
#set page(paper: "a5", margin: (x: 16mm, y: 15mm))
#set text(font: "Libertinus Serif", size: 10.5pt, fill: ink, lang: "en")
#set par(justify: true, leading: 0.62em)
#show heading.where(level: 1): set text(size: 18pt)
#show heading.where(level: 2): set text(size: 12.5pt, fill: accent)

// A heading, or text that only looks like one.
#let title(level, body) = if data.headings {
  heading(level: level, body)
} else {
  block(above: 1.3em, below: 0.8em, text(weight: "bold", size: if level == 1 { 18pt } else { 12.5pt }, fill: if level == 1 { ink } else { accent }, body))
}

// A bar chart of the results, as an SVG made from the data.
#let chart = {
  let top = calc.max(..data.rows.map(row => calc.max(row.target, row.result)), 1)
  let bars = data.rows.enumerate().map(((i, row)) => {
    let h = calc.round(row.result / top * 80, digits: 1)
    "<rect x='" + str(12 + i * 46) + "' y='" + str(90 - h) + "' width='30' height='" + str(h) + "' fill='#2f6f4f'/>"
  }).join("")
  bytes("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + str(24 + data.rows.len() * 46) + " 100'>" + bars + "<line x1='4' y1='90.5' x2='" + str(20 + data.rows.len() * 46) + "' y2='90.5' stroke='#17211b' stroke-width='1'/></svg>")
}

#title(1, data.title)
#data.summary

#title(2, [Results])
#table(
  columns: (1fr, auto, auto),
  stroke: 0.5pt + muted,
  inset: 6pt,
  ..if data.tableHeader { (table.header([*Outcome*], [*Target*], [*Result*]),) } else { ([*Outcome*], [*Target*], [*Result*]) },
  ..data.rows.map(row => (row.outcome, str(row.target), str(row.result))).flatten(),
)

#title(2, [Results at a glance])
#figure(
  image(chart, format: "svg", width: 62%, alt: if data.figureAlt { data.chartAlt } else { none }),
  caption: [Result by outcome],
)
