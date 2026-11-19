# @typfolio/dev-tools

Dev-time tools for Typfolio templates. Build-time template checks, a PDF structure inspector with checks for the structure a screen reader needs, PDF/UA and PDF/A validation with veraPDF, and a panel that shows a PDF's tags in the page while you work.

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
// report.structure: [{ page, elements: [{ role, text, alt?, lang?, summary?, scope?, id?, headers?, children }] }]  the tags of each page
```

`inspectPdf` reports facts about the file so a test can assert on them. It never says a file conforms to anything: a tagged PDF with PDF/UA metadata, a title, a language and alt text can still fail PDF/UA. Use a validator such as veraPDF for conformance; [`@typfolio/dev-tools/validate`](#validation-with-verapdf) runs it.

`structure` is the structure tree as a screen reader gets it: each page's elements in reading order, with the text drawn in them, a figure's alt text and the language an element sets. A table carries what Typst wrote for it: the table's `summary` (`pdf.table-summary`), a header cell's `scope` (`Row`, `Column` or `Both`) and `id`, and on each cell `headers`, the ids of the header cells that label it. A row header made with `pdf.header-cell(scope: "row")` is a `TH` with scope `Row`, and the cells of its row name it in `headers`. Text an artifact draws (a running header, a page number) belongs to no element.

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

## Validation with veraPDF

`@typfolio/dev-tools/validate` validates a PDF against PDF/UA or PDF/A with [veraPDF](https://verapdf.org/), compiled to WebAssembly: no Java, in Node and in a browser.

```ts
import { formatValidationReport, validatePdf } from '@typfolio/dev-tools/validate'; // needs @typfolio/verapdf-wasm

const report = await validatePdf(result.bytes, { flavour: 'ua1' });
// report.compliant: whether the file passes every rule of the flavour
// report.totalAssertions: how many checks were run
// report.profile: { name, description, rules }  the validation profile that was applied
// report.failedRules: [{ specification, clause, test, failedChecks, message, tags, object, condition, checks, context }], ordered by clause
//   message: what the standard requires; tags: veraPDF's topics, such as ['structure', 'table']
//   checks: [{ error, context }]  each failed check: what was wrong, with the values found, and where
// report.logs: [{ level, message, occurrences }]  what veraPDF logged while reading the file
assert.ok(report.compliant, formatValidationReport(report));
```

- `validatePdf(bytes, { flavour, wasm? })` starts a validator on the first call and keeps it. In Node it reads the binary from the installed package; a browser passes `wasm`, the bytes of `@typfolio/verapdf-wasm/verapdf.wasm` (about 31 MB, 10 MB gzipped) or a compiled `WebAssembly.Module`.
- `createPdfValidator({ wasm? })` gives a validator of your own, whose `validate(bytes, { flavour })` is synchronous: for many files, or to run in a worker. The first validation takes about 0.3 s, later ones tens of milliseconds for a few pages.
- `validateDeclaredPdf(bytes)` validates against every standard the file declares in its metadata (`pdfuaid:part`, `pdfaid:part` with `pdfaid:conformance`) and returns one report for each, in an array: for files you did not produce, or a folder of mixed outputs. A file that declares nothing gives an empty array, which is not a pass, so check the length. For a test that a template produces a given standard, name the flavour with `validatePdf`: this only checks what the file claims. A validator's `detectFlavours(bytes)` returns the declared ids alone.
- `flavour` is one of veraPDF's ids: `ua1`, `ua2`, `1a`, `1b`, `2a`, `2b`, `2u`, `3a`, `3b`, `3u`, `4`, `4e`, `4f`, `wt1a`, `wt1r`. `pdfValidationFlavours` names each (`'PDF/UA-1'`) and `pdfValidationFlavourIds` lists them. `validatePdf` does not read the flavour from the file: say which standard you compiled for.
- A rule that fails often lists its first 20 checks; `maxChecksPerRule` (1 to 10000) changes that, and `failedChecks` is exact either way. A check's `error` is veraPDF's own sentence with the values it found, such as `The "part" property of the PDF/UA Identification Schema is 1 instead of 2`. Its `context` is a path in veraPDF's model of the file, with PDF object numbers (`…/pages[0](14 0 obj PDPage)/…`); for a glyph it contains a number that changes from run to run.
- `logs` is what veraPDF logged at `WARNING` or `SEVERE` while it read the file, such as a font program or a content stream it could not parse. A file can pass with messages there: veraPDF then validated what it could read, so for a strict test require `report.compliant && report.logs.length === 0`.
- `formatValidationReport(report, name?)` is the report as text: each failed rule, under it the checks that are listed, and veraPDF's messages.
- Errors are `TypstPdfError`s: `INITIALIZATION` when `@typfolio/verapdf-wasm` is not installed or its binary cannot be started, `INVALID_REQUEST` for a flavour that does not exist, for bytes veraPDF cannot read as a PDF, and in a browser when no `wasm` is given.

`typfolio-validate` does the same from a shell or a CI step:

```sh
npx typfolio-validate --flavour ua1 out/report.pdf out/letter.pdf
# out/report.pdf: PASS PDF/UA-1 (734 checks)
# out/letter.pdf: FAIL PDF/UA-1: 2 rules, 2 of 730 checks
#   ISO 14289-1:2014 5, test 1 (1x) [metadata]: The PDF/UA version and conformance level of a file shall be specified using the PDF/UA Identification extension schema
#     The document metadata stream doesn't contain PDF/UA Identification Schema
#       at root/document[0]/metadata[0](45 0 obj PDMetadata)/XMPPackage[0]
#   ISO 14289-1:2014 7.1, test 10 (1x) [syntax]: The document catalog dictionary shall include a ViewerPreferences dictionary containing a DisplayDocTitle key, whose value shall be true
#     ViewerPreferences dictionary is not present in the document Catalog, or DisplayDocTitle key is set to false or is not present in the ViewerPreferences dictionary (ViewerPreferences = dictionary(size = 1), DisplayDocTitle = null)
#       at root
```

`--flavour` (`-f`) defaults to `ua1`; `--flavour auto` validates each file against every standard it declares, and reports a file that declares none as not validated (status 2). Further, `--format json` prints the reports as JSON, `--max-checks <n>` sets how many failed checks of one rule are listed (3 as text, 20 as JSON), and `--wasm <file>` names another binary. It exits with 0 when every file passes, 1 when one fails, and 2 for wrong usage or a file that could not be validated.

What a pass means: the file meets the rules of that standard that a machine can check, as veraPDF implements them. It does not show that the document is accessible. Whether the tags fit the content, the reading order makes sense and the alternative text says what the figure shows still needs a person, and `structureWarnings` above catches some of what the standard accepts.

`@typfolio/verapdf-wasm` is an **optional peer dependency** that you install yourself, loaded on the first call and only from this entry. It is a package of its own because its binary is not open source as a whole: it contains veraPDF (MPL 2.0) and a runtime under Oracle's GraalVM Free Terms and Conditions, which allow use, also inside a company, and free redistribution, but not shipping it as part of something a fee is charged for. Nothing in `@typfolio/dev-tools` contains it. It is not published to npm yet; until it is, it has to be built from this repository ([docs/verapdf-build.md](../../docs/verapdf-build.md)).

## Structure panel

`@typfolio/dev-tools/panel` shows a PDF's tags in the page while you work on a template: each page's tags in reading order, the warnings above with a link to the tag each is about, and, under the row of the tag you select, what the row does not say: its path in the tree, a figure's alt text, a table's columns and summary, a header cell's scope, the header cells that label a cell (by their text), and what it holds.

Beside the tags the panel draws the page with the page's pdf.js and marks the selected tag on it; moving over the page marks the tag under the pointer, and a click selects it in the list. The mark covers what the tag holds, which is its text or a figure's own box: a cell's border and padding belong to no tag, so they are not covered, and an empty cell has nothing to mark. The box of text is estimated from its font size and fits upright Latin text. The "Page" button in the toolbar hides the page. A row shows one line of its tag's text, cut short; the selected tag's row shows all of it. A tag's row shows a "Copy" button while the pointer or focus is on it, which copies the tag's whole text (a figure's alt text). In `mountStructureDevtools`, the toolbar's "Fill the page" button puts the panel over the whole page, for room to read the page view, and back. The lines between the tags, the page and, with a validator, veraPDF's findings can be dragged to give each more or less room (or moved with the arrow keys when focused); a double click puts one back. The page is a second drawing of the PDF, apart from any preview your application shows. It is written in React and ships with React bundled in (about 75 kB gzipped), so a page needs no React of its own, and in a React page it runs apart from the page's React. It loads no pdf.js: pass the one your page uses, with its worker set up.

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

Both also take `validator`, which gives the panel a third view beside the tags and the page: veraPDF's findings. It has what to validate against, a "Validate" button, and the verdict with every failed rule: its clause, what the standard requires and veraPDF's topics for it, and, when opened, each failed check with what was wrong and where. Each new PDF is validated the same way as the last, so the verdict follows the template you are editing. For a PDF whose tags cannot be shown (an untagged one), the findings have the panel to themselves.

With a validator that has `detectFlavours`, as `createPdfValidator`'s has, the panel validates without being asked: every PDF is validated against each standard its metadata names, as soon as it is on show, and a PDF that names none says so instead of passing. Pick a standard and use the button to validate against that one instead. A devtools panel that is closed validates nothing; the PDF on show is validated when it opens. With a validator that cannot detect, nothing is validated until the button is used. The panel loads no validator itself: pass what `createPdfValidator` gives, or an object of your own whose `validate(bytes, { flavour })` (and `detectFlavours(bytes)`) forward to one in a worker and return promises. Validation is synchronous in `createPdfValidator`'s validator: about 0.3 s for the first PDF and tens of milliseconds after that for a few pages, on the page's own thread.

```ts
import { createPdfValidator } from '@typfolio/dev-tools/validate';
import wasmUrl from '@typfolio/verapdf-wasm/verapdf.wasm?url';

const validator = await createPdfValidator({ wasm: await (await fetch(wasmUrl)).arrayBuffer() });
const devtools = mountStructureDevtools({ pdfjs, validator });
```

A failed check is shown with veraPDF's own path to the object (`root/document[0]/StructTreeRoot[0]/…`); it is not linked to a tag in the list, because that path and the tags pdf.js reads do not line up one to one.

Load it only in development, so that neither it nor pdf.js reaches a production bundle: behind `import.meta.env.DEV` (or your bundler's flag), with dynamic `import()`s. [`examples/vite-react/src/structureDevtools.ts`](../../examples/vite-react/src/structureDevtools.ts) does this for `usePdf`'s `result?.bytes`.

What it shows is what `structureWarnings` and `readStructure` give, read the same way pdf.js gives it to a screen reader. pdf.js gives each page its own part of the tree, so a table over a page break shows on each page it is on, and the later parts say "Continued from page N" and are counted once. pdf.js also lists every row of a table on each of its pages, so a run of rows drawn on another page shows as one line. Which tags are open, the selection and the filter are kept by position, so they stay across a recompile of the same template. The panel has the warnings' limits: no problems found is not a verdict.

`dist/panel.js` carries React's production build; [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) has its licence.

The package builds on `@typfolio/core/internal`, which is unstable and meant only for Typfolio's own packages.
