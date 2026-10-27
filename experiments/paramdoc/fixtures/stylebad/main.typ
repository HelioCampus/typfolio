// A show rule that recolours the digits inside a slot: Typst draws two styles in the box, the runtimes draw one,
// so the exporter must refuse the slot (M12; check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set document(title: "Two styles in a slot")
#show regex("[0-9]+"): set text(fill: red)

Room: #slot("room", data.room, width: 60mm, max-length: 40)
