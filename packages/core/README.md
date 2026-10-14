# @typfolio/core

Framework-independent Typst PDF compilation whose only runtime dependency is `@typfolio/wasm`, the generated WASM and matching bindings (packaged separately).

```ts
import { createCompiler } from '@typfolio/core';

const wasm = new URL('/typst/compiler.wasm', location.href);
const font = new Uint8Array(await (await fetch('/fonts/report.otf')).arrayBuffer());
const compiler = await createCompiler({ wasm, fonts: [font] });

try {
  const result = await compiler.compile({
    template: `
#let input = json("/input.json")
#set text(font: "Libertinus Serif", lang: "en")
#set document(title: input.title)
= #input.title
#input.message
`,
    input: { title: 'Report', message: 'Application data goes here.' },
    pdf: { standards: ['ua-1'], tags: true },
  });
  // result.bytes is a Uint8Array; the application owns previews/downloads.
} finally {
  await compiler.dispose();
}
```

The font name in the template must match the supplied font. Fonts and WASM are loaded explicitly. In Node, read the `@typfolio/wasm/compiler.wasm` export with `fs.readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')))`. Browsers/bundlers should copy that asset to a hosted URL or use their explicit asset mechanism; the package does not choose a CDN.

## Contract

- `template`: either a string or `{ entrypoint?, files }`. A string is a single-file template, mounted as `/main.typ` and used as the entrypoint; compile diagnostics for it report the path `/main.typ`. In the object form, `files` maps virtual paths to source strings (including nested `.typ` imports) and `entrypoint` defaults to `main.typ`, which must then be one of the files (otherwise the request is rejected with `INVALID_REQUEST`). Set `entrypoint` explicitly to use another file. The `PdfTemplate` type is exported.
- `templateFromFiles(files, { base?, entrypoint? })`: turns a bundler glob result (for example Vite's `import.meta.glob('./report/**/*.typ', { query: '?raw', import: 'default', eager: true })`) into a template whose keys are virtual paths relative to the template folder. Pure and bundler-neutral; see `docs/template-authoring.md`.
- `input`: JSON-compatible values. Core reserves `/input.json`; endpoint fetching and Zod/domain validation belong to the application. `PdfRequest<Input>` is generic (type-only, unconstrained, default `JsonValue`) so an application can type `input`; JSON compatibility is still checked at runtime. Templates can read the input as `json("input.json")` from the entrypoint, or with the bundled Typst package below.
- Reserved virtual paths: `/input.json` (the request input) and everything under `/@typfolio/` (core's mounted Typst package). Template files and assets at those paths are rejected with `INVALID_REQUEST`.
- `assets`: a record of virtual paths to `Uint8Array`, copied at submission.
- `pdf`: zero or one standard, tags, and creation timestamp in Unix seconds. Read `compiler.capabilities` for current support. Unsupported options are rejected.
- `compile(request, { signal })`: Promise of PDF bytes, diagnostics, and title metadata.
- `dispose()`: idempotent; stops new jobs and waits for accepted work.

One active call is allowed per compiler. Concurrent calls reject with `TypstPdfError.code === 'BUSY'`. Core does not schedule jobs. A signal can cancel before synchronous execution; hard cancellation requires a worker. Upstream WASM initialization is shared per JS realm: reuse the same `wasm` value for multiple compilers in that realm.

`TypstPdfError` provides `code`, `message`, `diagnostics`, and (when relevant) `cause`. Compile diagnostic ranges use upstream zero-based line/column notation. Export diagnostics can have only text.

Remote Typst packages (everything except the bundled one), page ranges, experimental feature flags, and simultaneous PDF standards are not implemented. The pinned upstream builder requires dynamic function construction, so a strict CSP that forbids `unsafe-eval` needs a future binding change. Importing the JS module alone does not instantiate WASM or fetch resources.

## Bundled Typst package

`@typfolio/core` ships one Typst package, `@local/typfolio:0.1.0`, as files in `typst-packages/local/typfolio/0.1.0/` (`typst.toml`, `lib.typ`, `sample.typ`). Each compile mounts `typst.toml` and `lib.typ` (not `sample.typ`) in the request's virtual file system, sets `sys.inputs.typfolio`, and also mounts the input at the package root (an absolute path inside a package resolves to the package root, not the project). Templates use it like this:

```typ
#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./report.schema.json"))
```

Under Typfolio `input()` returns `request.input` and never reads the schema. In an editor (where nothing sets `sys.inputs`) it imports the sample builder from `sample.typ`, inside the function body, and builds a sample from the JSON Schema so completion works; `--input typfolio-sample=minimal` previews the sparse sample instead of the default `full` one. The runtime embeds only `lib.typ`. `compiler.capabilities.typstPackages` is `['@local/typfolio:0.1.0']`; any other `@namespace/name:version` import fails with a `COMPILATION` error that names the supported package. The directory layout is the one Tinymist expects for `--package-path`; see `docs/template-authoring.md` for the editor setting. The shipped `.typ`/`.toml` files are the source of truth: `tools/generate-typst-package.mjs` (the first step of `npm run build`) generates `src/typst-package.generated.ts` (`typst.toml` and `lib.typ`, the runtime module) and `src/dev-tools/sample-source.generated.ts` (`sample.typ`, imported only by dev-tools). Neither is edited by hand.

## Dev-time tools

`@typfolio/core/dev-tools` is the home for tools used while building and testing templates, not while serving requests. It is a separate subpath entry: the main entry exports nothing from it and never imports it (a test follows the import graph, and `npm run test:vite` checks that the React example's bundle has `lib.typ` but none of `sample.typ`), so it adds nothing to a production bundle and tree-shaking does not have to find it. A PDF structure inspector is planned there; it is not implemented.

`createTemplateChecker({ wasm, fonts })` (the options of `createCompiler`) returns `{ check(template, { modes?, pdf? }), dispose() }`, and `checkTemplate(template, { wasm, fonts, modes?, pdf? })` is the one-shot form. `check` compiles the template once per sample mode (`'minimal'` then `'full'` by default) the way an editor does, so `input()` builds the sample from the schema, and returns `{ ok, results }` with `{ mode, ok, diagnostics, error?, bytes? }` per mode. The caller puts the schema in `template.files`, as a string, at the path the template's `json.with(...)` names; the helper does not locate it. A `COMPILATION` error is reported per mode, a malformed template or option is thrown, and nothing is written to disk. See "Build-time checks" in `docs/template-authoring.md` for the recipe and the limits: it compares the template with the schema's shape, not with runtime data, and says nothing about accessibility. Under `minimal`, strings are `""` unless the schema says `minLength` (Zod: `.min(1)`), so declare `minLength: 1` on a string that becomes a heading or the document title; otherwise PDF/UA correctly reports the empty heading.

## Captured browser assets

Browser-only helpers live behind separate subpath entries so Node, worker, and server code that imports `@typfolio/core` never loads DOM code. The main entry exports none of them, and none touch browser globals at import time.

- `@typfolio/core/capture`: `captureProps`, `captureAssets`, `TypfolioCaptureError`, and the adapter and result types.
- `@typfolio/core/capture/svg`: `svgCapture`, a dependency-free adapter that serializes one inline SVG and preserves vector output.
- `@typfolio/core/capture/dom`: `domPngCapture`, an opt-in PNG fallback for arbitrary DOM. It loads `html2canvas` by dynamic import only when it first runs. `html2canvas` is an optional peer dependency: install it only if you use this adapter. If it is missing when the default rasterizer runs, the capture rejects with `CAPTURE_FAILED` and the import error as `cause`; passing your own `rasterize` never loads it.

Each marked region owns its adapter `kind` and its alt text. `captureProps` returns the data attributes (`data-typfolio-capture`, `data-typfolio-capture-kind`, and `data-typfolio-capture-alt` or `data-typfolio-capture-decorative`) to spread onto any element. They add no role or accessible name. `@typfolio/react/capture` offers a `CaptureRegion` component over the same attributes; plain DOM and other frameworks can spread `captureProps` directly.

```ts
import { captureAssets, captureProps } from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';

// Plain DOM (any framework: spread the same props onto the element).
const chart = document.querySelector('#performance-chart');
for (const [name, value] of Object.entries(captureProps({
  id: 'performance-chart',
  kind: 'svg',
  altText: '72% of students met the goal.',
}))) chart.setAttribute(name, value);

const captured = await captureAssets(document.querySelector('#report'), {
  adapters: {
    svg: svgCapture({ removeSelectors: ['.chart-tooltip'] }),
    png: domPngCapture({ pixelRatio: 2, backgroundColor: '#fff' }),
  },
  require: ['performance-chart'],
});

await compiler.compile({
  ...request,
  assets: { ...request.assets, ...captured.assets },
  input: { report: reportInput, figures: captured.references },
});
```

`captureAssets(root, { adapters, require?, signal? })` discovers every marked element under `root` (and `root` itself) in DOM order, then captures them one at a time. Everything is validated before any adapter runs:

- `root === null` rejects with `NOT_READY`; a root with no regions and nothing required resolves with empty results.
- `INVALID_OPTIONS` for a malformed id (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, because it becomes a file name), a missing kind, or an invalid adapter; `DUPLICATE_ID` for repeated ids.
- `UNKNOWN_KIND` for a region whose kind has no entry in `adapters` (never skipped silently).
- `INVALID_ACCESSIBILITY` for a region that has neither non-blank alt text nor `decorative`, or has both. Alt text is trimmed.
- `NOT_FOUND` for each id in `require` that is not present.
- Capture failures are wrapped as `CAPTURE_FAILED`, an adapter that returns no bytes as `EMPTY_ASSET`, and an aborted signal as `ABORTED`.

Asset paths are derived as `captures/<id><first adapter extension>`. The result is `{ assets, references }`: `assets` is ready for `request.assets`, and `references` is keyed by id with `{ path, decorative: false, altText }` or `{ path, decorative: true }`, suitable for `request.input`. `captureProps` does not throw for empty alt text so a component can render before its data is ready; `captureAssets` rejects it.

The template must apply the reference at the image use site, for example `#image(figure.path, alt: figure.altText)`. Alternative text should communicate the visual's conclusion, not merely identify it as a chart, and complex visuals need nearby text or tabular data. SVG is preferred for charts. DOM-to-PNG is intended for composed visuals; paragraphs, headings, and tables should be generated natively in Typst. Captured regions must have a non-zero rendered size. DOM-to-PNG follows browser rasterization constraints: cross-origin images need suitable CORS headers, web fonts and images must already be ready, and an `AbortSignal` cannot preempt work already executing inside `html2canvas`.

See the repository's `docs/compiler-build.md` for source pins, build commands, and compatibility and limits. A PDF/UA option does not replace accessible template authoring and human review.
