# Offscreen chart drawing benchmark

Measures drawing charts for a PDF away from what the user sees, three ways:

- `iframe`: a hidden iframe with its own React root, emotion cache and theme provider.
- `div`: a hidden, off-screen `div` in the page's own document.
- `div-contain`: the same `div` with `contain: strict` and a fixed size.

The page copies the shape of an assessment results page: 75 outcome cards, each with a Highcharts bullet
chart and an MUI X bar chart drawn live at the page's width (synthetic data). Each run draws the same 150
charts again at fixed sizes, waits until every one has an SVG with a size, and serializes them with their
computed styles. It is what `useRenderedAssets` in `@typfolio/react` does; the hook uses the hidden `div`.

This folder has its own `package.json` and is not part of the npm workspace:

    npm install --prefix examples/bench-offscreen
    cd examples/bench-offscreen && node run.ts

`run.ts` builds the page for production, serves it, and runs every mode with and without the results page
in Chromium, Firefox and WebKit (`--runs 5 --outcomes 75 --browsers chromium,firefox,webkit --headed`).
It prints the median of the runs after one warm-up. `npm run dev` serves the page for manual runs
(`?mode=iframe|div|div-contain&runs=3&outcomes=75&page=0|1`), and `node debug.ts "<query>"` prints one
page's console errors and result.

Measured on 18 October 2026 (Apple Silicon, 150 charts, median of 3 runs, results page present):

| Browser | iframe | div | div + `contain: strict` |
|---|---|---|---|
| Chromium | 202 ms | 239 ms | 234 ms |
| Firefox | 344 ms | 380 ms | 377 ms |
| WebKit | 308 ms | 404 ms | 431 ms |

The iframe is 40–100 ms faster; containment does not help; removing the results page changes little.
In the real assessment application (144 charts), the iframe took 370–415 ms and the hidden `div` 460–515 ms.

Highcharts is not open source: it is free for personal and non-commercial use, and commercial use needs a
Highcharts licence. It is installed here only to measure a chart library that measures text heavily.
