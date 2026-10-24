// Experimental slot dialect.
// A slot is a fixed-size, clipped box whose content comes from data. Everything outside slots must lay out
// identically for every valid input; the exporter checks that by fuzzing the data and diffing the frames.
#let slot(
  name,               // slot name in the manifest
  value,              // the sample or current value (string or content)
  width: auto,        // fixed width; `auto` leaks the content width into the layout (the check catches it)
  height: 1.2em,      // fixed height; the box baseline is pinned to its bottom so content cannot move the line
  align: left,        // left | center | right
  overflow: "error",  // error | clip | shrink | ellipsis: what the runtime does when the text does not fit
  max-length: none,   // the schema's maxLength, informative for now
  ..text-args,        // text arguments applied inside the slot: size, weight, style, fill
) = box(width: width, height: height, clip: true, baseline: bottom)[
  #metadata((name: name, align: repr(align), overflow: overflow, max-length: max-length)) <paramdoc-slot>
  #set text(kerning: false, ligatures: false, bottom-edge: "baseline")
  #std.align(align + bottom, text(..text-args.named())[#value])
]
