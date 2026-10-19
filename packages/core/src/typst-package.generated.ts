// GENERATED FILE. Do not edit.
// Source of truth: packages/core/typst-packages/local/typfolio/0.1.0/.
// Regenerate with `node tools/generate-typst-package.mjs` (the root `npm run build` does this first).

export const typfolioPackage = {
  "namespace": "local",
  "name": "typfolio",
  "version": "0.1.0",
  "files": {
    "typst.toml": "[package]\nname = \"typfolio\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n",
    "lib.typ": "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n#let input(schema) = {\n  if \"typfolio\" in sys.inputs {\n    if sys.inputs.at(\"typfolio-inputs\", default: none) != \"documents\" { return json(\"/input.json\") }\n\n    if type(schema) == function { return schema() }\n    panic(\"@local/typfolio: in a template made with defineTemplate, input() needs json.with(\\\"<schema>.json\\\"): the data is mounted at that path\")\n  }\n  import \"sample.typ\": sample-from-schema\n  let mode = sys.inputs.at(\"typfolio-sample\", default: \"full\")\n  if type(schema) == function { return sample-from-schema(schema(), mode: mode) }\n  if type(schema) == dictionary { return sample-from-schema(schema, mode: mode) }\n  if schema == none {\n    panic(\"@local/typfolio: input() needs a JSON Schema so the editor can build a sample. Pass json.with(\\\"<schema>.json\\\"), for example input(json.with(\\\"./report.schema.json\\\")).\")\n  }\n  panic(\"@local/typfolio: input() expects json.with(\\\"<schema>.json\\\") or a schema dictionary, got \" + repr(type(schema)))\n}\n"
  }
} as const;
