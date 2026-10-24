# Template authoring

Typfolio compiles Typst templates with JSON data that exists only at runtime. This guide covers the template layout, how a template reads its data with editor completion, templates whose parts read data of their own, build-time template checks, and typed calls. Typfolio is not tied to a schema library: a template checks its data with any schema that implements [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, …), which the application imports and passes in.

## Folder layout

Keep the template as a folder of `.typ` files plus the JSON Schema of its data, and a definition beside them. There is no data file:

```text
src/report/
  main.typ               entrypoint
  report.schema.json     JSON Schema of the data (editor only; never sent at runtime)
  partials/layout.typ    imported by main.typ
  template.ts            defineTemplate: the files, the schema, and where the data is read
```

Editor support exists for `.typ` files, not for Typst source inside JavaScript strings, which is why the template lives in files. The schema is the application's artifact: write it in a validation library and generate the JSON file from it (see [The JSON Schema files](#the-json-schema-files)), or write the JSON by hand. Typfolio adds no schema dependency.

```ts
// src/report/template.ts
import { defineTemplate } from '@typfolio/core';
import { z } from 'zod';
import main from './main.typ?raw';
import layout from './partials/layout.typ?raw';

export const reportSchema = z.object({ title: z.string().min(1), rows: z.array(z.object({ name: z.string(), score: z.number() })) });

export const report = defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': main, 'report/partials/layout.typ': layout },
  schema: reportSchema,
  schemaPath: 'report/report.schema.json', // where main.typ's json.with("./report.schema.json") points
});

await client.compile(report({ title: 'Q3', rows: [] }), { pdf: { standards: ['ua-1'] } });
```

## Reading the data

```typ
#import "@local/typfolio:0.1.0": input
#import "partials/layout.typ": summary

#let data = input(json.with("./report.schema.json"))
#set document(title: data.title)

= #data.title
#summary(data)
```

`@local/typfolio:0.1.0` is a small Typst package that ships inside `@typfolio/core` and is the only package templates can import. `input(schema)` behaves differently depending on who compiles:

- Under Typfolio, core sets `sys.inputs.typfolio`, mounts the data the template was called with as JSON at its `schemaPath`, and `input()` reads it there. The schema is never sent, and `defineTemplate` rejects a schema file listed in `files`.
- In an editor, nothing sets it, and the same path holds the JSON Schema file, so `input()` builds a sample value from it. That sample is a real Typst value, so the editor completes `#data.` fields, nested fields, and loop variables over arrays.

Pass the schema as `json.with("<path>")`, not as a path string or a loaded dictionary. The path is resolved relative to the file that contains `json.with`, which is why the function must be created in the template and not inside the package; under Typfolio that is what reads the data. `input(none)` and `input(dictionary)` are errors, with a message that says to pass `json.with(...)`.

The sample builder lives in a second file of the package, `sample.typ`, which `input()` imports only in the editor branch. A compile under Typfolio never loads it, and core does not even mount it, so the runtime embeds only `input()`. The package's `lib.typ` does not re-export the builder: only the editor and `@typfolio/dev-tools` (see [Build-time checks](#build-time-checks)) use it.

### Path rules

- A relative path in `json.with(...)` is relative to the file that contains it, so a template at `reports/outcome/main.typ` writes `json.with("./schemas/report.schema.json")` for `reports/outcome/schemas/report.schema.json`.
- Typst refuses paths that leave the project root, and the editor uses the workspace folder as the project root. Keep the schema inside the workspace (usually next to the template). A path above it, such as `../../shared.schema.json`, fails in the editor.
- Call `input(...)` from the entrypoint, or from a partial that creates its own `json.with(...)`, and pass `data` to partials as an argument. Do not rely on a partial reading the schema through a path written in another file. A file with data of its own, such as a shared header, reads it itself: see the next section.

An existing template that reads `json("/input.json")` works with `schemaPath: 'input.json'`, where the data is then mounted. It gets no editor completion.

## Templates whose parts have data of their own

A report often has parts with data of their own: a shared header with the institution's name and logo, used by every report. `defineTemplate` and `definePartial` from `@typfolio/core` describe such a template once, with a schema for each piece of data. Each Typst file reads its own data, at the path of its schema file. The [vite-react example](../examples/vite-react/src/outcomes/) is a complete one.

```text
src/
  common/header.typ             reads its own data
  common/header.schema.ts       its schema
  common/header.schema.json     its JSON Schema (generated; editor only)
  common/header.ts              definePartial
  outcomes/main.typ             imports ../common/header.typ
  outcomes/outcomes.schema.ts
  outcomes/outcomes.schema.json
  outcomes/template.ts          defineTemplate
```

```typ
// common/header.typ
#import "@local/typfolio:0.1.0": input
#let header = input(json.with("./header.schema.json"))

#let report-header() = grid(
  columns: (auto, 1fr),
  column-gutter: 4mm,
  image(header.logo, height: 9mm, alt: header.institution + " logo"),
  header.institution,
)
```

```typ
// outcomes/main.typ
#import "@local/typfolio:0.1.0": input
#import "../common/header.typ": report-header
#let data = input(json.with("./outcomes.schema.json"))
#set document(title: data.title)

#report-header()
= #data.title
```

```ts
// common/header.schema.ts: the application imports its schema library, Typfolio does not
import { z } from 'zod';

export const headerSchema = z.object({
  institution: z.string().min(1),
  logo: z.string().meta({ contentMediaType: 'image/png' }),
});

// common/header.ts
import { definePartial } from '@typfolio/core';
import { headerSchema } from './header.schema';
import source from './header.typ?raw';

export const header = definePartial({
  files: { 'common/header.typ': source },
  schema: headerSchema,
  schemaPath: 'common/header.schema.json',
});

// outcomes/outcomes.schema.ts
export const outcomesSchema = z.object({
  title: z.string().min(1),
  outcomes: z.array(z.object({ name: z.string(), met: z.number() })),
});

// outcomes/template.ts
import { defineTemplate } from '@typfolio/core';
import source from './main.typ?raw';

export const outcomes = defineTemplate({
  entrypoint: 'outcomes/main.typ',
  files: { 'outcomes/main.typ': source },
  schema: outcomesSchema,
  schemaPath: 'outcomes/outcomes.schema.json',
  partials: { header },
});

// The template called with its data and the header's, typed by both schemas.
await client.compile(
  outcomes(
    { title: 'Outcome results', outcomes: [] },
    { header: { institution: 'Example University', logo: '/attachments/0.png' } },
  ),
  { assets: { 'attachments/0.png': logoBytes } },
);
```

How it fits together:

- `schemaPath` is the path of the schema's JSON file, relative to the template root (the root of the virtual paths in `files`). The file reads its data there with `input(json.with("./header.schema.json"))`, relative to itself: in an editor, the file there is the JSON Schema and `input()` builds a sample from it; when Typfolio compiles, the data is mounted at that same path. `schema` without `schemaPath` is refused at definition time.
- A template is a function: `outcomes(data, { header: headerData })`. The key in `partials` (`header`) names the partial's data in that call; Typst never sees it. Without partials it is `outcomes(data)`, without data `outcomes()`, and with partials but no data of its own `outcomes(undefined, { header })`.
- A partial is Typst code with runtime data of its own: its files, its schema and path, and the partials it uses (`partials` again, nested as deep as needed; their data goes in the same second argument, by key). Shared code without data of its own (helpers, a badge) needs no partial: spread its files into the template's `files`, as in `files: { ...badgeFiles, 'outcomes/main.typ': source }`.
- `defineTemplate` merges the files of the template and of every partial, and rejects the same path with different contents, two different partials under one key, and two pieces of data on one path.
- Before compiling, each piece of data is checked against its schema, on the calling thread (the worker client too, which then sends only the data). Data that does not match rejects with `INVALID_INPUT`, whose message names whose data it is and lists the issues (`The data of partial "header" does not match its schema (common/header.schema.json):` then `- institution: …`); the issues are also on the error's `issues`. A schema that validates asynchronously is awaited. Missing data, or data for a partial the template does not have, rejects with `INVALID_REQUEST`. `compile(document, { validate: false })` skips the schemas.
- Typst gets the data as it was passed, not the schema's parsed output: a schema's defaults and transforms do not reach the template, so read an optional field with `.at(key, default: …)`.
- A template compiles from the files it declares and nothing else. A file it imports but does not declare fails with a diagnostic whose `code` is `file-not-found`, naming the file and linking to what to do ([docs/errors.md](./errors.md#file-not-found)): `File not found: /common/header.typ (read by /outcomes/main.typ). See …`. The header's code listed in `files` without its partial fails the same way, on `common/header.schema.json`, where no data is mounted.
- A partial has one input per compile. A template that shows the header twice shows the same data in both places; whatever differs between the two uses goes in as Typst arguments (`report-header(subtitle: …)`).

### Images the data points to

A chart or a logo travels in `assets`, and the data holds its path. `createAttachments()` numbers the files and keeps the bytes:

```ts
import { createAttachments } from '@typfolio/core';

const files = createAttachments();
const logo = files.add(logoBytes, 'png'); // '/attachments/0.png'; the same bytes again give the same path
await client.compile(outcomes(data, { header: { institution, logo } }), { assets: files.assets });
```

The paths are absolute, so `image(header.logo)` reads the file from any template file. In React, `usePdf`'s document function gets `attach`, which does the same, and `render`, which draws a chart and returns its path (`/charts/0.svg`): `usePdf(({ render, attach }) => outcomes(…), { client, deps })`.

Mark such a field with `contentMediaType` in its JSON Schema (Zod: `z.string().meta({ contentMediaType: 'image/png' })`). In an editor and in a check the sample is then a placeholder image instead of a string, so `image(header.logo)` compiles there too.

### The JSON Schema files

The editor reads each JSON Schema from disk, so the files must exist and must follow the schemas. `inputSchemaFiles` from `@typfolio/dev-tools` gives every file, by path, as JSON text; it writes nothing. It takes templates or partials (each template's own file and every partial's, once per path), or `{ schema, schemaPath }` pairs, which a Node script can import even where the definitions import `.typ` files through the bundler:

```ts
// scripts/write-schemas.ts: node scripts/write-schemas.ts
import { writeFile } from 'node:fs/promises';
import { inputSchemaFiles } from '@typfolio/dev-tools';
import { headerSchema } from '../src/common/header.schema.ts';
import { outcomesSchema } from '../src/outcomes/outcomes.schema.ts';

const files = inputSchemaFiles([
  { schema: headerSchema, schemaPath: 'common/header.schema.json' },
  { schema: outcomesSchema, schemaPath: 'outcomes/outcomes.schema.json' },
]); // or inputSchemaFiles([outcomes]) where the definitions can be imported
for (const [path, text] of Object.entries(files)) {
  await writeFile(new URL(`../src/${path}`, import.meta.url), text);
}
```

A test calls it the same way and compares the parsed files with the parsed results (a formatter may change the text), so a schema that changed without its file fails CI. Schemas that implement Standard JSON Schema (`~standard.jsonSchema`; Zod's do) need nothing more. For others, such as Zod Mini's, pass `toJSONSchema: schema => z.toJSONSchema(schema, { io: 'input' })`. Use the input side of the schema: Typfolio mounts the data as it was passed, not the parsed output. Zod 4's output (nullable objects as `anyOf` with `null`, defaulted arrays, `$defs`) is handled by the sample builder; hand-written JSON Schema works equally well.

## Editor setting for Cursor and VS Code

The Tinymist extension resolves `@local/typfolio:0.1.0` from a package path directory. Core ships that directory as `typst-packages/` (layout `local/typfolio/0.1.0/`), so one workspace setting is enough:

```jsonc
// .vscode/settings.json in a project that depends on @typfolio/core
{
  "tinymist.typstExtraArgs": ["--package-path", "node_modules/@typfolio/core/typst-packages"]
}
```

In this repository the same package is at `packages/core/typst-packages`, and `.vscode/settings.json` already sets it.

What was checked against Tinymist 0.15.2:

- An absolute path works.
- A relative path works, and is resolved against the working directory of the Tinymist process. The VS Code language client starts the server in the first workspace folder, so the setting above is correct when the project root is that folder. A multi-root workspace whose first folder is another project, or a monorepo opened from a parent folder, needs another path or an absolute one.
- `${workspaceFolder}` does not work in `typstExtraArgs`: Tinymist's VS Code extension substitutes variables only in `serverPath`, `rootPath`, `outputPath`, and `fontPaths`, and the server does not expand them either. Do not use it.

To preview the sparse sample (see [The sample and its limits](#the-sample-and-its-limits)) instead of the default one, pass the Typst input `typfolio-sample=minimal` in the same setting. With Tinymist 0.15.2 this changes the sample, and a template that reads an optional field then shows the compile error in the editor, as it would in a check:

```jsonc
{
  "tinymist.typstExtraArgs": ["--package-path", "node_modules/@typfolio/core/typst-packages", "--input", "typfolio-sample=minimal"]
}
```

The default is `full`. Core ships both package files (`lib.typ` and `sample.typ`) in `typst-packages/` because the editor reads that folder from disk.

Tinymist resolves other Typst packages from the OS data directory; Typfolio does not use that, and templates compiled by Typfolio cannot import anything except `@local/typfolio:0.1.0`.

## The sample and its limits

There are two sample modes, selected by `sys.inputs.at("typfolio-sample", default: "full")`. The `full` sample is built for authoring completion:

- Every declared property is present, so an optional field appears. An array has at least one item (`minItems` is honored). Nullable shapes such as `anyOf` with `null` produce the non-null shape.
- A string with a `contentMediaType` that starts with `image/` is a placeholder image (SVG bytes), in both modes, so `image(...)` of a path the data carries compiles. See [Images the data points to](#images-the-data-points-to).
- `examples`, `default`, `const`, and `enum` are preferred in that order. An empty `[]` or `{}` default does not replace a generated shape, and a partial object default is merged into the generated object.
- Local `$ref` (`#`, `#/$defs/...`) is resolved, and a recursive schema is expanded one level: a tree gets one child, whose own recursive parts end. There, a list is empty, an optional property is left out, and a required one is `null`, so a template that loops over children is checked with real items and never meets a `null` item. `anyOf` and `oneOf` take the first non-null branch, `allOf` merges objects. Type arrays use the first non-null type, and a missing `type` is inferred from `properties` or `items`.
- Strings are `"Sample text"` or a fixed value for `date`, `date-time`, `email`, `uri`, and `uuid` formats. Numbers are `minimum` or `1`; booleans are `true`.
- The sample is not validated against the schema, and keywords that only restrict a value (`pattern`, `maximum`, `exclusiveMinimum`, `minLength`, `additionalProperties`, ...) are ignored by `full`. (`minimal` honours `minLength`, `minItems`, `minimum` and `exclusiveMinimum`.) External `$ref` is not supported.

The `minimal` sample is the opposite: the sparsest value the schema allows, the one most likely to break a careless template.

- Only properties listed in `required` are present (none when `required` is absent). A required name the schema does not declare is present as `null`.
- Nullable values are `null`: `type` includes `"null"`, or an `anyOf`/`oneOf` has a branch with `type: "null"`.
- Arrays are empty unless `minItems` is above zero, then that many minimal items.
- Strings are `""`, or `"a"` repeated `minLength` times, so declare `minLength: 1` (Zod: `z.string().min(1)`) on a string that must not be empty, such as one that becomes a heading or the document title. Numbers are `minimum`, else `exclusiveMinimum + 1` for integers, else `0`; booleans are `false`.
- A `const`, or the first `enum` value, wins over the type.
- `examples` and `default` are ignored. `$ref` (with the same recursion guard), `allOf`, inferred types, `anyOf`/`oneOf` (first branch) and type arrays (first type) behave as in `full`.

The sample does not replace the real data: at runtime the data is whatever the template is called with, checked against its schema.

## Build-time checks

`@typfolio/dev-tools` is the home for dev-time tools. It is a separate package, installed as a devDependency, and `@typfolio/core` never imports it, so it adds no bytes to a production bundle. Its template checker compiles a template against samples built from its schema, so CI catches a template that no longer matches the schema:

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

`checkTemplate(template, { wasm, fonts, modes?, pdf?, assets?, structure? })` is the one-shot form that creates and disposes a checker.

`check` takes a template made with `defineTemplate`. It compiles the files the template declares and nothing else, with each piece of data's JSON Schema at its `schemaPath`, made as `inputSchemaFiles` makes it (pass `toJSONSchema` where the schemas need it). A JSON Schema file given in `assets` at a data path is used as it is instead: that is how the files committed on disk are checked, and how data without a schema is. A file the template imports without declaring it fails with the message described in [Templates whose parts have data of their own](#templates-whose-parts-have-data-of-their-own), which is the check that catches a forgotten partial before any data does.

What a check does:

- It compiles in editor mode, once per mode: Typfolio's runtime marker is not set, `sys.inputs.typfolio-sample` is the mode, and the package's `typst.toml`, `lib.typ` and `sample.typ` are mounted. `input()` therefore reads the schema and builds the sample, exactly as an editor does.
- **Each `schemaPath` must be the path the Typst file's `json.with(...)` names**, relative to the template root (`reports/outcome/schemas/x.json` for a template at `reports/outcome/main.typ` that says `json.with("./schemas/x.json")`). A mismatch makes every mode fail with `file-not-found` on the path the file reads.
- The default modes are `minimal` then `full`. `full` catches a template that no longer matches the schema (a renamed or removed field). `minimal` catches the templates that assume optional data: reading an optional field without `.at(key, default: ...)`, calling `.first()` on a list that can be empty, or treating a nullable value as present.
- A compile error in one mode is reported in that mode's result (`ok: false`, `error`, `diagnostics`) and the other modes still run. A malformed template (`INVALID_REQUEST`) or an unsupported `pdf` option (`UNSUPPORTED_OPTION`) is thrown, as for `compile()`. `bytes` of a mode that compiled are in memory only.
- With `structure: checkStructure` (from `@typfolio/dev-tools/pdf`, which needs `pdfjs-dist`), the PDF of each mode that compiled is read for the structure a screen reader needs, as in [Inspecting the output](#inspecting-the-output): a mode with any warning is not `ok`, and its result lists them in `structure`. The option is the function itself, so the main entry never loads pdf.js; wrap it to accept a warning, for example `structure: async bytes => (await checkStructure(bytes)).filter(warning => warning.kind !== 'no-headings')`.
- Nothing is written to disk. The samples exist only inside the compile, and `@typfolio/dev-tools` imports no file-system module. Writing the PDFs somewhere is up to the caller.
- A checker runs one check at a time, like a compiler.

A complete `node:test` recipe, which reads the template folder and its committed schema file from disk. It is TypeScript that Node runs by stripping the types (`node --test test/report.template.test.ts` on Node 22.18 or newer; no build step), and it type-checks under `strict`:

```ts
// test/report.template.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { defineTemplate } from '@typfolio/core';
import { createTemplateChecker } from '@typfolio/dev-tools';
import type { TemplateChecker } from '@typfolio/dev-tools';

const folder = new URL('../src/report/', import.meta.url);
const font = new Uint8Array(await readFile(new URL('../fonts/report.otf', import.meta.url)));
const wasm = await readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')));

// Every .typ file of the folder, keyed by its path under the template root.
async function loadTemplate() {
  const files: Record<string, string> = {};
  for (const path of await readdir(folder, { recursive: true })) {
    if (path.endsWith('.typ')) files[`report/${path.split('\\').join('/')}`] = await readFile(new URL(path, folder), 'utf8');
  }
  // No schema here: the check reads the committed JSON Schema file, given in `assets` below.
  return defineTemplate({ entrypoint: 'report/main.typ', files, schemaPath: 'report/report.schema.json' });
}

let checker: TemplateChecker;
before(async () => { checker = await createTemplateChecker({ wasm, fonts: [font] }); });
after(() => checker.dispose());

test('the report template compiles as PDF/UA against minimal and full samples of its schema', async () => {
  const schema = await readFile(new URL('report.schema.json', folder));
  const report = await checker.check(await loadTemplate(), {
    pdf: { standards: ['ua-1'] },
    assets: { 'report/report.schema.json': schema },
  });
  for (const result of report.results) assert.ok(result.ok, `${result.mode} sample: ${result.error?.message}`);
});
```

Where the test can import the application's definition (`report` from `src/report/template.ts`), pass it instead: `checker.check(report)` then makes the JSON Schema from its schema. Vitest or any other runner works the same way.

Limits of a check, stated plainly:

- It checks the shape of the template against the shape of the schema. It does not validate runtime data, and the samples are not validated against the schema; data the schema allows but the samples do not exercise (a non-first `anyOf` branch, a string `pattern`, a long list, an unusual `enum` value) can still break a template.
- PDF standards apply to every mode, so `minimal` can reveal PDF/UA problems. A string the template turns into a heading or the document title is `""` in the `minimal` sample, and PDF/UA reports that ("heading title is empty"). If the schema promises the string is non-empty, say so with `minLength: 1` (Zod: `z.string().min(1)`): `minimal` then produces `"a"` and the check is meaningful. If the string may legitimately be empty, the failure is real: the template would emit an invalid document for that data, and it has to guard against it.
- It makes no accessibility claim. `pdf: { standards: ['ua-1'] }` only asks the compiler for PDF/UA output, and a compile that succeeds is not a conformance verdict (see `docs/compiler-build.md`). Accessible authoring and human review stay necessary.
- `structure` sees the samples' PDFs, which are small: `minimal` has empty lists, `full` one item in each, so a sample is usually one page. It catches what the template draws whatever the data, such as a table with no header row, but not what only shows with real data, such as six pages without a heading. Run `checkStructure` on PDFs compiled from real or recorded data as well.
- The sample is only as good as the schema. A schema that does not describe what the application actually sends is checked faithfully and proves nothing.

### Inspecting the output

`@typfolio/dev-tools/pdf` reads a compiled PDF and reports what is in it, so a test can assert on it (for example the `bytes` of a check result, or the `bytes` of a `compile()` result):

```ts
import { inspectPdf } from '@typfolio/dev-tools/pdf'; // needs pdfjs-dist, installed by you

const report = await inspectPdf(bytes);
// report.pages, tagged, structureTree, title, language, creationDate
// report.standard: { pdfUa?, pdfA?: { part, conformance? } }, as the XMP metadata declares them
// report.headings: [{ level, text }] in document order; report.figures: [{ alt? }]; report.tables
// report.fonts: [{ name, embedded }]; report.structureRoles: how often each structure role occurs
// report.structure: [{ page, elements: [{ role, text, alt?, lang?, children }] }]: each page's tags in reading order
```

`pdfjs-dist` (6.3 or later) is an optional peer dependency of `@typfolio/dev-tools`, loaded only when `inspectPdf` or `checkStructure` is first called (`structureWarnings` and `readStructure` never load it); without it the call rejects with a `TypstPdfError` that says to install it. Input that is not a readable PDF rejects with `INVALID_REQUEST`.

The report states facts and nothing more. A tagged PDF with a title, a language, a heading outline, figure alt text and a PDF/UA declaration can still fail PDF/UA, and `standard.pdfUa` only repeats what the file claims. Use the report to catch regressions (a lost heading level, a figure that lost its alt text, a missing language); use a validator such as [veraPDF](https://verapdf.org) for conformance, and review reading order and alt text by hand.

`structureWarnings(report.structure)` lists what a screen reader user would trip over and neither a PDF/UA-1 compile nor a validator reports: a table without header cells (TH), and several pages without a heading, such as titles drawn in a large face. It also lists headings that skip a level and figures without alt text, which a PDF/UA-1 compile refuses but a tagged compile accepts. Each warning has a `kind`, a `message`, and, unless it is about the whole document, the `page` and the `element` of `report.structure` it is about. `checkStructure(bytes)` reads the bytes and returns the same, or a single `untagged` warning for a PDF that is not tagged; it is the function a template check takes as `structure` (see [Build-time checks](#build-time-checks)). `readStructure(document)` gives `report.structure` from a pdf.js document you loaded yourself, for example in a browser page that shows a PDF's tags.

```ts
import { checkStructure } from '@typfolio/dev-tools/pdf';

const { bytes } = await compiler.compile(report(recordedData), { pdf: { standards: ['ua-1'] } });
assert.deepEqual((await checkStructure(bytes)).map(warning => warning.message), []);
```

The warnings are heuristics, not a conformance check, and an empty list is not a verdict: they say nothing about reading order, wording, or whether alt text describes the image.

To see the tags while you edit a template, `mountStructureDevtools` from `@typfolio/dev-tools/panel` shows them in the page, page by page, with these warnings and the tag each is about; load it in development only. See [the panel](../packages/dev-tools/README.md#structure-panel).

What the report cannot tell you, because of how pdf.js exposes the structure tree (it is read per page):

- An element that continues over a page break is counted once for each page it has content on. A table that spans three pages makes `tables` 3 and adds three `Table`, and so on, to `structureRoles`, and is in `structure` once for each of those pages. Assert `tables >= 1` or compare against a baseline, not exact counts, for content that can break.
- `structureWarnings` checks a table that runs over a page break once, on the page it starts, because the part that carries on has no header row unless the header repeats. It tells a continuation from a new table only by position, so a new table that starts a page right after another table ended the previous page is not checked.
- `figures` lists the structure elements whose role is `Figure`. Typst 0.15.1 writes one for an `image` (with its alt text), but a `figure` around other content, such as a drawn shape, is tagged `Div`, so it is not listed.
- Roles are the ones pdf.js reports after resolving the file's `/RoleMap` once, so a custom role that the file maps appears under the standard role it maps to. Typst maps a heading deeper than level 6 (`H7`) to `P`, so such a heading is not in `headings`.
- `headings[].text` is recovered from the page's marked content; it is the empty string for a heading whose text pdf.js cannot attribute to it.
- `fonts` lists the fonts that page content selects, not every font resource in the file.

## Typed calls

A template's call is typed by its schemas (each schema's input type, through `~standard.types`): `outcomes(data, { header })` must pass data of the template's shape and one key per partial, nested partials included. A missing key, an unknown key or data of the wrong shape is a type error, in `compile`, the worker client and `usePdf` alike, because they all take the document the call returns. A template without a schema takes `unknown` data, unchecked.

A function that takes any template, such as an export hook of the application's own, types it as `TemplateDefinition<T, { header: HeaderSettings }>` and calls it with `T` and the header's data, without a cast. `AnyTemplate` is any template at all.

The call checks the application's own types against the schema's, which TypeScript does strictly:

- An `interface` is not assignable to a loose object schema's type (Zod's `z.looseObject`, which carries `[key: string]: unknown`): declare such data with `type` instead, which is.
- A `readonly` array is not assignable to the schema's `T[]`: copy it (`[...rows]`) or declare it mutable.

The typing is type-only: at runtime the schemas check the data, and the JSON compatibility of the value (finite numbers, plain objects, no cycles) is checked when it is mounted.

## Loading a folder

A bundler glob gives a template's files in one call. The `import.meta.glob` call must stay literal so the bundler can analyse it; drop the leading `./` from its keys, which `defineTemplate` would refuse:

```ts
const globbed = import.meta.glob<string>('./report/**/*.typ', { query: '?raw', import: 'default', eager: true });
const files = Object.fromEntries(Object.entries(globbed).map(([path, source]) => [path.slice(2), source]));

export const report = defineTemplate({ entrypoint: 'report/main.typ', files, schema: reportSchema, schemaPath: 'report/report.schema.json' });
```

The glob matches `*.typ` only, so `report.schema.json` is never sent at runtime. A lazy glob yields functions and one without `import: 'default'` yields module objects; `defineTemplate` rejects both.

## Validation

A template's data, and each partial's, is validated with the schemas the application gave them, before anything is compiled (see [Templates whose parts have data of their own](#templates-whose-parts-have-data-of-their-own)). Typfolio only calls each schema's `~standard.validate`; which library, and how strict (a loose object that lets the backend add fields, say), is the application's choice. Data without a schema is not validated: the compiler checks only that it can be serialised as JSON. `validate: false` (on `compile`, the worker client, a batch job and `usePdf`) skips the schemas and keeps the types.
