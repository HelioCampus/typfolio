# @typfolio/core

Framework-independent Typst PDF compilation whose only runtime dependency is `@typfolio/wasm`, the generated WASM and matching bindings (packaged separately).

```ts
import { createCompiler } from '@typfolio/core';

const wasm = new URL('/typst/compiler.wasm', location.href);
const font = new URL('/fonts/report.otf', location.href);
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

The font name in the template must match the supplied font. Fonts and WASM are loaded explicitly.

`fonts` is a list of `Uint8Array | string | URL` with at least one entry, and the order is kept. Bytes are copied. A `URL`, or a string (resolved against the page URL when there is one, otherwise it must be absolute; an unresolvable string is an `INVALID_REQUEST` error), is downloaded with the global `fetch` while `createCompiler` runs; all downloads run concurrently and `compile` never fetches again. A non-OK response, a network error, an empty body, or a missing `fetch` rejects `createCompiler` with an `INITIALIZATION` error that names the URL and the status or cause. There is no default font set and no CDN: you name every font. In Node, read font files to bytes with `fs.readFile`; Node's `fetch` does not serve `file:` URLs. In Node, read the `@typfolio/wasm/compiler.wasm` export with `fs.readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')))`. Browsers/bundlers should copy that asset to a hosted URL or use their explicit asset mechanism; the package does not choose a CDN.

## Contract

- `template`: either a string or `{ entrypoint?, files }`. A string is a single-file template, mounted as `/main.typ` and used as the entrypoint; compile diagnostics for it report the path `/main.typ`. In the object form, `files` maps virtual paths to source strings (including nested `.typ` imports) and `entrypoint` defaults to `main.typ`, which must then be one of the files (otherwise the request is rejected with `INVALID_REQUEST`). Set `entrypoint` explicitly to use another file. The `PdfTemplate` type is exported.
- `templateFromFiles(files, { base?, entrypoint? })`: turns a bundler glob result (for example Vite's `import.meta.glob('./report/**/*.typ', { query: '?raw', import: 'default', eager: true })`) into a template whose keys are virtual paths relative to the template folder. Pure and bundler-neutral; see `docs/template-authoring.md`.
- `input`: JSON-compatible values. Core reserves `/input.json`; endpoint fetching and Zod/domain validation belong to the application. `PdfRequest<Input>` is generic (type-only, unconstrained, default `JsonValue`) so an application can type `input`; JSON compatibility is still checked at runtime. Templates can read the input as `json("input.json")` from the entrypoint, or with the bundled Typst package below.
- Reserved virtual paths: `/input.json` (the request input) and everything under `/@typfolio/` (core's mounted Typst package). Template files and assets at those paths are rejected with `INVALID_REQUEST`.
- `assets`: a record of virtual paths to `Uint8Array`, copied at submission (see `copyAssets` below).
- `copyAssets` (a `createCompiler` option, default `true`): by default `compile` copies every asset when it captures the request, so mutating, reusing, or detaching a buffer after calling `compile` cannot change the result. `copyAssets: false` mounts the caller's `Uint8Array` views as they are and skips that copy, which matters for multi-megabyte assets. The contract then is: the caller must not mutate, detach, or reuse an asset's buffer until the promise returned by `compile` settles. Validation of paths, types, reserved paths and JSON input is identical either way. `@typfolio/workers` sets it inside its workers, where the request arrives as a private transferred copy; set it yourself only when you own the buffers for the duration of the call.
- `pdf`: zero or one standard, tags, and creation timestamp in Unix seconds. Read `compiler.capabilities` for current support. Unsupported options are rejected.
- `compile(request, { signal })`: Promise of PDF bytes, diagnostics, and title metadata.
- A template made with `defineTemplate({ entrypoint?, files, input?, partials? })` takes `{ template, input, partials, assets?, pdf? }`, typed by its schemas (`TemplateRequest<typeof template>`). `defineInput(schema, path)` pairs a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, …) with the path of its JSON Schema file; `definePartial({ files, input, partials? })` is Typst code with runtime data of its own. Each piece of data is checked against its schema before compiling (`INVALID_INPUT`, with the issues; an asynchronous schema is awaited) and mounted at its schema's path, where its file reads it with `input(json.with(...))`. Such a template compiles only the files it declares; a file it imports without declaring it fails with a message that says what to do. See `docs/template-authoring.md`.
- `createAttachments()`: `add(bytes, extension)` returns a path such as `/attachments/0.png` to put in the data, and `assets` holds the files for the request. The same bytes added twice share one path.
- `dispose()`: idempotent; stops new jobs and waits for accepted work.

`createLazyCompiler(options)` takes the same options but is synchronous and returns a `PdfClient`: nothing is downloaded until its first `compile`, which loads the WASM and fonts once for every later call. A failed load is not kept, so the next call tries again, and calls run one at a time in order, so callers never see `BUSY`. Create it once at module level and pass it to `PdfProvider`, or as `usePdf`'s `client`:

```ts
import { createLazyCompiler } from '@typfolio/core';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';

export const pdfClient = createLazyCompiler({ wasm: wasmUrl, fonts: ['/fonts/report.otf'] });
```

One active call is allowed per compiler. Concurrent calls reject with `TypstPdfError.code === 'BUSY'`. Core does not schedule jobs. A signal can cancel before synchronous execution; hard cancellation requires a worker. Upstream WASM initialization is shared per JS realm: reuse the same `wasm` value for multiple compilers in that realm.

`TypstPdfError` provides `code`, `message`, `diagnostics`, and (when relevant) `cause`. A diagnostic Typfolio recognises carries a `code` of its own (`file-not-found` with `file`, `missing-glyph` with `text`) and a one-line message that links to what to do; switch on the codes, not the messages. [docs/errors.md](../../docs/errors.md) lists them all. Compile diagnostic ranges use upstream zero-based line/column notation. Export diagnostics can have only text.

Remote Typst packages (everything except the bundled one), page ranges, experimental feature flags, and simultaneous PDF standards are not implemented. The pinned upstream builder requires dynamic function construction, so a strict CSP that forbids `unsafe-eval` needs a future binding change. Importing the JS module alone does not instantiate WASM or fetch resources.

## Bundled Typst package

`@typfolio/core` ships one Typst package, `@local/typfolio:0.1.0`, as files in `typst-packages/local/typfolio/0.1.0/` (`typst.toml`, `lib.typ`, `sample.typ`). Each compile mounts `typst.toml` and `lib.typ` (not `sample.typ`) in the request's virtual file system, sets `sys.inputs.typfolio`, and also mounts the input at the package root (an absolute path inside a package resolves to the package root, not the project). Templates use it like this:

```typ
#import "@local/typfolio:0.1.0": input
#let data = input(json.with("./report.schema.json"))
```

Under Typfolio `input()` returns `request.input` and never reads the schema; in a template made with `defineTemplate`, it returns the data mounted at the schema's path. In an editor (where nothing sets `sys.inputs`) it imports the sample builder from `sample.typ`, inside the function body, and builds a sample from the JSON Schema so completion works; `--input typfolio-sample=minimal` previews the sparse sample instead of the default `full` one. The runtime embeds only `lib.typ`. `compiler.capabilities.typstPackages` is `['@local/typfolio:0.1.0']`; any other `@namespace/name:version` import fails with a `COMPILATION` error that names the supported package. The directory layout is the one Tinymist expects for `--package-path`; see `docs/template-authoring.md` for the editor setting. The shipped `.typ`/`.toml` files are the source of truth: `tools/generate-typst-package.ts` (the first step of `npm run build`) generates `src/typst-package.generated.ts` (`typst.toml` and `lib.typ`, the runtime module) and `packages/dev-tools/src/sample-source.generated.ts` (`sample.typ`, imported only by `@typfolio/dev-tools`). Neither is edited by hand.

## Dev-time tools

Tools used while building and testing templates, not while serving requests, live in the separate `@typfolio/dev-tools` package (see [its README](../dev-tools/README.md) and "Build-time checks" in `docs/template-authoring.md`). Install it as a devDependency; core never imports it. `@typfolio/core/internal` exists for Typfolio's own packages and is not a public API.

## Captured browser assets

Browser-only helpers live behind separate subpath entries so Node, worker, and server code that imports `@typfolio/core` never loads DOM code. The main entry exports none of them, and none touch browser globals at import time.

- `@typfolio/core/capture`: `captureProps`, `captureAssets`, `TypfolioCaptureError`, and the adapter and result types.
- `@typfolio/core/capture/svg`: `svgCapture`, a dependency-free adapter that serializes one inline SVG and preserves vector output, and `serializeSvg(svg, { fontFamily?, beforeSerialize? })`, the same serializer for an SVG element you already hold. It inlines the computed paint and text styles (chart libraries often style SVGs from page CSS), rewrites `url(#id)` references to be local, writes the drawn size, and returns the file as bytes. The SVG must be in a document and have a rendered size. `beforeSerialize(svg)` runs on the copy just before it is written (remove a tooltip, add a `<title>`); the live SVG is never passed to it. `@typfolio/react`'s `usePdf` uses it for charts.
- `@typfolio/core/capture/dom`: `domPngCapture`, an opt-in PNG fallback for arbitrary DOM. It loads `html2canvas` by dynamic import only when it first runs. `html2canvas` is an optional peer dependency: install it only if you use this adapter. If it is missing when the default rasterizer runs, the capture rejects with `CAPTURE_FAILED` and the import error as `cause`; passing your own `rasterize` never loads it. `beforeRasterize(element)` runs on html2canvas's copy of the element before it is drawn, never on the live page.

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
    svg: svgCapture({ beforeSerialize: svg => svg.querySelector('.chart-tooltip')?.remove() }),
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
