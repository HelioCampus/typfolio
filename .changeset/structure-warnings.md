---
'@typfolio/dev-tools': minor
---

Structure warnings: what a screen reader user would trip over, including what a PDF/UA-1 compile accepts.

- `@typfolio/dev-tools/pdf`: `inspectPdf` reports `structure`, each page's tags in reading order with their text, alt text and language.
- `@typfolio/dev-tools/pdf`: `structureWarnings(pages)` lists a table without header cells, several pages without a heading, headings that skip a level and a figure without alt text, each with its page and element. A PDF/UA-1 compile refuses the last two but accepts the first two. `checkStructure(bytes)` reads a PDF and returns them, or one `untagged` warning for a PDF that is not tagged. `readStructure(document)` reads the pages from a pdf.js document you already loaded, without loading pdf.js itself.
- `@typfolio/dev-tools`: `check` and `checkTemplate` take `structure`, a function such as `checkStructure`. A mode whose PDF has warnings is not `ok`, and its result lists them in `structure`. The main entry still never loads pdf.js.
- `@typfolio/dev-tools/pdf`: a heading's text no longer includes text that an artifact draws inside it.
