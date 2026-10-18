# @typfolio/react

Headless React bindings over the framework-independent `PdfClient` contract from `@typfolio/core`. `react` and `react-dom` (18.2 or newer) are peer dependencies. The package neither creates nor disposes a compiler: `PdfProvider` takes one, a direct core compiler or the optional worker-backed client from `@typfolio/workers`, and every hook below uses it.

- `usePdf`: a PDF kept up to date with its inputs, like a query. Charts included. Start here.
- `usePdfCompilation`: compile when you say so, like a mutation.
- `useRenderedAssets`: only the chart drawing, for a compile flow of your own.
- `CaptureRegion` (`@typfolio/react/capture`): marks live regions for `captureAssets`.

## usePdf

```tsx
import { PdfProvider, usePdf } from '@typfolio/react';

const charts = {
  fonts: [{ family: 'Open Sans', source: openSansUrl }],
  fontFamily: 'Open Sans',
  beforeSerialize: (svg: SVGSVGElement) =>
    svg.querySelectorAll('.highcharts-tooltip').forEach(node => node.remove()),
};

function ResultsPdf({ rows, includeDetails }) {
  const pdf = usePdf({
    template, // stable: defined outside the component
    // render() draws a React element for the PDF and returns its path: "charts/0.svg", …
    input: ({ render }) => ({
      includeDetails,
      rows: rows.map(row => ({
        name: row.name,
        chart: render(<ProficiencyChart data={row.levels} width={720} height={200} skipAnimation />),
        chartAlt: describeLevels(row.levels),
      })),
    }),
    deps: [rows, includeDetails], // like useMemo: a change builds the input again and recompiles
    assets: logo ? { 'logo.png': logo } : undefined,
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

<PdfProvider client={client}>
  <ResultsPdf rows={rows} includeDetails />
</PdfProvider>;
```

```typst
#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./results.schema.json"))
#for row in data.rows [
  #image("/" + row.chart, width: 100%, alt: row.chartAlt)
]
```

It draws the input's charts, compiles once they are drawn, and compiles again when `deps`, `assets`, `template` or `pdf` change. A newer compile cancels the one in flight, and the newest finished PDF stays in `result` while the next one is on its way. Nothing is compiled on a render that changed nothing: `assets` and the template's files are compared by reference, `pdf` as JSON, and a plain `input` value as JSON when its reference changes, so objects written inline in JSX do not recompile.

Options:

| Option | |
|---|---|
| `template` | A `PdfTemplate`. Keep it stable. |
| `input` | The template input, or `({ render }) => input`. |
| `deps` | What a function `input` reads, compared like `useMemo`'s dependencies. Defaults to `[]`: built once. Hold data in `useState` for a snapshot that ignores later refreshes. |
| `assets` | Other files the template reads, by path. |
| `pdf` | `PdfOptions`, such as `{ standards: ['ua-1'] }`. |
| `charts` | How `render` draws: `fonts`, `fontFamily`, `beforeSerialize`, `directory` (default `charts`), `width` (default 1024 px), `timeoutMs` (default 10 000). |
| `enabled` | When false, nothing is drawn or compiled, and a compile in flight is cancelled (nothing late is reported). Enabled again with nothing changed, the PDF already compiled is reused. Defaults to true. |
| `validate` | Checks the built input before anything is drawn or compiled; throw to reject it, e.g. `validate: input => schema.parse(input)` with your schema library. A rejected input is reported through `error` and `onError`. Typfolio validates nothing itself. |
| `client` | Compiles with this `PdfClient` instead of the one from `PdfProvider`: for an application without one provider above every screen. |
| `onSuccess`, `onError`, `onSettled` | `onError` also reports a chart that could not be drawn. |

Result: `status` (`idle`, `drawing`, `compiling`, `success`, `error`), `result` (`bytes`, `diagnostics`, `metadata`), `diagnostics`, `error`, `isLoading` (no PDF yet, one on its way), `isFetching` (drawing or compiling), `isSuccess`, `isError`, `url` (an object URL of `result`, revoked for you), `download(fileName?)` (adds `.pdf` once; defaults to the PDF's title), `rebuild()` (builds the input again with the same `deps`, draws every chart again, recompiles), `cancel()`, and `AssetRenderer`.

### Charts

`render(element)` draws the element once more for the PDF: away from the page, at the size its own props give it. The PDF never depends on how wide the page is, or on what a narrow layout hides, and the path goes straight into the input where the chart is used: nothing to match up afterwards.

- Render `<pdf.AssetRenderer />` anywhere in your tree. The charts draw inside it, portalled to a hidden, off-screen element at the end of `<body>` (`aria-hidden`, `inert`), so they see your providers (theme, i18n, data clients) and your page CSS. It renders nothing visible.
- The charts mount in a React transition: on a concurrent root (`createRoot`), React draws them in slices and the browser can paint (the dialog that asked for the PDF, say) in between. Under the legacy `ReactDOM.render` they draw at once; nothing else changes.
- A chart whose component and props are unchanged since the last build is not drawn again. Props are compared as plain data: a chart with a function, an element or a class instance (a `Date`, a `Map`) among its props is drawn on every build. `rebuild()` draws everything again.
- `fonts` are loaded before anything is drawn, and stay loaded until the component unmounts; with `fontFamily`, chart text is drawn, measured and written in that family whatever font the chart asks for.
- `beforeSerialize(svg)` runs on each chart's copy, after its styles are inlined, just before it is written: remove tooltips, add a `<title>`, rewrite labels. The chart on the page is never passed to it.
- Turn chart animations off (`skipAnimation`, `animation: false`): the first drawing is the one written. Each element should draw one SVG; when it draws several (legend icons), the largest is used. Canvas-based charts draw no SVG and are not supported.

## usePdfCompilation

```tsx
import { PdfProvider, usePdfCompilation, usePdfObjectUrl } from '@typfolio/react';

function ExportButton({ request }) {
  const pdf = usePdfCompilation({
    onSuccess(result) {
      analytics.track('pdf-generated', { bytes: result.bytes.length });
    },
    onError(error) {
      reportError(error);
    },
    onSettled(result, error, request) {
      auditCompilation({ result, error, request });
    },
  });
  const downloadUrl = usePdfObjectUrl(pdf.result);

  return (
    <>
      <button disabled={pdf.isCompiling} onClick={() => void pdf.compile(request)}>
        {pdf.isCompiling ? 'Generating…' : 'Generate PDF'}
      </button>
      {downloadUrl === undefined ? null : <a href={downloadUrl}>Download PDF</a>}
    </>
  );
}

<PdfProvider client={client}>
  <ExportButton request={request} />
</PdfProvider>;
```

The provider accepts the shared `PdfClient` contract, so a worker client needs no
React-specific adapter:

```tsx
import { createWorkerClient } from '@typfolio/workers';

const client = createWorkerClient({
  compiler: { wasm: wasmUrl, fonts },
  workerCount: 2,
});

<PdfProvider client={client}>
  <ExportButton request={request} />
</PdfProvider>;
```

The application still owns this client and should call `client.dispose()` when
its application-level lifetime ends. Cancelling `usePdfCompilation()` reaches
the worker client's `AbortSignal` path, which can terminate an active WASM job.

`usePdfCompilation()` is imperative. It owns at most one active request, cancels a previous request when a newer one starts, ignores stale completions, and cancels its active request during unmount or client replacement. Rerenders and request identity changes never start compilation.

`isIdle`, `isCompiling`, `isRecompiling`, `isSuccess`, `isError`, and `isCancelled` provide convenient state checks. A recompilation retains the last successful `result` and its diagnostics while the replacement runs; a failed or cancelled replacement also leaves that result available. `reset()` returns the hook to a completely empty idle state.

Optional `onSuccess`, `onError`, `onCancel`, and `onSettled` callbacks can be supplied to the hook or to an individual `compile()` call. Hook callbacks run before call-specific callbacks, and all callbacks receive the submitted request. `compile()` returns the new result and rejects on failure or cancellation so event handlers can also use ordinary promise control flow.

`usePdfObjectUrl(result)` turns the returned bytes into an `application/pdf` object URL and owns its complete lifecycle. It revokes replaced URLs and the current URL on unmount, while remaining safe to import and render on the server.

The provider treats `client` as caller-owned. It cancels requests owned by its hooks but never calls `dispose()` on the injected client. There is no compiler initialization, worker creation, or browser-global access during module import or server rendering.

## useRenderedAssets

The chart drawing of `usePdf` on its own, for an application that compiles in its own way. It takes the same builder and chart options, plus `deps`, `enabled`, `validate(value)`, `onReady(assets, value)` and `onError(error)`, and returns `{ value, assets, status, error, rebuild, AssetRenderer }`: `assets` holds the drawn SVG files for `value` once `status` is `ready`.

```tsx
const charts = useRenderedAssets(({ render }) => buildPayload(report, render), {
  deps: [report],
  fontFamily: 'Open Sans',
  onError: () => notify.error('Could not draw the charts.'),
});
// <charts.AssetRenderer />, then compile { input: charts.value, assets: charts.assets }
```

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
