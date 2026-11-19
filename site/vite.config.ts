import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';
import { prepareVerapdfDemo } from '../tools/prepare-verapdf-demo.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/site', import.meta.url)),
  plugins: [
    tanstackStart({
      // Each URL gets static HTML with its own hydration state. Demo components
      // have ssr: false, so only their loading shell is rendered during the build.
      prerender: { enabled: true, autoStaticPathsDiscovery: false, crawlLinks: false },
      pages: ['/', '/ascii', '/editorial', '/performance', '/inspect', '/validate'].map(path => ({
        path,
        prerender: { enabled: true, outputPath: path === '/' ? '/index.html' : `${path}.html` },
      })),
    }),
    react(),
    {
      // The veraPDF validator of the /validate page, staged into public/verapdf/ for the dev server and the build
      // alike, or cleared from it when it has not been built. See tools/prepare-verapdf-demo.ts.
      name: 'typfolio-verapdf-demo',
      buildStart() {
        prepareVerapdfDemo();
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4190,
  },
  build: {
    outDir: fileURLToPath(new URL('../.build/site', import.meta.url)),
    emptyOutDir: true,
  },
});
