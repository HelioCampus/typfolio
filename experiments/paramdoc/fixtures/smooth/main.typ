// A static image with `scaling: "smooth"`: the runtimes do not write the PDF's interpolation flag, so the exporter
// must refuse it (M12; check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set document(title: "A smoothly scaled image")

Name: #slot("name", data.name, width: 60mm, max-length: 40)

#image("/dot.png", width: 20mm, scaling: "smooth")
