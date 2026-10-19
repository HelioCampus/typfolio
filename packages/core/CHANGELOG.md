# @typfolio/core

## 0.2.0

### Minor Changes

- 4971d15: A PDF kept up to date with its inputs, with charts drawn at the template's size; templates whose parts have data of their own, each checked by its schema.
  
  - `@typfolio/core`: `defineTemplate`, `definePartial` and `defineInput` describe a template whose parts read data of their own, such as a shared header with the institution and its logo. Each input pairs a Standard Schema (Zod, Valibot, ArkType, …) with the path of its JSON Schema file; the Typst file reads its data with `input(json.with("./header.schema.json"))`, a sample in the editor and the request's data under Typfolio. A request is `{ template, input, partials: { header: … } }`, typed by the schemas (`TemplateRequest`), and every `compile` (core, worker, React) type-checks it. Data is checked before compiling; data that does not match rejects with the new error code `INVALID_INPUT`, which lists the issues. Such a template compiles only the files it declares, and a file it imports without declaring it fails with a `file-not-found` diagnostic. Plain templates and `/input.json` work as before.
  - `@typfolio/core`: diagnostic codes. A diagnostic Typfolio recognises carries a `code`, the facts as fields and a one-line message linking to `docs/errors.md`: `file-not-found` (with `file`: a missing import, JSON file or image, where Typst only said "failed to load file (is a directory)") and `missing-glyph` (with `text`: a character no loaded font can draw, refused by a PDF standard). Switch on `code` rather than on messages.
  - `@typfolio/core`: a PDF standard's failure (an image without alt text, a missing glyph) reads as its message, one diagnostic per failure, instead of the binding's Rust debug text.
  - `@typfolio/core`: the Typst package every compile mounts is embedded without its comments (about 0.7 KB less in an application's bundle); the files shipped for editors keep them.
  - `@typfolio/core`: `createAttachments()` numbers the files a request carries: `add(bytes, "png")` returns `/attachments/0.png` to put in the data.
  - `@typfolio/core`, `@typfolio/dev-tools`: the sample builder draws a placeholder image for a string whose `contentMediaType` is an image, so `image(data.logo)` compiles in the editor and in checks.
  - `@typfolio/core` (breaking, types only): `PdfClient.compile` is generic so that it can check a defined template's request. A custom client whose `compile` takes only `PdfRequest` must take `AnyPdfRequest`.
  - `@typfolio/workers`: a defined template's data is checked on the calling thread, and only the data crosses to the worker. In a batch, a job whose data fails its schema is that job's error; the rest still compile.
  - `@typfolio/dev-tools`: `inputSchemaFiles(definitions, { toJSONSchema? })` gives each input's JSON Schema file by path, to write for the editor and to compare in a test; `check` takes a defined template and compiles only the files it declares.
  - `@typfolio/react` (breaking): `usePdf` is the React API. `PdfProvider`, `usePdfClient`, `usePdfCompilation` and `usePdfObjectUrl` are removed: pass the client to `usePdf` (`client` is required), use its `url`, keep submitted data in state and `enabled` for a compile on click, and call `client.compile(request)` for a one-off PDF.
  - `@typfolio/react`: new `usePdf(options)`: it builds the data (`data: ({ render, attach }) => ({ input, partials })`, rebuilt when `deps` change, typed by the template), draws the charts `render(<Chart … />)` adds, compiles, and compiles again when its inputs change. `attach(bytes, extension)` adds a file such as a logo. A defined template's schemas are checked before anything is drawn. It returns the status, the newest `result`, an object `url`, `download(fileName?)`, `rebuild()`, `cancel()` and `<AssetRenderer />`, which you render once in your tree: the charts draw in it, off the page, with your providers and CSS. Unchanged charts are not drawn again.
  - `@typfolio/react`: `usePdf` takes `validate`: throw to reject the data (for a plain template, with your schema library); nothing is drawn or compiled, and the error is reported. Where the platform has no object URLs (jsdom), `url` stays undefined instead of throwing.
  - `@typfolio/react`: `render()` returns absolute paths (`/charts/0.svg`), so a template reads a chart with `image(path)` from any of its files.
  - `@typfolio/core`, `@typfolio/dev-tools`: the sample builder expands a recursive schema one level and ends it in empty lists (it used to leave a `null` item in a list), and resolves `"$ref": "#"`.
  - `@typfolio/react`: `react-dom` (18.2 or newer) is now a peer dependency.
  - `@typfolio/core`: `createLazyCompiler(options)`, a synchronous `PdfClient` that loads its compiler on the first compile, retries a failed load, and queues calls.
  - `@typfolio/core`: `serializeSvg(svg, { fontFamily?, beforeSerialize? })` from `@typfolio/core/capture/svg`, the serializer behind `svgCapture`, for an SVG element you already hold.
  - `@typfolio/core` (breaking): `svgCapture`'s `removeSelectors` is replaced by `beforeSerialize(svg)`, and `domPngCapture`'s by `beforeRasterize(element)`. Each runs on the copy before it is written, never on the live page: `svgCapture({ beforeSerialize: svg => svg.querySelector('.tooltip')?.remove() })`.
  - `@typfolio/dev-tools`: `check` and `checkTemplate` take `assets`, the files a template reads besides its input, as a request does.
  - All packages: top-level `types` and, for subpath entries, `typesVersions`, so TypeScript projects that still use `moduleResolution: "node"` (which ignores `exports`) find the declarations.
  - `@typfolio/core`: an SVG whose clone carries its own `xmlns` attribute (Highcharts sets one) no longer serializes with the namespace declared twice, which was invalid XML.

### Patch Changes

- Updated dependencies [4971d15]
  - @typfolio/wasm@0.1.1

## 0.1.0

### Minor Changes

- First npm release of the Typfolio packages: the Typst WebAssembly compiler (`@typfolio/wasm`), the framework-independent PDF compiler (`@typfolio/core`), template and PDF checks for development (`@typfolio/dev-tools`), Web Worker execution (`@typfolio/workers`) and headless React bindings (`@typfolio/react`).

### Patch Changes

- Updated dependencies
  - @typfolio/wasm@0.1.0
