# @typfolio/react

Headless React bindings over the framework-independent `PdfClient` contract from `@typfolio/core`. `react` and `react-dom` (18.2 or newer) are peer dependencies.

- `usePdf`: a PDF kept up to date with its inputs, like a query, charts included.
- `CaptureRegion` (`@typfolio/react/capture`): marks live regions for `captureAssets`.

`usePdf` takes the client that compiles, and neither creates nor disposes it. Create it once, outside your components:

```ts
import { createLazyCompiler } from '@typfolio/core';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';

// Loads the WASM and the fonts on the first compile, and keeps them for the page.
export const pdfClient = createLazyCompiler({ wasm: wasmUrl, fonts: ['/fonts/report.otf'] });
```

To compile off the main thread, pass a worker client instead (`createWorkerClient` from `@typfolio/workers`): the same `PdfClient` contract, and cancelling reaches the worker, which can stop an active WASM job. Your application owns the client and calls its `dispose()` when its lifetime ends. A one-off PDF outside React is `await pdfClient.compile(request)`.

## usePdf

```tsx
import { usePdf } from '@typfolio/react';
import { pdfClient } from './pdfClient';

const charts = {
  fonts: [{ family: 'Open Sans', source: openSansUrl }],
  fontFamily: 'Open Sans',
  beforeSerialize: (svg: SVGSVGElement) =>
    svg.querySelectorAll('.highcharts-tooltip').forEach(node => node.remove()),
};

function ResultsPdf({ rows, includeDetails, institution, logo }) {
  const pdf = usePdf({
    client: pdfClient,
    template: results, // defineTemplate({ ..., partials: { header } }), defined outside the component
    // render() draws a React element for the PDF and returns its path: "/charts/0.svg", …
    // attach() adds a file, such as a logo, and returns its path: "/attachments/0.png".
    data: ({ render, attach }) => ({
      input: {
        includeDetails,
        rows: rows.map(row => ({
          name: row.name,
          chart: render(<ProficiencyChart data={row.levels} width={720} height={200} skipAnimation />),
          chartAlt: describeLevels(row.levels),
        })),
      },
      partials: { header: { institution, logo: attach(logo, 'png') } },
    }),
    deps: [rows, includeDetails, institution, logo], // like useMemo: a change builds the data again and recompiles
    pdf: { standards: ['ua-1'] },
    charts,
    onError: error => notify.error('Could not build the PDF.'),
  });

  return (
    <>
      <pdf.AssetRenderer />
      {pdf.isLoading ? <Spinner /> : <iframe src={pdf.url} title="PDF preview" />}
      <button disabled={!pdf.isSuccess} onClick={() => pdf.download('results')}>Download</button>
    </>
  );
}
```

```typst
#import "@local/typfolio:0.1.0": input
#import "../common/header.typ": report-header
#let data = input(json.with("./results.schema.json"))
#report-header()
#for row in data.rows [
  #image(row.chart, width: 100%, alt: row.chartAlt)
]
```

`data` is typed by the template: `input` by its schema, and `partials` with each partial's data, so a missing header or a wrong field is a type error. Before anything is drawn, the data is checked against the template's schemas; data that does not match is reported through `error` and `onError` (`INVALID_INPUT`), and no chart is drawn. See [templates whose parts have data of their own](../../docs/template-authoring.md#templates-whose-parts-have-data-of-their-own) for `defineTemplate`. A plain template (`{ entrypoint, files }` or a string) takes `data: { input }`.

It draws the data's charts, compiles once they are drawn, and compiles again when `deps`, `assets`, `template` or `pdf` change. A newer compile cancels the one in flight, and the newest finished PDF stays in `result` while the next one is on its way. Nothing is compiled on a render that changed nothing: `assets` and a plain template's files are compared by reference, a defined template by reference, `pdf` as JSON, and a plain `data` value as JSON when its reference changes, so objects written inline in JSX do not recompile.

Options:

| Option | |
|---|---|
| `client` | The `PdfClient` that compiles: `createLazyCompiler(...)`, or a worker client. Required. |
| `template` | A template made with `defineTemplate`, or a plain `PdfTemplate`. Keep it stable. |
| `data` | `{ input, partials }`, or `({ render, attach }) => ({ input, partials })`. `render(element)` draws a chart and returns its path (`/charts/0.svg`); `attach(bytes, extension)` adds a file and returns its path (`/attachments/0.png`); the same bytes share one path. |
| `deps` | What a function `data` reads, compared like `useMemo`'s dependencies. Defaults to `[]`: built once. Hold data in `useState` for a snapshot that ignores later refreshes. |
| `assets` | Other files the template reads, by path, that `data` does not attach. |
| `pdf` | `PdfOptions`, such as `{ standards: ['ua-1'] }`. |
| `charts` | How `render` draws: `fonts`, `fontFamily`, `beforeSerialize`, `directory` (default `charts`), `width` (default 1024 px), `timeoutMs` (default 10 000). |
| `enabled` | When false, nothing is drawn or compiled, and a compile in flight is cancelled (nothing late is reported). Enabled again with nothing changed, the PDF already compiled is reused. Defaults to true. |
| `validate` | Checks the built data before anything is drawn or compiled; throw to reject it. A defined template checks its own schemas; this is for a plain template (`validate: data => schema.parse(data.input)`) or for checks a schema cannot express. Rejected data is reported through `error` and `onError`. |
| `onSuccess`, `onError`, `onSettled` | `onError` also reports data that does not match its schema and a chart that could not be drawn. A compile error carries `diagnostics`; switch on a diagnostic's `code` (`missing-glyph`, `file-not-found`), not its message: see [docs/errors.md](../../docs/errors.md). |

Result: `status` (`idle`, `drawing`, `compiling`, `success`, `error`), `result` (`bytes`, `diagnostics`, `metadata`), `diagnostics`, `error`, `isLoading` (no PDF yet, one on its way), `isFetching` (drawing or compiling), `isSuccess`, `isError`, `url` (an object URL of `result`, revoked for you), `download(fileName?)` (adds `.pdf` once; defaults to the PDF's title), `rebuild()` (builds the data again with the same `deps`, draws every chart again, recompiles), `cancel()`, and `AssetRenderer`.

To compile on a click rather than as the data changes, keep what was submitted in state and enable `usePdf` once there is something: `data: { input: submitted }, enabled: submitted !== undefined`. Submitting equal data again changes nothing, so call `rebuild()` for that. The hook renders on the server without starting any work.

### Charts

`render(element)` draws the element once more for the PDF: away from the page, at the size its own props give it. The PDF never depends on how wide the page is, or on what a narrow layout hides, and the path goes straight into the data where the chart is used: nothing to match up afterwards. Paths are absolute, so `image(row.chart)` reads the chart from any template file.

- Render `<pdf.AssetRenderer />` anywhere in your tree. The charts draw inside it, portalled to a hidden, off-screen element at the end of `<body>` (`aria-hidden`, `inert`), so they see your providers (theme, i18n, data clients) and your page CSS. It renders nothing visible.
- The charts mount in a React transition: on a concurrent root (`createRoot`), React draws them in slices and the browser can paint (the dialog that asked for the PDF, say) in between. Under the legacy `ReactDOM.render` they draw at once; nothing else changes.
- A chart whose component and props are unchanged since the last build is not drawn again. Props are compared as plain data: a chart with a function, an element or a class instance (a `Date`, a `Map`) among its props is drawn on every build. `rebuild()` draws everything again.
- `fonts` are loaded before anything is drawn, and stay loaded until the component unmounts; with `fontFamily`, chart text is drawn, measured and written in that family whatever font the chart asks for.
- `beforeSerialize(svg)` runs on each chart's copy, after its styles are inlined, just before it is written: remove tooltips, add a `<title>`, rewrite labels. The chart on the page is never passed to it.
- Turn chart animations off (`skipAnimation`, `animation: false`): the first drawing is the one written. Each element should draw one SVG; when it draws several (legend icons), the largest is used. Canvas-based charts draw no SVG and are not supported.

## Captured browser assets

`@typfolio/react/capture` exports `CaptureRegion`, a thin component that marks a rendered region without adding a role or accessible name to the live page. Each region carries its own adapter `kind` and its own alt text (or `decorative`), so the component that owns the data also owns the description.

Discovery and capture are framework-independent and live in `@typfolio/core`: `captureAssets` from `@typfolio/core/capture`, plus the `svgCapture` and `domPngCapture` adapters from `@typfolio/core/capture/svg` and `@typfolio/core/capture/dom`. The React package re-exports none of them. Capture remains imperative: call it from the export action after the application knows its content is ready. See [the core README](../core/README.md#captured-browser-assets) for the full API, errors, and the DOM-to-PNG `html2canvas` peer dependency.

```tsx
import { CaptureRegion } from '@typfolio/react/capture';
import { captureAssets } from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';

// Inside the components that own the data:
<CaptureRegion captureId="performance-chart" kind="svg" altText={`${pct}% of students met the goal.`}>
  <PerformanceChart />
</CaptureRegion>;
<CaptureRegion captureId="divider" kind="png" decorative>
  <Divider />
</CaptureRegion>;

// In the export action, which only knows the root and which adapters exist:
const captured = await captureAssets(reportRef.current, {
  adapters: {
    svg: svgCapture({ beforeSerialize: svg => svg.querySelector('.chart-tooltip')?.remove() }),
    png: domPngCapture({ pixelRatio: 2, backgroundColor: '#fff' }),
  },
  require: ['performance-chart'],
});

await pdf.compile({
  ...request,
  assets: { ...request.assets, ...captured.assets },
  input: { report: reportInput, figures: captured.references },
});
```

`CaptureRegion` accepts `captureId`, `kind`, either `altText` or `decorative`, an optional `as` element type (default `div`), and the element's own props. Assets are written to `captures/<captureId><extension>`. Every region must provide non-empty `altText` or be `decorative`; `captureAssets` rejects a region that has neither or both. References are JSON-safe, but the template must apply their semantics at the image use site:

```typst
#let figure = input.figures.at("performance-chart")
#image(figure.path, alt: figure.altText)
```

Alternative text should communicate the visual's conclusion ("72% of students met the goal"), not merely identify it as a chart. Complex visuals should also have nearby text or tabular data. DOM-to-PNG is intended for composed visuals; paragraphs, headings, and tables should be generated natively in Typst so their document structure remains available to assistive technology.

Captured regions must be rendered at a non-zero size. SVG is preferred for charts. DOM-to-PNG follows browser rasterization constraints: cross-origin images need suitable CORS headers, web fonts and images must already be ready, and an `AbortSignal` can discard an unfinished capture but cannot preempt work already executing inside `html2canvas`.
