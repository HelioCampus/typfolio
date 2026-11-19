import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import HomePage from '../pages/HomePage.tsx';

export const Route = createFileRoute('/')({
  // Rendered to index.html at build time; no application server is deployed.
  ssr: true,
  head: () => pageHead({
    path: '/',
    title: 'Typfolio · Compile PDFs in your browser',
    description: 'Compile a Typst template and typed data into a tagged, accessible PDF in your browser, with no PDF server. Typst runs as WASM, with typed inputs and tools that check the result.',
  }),
  component: HomePage,
});
