// Two PDFs of the basic fixture for the browser specs that need real files: one compiled as PDF/UA-1 and one with no
// standard. Compiled once per test process: the specs share one process, and core takes one compiler binary per
// JavaScript realm, so each spec compiling its own would fail in the second.
import { readFile } from 'node:fs/promises';
import { createCompiler, defineTemplate } from '@typfolio/core';

const root = new URL('../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const text = async (path: string) => (await file(path)).toString();

let compiled: Promise<{ ua1: Uint8Array; plain: Uint8Array }> | undefined;

export function samplePdfs(): Promise<{ ua1: Uint8Array; plain: Uint8Array }> {
  compiled ??= (async () => {
    const compiler = await createCompiler({
      wasm: await file('packages/wasm/generated/compiler_bg.wasm'),
      fonts: await Promise.all(['Regular', 'Bold'].map(style => file(`fixtures/fonts/LibertinusSerif-${style}.otf`))),
    });
    try {
      const template = defineTemplate({
        files: { 'main.typ': await text('fixtures/basic/main.typ'), 'partials/layout.typ': await text('fixtures/basic/partials/layout.typ') },
        schemaPath: 'input.json',
      });
      const request = template(JSON.parse(await text('fixtures/basic/input.json')));
      const assets = { 'assets/chart.svg': await file('fixtures/basic/chart.svg') };
      return {
        ua1: (await compiler.compile(request, { assets, pdf: { standards: ['ua-1'], creationTimestamp: 1700000000 } })).bytes,
        plain: (await compiler.compile(request, { assets, pdf: { creationTimestamp: 1700000000 } })).bytes,
      };
    } finally {
      compiler.dispose();
    }
  })();
  return compiled;
}
