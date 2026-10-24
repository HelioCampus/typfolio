import { rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const dist = fileURLToPath(new URL('dist/', import.meta.url));

// dist/panel.js, with React and the panel's modules bundled in: a page shows the panel without React of its own.
// tsc writes the declarations first, and an unbundled copy of the panel's modules, which this removes.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  logLevel: 'warn',
  // React's production build: the panel's own React never shares a page's development checks.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'es2022',
    // Rolldown minifies (below): Vite's own pass would drop the licence comments.
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('src/panel.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'panel.js',
    },
    rolldownOptions: {
      // The page's own @typfolio/core, which dev-tools depends on.
      external: ['@typfolio/core'],
      // Fully minified, keeping the licence comments of what is bundled (React's, and the code it carries).
      output: { minify: true, comments: { legal: true, annotation: false, jsdoc: false } },
    },
  },
  plugins: [{
    name: 'remove-unbundled-panel',
    closeBundle: () => rm(dist + 'panel', { recursive: true, force: true }),
  }],
});
