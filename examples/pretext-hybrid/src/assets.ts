import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import regularUrl from '../../../fixtures/fonts/LibertinusSerif-Regular.otf?url';
import boldUrl from '../../../fixtures/fonts/LibertinusSerif-Bold.otf?url';
import italicUrl from '../../../fixtures/fonts/LibertinusSerif-Italic.otf?url';
import boldItalicUrl from '../../../fixtures/fonts/LibertinusSerif-BoldItalic.otf?url';

let wasmPromise: Promise<WebAssembly.Module> | undefined;

/** Share compiled code across realms; each compiler still owns its own WASM instance. */
export function loadWasm(): Promise<WebAssembly.Module> {
  // Concurrent worker fetches of this large cached response can fail in Chromium.
  // Fetch and compile once, then structured-clone the module into each worker.
  wasmPromise ??= WebAssembly.compileStreaming(fetch(wasmUrl).then(response => {
    if (!response.ok) throw new Error(`Could not fetch the compiler: HTTP ${response.status}`);
    return response;
  })).catch(error => {
    wasmPromise = undefined;
    throw error;
  });
  return wasmPromise;
}

/** The family name used by canvas font strings, CSS, and the Typst template. */
export const FONT_FAMILY = 'Libertinus Serif';

/** URLs of every face, in the order they are passed to the compilers. */
export type FontUrls = readonly string[];
export const fontUrls: FontUrls = [regularUrl, boldUrl, italicUrl, boldItalicUrl];

let fontsPromise: Promise<void> | undefined;

async function registerFace(url: string, weight: '400' | '700', style: 'normal' | 'italic'): Promise<void> {
  const face = new FontFace(FONT_FAMILY, `url("${url}")`, { weight, style });
  await face.load();
  document.fonts.add(face);
}

/**
 * Font parity: the browser (so pretext measures through canvas with them) and the Typst compilers
 * load the very same files, by URL. Resolves only after the browser can use all four faces, so it is
 * safe to call any pretext `prepare*` function afterwards.
 */
export function loadFonts(): Promise<void> {
  fontsPromise ??= (async () => {
    await Promise.all([
      registerFace(regularUrl, '400', 'normal'),
      registerFace(boldUrl, '700', 'normal'),
      registerFace(italicUrl, '400', 'italic'),
      registerFace(boldItalicUrl, '700', 'italic'),
    ]);
    await document.fonts.ready;
  })().catch(error => {
    fontsPromise = undefined;
    throw error;
  });
  return fontsPromise;
}
