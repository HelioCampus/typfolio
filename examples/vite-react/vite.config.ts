import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4179,
  },
  build: {
    outDir: fileURLToPath(new URL('../../.build/vite-react', import.meta.url)),
    emptyOutDir: true,
  },
});
