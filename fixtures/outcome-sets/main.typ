#import "partials/report.typ": report, outcome-set

#let input = json("/input.json")
#assert(
  input.schema_version == 1,
  message: "Unsupported Outcome Sets fixture schema",
)

#set document(
  title: input.document.title,
  author: input.document.author,
  date: auto,
)
#set text(
  font: "Libertinus Serif",
  lang: input.document.language,
  size: 10pt,
)
#show: body => report(input.document, body)

= #input.document.title

#block[
  *#input.institution.name* \
  #input.program.name · #input.program.degree_level \
  Academic year: #input.program.academic_year
]

#input.document.summary

#for item in input.outcome_sets {
  outcome-set(item)
}
