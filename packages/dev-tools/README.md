# @typfolio/dev-tools

Dev-time tools for Typfolio templates. Build-time template checks, a PDF structure inspector with checks for the structure a screen reader needs, and a panel that shows a PDF's tags in the page while you work.

Install it as a devDependency. Nothing here is needed at runtime: `@typfolio/core` never imports this package, so none of it reaches a production bundle.

```ts
import { createTemplateChecker } from '@typfolio/dev-tools';

const checker = await createTemplateChecker({ wasm, fonts }); // the options of createCompiler
try {
  const report = await checker.check(template, { modes: ['minimal', 'full'], pdf: { standards: ['ua-1'] } });
  // report.ok: true only if every mode is ok
  // report.results: { mode, ok, diagnostics, error?, bytes?, structure? } per mode
} finally {
  await checker.dispose();
}
```

`template` is a template made with `defineTemplate`. The check compiles only the files it declares, with each piece of data's JSON Schema at its `schemaPath`, made from its schema, so a file the template imports without declaring it fails, with what to do.

`check` also takes `assets`, the files a template reads besides its data (a logo), exactly as `compile`'s `assets`. A JSON Schema file given there at a data path is used as it is instead of one made from the schema: this is how data without a schema, or a schema without Standard JSON Schema, is checked.

`check` takes `structure`, a function that reads each compiled mode's PDF and returns warnings: a mode with any is not `ok`, and its result lists them in `structure`. Pass `checkStructure` from `@typfolio/dev-tools/pdf` (below), or wrap it to accept a warning. The main entry never loads pdf.js itself, so the function is passed in rather than switched on.

```ts
import { checkStructure } from '@typfolio/dev-tools/pdf'; // needs pdfjs-dist

const report = await checker.check(template, { pdf: { standards: ['ua-1'] }, structure: checkStructure });
// full: { ok: false, structure: [{ kind: 'table-without-headers', page: 1, message: 'The table starting "Sample text" has no header cells (TH), …' }] }
```

`checkTemplate(template, { wasm, fonts, modes?, pdf?, assets?, structure? })` is the one-shot form that creates and disposes a checker.

`inputSchemaFiles(definitions, { toJSONSchema? })` returns the JSON Schema file of every piece of data these templates and partials read (nested partials included), or of `{ schema, schemaPath }` pairs, by path, as JSON text. It writes nothing: a script writes the files where the editor reads them, and a test compares them, so a schema that changed without its file fails CI. Schemas that implement Standard JSON Schema (`~standard.jsonSchema`, as Zod's do) need no option; for Zod Mini, pass `toJSONSchema: schema => z.toJSONSchema(schema, { io: 'input' })`.

```ts
import { inputSchemaFiles } from '@typfolio/dev-tools';

// Every template's own schema file and each of its partials', once per path.
for (const [path, text] of Object.entries(inputSchemaFiles([outcomes, results]))) {
  assert.deepEqual(JSON.parse(await readFile(new URL(path, templatesRoot), 'utf8')), JSON.parse(text), `${path} is out of date`);
}
```

A check compiles the template once per sample mode (`minimal`, then `full`) the way an editor does, so `input()` builds a sample from the JSON Schema at each data path. A compile error is reported in that mode's result; a malformed template or option is thrown. Nothing is written to disk. See "Build-time checks" in [docs/template-authoring.md](../../docs/template-authoring.md) for the rules and a test recipe.

## `inspectPdf`

```ts
import { inspectPdf } from '@typfolio/dev-tools/pdf';

const report = await inspectPdf(bytes); // the bytes of a compiled PDF
// report.pages, tagged, structureTree, title, language, creationDate
// report.standard: { pdfUa?, pdfA?: { part, conformance? } }  what the XMP metadata declares
// report.headings: [{ level, text }]  in document order
// report.figures: [{ alt? }], report.tables, report.fonts: [{ name, embedded }]
// report.structureRoles: { H1: 1, Table: 1, ... }  how often each structure role occurs
// report.structure: [{ page, elements: [{ role, text, alt?, lang?, children }] }]  the tags of each page
```

`inspectPdf` reports facts about the file so a test can assert on them. It never says a file conforms to anything: a tagged PDF with PDF/UA metadata, a title, a language and alt text can still fail PDF/UA. Use a validator such as veraPDF for conformance.

`structure` is the structure tree as a screen reader gets it: each page's elements in reading order, with the text drawn in them, a figure's alt text and the language an element sets. Text an artifact draws (a running header, a page number) belongs to no element.

`inspectPdf` and `checkStructure` read the file with [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist), an **optional peer dependency** (`^6.3.0`) that you install yourself when you use this entry. It is loaded on the first call and only from `@typfolio/dev-tools/pdf`: the main entry never imports it. Without it, the call rejects with a `TypstPdfError` (`INITIALIZATION`) that says to install `pdfjs-dist`; bytes that are not a readable PDF reject with `INVALID_REQUEST`. Counts are per page (an element that continues over a page break is counted for each page), see "Inspecting the output" in [docs/template-authoring.md](../../docs/template-authoring.md) for this and the other limits.

## Structure warnings

A PDF/UA-1 compile refuses some missing structure but accepts some that a screen reader user still needs. A validator such as veraPDF checks that the tags present are well formed, not that the content has the ones it needs. Checked against the pinned compiler (Typst 0.15.1):

| | PDF/UA-1 compile | Tagged compile (the default) | `structureWarnings` |
|---|---|---|---|
| Headings that skip a level, or start below H1 | refused | accepted | `heading-skips-level` |
| An image without alt text | refused | accepted | `figure-without-alt` |
| A table without header cells | accepted | accepted | `table-without-headers` |
| Several pages and no headings (titles drawn as large text) | accepted | accepted | `no-headings` |

```ts
import { checkStructure, inspectPdf, structureWarnings } from '@typfolio/dev-tools/pdf';

const warnings = structureWarnings((await inspectPdf(bytes)).structure);
// [{ kind: 'no-headings', message: '6 pages and no headings, so a screen reader user cannot move between sections.' }]
// [{ kind, page, element, message }]  in reading order; element is the one in the pages given

await checkStructure(bytes); // the same, and one `untagged` warning for a PDF that is not tagged at all
```

`structureWarnings(pages)` is a plain function of the pages and needs nothing installed. A table that runs over a page break is checked once, on the page it starts: pdf.js gives each page its own part of the tree, and the part that carries on has no header row unless the header repeats. Its limits: a new table that starts a page right after another table ended the previous one is taken for a continuation and not checked, and the warnings say nothing about reading order, wording or whether alt text describes anything. An empty list is not a verdict.

`readStructure(document)` reads the same pages from a pdf.js document (`PDFDocumentProxy`) you already have, such as one a browser page loaded with its own pdf.js build, so a page can show the tags and their warnings without this package loading pdf.js.

## Structure panel

`@typfolio/dev-tools/panel` shows a PDF's tags in the page while you work on a template: each page's tags in reading order, the warnings above with a link to the tag each is about, and the text, alt text and language of the tag you select. It is written in React and ships with React bundled in (about 75 kB gzipped), so a page needs no React of its own, and in a React page it runs apart from the page's React. It loads no pdf.js: pass the one your page uses, with its worker set up.

```ts
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { mountStructureDevtools } from '@typfolio/dev-tools/panel';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
const devtools = mountStructureDevtools({ pdfjs }); // a button in a corner, with the number of problems found
devtools.update({ bytes: result.bytes });         // after each compile: the panel reads the new PDF
devtools.unmount();
```

- `mountStructureDevtools(options)` adds a button to a corner of the page (`buttonPosition`: `'bottom-right'`, the default, `'bottom-left'`, `'top-right'` or `'top-left'`) that opens the panel along a side of the page (`position`: `'bottom'`, the default, `'top'`, `'left'` or `'right'`), like React Query's devtools. The buttons in its toolbar move it to another side, and `update({ position })` does too. Drag its inner edge to resize it, or use the arrow keys on that edge; Escape closes it. `initialIsOpen: true` starts it open. The PDF is read while the panel is closed too, for the button's count.
- `mountStructurePanel(element, options)` shows the panel inside an element of yours instead, such as a tab beside a PDF preview. Give the element a height.
- Both take `pdfjs`, `bytes` (absent until there is a PDF) and `theme` (`'system'`, the default, `'light'` or `'dark'`), and return `update(options)`, which changes the options given, and `unmount()`. Options they cannot use throw `INVALID_REQUEST`. The panel gives pdf.js a copy of the bytes and frees each document once it is read; a new PDF replaces the one being read.

Load it only in development, so that neither it nor pdf.js reaches a production bundle: behind `import.meta.env.DEV` (or your bundler's flag), with dynamic `import()`s. [`examples/vite-react/src/structureDevtools.ts`](../../examples/vite-react/src/structureDevtools.ts) does this for `usePdf`'s `result?.bytes`.

What it shows is what `structureWarnings` and `readStructure` give, read the same way pdf.js gives it to a screen reader. pdf.js gives each page its own part of the tree, so a table over a page break shows on each page it is on, and the later parts say "Continued from page N" and are counted once. pdf.js also lists every row of a table on each of its pages, so a run of rows drawn on another page shows as one line. Which tags are open, the selection and the filter are kept by position, so they stay across a recompile of the same template. The panel has the warnings' limits: no problems found is not a verdict.

`dist/panel.js` carries React's production build; [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) has its licence.

The package builds on `@typfolio/core/internal`, which is unstable and meant only for Typfolio's own packages.
