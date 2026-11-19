# How Typfolio compares

## Typst in JavaScript

Several projects run the Typst compiler from JavaScript. They solve different problems, and Typfolio builds on one of them. Versions are the published ones on 13 October 2026.

| | **Typfolio** (Typst 0.15.1) | [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) (0.7.0) | [typst-wasm](https://github.com/typst-wasm/typst-wasm) (1.0.0) | [wasm-typst](https://github.com/LibrePaper/wasm-typst) (Typst 0.15.1) | [typst](https://github.com/typst-community/typst.js) npm (0.10.0-8) |
|---|---|---|---|---|---|
| What it is | Browser-first document-generation SDK: template + typed JSON → PDF | Typst toolkit: compiler, SVG/canvas/HTML renderer, framework components | Promise-based compiler for many runtimes | Raw WASM build of the compiler | Native Typst CLI binaries wrapped for Node |
| Runs in the browser | Yes, primary target | Yes | Yes | Yes | No |
| Runs in Node | Yes | Yes | Yes, plus Deno, Bun, Cloudflare Workers | Tooling only | Yes, plus Deno and Bun |
| Outputs | PDF | SVG, canvas, HTML, PDF | PDF, SVG, PNG, HTML | PDF, experimental HTML | Whatever the CLI writes (PDF, PNG, SVG) |
| Fonts | Supplied by the application | Downloaded from GitHub by default | Separate `@typst-wasm/fonts` package | Default fonts embedded in the binary | System and CLI fonts |
| Typst packages | Not supported; one bundled helper package | Fetched from the registry | Loader and cache hooks | Host downloads what the compile reports it needs | CLI behaviour |
| Network at compile time | None | Fonts and packages by default | Depends on loaders | None | None |
| Workers and cancellation | Built-in pool, hard cancel, batches | Compiler runs where you put it | Worker and JSPI backends | None | Processes |
| PDF standards | PDF/A-1 to A-4, PDF/UA-1, tags, timestamp; exporter-validated | No | Not documented | Not documented | CLI flags |
| Typed input and schema-driven editor completion | Yes | No | No | No | No |
| Reproducible, pinned build with verified provenance | Yes | Published packages | Published packages | Pinned to Typst 0.15.1 | Pinned binaries |
| Licence | Apache-2.0 | Apache-2.0 | MIT | MIT (binary includes Apache-2.0 Typst) | See project |
| Compiler asset, raw / Brotli (measured 1 Nov 2026, Brotli q11, 16 MB window) | 24.1 MB / 6.4 MB | 30.2 MB / 7.6 MB (`@myriaddreamin/typst-ts-web-compiler` 0.8.0-rc3) | 22.8 MB / 6.2 MB (`typst-wasm` 1.0.0) | 33.8 MB / 10.0 MB (release v0.3.1, fonts embedded) | Native binaries, not comparable |

Typfolio's compiler binary is its own binding of Typst 0.15.1 (`crates/compiler`, built to WebAssembly with pinned sources and tools, and loadable under a strict Content Security Policy). If you need SVG or canvas rendering, incremental preview or Typst package imports, typst.ts is the right tool. If you need one PDF per data record with a typed contract and no network access, that is what Typfolio is for.

## Other ways to make PDFs in a web application

| Approach | Layout quality | Where it runs | Accessibility | Trade-off |
|---|---|---|---|---|
| **Typfolio** | Full typesetter | In the user's browser, no service (Node too) | Tagged PDF, PDF/UA-1 and PDF/A on request | 24 MB compiler asset (6.4 MB with Brotli) to host and cache |
| HTML to PDF via headless Chrome (Puppeteer, Playwright) | Browser layout, good | A server process per job | Tagged PDF only with care; no PDF/UA validation | Needs a service and Chrome; slow and heavy per document |
| `@react-pdf/renderer` | Flexbox subset of CSS | Browser or Node | No tagging | Re-implements layout; tables and typography are basic |
| pdfmake, jsPDF, PDFKit | Manual layout primitives | Browser or Node | Untagged, or a tag tree you build by hand (PDFKit) | You write the page-breaking and text flow yourself |
| LaTeX in WASM | Full typesetter | Browser | Tagged PDF is experimental in LaTeX | Larger assets, slower, LaTeX templates |
| Commercial HTML/CSS formatters (Prince, PDFreactor) | Excellent | Server | Good | Licence cost, server-side only |
