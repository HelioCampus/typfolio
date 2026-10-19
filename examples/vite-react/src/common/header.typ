#import "@local/typfolio:0.1.0": input
// The header's own data. In an editor, ./header.schema.json is its schema and this is a sample;
// when the app compiles, the request's partials.header is mounted at that path.
#let header = input(json.with("./header.schema.json"))

#let report-header() = grid(
  columns: (auto, 1fr),
  column-gutter: 4mm,
  align: horizon,
  image(header.logo, height: 9mm, alt: header.institution + " logo"),
  text(size: 9pt, fill: rgb("66736c"), header.institution),
)
