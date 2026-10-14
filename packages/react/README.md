# @typfolio/react

Headless React bindings over the framework-independent `PdfClient` contract from `@typfolio/core`. The package neither creates nor disposes a compiler. Applications may inject a direct core compiler or the optional worker-backed client from `@typfolio/workers`.

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
    svg: svgCapture({ removeSelectors: ['.chart-tooltip'] }),
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
