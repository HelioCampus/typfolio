# Production bundler verification

These examples verify deployment behavior; they are not additional Typfolio packages. All of them are TypeScript and are type-checked by `npm run build`.

The Vite application uses `@typfolio/workers` and imports the package WASM with an explicit URL query, so Vite emits the module worker, compiler, and font as separate assets. The Vite library accepts hosted asset URLs at runtime and uses a small build plugin to copy the compiler to `typfolio/compiler_bg.wasm`.

The React example is a Vite React TypeScript application using the official React plugin, React Router, TSX components, and a typed Vite configuration. Run it with `npm run dev:react`. Its `/` route injects a direct core client, while `/workers` injects the optional worker client into the same React components. The pages are lazy chunks, so the direct route does not load worker orchestration or Effect. The `/charts` route draws its charts once more for the PDF with `useRenderedAssets`, at the template's image size and in the PDF's font, while the page shows them at whatever size it has.

After generating the pinned WASM, run:

    npm run test:vite

The check builds both modes, compares each emitted WASM file with the provenance hash, rejects inlined WASM data, and guards against unexpectedly large JavaScript output.

`vite-capture` builds two tiny entries, one using only the SVG capture adapter and one using the DOM adapter. `npm run test:vite` checks that the first contains no `html2canvas` code and that the second loads it only from a separate lazy chunk. Its `index.html` is a manual browser smoke page: `npm run dev:capture` runs both adapters for real, including the `html2canvas` rasterizer, and compiles the captured assets into a PDF/UA document.

`npm run test:browsers` drives the capture smoke page, the Vite application, and the React routes (direct, workers and charts) in Chromium, Firefox, and WebKit; see `tests/browser`.

`bench-offscreen` measures drawing 150 charts (Highcharts and MUI X Charts) for a PDF in a hidden iframe, a hidden div, and a hidden div with CSS containment. It has its own `package.json` and is not part of the workspace; see its README.

`pretext-hybrid` ports two pretext demos to PDF: pretext lays the text out in the browser, the geometry travels as JSON input, and Typst only places and draws it. Run it with `npm run dev:pretext`; see its README.
