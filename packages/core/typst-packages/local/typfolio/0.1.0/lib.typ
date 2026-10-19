// @local/typfolio: the template-side helper for Typfolio.
//
//   #import "@local/typfolio:0.1.0": input
//   #let data = input(json.with("./report.schema.json"))
//
// While Typfolio compiles, core sets `sys.inputs.typfolio` and `input()` returns runtime data. For a
// template made with `defineTemplate`, every input (the template's own and each partial's) is mounted
// at the path of its schema file, so `input(json.with("./header.schema.json"))` reads the header's
// data there: the schema path is the input's identity, and a file can only read its own. For a plain
// request, the input is the package root's /input.json. In an editor nothing sets the marker, so
// `input()` builds a sample from the JSON Schema and the editor can complete `#data.` fields. The
// sample is for authoring only: it is not validated, and keywords that only restrict values are
// ignored.
//
// The sample builder lives in `sample.typ` and is imported inside `input()`, in the editor branch only,
// so a runtime compile never loads it. `--input typfolio-sample=minimal` (Tinymist's `typstExtraArgs`)
// previews the sparsest sample instead of the default "full" one.
//
// The schema is passed as a function created in the template (`json.with(path)`) because a relative
// path written inside this package would resolve against the package, not the template.

/// Returns the request input under Typfolio and a schema-built sample in the editor.
///
/// `schema` is `json.with("<path>")` (a function that loads the schema, with the path resolved
/// relative to the calling file) or an already-loaded schema dictionary.
#let input(schema) = {
  if "typfolio" in sys.inputs {
    if sys.inputs.at("typfolio-inputs", default: none) != "documents" { return json("/input.json") }
    // The data is mounted where the schema file sits, so the same function now loads the data.
    if type(schema) == function { return schema() }
    panic("@local/typfolio: in a template made with defineTemplate, input() needs json.with(\"<schema>.json\"): the data is mounted at that path")
  }
  import "sample.typ": sample-from-schema
  let mode = sys.inputs.at("typfolio-sample", default: "full")
  if type(schema) == function { return sample-from-schema(schema(), mode: mode) }
  if type(schema) == dictionary { return sample-from-schema(schema, mode: mode) }
  if schema == none {
    panic("@local/typfolio: input() needs a JSON Schema so the editor can build a sample. Pass json.with(\"<schema>.json\"), for example input(json.with(\"./report.schema.json\")).")
  }
  panic("@local/typfolio: input() expects json.with(\"<schema>.json\") or a schema dictionary, got " + repr(type(schema)))
}
