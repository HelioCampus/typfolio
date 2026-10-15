import { createCompiler, TypstPdfError } from '@typfolio/core';
import { decodeHostMessage, protocolVersion, type RuntimeMessage, type SerializedError } from './protocol.js';

export interface WorkerRuntimeScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: RuntimeMessage, transfer?: readonly Transferable[]): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof TypstPdfError) {
    return { code: error.code, message: error.message, diagnostics: error.diagnostics };
  }
  return { code: 'WORKER', message: errorMessage(error), diagnostics: [] };
}

function transferable(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

export function installWorkerRuntime(scope: WorkerRuntimeScope): void {
  let compiler: Awaited<ReturnType<typeof createCompiler>> | undefined;
  let initializing: Promise<void> | undefined;

  scope.addEventListener('message', event => {
    let requestId: number | undefined;
    try {
      const message = decodeHostMessage(event.data);
      if (message.type === 'initialize') {
        if (initializing || compiler) throw new Error('Typfolio worker is already initialized');
        // The request is owned by this worker (a transferred snapshot), so core need not copy its assets again.
        initializing = createCompiler({ ...message.compiler, copyAssets: false }).then(value => {
          compiler = value;
          scope.postMessage({ protocol: protocolVersion, type: 'ready' });
        }).catch(error => {
          scope.postMessage({ protocol: protocolVersion, type: 'failure', error: serializeError(error) });
        });
        return;
      }

      requestId = message.id;
      if (!compiler) throw new Error('Typfolio worker is not ready');
      void compiler.compile(message.request).then(result => {
        const bytes = transferable(result.bytes);
        scope.postMessage({
          protocol: protocolVersion,
          type: 'result',
          id: message.id,
          result: { ...result, bytes },
        }, [bytes.buffer]);
      }).catch(error => {
        scope.postMessage({
          protocol: protocolVersion,
          type: 'failure',
          id: message.id,
          error: serializeError(error),
        });
      });
    } catch (error) {
      scope.postMessage({
        protocol: protocolVersion,
        type: 'failure',
        id: requestId,
        error: serializeError(error),
      });
    }
  });
}
