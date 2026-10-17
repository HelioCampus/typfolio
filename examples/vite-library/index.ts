import { createCompiler } from '@typfolio/core';

async function loadBytes(url: string | URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(url) + ': HTTP ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

export interface HostedCompilerOptions {
  /** Where `typfolio/compiler_bg.wasm` is hosted; defaults to the directory of this module. */
  baseUrl?: string | URL;
  fontUrls: readonly (string | URL)[];
}

export async function createHostedCompiler(options: HostedCompilerOptions) {
  const baseUrl = options.baseUrl ?? new URL('.', import.meta.url);
  const fonts = await Promise.all(options.fontUrls.map(loadBytes));
  return createCompiler({
    wasm: new URL('typfolio/compiler_bg.wasm', baseUrl),
    fonts,
  });
}

export { capabilities, pdfStandards, TypstPdfError } from '@typfolio/core';
