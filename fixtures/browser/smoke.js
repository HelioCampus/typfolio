import { createCompiler, defineTemplate } from '/packages/core/dist/index.js';

async function resource(path, asText = false) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return asText ? response.text() : new Uint8Array(await response.arrayBuffer());
}

export async function runSmoke() {
  const fonts = await Promise.all(['Regular', 'Bold'].map(style => resource(`../fonts/LibertinusSerif-${style}.otf`)));
  const start = performance.now();
  const compiler = await createCompiler({ wasm: new URL('/packages/wasm/generated/compiler_bg.wasm', import.meta.url), fonts });
  const initialized = performance.now();
  try {
    // main.typ reads its data with json("/input.json"): schemaPath mounts the call's data there.
    const report = defineTemplate({
      files: {
        'main.typ': await resource('../basic/main.typ', true),
        'partials/layout.typ': await resource('../basic/partials/layout.typ', true),
      },
      schemaPath: 'input.json',
    });
    const input = JSON.parse(await resource('../basic/input.json', true));
    const options = {
      assets: { 'assets/chart.svg': await resource('../basic/chart.svg') },
      pdf: { standards: ['ua-1'], tags: true, creationTimestamp: 1700000000 },
    };
    const began = performance.now();
    const result = await compiler.compile(report(input), options);
    if (new TextDecoder().decode(result.bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Invalid PDF');
    if (result.metadata.title !== input.title) throw new Error('JSON input was not applied');
    if (result.diagnostics.length) throw new Error(JSON.stringify(result.diagnostics));
    return { title: result.metadata.title, bytes: result.bytes.length,
      initializeMs: initialized - start, compileMs: performance.now() - began,
      hasDocument: typeof document !== 'undefined' };
  } finally { await compiler.dispose(); }
}
