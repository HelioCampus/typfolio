// A link to a place in the document: the exporter must refuse it, because the runtime writes URL links only
// (check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set document(title: "Internal link")

= Heading <top>
Name: #slot("name", data.name, width: 60mm, max-length: 40)

See #link(<top>)[the heading above].
