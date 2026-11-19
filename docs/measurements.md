# Browser support and measurements

Browser-first means the browser matrix is the primary test target: a Playwright suite drives the smoke pages and the React example in Chromium, Firefox and WebKit. All five pages pass in each engine.

| | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|
| Compiler initialisation (page / module worker) | 37 ms / 19 ms | 223 ms / 211 ms | 122 ms / 72 ms |
| One-page compile, warm (page / worker) | 46 ms / 4 ms | 5 ms / 5 ms | 26 ms / 27 ms |
| Capture (SVG + html2canvas) and PDF/UA compile | pass | pass | pass |
| React example, direct and worker routes | pass | pass | pass |

Throughput on a realistic document (a report with a heading, five paragraphs and a 12-row table per section, PDF/UA-1, fresh data on every run so nothing is cached; Node on a laptop, median of five runs):

| Document | Pages | Output | Compile time |
|---|---|---|---|
| 5 sections | 12 | 76 kB | 74 ms |
| 25 sections | 52 | 328 kB | 218 ms |
| 50 sections | 102 | 647 kB | 358 ms |

Compiling the same data twice takes about 20 ms the second time, because the compiler caches unchanged work. The first compile after loading the module costs an extra 200–250 ms.

Sizes from the production Vite builds:

| Artifact | Size |
|---|---|
| Compiler WASM | 24,161,860 bytes; about 8.8 MB gzip, 6.4 MB Brotli |
| Worker application JavaScript (host + worker runtime) | 47.7 kB + 33.3 kB |
| Core-only library build | about 40 kB |

The WASM is emitted as a separate asset by every tested build, never inlined into JavaScript, so browsers cache it once. Numbers are from one machine with a local server and are illustrative, not benchmarks.
