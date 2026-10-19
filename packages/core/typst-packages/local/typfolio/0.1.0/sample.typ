// @local/typfolio: sample builder. Not used at runtime.
//
// `lib.typ` imports this file only from the editor branch of `input()`, so a compile under Typfolio
// never loads it (and core does not even mount it). It ships next to `lib.typ` because an editor reads
// the package folder from disk. `@typfolio/dev-tools` mounts it for build-time template checks.
//
// `sample-from-schema(schema, mode: "full")` builds a value from a JSON Schema (a dictionary):
//   "full"    shape-complete, for editor completion: every property, one array item, non-null shapes.
//   "minimal" the sparsest value the schema allows, to expose templates that assume optional data.
// In both, an image field (`contentMediaType: "image/..."`) is a placeholder image's bytes.
// The sample is not validated against the schema.

#let _is-empty(v) = (type(v) == array or type(v) == dictionary) and v.len() == 0

// A field that holds the path of an image file says so with `contentMediaType: "image/..."`. In the
// editor and in template checks there is no such file to read, so the sample is the bytes of a grey
// placeholder image instead, which `image()` draws: write `image(data.logo)`, not `image("/" + ...)`.
#let _placeholder = bytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"200\" viewBox=\"0 0 400 200\"><rect width=\"400\" height=\"200\" fill=\"#e6e8eb\"/><path d=\"M0 0L400 200M400 0L0 200\" stroke=\"#c4c8cd\" stroke-width=\"2\"/></svg>")
#let _is-image(node) = {
  let media = node.at("contentMediaType", default: none)
  type(media) == str and media.starts-with("image/")
}

#let _formats = (
  "date": "2024-01-15",
  "date-time": "2024-01-15T09:30:00Z",
  "email": "user@example.com",
  "uri": "https://example.com",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
)

// Resolves a local "#" or "#/..." reference against the root schema.
#let _resolve(root, ref) = {
  if ref == "#" { return root }
  let node = root
  for part in ref.slice(2).split("/") {
    node = node.at(part.replace("~1", "/").replace("~0", "~"))
  }
  node
}

// `seen` holds the $ref values being expanded on the current path. A recursive schema is expanded
// one level (a tree gets one child) and then cut: the cut value is `_cut`, which an array turns into
// no items and an object into a missing optional property, so a recursive list ends empty instead
// of holding `none`. `depth` bounds anything else.
#let _cut = "\u{E000}typfolio-recursion-cut"
#let _recursing(seen, ref) = seen.filter(r => r == ref).len() >= 2

// An object's properties from their samples: a cut optional property is left out, a cut required
// one is `none` (the schema demands an endless value there).
#let _object(node, sampled) = {
  let required = node.at("required", default: ())
  let out = (:)
  for (key, v) in sampled {
    if v == _cut {
      if key in required { out.insert(key, none) }
    } else {
      out.insert(key, v)
    }
  }
  out
}

#let _sample(root, node, depth, seen) = {
  if depth > 16 or type(node) != dictionary { return none }
  if _is-image(node) { return _placeholder }
  let candidates = ()
  if "examples" in node { candidates += node.at("examples") }
  if "default" in node { candidates.push(node.at("default")) }
  // An empty [] or {} default is not preferred over a generated shape.
  let filled = candidates.filter(v => v != none and not _is-empty(v))
  if filled.len() > 0 and type(filled.first()) != dictionary { return filled.first() }
  if "const" in node and node.at("const") != none { return node.at("const") }
  if "enum" in node {
    let e = node.at("enum").filter(v => v != none)
    if e.len() > 0 { return e.first() }
  }
  if "$ref" in node {
    let ref = node.at("$ref")
    if _recursing(seen, ref) { return _cut }
    return _sample(root, _resolve(root, ref), depth + 1, seen + (ref,))
  }
  for key in ("anyOf", "oneOf") {
    if key in node {
      for branch in node.at(key) {
        let v = _sample(root, branch, depth + 1, seen)
        if v != none and v != _cut { return v }
      }
    }
  }
  if "allOf" in node {
    let merged = (:)
    for part in node.at("allOf") {
      let v = _sample(root, part, depth + 1, seen)
      if type(v) == dictionary { merged += v }
    }
    return merged
  }
  let t = node.at("type", default: none)
  if type(t) == array { t = t.filter(x => x != "null").at(0, default: "null") }
  if t == none {
    if "properties" in node { t = "object" } else if "items" in node { t = "array" }
  }
  if t == "object" {
    let sampled = (:)
    for (key, sub) in node.at("properties", default: (:)) {
      sampled.insert(key, _sample(root, sub, depth + 1, seen))
    }
    let out = _object(node, sampled)
    // A partial object default fills in the generated shape rather than replacing it.
    if filled.len() > 0 { out += filled.first() }
    return out
  }
  if t == "array" {
    let items = node.at("items", default: none)
    if items == none { return () }
    let item = _sample(root, items, depth + 1, seen)
    if item == _cut { return () }
    return range(calc.max(1, node.at("minItems", default: 1))).map(_ => item)
  }
  if t == "string" { return _formats.at(node.at("format", default: ""), default: "Sample text") }
  if t == "integer" or t == "number" { return node.at("minimum", default: 1) }
  if t == "boolean" { return true }
  none
}

// Minimal mode. Only `required` properties, nullable values are `none`, arrays are empty unless
// `minItems` says otherwise, `examples` and `default` are ignored. `$ref` and `allOf` follow full mode.
#let _is-nullable(node) = {
  let t = node.at("type", default: none)
  if t == "null" or (type(t) == array and "null" in t) { return true }
  for key in ("anyOf", "oneOf") {
    for branch in node.at(key, default: ()) {
      if type(branch) == dictionary and branch.at("type", default: none) == "null" { return true }
    }
  }
  false
}

#let _minimal(root, node, depth, seen) = {
  if depth > 16 or type(node) != dictionary { return none }
  if _is-nullable(node) { return none }
  if _is-image(node) { return _placeholder }
  if "const" in node { return node.at("const") }
  if "enum" in node and node.at("enum").len() > 0 { return node.at("enum").first() }
  if "$ref" in node {
    let ref = node.at("$ref")
    if _recursing(seen, ref) { return _cut }
    return _minimal(root, _resolve(root, ref), depth + 1, seen + (ref,))
  }
  for key in ("anyOf", "oneOf") {
    if key in node and node.at(key).len() > 0 {
      let v = _minimal(root, node.at(key).first(), depth + 1, seen)
      return if v == _cut { none } else { v }
    }
  }
  if "allOf" in node {
    let merged = (:)
    for part in node.at("allOf") {
      let v = _minimal(root, part, depth + 1, seen)
      if type(v) == dictionary { merged += v }
    }
    return merged
  }
  let t = node.at("type", default: none)
  if type(t) == array { t = t.at(0, default: none) }
  if t == none {
    if "properties" in node { t = "object" } else if "items" in node { t = "array" }
  }
  if t == "object" {
    let sampled = (:)
    let properties = node.at("properties", default: (:))
    for key in node.at("required", default: ()) {
      sampled.insert(key, _minimal(root, properties.at(key, default: none), depth + 1, seen))
    }
    return _object(node, sampled)
  }
  if t == "array" {
    let items = node.at("items", default: none)
    let count = node.at("minItems", default: 0)
    if items == none or count <= 0 { return () }
    let item = _minimal(root, items, depth + 1, seen)
    if item == _cut { return () }
    return range(count).map(_ => item)
  }
  if t == "string" { return "a" * node.at("minLength", default: 0) }
  if t == "integer" or t == "number" {
    if "minimum" in node { return node.at("minimum") }
    let above = node.at("exclusiveMinimum", default: none)
    if t == "integer" and type(above) in (int, float) { return above + 1 }
    return 0
  }
  if t == "boolean" { return false }
  none
}

/// Builds a sample value from a JSON Schema (a dictionary). `mode` is "full" or "minimal".
#let sample-from-schema(schema, mode: "full") = {
  // The root is itself an expansion of "#", so a schema that refers to itself recurses one level too.
  let value = if mode == "full" { _sample(schema, schema, 0, ("#",)) }
    else if mode == "minimal" { _minimal(schema, schema, 0, ("#",)) }
    else { panic("@local/typfolio: sample mode must be \"full\" or \"minimal\", got " + repr(mode)) }
  if value == _cut { none } else { value }
}
