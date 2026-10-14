import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('../../.build/vite-app', import.meta.url)),
    emptyOutDir: true,
  },
});
