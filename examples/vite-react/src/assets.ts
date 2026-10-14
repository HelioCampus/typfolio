import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import fontUrl from '../../../fixtures/fonts/LibertinusSerif-Regular.otf?url';

let fontBytesPromise: Promise<Uint8Array> | undefined;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export { wasmUrl };

export function loadFontBytes(): Promise<Uint8Array> {
  fontBytesPromise ??= fetchBytes(fontUrl).catch(error => {
    fontBytesPromise = undefined;
    throw error;
  });
  return fontBytesPromise;
}
