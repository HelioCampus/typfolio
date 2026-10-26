// Slots that declare a `charset` beyond the default: Turkish, Greek and Cyrillic letters under `lang: "tr"`, so
// the exporter's repertoire proof shapes every one of them through this template (M12) and the random-text
// references (`--fuzz-references`) compare the runtimes' line breaking with Typst's on all of them. Every slot
// clips, as `wrapfuzz` does, so random texts compare cleanly whatever they do.
#import "paramdoc.typ": slot
#let data = json("/data.json")

#let latin = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
#let turkish = "ÇçĞğİıÖöŞşÜüÂâÎîÛû"
#let greek = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψωςΆΈΉΊΌΎΏάέήίόύώϊϋΐΰ\u{37e}\u{384}\u{385}\u{387}"
#let cyrillic = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяЂђЈјЉљЊњЋћЏџЄєІіЇїҐґ"
#let punctuation = "\u{a0}«»–—‘’‚“”„•…€‹›"
#let repertoire = latin + turkish + greek + cyrillic + punctuation

#set page(width: 210mm, height: 200mm, margin: 15mm)
#set text(font: "Libertinus Serif", size: 10pt, lang: "tr")
#set par(leading: 0.6em)
#set document(title: "Wrapping slots, a declared repertoire")

#slot("wide", data.wide, width: 100%, lines: 4, overflow: "clip", max-length: 1000, charset: repertoire)
#v(3mm)
#slot("narrow", data.narrow, width: 40mm, lines: 6, overflow: "clip", max-length: 1000, size: 9pt, charset: repertoire)
#v(3mm)
#slot("centered", data.centered, width: 120mm, lines: 3, align: center, overflow: "clip", max-length: 1000, size: 12pt, charset: repertoire)
#v(3mm)
#slot("right", data.right, width: 80mm, lines: 3, align: right, overflow: "clip", max-length: 1000, charset: repertoire)
