# @typfolio/dev-tools

Dev-time tools for Typfolio templates. Build-time template checks and a PDF structure inspector.

Install it as a devDependency. Nothing here is needed at runtime: `@typfolio/core` never imports this package, so none of it reaches a production bundle.

```ts
import { createTemplateChecker } from '@typfolio/dev-tools';

const checker = await createTemplateChecker({ wasm, fonts }); // the options of createCompiler
try {
  const report = await checker.check(template, { modes: ['minimal', 'full'], pdf: { standards: ['ua-1'] } });
  // report.ok: true only if every mode compiled
  // report.results: { mode, ok, diagnostics, error?, bytes? } per mode
} finally {
  await checker.dispose();
}
```

`check` also takes `assets`, the files a template reads besides its input (shared settings, a logo), exactly as a request's `assets`: a template that reads `json("/export-settings.json")` can be checked with that file in place.

`checkTemplate(template, { wasm, fonts, modes?, pdf?, assets? })` is the one-shot form that creates and disposes a checker.

A check compiles the template once per sample mode (`minimal`, then `full`) the way an editor does, so `input()` builds a sample from the JSON Schema in `template.files`. A compile error is reported in that mode's result; a malformed template or option is thrown. Nothing is written to disk. See "Build-time checks" in [docs/template-authoring.md](../../docs/template-authoring.md) for the rules and a test recipe.

## `inspectPdf`

```ts
import { inspectPdf } from '@typfolio/dev-tools/pdf';

const report = await inspectPdf(bytes); // the bytes of a compiled PDF
// report.pages, tagged, structureTree, title, language, creationDate
// report.standard: { pdfUa?, pdfA?: { part, conformance? } }  what the XMP metadata declares
// report.headings: [{ level, text }]  in document order
// report.figures: [{ alt? }], report.tables, report.fonts: [{ name, embedded }]
// report.structureRoles: { H1: 1, Table: 1, ... }  how often each structure role occurs
```

`inspectPdf` reports facts about the file so a test can assert on them. It never says a file conforms to anything: a tagged PDF with PDF/UA metadata, a title, a language and alt text can still fail PDF/UA. Use a validator such as veraPDF for conformance.

It reads the file with [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist), an **optional peer dependency** (`^6.3.0`) that you install yourself when you use this entry. It is loaded on the first call and only from `@typfolio/dev-tools/pdf`: the main entry never imports it. Without it, the call rejects with a `TypstPdfError` (`INITIALIZATION`) that says to install `pdfjs-dist`; bytes that are not a readable PDF reject with `INVALID_REQUEST`. Counts are per page (an element that continues over a page break is counted for each page), see "Inspecting the output" in [docs/template-authoring.md](../../docs/template-authoring.md) for this and the other limits.

The package builds on `@typfolio/core/internal`, which is unstable and meant only for Typfolio's own packages.
