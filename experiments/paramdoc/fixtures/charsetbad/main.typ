// A slot that declares a script the runtimes cannot shape: the exporter must refuse it at export, naming the
// character and the reason (M12; check.sh expects exit 1).
#import "paramdoc.typ": slot
#let data = json("/data.json")

#set page(width: 210mm, height: 148mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set document(title: "An unsupported repertoire")

Name: #slot("name", data.name, width: 60mm, max-length: 40, charset: "abcdefghijklmnopqrstuvwxyz عربي")
