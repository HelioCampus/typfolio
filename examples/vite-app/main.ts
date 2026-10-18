import type { PdfRequest } from '@typfolio/core';
import { createWorkerClient } from '@typfolio/workers';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import fontUrl from '../../fixtures/fonts/LibertinusSerif-Regular.otf?url';
import chartUrl from '../../fixtures/basic/chart.svg?url';

const status = document.querySelector<HTMLElement>('#status')!;

try {
  const compiler = createWorkerClient({
    compiler: { wasm: wasmUrl, fonts: [fontUrl] },
    timeoutMs: 30_000,
  });
  try {
    const chart = new Uint8Array(await (await fetch(chartUrl)).arrayBuffer());
    const chartLength = chart.length;
    if (!chartLength) throw new Error('The chart asset is empty');
    const baseRequest = {
      template: '#let input = json("/input.json")\n#set text(font: "Libertinus Serif")\n#set document(title: input.title)\n= #input.title',
      input: { title: 'Vite application build' },
      pdf: { standards: ['ua-1'] },
    } satisfies PdfRequest;
    // The first compile carries a real asset, so the transfer path runs through a real Worker. The client
    // copies the asset once and transfers that copy; the buffer in `chart` stays usable here.
    const result = await compiler.compile({
      ...baseRequest,
      template: baseRequest.template + '\n#image("chart.svg", alt: "A blue bar representing the vite chart asset.")',
      assets: { 'chart.svg': chart },
    });
    if (chart.length !== chartLength) throw new Error('The caller asset buffer was detached by compile()');

    const controller = new AbortController();
    const cancelled = compiler.compile({
      ...baseRequest,
      template: '#set text(font: "Libertinus Serif")\n#for value in range(200000) [#value ]',
    }, { signal: controller.signal });
    setTimeout(() => controller.abort('browser smoke cancellation'), 0);
    try {
      await cancelled;
      throw new Error('Expected the active worker job to be cancelled');
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== 'ABORTED') throw error;
    }

    const recovered = await compiler.compile({
      ...baseRequest,
      input: { title: 'Worker replacement succeeded' },
    });
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
