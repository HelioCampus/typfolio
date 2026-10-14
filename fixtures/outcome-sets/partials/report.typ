#let report(document, body) = {
  set page(
    paper: "a4",
    margin: (top: 22mm, right: 18mm, bottom: 20mm, left: 18mm),
    header: align(
      right,
      text(size: 8pt, fill: luma(90))[#document.short_title],
    ),
    footer: context align(
      center,
      text(size: 8pt, fill: luma(90))[#counter(page).display("1")],
    ),
  )
  set par(justify: true, leading: 0.75em)
  body
}

#let outcome-set(item) = [
  == #item.title

  #item.description

  #table(
    columns: (auto, 1fr, auto),
    inset: 6pt,
    stroke: 0.5pt + luma(210),
    table.header([*Code*], [*Learning outcome*], [*Status*]),
    ..item.outcomes.map(outcome => (
      [#outcome.code],
      [
        *#outcome.title* \
        #outcome.description

        _Measures:_ #outcome.measures.join(", ")
      ],
      [#outcome.status],
    )).flatten(),
  )
]
