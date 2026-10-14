import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const entry = fileURLToPath(new URL('index.js', import.meta.url));
const output = fileURLToPath(new URL('../../.build/vite-library', import.meta.url));
const wasm = fileURLToPath(new URL('../../packages/wasm/generated/compiler_bg.wasm', import.meta.url));

export default defineConfig({
  plugins: [{
    name: 'emit-typfolio-wasm',
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'typfolio/compiler_bg.wasm',
        source: await readFile(wasm),
      });
    },
  }],
  build: {
    outDir: output,
    emptyOutDir: true,
    lib: {
      entry,
      formats: ['es'],
      fileName: 'typfolio-adapter',
    },
  },
});
