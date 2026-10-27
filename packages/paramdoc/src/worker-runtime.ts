// The worker side: `open` creates the runtime once (the document parsed, the fonts compressed), every `fill`
// writes one PDF and transfers it back. Installed on the worker's global scope by `./worker.js`; the tests
// install it on an in-process scope instead.
import { ParamdocError, messageOf } from './errors.js';
import { createRuntime, type ParamdocRuntime } from './runtime-api.js';
import { decodeHostMessage, protocolVersion, type SerializedError, type WorkerMessage } from './protocol.js';

export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerMessage, transfer?: readonly Transferable[]): void;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof ParamdocError) return { code: error.code, message: error.message };
  return { code: 'worker', message: messageOf(error) };
}

/** A view that owns its whole buffer can be transferred as it is; any other is copied first. */
function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
}

export function installParamdocWorker(scope: WorkerScope): void {
  let runtime: ParamdocRuntime | undefined;
  let opening: Promise<void> | undefined;

  scope.addEventListener('message', event => {
    let id: number | undefined;
    try {
      const message = decodeHostMessage(event.data);
      if (message.type === 'open') {
        if (opening || runtime) throw new ParamdocError('worker', 'The paramdoc worker already has a document');
        opening = createRuntime({ document: message.document, fonts: message.fonts, images: message.images }).then(created => {
          runtime = created;
          scope.postMessage({ protocol: protocolVersion, type: 'ready' });
        }).catch(error => {
          scope.postMessage({ protocol: protocolVersion, type: 'failure', error: serializeError(error) });
        });
        return;
      }
      id = message.id;
      if (!runtime) throw new ParamdocError('worker', 'The paramdoc worker has no document yet');
      void runtime.fill(message.data).then(result => {
        const pdf = transferable(result.pdf);
        scope.postMessage({ protocol: protocolVersion, type: 'result', id: message.id, pdf, pages: result.pages }, [pdf.buffer]);
      }).catch(error => {
        scope.postMessage({ protocol: protocolVersion, type: 'failure', id: message.id, error: serializeError(error) });
      });
    } catch (error) {
      scope.postMessage({ protocol: protocolVersion, type: 'failure', id, error: serializeError(error) });
    }
  });
}
