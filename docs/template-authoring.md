# Template authoring

Typfolio compiles Typst templates with JSON input that exists only at runtime. This guide covers the template layout, how a template reads its input with editor completion, build-time template checks, typed requests, and the folder loader. Typfolio does no runtime validation and is not tied to a schema library.

## Folder layout

Keep the template as a folder of `.typ` files plus the JSON Schema of its input. There is no input file:

```text
src/report/
  main.typ               entrypoint
  report.schema.json     JSON Schema of the input (editor only; never sent at runtime)
  partials/layout.typ    imported by main.typ
```

Editor support exists for `.typ` files, not for Typst source inside JavaScript strings, which is why the template lives in files. The schema is the application's artifact. Write it by hand or generate it from a validation library (see below); Typfolio does not care where it comes from and adds no schema dependency.

## Reading the input

```typ
#import "@local/typfolio:0.1.0": input
#import "partials/layout.typ": summary

#let data = input(json.with("./report.schema.json"))
#set document(title: data.title)

= #data.title
#summary(data)
```

`@local/typfolio:0.1.0` is a small Typst package that ships inside `@typfolio/core` and is the only package templates can import. `input(schema)` behaves differently depending on who compiles:

- Under Typfolio, core sets `sys.inputs.typfolio` and `input()` returns the request's `input`. The schema is never read, so it does not have to be in `template.files`.
- In an editor, nothing sets it, so `input()` builds a sample value from the schema. That sample is a real Typst value, so the editor completes `#data.` fields, nested fields, and loop variables over arrays.

Pass the schema as `json.with("<path>")`, not as a path string. The path is resolved relative to the file that contains `json.with`, which is why the function must be created in the template and not inside the package. `input(none)` returns the request input under Typfolio but is a hard error in the editor (with a message that says to pass `json.with(...)`), because there is nothing to build a sample from. `input` also accepts an already-loaded schema dictionary, for example `input(json("report.schema.json"))`.

The sample builder lives in a second file of the package, `sample.typ`, which `input()` imports only in the editor branch. A compile under Typfolio never loads it, and core does not even mount it, so the runtime embeds only `input()`. The package's `lib.typ` does not re-export the builder: only the editor and `@typfolio/core/dev-tools` (see [Build-time checks](#build-time-checks)) use it.

### Path rules

- A relative path in `json.with(...)` is relative to the file that contains it, so a template at `reports/outcome/main.typ` writes `json.with("./schemas/report.schema.json")` for `reports/outcome/schemas/report.schema.json`.
- Typst refuses paths that leave the project root, and the editor uses the workspace folder as the project root. Keep the schema inside the workspace (usually next to the template). A path above it, such as `../../shared.schema.json`, fails in the editor.
- Call `input(...)` from the entrypoint, or from a partial that creates its own `json.with(...)`, and pass `data` to partials as an argument. Do not rely on a partial reading the schema through a path written in another file.

Existing templates that read `json("/input.json")` or `json("input.json")` keep working in Typfolio: core still mounts the request input at `/input.json`. They get no editor completion.

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
- `examples`, `default`, `const`, and `enum` are preferred in that order. An empty `[]` or `{}` default does not replace a generated shape, and a partial object default is merged into the generated object.
- Local `$ref` (`#/$defs/...`) is resolved with a recursion guard: a reference that loops back to itself ends in `null`. `anyOf` and `oneOf` take the first non-null branch, `allOf` merges objects. Type arrays use the first non-null type, and a missing `type` is inferred from `properties` or `items`.
- Strings are `"Sample text"` or a fixed value for `date`, `date-time`, `email`, `uri`, and `uuid` formats. Numbers are `minimum` or `1`; booleans are `true`.
- The sample is not validated against the schema, and keywords that only restrict a value (`pattern`, `maximum`, `exclusiveMinimum`, `minLength`, `additionalProperties`, ...) are ignored by `full`. (`minimal` honours `minLength`, `minItems`, `minimum` and `exclusiveMinimum`.) External `$ref` is not supported.

The `minimal` sample is the opposite: the sparsest value the schema allows, the one most likely to break a careless template.

- Only properties listed in `required` are present (none when `required` is absent). A required name the schema does not declare is present as `null`.
- Nullable values are `null`: `type` includes `"null"`, or an `anyOf`/`oneOf` has a branch with `type: "null"`.
- Arrays are empty unless `minItems` is above zero, then that many minimal items.
- Strings are `""`, or `"a"` repeated `minLength` times, so declare `minLength: 1` (Zod: `z.string().min(1)`) on a string that must not be empty, such as one that becomes a heading or the document title. Numbers are `minimum`, else `exclusiveMinimum + 1` for integers, else `0`; booleans are `false`.
- A `const`, or the first `enum` value, wins over the type.
- `examples` and `default` are ignored. `$ref` (with the same recursion guard), `allOf`, inferred types, `anyOf`/`oneOf` (first branch) and type arrays (first type) behave as in `full`.

The sample does not replace the real input: the runtime input is whatever the request carries, and the schema is not checked against it.

## Build-time checks

`@typfolio/core/dev-tools` is the home for dev-time tools; nothing in it is reachable from `@typfolio/core`, so it adds no bytes to a production bundle (a PDF structure inspector is planned there; it does not exist yet). Its first tool compiles a template against samples built from its schema, so CI catches a template that no longer matches the schema:

```ts
import { createTemplateChecker } from '@typfolio/core/dev-tools';

const checker = await createTemplateChecker({ wasm, fonts }); // the options of createCompiler
try {
  const report = await checker.check(template, { modes: ['minimal', 'full'], pdf: { standards: ['ua-1'] } });
  // report.ok: true only if every mode compiled
  // report.results: { mode, ok, diagnostics, error?, bytes? } per mode
} finally {
  await checker.dispose();
}
```

`checkTemplate(template, { wasm, fonts, modes?, pdf? })` is the one-shot form that creates and disposes a checker.

What a check does:

- It compiles in editor mode, once per mode: Typfolio's runtime marker is not set, `sys.inputs.typfolio-sample` is the mode, and the package's `typst.toml`, `lib.typ` and `sample.typ` are mounted. `input()` therefore reads the schema and builds the sample, exactly as an editor does.
- **The schema must be in `template.files`**, as a string, at the path the template's `json.with(...)` names, relative to the file that writes it (`reports/outcome/schemas/x.json` for a template at `reports/outcome/main.typ` that says `json.with("./schemas/x.json")`). The helper does not look for schemas itself: your test reads the file, or serializes the schema it generated from Zod, and passes the text. A schema that is missing makes every mode fail to compile.
- The default modes are `minimal` then `full`. `full` catches a template that no longer matches the schema (a renamed or removed field). `minimal` catches the templates that assume optional data: reading an optional field without `.at(key, default: ...)`, calling `.first()` on a list that can be empty, or treating a nullable value as present.
- A compile error in one mode is reported in that mode's result (`ok: false`, `error`, `diagnostics`) and the other modes still run. A malformed template (`INVALID_REQUEST`) or an unsupported `pdf` option (`UNSUPPORTED_OPTION`) is thrown, as for `compile()`. `bytes` of a successful mode are in memory only.
- Nothing is written to disk. The samples exist only inside the compile, and `dev-tools` imports no file-system module. Writing the PDFs somewhere is up to the caller.
- A checker runs one check at a time, like a compiler.

A complete `node:test` recipe, which reads the template folder and its schema from disk:

```js
// test/report.template.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { createTemplateChecker } from '@typfolio/core/dev-tools';

const folder = new URL('../src/report/', import.meta.url);
const font = new Uint8Array(await readFile(new URL('../fonts/report.otf', import.meta.url)));
const wasm = await readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')));

// Every .typ file of the folder, plus the schema, keyed by their path relative to main.typ.
async function loadTemplate() {
  const files = {};
  for (const path of await readdir(folder, { recursive: true })) {
    if (path.endsWith('.typ') || path === 'report.schema.json') files[path.split('\\').join('/')] = await readFile(new URL(path, folder), 'utf8');
  }
  return { files };
}

let checker;
before(async () => { checker = await createTemplateChecker({ wasm, fonts: [font] }); });
after(() => checker.dispose());

test('the report template compiles as PDF/UA against minimal and full samples of its schema', async () => {
  const report = await checker.check(await loadTemplate(), { pdf: { standards: ['ua-1'] } });
  for (const result of report.results) assert.ok(result.ok, `${result.mode} sample: ${result.error?.message}`);
});
```

A schema generated from Zod can be passed directly instead of being read from disk: `files['report.schema.json'] = JSON.stringify(z.toJSONSchema(Report))`. Vitest or any other runner works the same way.

Limits of a check, stated plainly:

- It checks the shape of the template against the shape of the schema. It does not validate runtime data, and the samples are not validated against the schema; data the schema allows but the samples do not exercise (a non-first `anyOf` branch, a string `pattern`, a long list, an unusual `enum` value) can still break a template.
- PDF standards apply to every mode, so `minimal` can reveal PDF/UA problems. A string the template turns into a heading or the document title is `""` in the `minimal` sample, and PDF/UA reports that ("heading title is empty"). If the schema promises the string is non-empty, say so with `minLength: 1` (Zod: `z.string().min(1)`): `minimal` then produces `"a"` and the check is meaningful. If the string may legitimately be empty, the failure is real: the template would emit an invalid document for that input, and it has to guard against it.
- It makes no accessibility claim. `pdf: { standards: ['ua-1'] }` only asks the compiler for PDF/UA output, and a compile that succeeds is not a conformance verdict (see `docs/compiler-build.md`). Accessible authoring and human review stay necessary.
- The sample is only as good as the schema. A schema that does not describe what the application actually sends is checked faithfully and proves nothing.

## Producing the schema from Zod (one option)

```ts
import { z } from 'zod';
import { writeFileSync } from 'node:fs';

const Report = z.object({ title: z.string().min(1), rows: z.array(z.object({ name: z.string(), score: z.number() })).default([]) });
writeFileSync('src/report/report.schema.json', JSON.stringify(z.toJSONSchema(Report), null, 2));
```

Zod 4's `z.toJSONSchema()` output (nullable objects as `anyOf` with `null`, defaulted arrays, `$defs`) is handled by the sample builder. Regenerate the file when the Zod schema changes. Hand-written JSON Schema works equally well; `examples/vite-react/src/report/report.schema.json` is one.

## Typed requests

`PdfRequest` takes the type of its input, so TypeScript checks the runtime input against the application's own type:

```ts
import type { PdfRequest } from '@typfolio/core';

interface ReportInput { title: string; owner: string | null; rows: { name: string; score: number }[] }

const request: PdfRequest<ReportInput> = { template, input: { title: 'Q3', owner: null, rows: [] } };
await client.compile(request); // core, worker and React `compile` all accept it without a cast
```

The parameter is unconstrained, so an `interface` works (it is not assignable to `JsonValue`). The typing is type-only: JSON compatibility of the value (finite numbers, plain objects, no cycles) is still enforced at runtime, and nothing checks that the value matches `ReportInput` beyond the compiler. A plain `PdfRequest` means `PdfRequest<JsonValue>` as before. Code that accepts any request should use `PdfRequest<unknown>`. Keeping `ReportInput`, the schema file, and the template in step is the application's responsibility.

## Loading the folder

`templateFromFiles` turns the result of a bundler glob into a template. The `import.meta.glob` call must stay literal in application code so the bundler can analyse it; the helper takes its result and has no bundler or file-system dependency.

```ts
import { templateFromFiles } from '@typfolio/core';

const template = templateFromFiles(
  import.meta.glob<string>('./report/**/*.typ', { query: '?raw', import: 'default', eager: true }),
);
```

The glob matches `*.typ` only, so `report.schema.json` is never sent at runtime. Keys become virtual paths relative to the template folder: a leading `./` or `/` is removed, then either `options.base` or, when not given, the longest directory prefix shared by all keys. `./report/main.typ` and `./report/partials/layout.typ` become `main.typ` and `partials/layout.typ`; a single `./report/main.typ` becomes `main.typ`. `options.entrypoint` is passed through when given; otherwise core's `main.typ` default applies.

The loader rejects with `INVALID_REQUEST` an empty record, a key outside an explicit `base`, two keys that normalise to the same path, and a non-string value. A non-string value usually means the glob lacks `{ query: '?raw', import: 'default', eager: true }`: a lazy glob yields functions, and a glob without `import: 'default'` yields module objects. Path rules, the reserved paths (`/input.json` and everything under `/@typfolio/`) and a missing entrypoint are checked later by the compiler as for any request.

## Validation belongs to the application

Typfolio does no runtime schema validation. The compiler checks only that `input` can be serialised as JSON, and the schema file is used only to build the editor sample. Validate API responses with whatever the application already uses (Zod or another tool) before building the request.
