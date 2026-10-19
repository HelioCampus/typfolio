import { defineTemplate, type PdfOptions } from '@typfolio/core';
import { createWorkerClient } from '@typfolio/workers';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import fontUrl from '../../fixtures/fonts/LibertinusSerif-Regular.otf?url';
import chartUrl from '../../fixtures/basic/chart.svg?url';

const status = document.querySelector<HTMLElement>('#status')!;

// `schemaPath: 'input.json'` mounts each call's data at /input.json, where the Typst reads it.
const heading = '#let input = json("/input.json")\n#set text(font: "Libertinus Serif")\n#set document(title: input.title)\n= #input.title';
const titled = defineTemplate({ files: { 'main.typ': heading }, schemaPath: 'input.json' });
const charted = defineTemplate({
  files: { 'main.typ': heading + '\n#image("chart.svg", alt: "A blue bar representing the vite chart asset.")' },
  schemaPath: 'input.json',
});
// No data: a long loop, cancelled while a worker compiles it.
const slow = defineTemplate({ files: { 'main.typ': '#set text(font: "Libertinus Serif")\n#for value in range(200000) [#value ]' } });
const pdf: PdfOptions = { standards: ['ua-1'] };

try {
  const compiler = createWorkerClient({
    compiler: { wasm: wasmUrl, fonts: [fontUrl] },
    timeoutMs: 30_000,
  });
  try {
    const chart = new Uint8Array(await (await fetch(chartUrl)).arrayBuffer());
    const chartLength = chart.length;
    if (!chartLength) throw new Error('The chart asset is empty');
    // The first compile carries a real asset, so the transfer path runs through a real Worker. The client
    // copies the asset once and transfers that copy; the buffer in `chart` stays usable here.
    const result = await compiler.compile(charted({ title: 'Vite application build' }), {
      assets: { 'chart.svg': chart },
      pdf,
    });
    if (chart.length !== chartLength) throw new Error('The caller asset buffer was detached by compile()');

    const controller = new AbortController();
    const cancelled = compiler.compile(slow(), { pdf, signal: controller.signal });
    setTimeout(() => controller.abort('browser smoke cancellation'), 0);
    try {
      await cancelled;
      throw new Error('Expected the active worker job to be cancelled');
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== 'ABORTED') throw error;
    }

    const recovered = await compiler.compile(titled({ title: 'Worker replacement succeeded' }), { pdf });
    if (recovered.metadata.title !== 'Worker replacement succeeded') {
      throw new Error('Replacement worker returned the wrong document');
    }
    status.textContent = 'Compiled ' + result.bytes.length + ' PDF bytes with a ' + chartLength + '-byte asset, hard-cancelled an active job, and recovered.';
    status.dataset.status = 'passed';
  } finally {
    await compiler.dispose();
  }
} catch (error) {
  status.textContent = String((error as Error).stack ?? error);
  status.dataset.status = 'failed';
}
