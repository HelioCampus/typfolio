import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import regularUrl from '../../../fixtures/fonts/LibertinusSerif-Regular.otf?url';
import boldUrl from '../../../fixtures/fonts/LibertinusSerif-Bold.otf?url';
import italicUrl from '../../../fixtures/fonts/LibertinusSerif-Italic.otf?url';
import boldItalicUrl from '../../../fixtures/fonts/LibertinusSerif-BoldItalic.otf?url';

export { wasmUrl };

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
