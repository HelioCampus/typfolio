import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/pretext-hybrid', import.meta.url)),
  plugins: [
    tanstackStart({
      // Each URL gets static HTML with its own hydration state. Demo components
      // have ssr: false, so only their loading shell is rendered during the build.
      prerender: { enabled: true, autoStaticPathsDiscovery: false, crawlLinks: false },
      pages: ['/', '/ascii', '/editorial', '/performance'].map(path => ({
        path,
        prerender: { enabled: true, outputPath: path === '/' ? '/index.html' : `${path}.html` },
      })),
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
