import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import regularUrl from '../../../fixtures/fonts/LibertinusSerif-Regular.otf?url';
import boldUrl from '../../../fixtures/fonts/LibertinusSerif-Bold.otf?url';
import italicUrl from '../../../fixtures/fonts/LibertinusSerif-Italic.otf?url';
import boldItalicUrl from '../../../fixtures/fonts/LibertinusSerif-BoldItalic.otf?url';

export { wasmUrl };

/** The family name used by canvas font strings, CSS, and the Typst template. */
export const FONT_FAMILY = 'Libertinus Serif';

export interface FontBytes {
  readonly regular: Uint8Array;
  readonly bold: Uint8Array;
  readonly italic: Uint8Array;
  readonly boldItalic: Uint8Array;
}

/** All faces in the order they are passed to `createCompiler`. */
export function fontList(fonts: FontBytes): Uint8Array[] {
  return [fonts.regular, fonts.bold, fonts.italic, fonts.boldItalic];
}

let fontsPromise: Promise<FontBytes> | undefined;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function registerFace(bytes: Uint8Array, weight: '400' | '700', style: 'normal' | 'italic'): Promise<void> {
  // FontFace copies the data it is given, so these exact bytes can still be
  // handed to the Typst compiler afterwards.
  const face = new FontFace(FONT_FAMILY, bytes.slice().buffer, { weight, style });
  await face.load();
  document.fonts.add(face);
}

/**
 * Font parity: the very same bytes are registered with the browser (so pretext
 * measures through canvas with them) and returned for `createCompiler`.
 * Resolves only after the browser can use all four faces, so it is safe to call
 * any pretext `prepare*` function afterwards.
 */
export function loadFonts(): Promise<FontBytes> {
  fontsPromise ??= (async () => {
    const [regular, bold, italic, boldItalic] = await Promise.all(
      [regularUrl, boldUrl, italicUrl, boldItalicUrl].map(fetchBytes),
    );
    await Promise.all([
      registerFace(regular!, '400', 'normal'),
      registerFace(bold!, '700', 'normal'),
      registerFace(italic!, '400', 'italic'),
      registerFace(boldItalic!, '700', 'italic'),
    ]);
    await document.fonts.ready;
    return { regular: regular!, bold: bold!, italic: italic!, boldItalic: boldItalic! };
  })().catch(error => {
    fontsPromise = undefined;
    throw error;
  });
  return fontsPromise;
}
