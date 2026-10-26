// A static link under a rotation: its clickable area would be a bounding box where Typst writes a quadrilateral,
// so the exporter must refuse it (M12; check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set document(title: "A rotated link")

Name: #slot("name", data.name, width: 60mm, max-length: 40)

#rotate(12deg, reflow: true)[See #link("https://example.org/")[the example site].]
