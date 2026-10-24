// The Web Worker side of the paramdoc engine: `init` creates the runtime from the exported document and its
// fonts (the font programs are compressed once here), `fill` renders one document and transfers the PDF back.
// The runtime is the experiment's own, imported from the repository; nothing here comes from a package.
import { Runtime } from '../../../../experiments/paramdoc/ts/runtime.ts';

type Request = { type: 'init'; doc: Uint8Array; fonts: Uint8Array[] } | { type: 'fill'; data: unknown };
type Reply = { type: 'ready' } | { type: 'done'; pdf: Uint8Array } | { type: 'error'; message: string };

const scope = self as unknown as {
  postMessage(reply: Reply, options?: { transfer: Transferable[] }): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<Request>) => void): void;
};

let runtime: Runtime | undefined;

async function handle(request: Request): Promise<void> {
  try {
    if (request.type === 'init') {
      runtime = await Runtime.create(request.doc, request.fonts);
      scope.postMessage({ type: 'ready' });
    } else {
      if (!runtime) throw new Error('The worker has no document yet');
      const { pdf } = await runtime.fill(request.data);
      scope.postMessage({ type: 'done', pdf }, { transfer: [pdf.buffer as ArrayBuffer] });
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

scope.addEventListener('message', event => { void handle(event.data); });
