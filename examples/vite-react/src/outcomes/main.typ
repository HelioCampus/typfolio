#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./outcomes.schema.json"))
#set page(paper: "a4", margin: (x: 22mm, y: 20mm))
#set text(font: "Libertinus Serif", size: 10.5pt, fill: rgb("17211b"))
#set par(leading: 0.72em, justify: true)
#set document(title: data.title)

= #data.title
#text(size: 9pt, fill: rgb("66736c"))[Generated #data.generatedAt]
#v(6mm)

#for outcome in data.outcomes [
  == #outcome.name
  #outcome.summary
  // Drawn by useRenderedAssets at 480 × 160 px; the path comes from render().
  #image("/" + outcome.chart, width: 100%, alt: outcome.chartAlt)
  #v(4mm)
]
