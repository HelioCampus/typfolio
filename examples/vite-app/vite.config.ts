import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  worker: { format: 'es' },
  build: {
    // Emit every ?url asset as a file: Vite would inline the 150-byte chart.svg as a data URL and trim its trailing newline.
    assetsInlineLimit: 0,
    outDir: fileURLToPath(new URL('../../.build/vite-app', import.meta.url)),
    emptyOutDir: true,
  },
});
