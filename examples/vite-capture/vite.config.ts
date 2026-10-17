import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `--mode svg` bundles an app without the DOM adapter; `--mode dom` bundles one with it.
export default defineConfig(({ command, mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // `npm run dev:capture` serves index.html, the manual browser smoke page.
  server: { host: '127.0.0.1', port: 4191 },
  build: {
    outDir: fileURLToPath(new URL(`../../.build/vite-capture-${mode}`, import.meta.url)),
    emptyOutDir: true,
    // Only a build has a mode-named entry; the dev server serves index.html (the smoke page).
    rollupOptions: command === 'build' ? {
      input: fileURLToPath(new URL(`${mode}.ts`, import.meta.url)),
      output: { entryFileNames: 'entry.js' },
    } : undefined,
  },
}));
