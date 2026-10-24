// Experimental slot dialect.
// A slot is a fixed-size, clipped box whose content comes from data. Everything outside slots must lay out
// identically for every valid input; the exporter checks that by fuzzing the data and diffing the frames.
// Lengths in `em` are relative to the slot's own text size (after `text-args`).
#let slot(
  name,               // slot name in the manifest
  value,              // the sample or current value (string or content)
  width: auto,        // fixed width; `auto` leaks the content width into the layout (the check catches it)
  height: 1.2em,      // fixed height, descent included
  descent: 0.25em,    // room below the baseline for descenders; the baseline sits this far above the box bottom
  align: left,        // left | center | right
  overflow: "error",  // error | clip | shrink | ellipsis: what the runtime does when the text does not fit
  max-length: none,   // the schema's maxLength, informative for now
  ..text-args,        // text arguments applied inside the slot: size, weight, style, fill
) = text(..text-args.named(), context {
  let d = descent.to-absolute()
  // The box baseline is pinned (`at: bottom`, shifted up by the descent) so content cannot move the line.
  box(width: width, height: height, clip: true, inset: (bottom: d), baseline: (at: bottom, shift: d))[
    #metadata((name: name, align: repr(align), overflow: overflow, max-length: max-length, descent: d.pt())) <paramdoc-slot>
    #set text(kerning: false, ligatures: false, bottom-edge: "baseline")
    #std.align(align + bottom, value)
  ]
})
