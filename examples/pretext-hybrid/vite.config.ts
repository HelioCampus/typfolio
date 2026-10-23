import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/pretext-hybrid', import.meta.url)),
  plugins: [
    tanstackStart({
      spa: {
        enabled: true,
        maskPath: '/ascii',
        prerender: { outputPath: '/_shell.html' },
      },
      // Keep the homepage as real HTML; browser-only demos use the separate SPA shell.
      prerender: { autoStaticPathsDiscovery: false, crawlLinks: false },
      pages: [{ path: '/', prerender: { enabled: true } }],
    }),
    react(),
  ],
  server: {
    host: '127.0.0.1',
    port: 4190,
  },
  build: {
    outDir: fileURLToPath(new URL('../../.build/pretext-hybrid', import.meta.url)),
    emptyOutDir: true,
  },
});
