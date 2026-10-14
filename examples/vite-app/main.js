import { createWorkerClient } from '@typfolio/workers';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import fontUrl from '../../fixtures/fonts/LibertinusSerif-Regular.otf?url';

const status = document.querySelector('#status');

async function bytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

try {
  const compiler = createWorkerClient({
    compiler: { wasm: wasmUrl, fonts: [await bytes(fontUrl)] },
    timeoutMs: 30_000,
  });
  try {
    const baseRequest = {
      template: '#let input = json("/input.json")\n#set text(font: "Libertinus Serif")\n#set document(title: input.title)\n= #input.title',
      input: { title: 'Vite application build' },
      pdf: { standards: ['ua-1'] },
    };
    const result = await compiler.compile(baseRequest);

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
      if (error?.code !== 'ABORTED') throw error;
    }

    const recovered = await compiler.compile({
      ...baseRequest,
      input: { title: 'Worker replacement succeeded' },
    });
    if (recovered.metadata.title !== 'Worker replacement succeeded') {
      throw new Error('Replacement worker returned the wrong document');
    }
    status.textContent = 'Compiled ' + result.bytes.length + ' PDF bytes, hard-cancelled an active job, and recovered.';
    status.dataset.status = 'passed';
  } finally {
    await compiler.dispose();
  }
} catch (error) {
  status.textContent = String(error.stack ?? error);
  status.dataset.status = 'failed';
}
