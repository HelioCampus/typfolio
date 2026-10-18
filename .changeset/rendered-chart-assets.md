---
"@typfolio/core": minor
"@typfolio/react": minor
"@typfolio/wasm": patch
"@typfolio/workers": patch
"@typfolio/dev-tools": minor
---

A PDF kept up to date with its inputs, with charts drawn at the template's size.

- `@typfolio/react`: new `usePdf(options)`, a declarative counterpart to `usePdfCompilation`: it builds the input (`input: ({ render }) => …`, rebuilt when `deps` change), draws the charts `render(<Chart … />)` adds, compiles, and compiles again when its inputs change. It returns the status, the newest `result`, an object `url`, `download(fileName?)`, `rebuild()`, `cancel()` and `<AssetRenderer />`, which you render once in your tree: the charts draw in it, off the page, with your providers and CSS. Unchanged charts are not drawn again.
- `@typfolio/react`: `usePdf` and `usePdfCompilation` take a `client` option, for applications without a `PdfProvider` above every screen. `usePdfObjectUrl` gives no URL where the platform has no object URLs (jsdom), instead of throwing.
- `@typfolio/react`: `usePdf` and `useRenderedAssets` take `validate(input)`: throw to reject an input (with your schema library); nothing is drawn or compiled, and the error is reported.
- `@typfolio/core`, `@typfolio/dev-tools`: the sample builder expands a recursive schema one level and ends it in empty lists (it used to leave a `null` item in a list), and resolves `"$ref": "#"`.
- `@typfolio/react`: new `useRenderedAssets(build, options)`, the chart drawing on its own, for a compile flow of your own.
- `@typfolio/react`: `react-dom` (18.2 or newer) is now a peer dependency.
- `@typfolio/core`: `serializeSvg(svg, { fontFamily?, beforeSerialize? })` from `@typfolio/core/capture/svg`, the serializer behind `svgCapture`, for an SVG element you already hold.
- `@typfolio/core` (breaking): `svgCapture`'s `removeSelectors` is replaced by `beforeSerialize(svg)`, and `domPngCapture`'s by `beforeRasterize(element)`. Each runs on the copy before it is written, never on the live page: `svgCapture({ beforeSerialize: svg => svg.querySelector('.tooltip')?.remove() })`.
- `@typfolio/dev-tools`: `check` and `checkTemplate` take `assets`, the files a template reads besides its input, as a request does.
- All packages: top-level `types` and, for subpath entries, `typesVersions`, so TypeScript projects that still use `moduleResolution: "node"` (which ignores `exports`) find the declarations.
- `@typfolio/core`: an SVG whose clone carries its own `xmlns` attribute (Highcharts sets one) no longer serializes with the namespace declared twice, which was invalid XML.
