# @typfolio/dev-tools

Dev-time tools for Typfolio templates. Today: build-time template checks. Planned: PDF inspection.

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

`checkTemplate(template, { wasm, fonts, modes?, pdf? })` is the one-shot form that creates and disposes a checker.

A check compiles the template once per sample mode (`minimal`, then `full`) the way an editor does, so `input()` builds a sample from the JSON Schema in `template.files`. A compile error is reported in that mode's result; a malformed template or option is thrown. Nothing is written to disk. See "Build-time checks" in [docs/template-authoring.md](../../docs/template-authoring.md) for the rules and a test recipe.

The package builds on `@typfolio/core/internal`, which is unstable and meant only for Typfolio's own packages.
