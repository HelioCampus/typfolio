import { createCompiler } from '@typfolio/core';

async function loadBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(url) + ': HTTP ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

export async function createHostedCompiler(options) {
  const baseUrl = options.baseUrl ?? new URL('.', import.meta.url);
  const fonts = await Promise.all(options.fontUrls.map(loadBytes));
  return createCompiler({
    wasm: new URL('typfolio/compiler_bg.wasm', baseUrl),
    fonts,
  });
}

export { capabilities, pdfStandards, TypstPdfError } from '@typfolio/core';
