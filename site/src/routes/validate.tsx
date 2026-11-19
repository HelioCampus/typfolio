import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import ValidatePage from '../pages/ValidatePage.tsx';

export const Route = createFileRoute('/validate')({
  ssr: false,
  head: () => pageHead({
    path: '/validate',
    title: 'Validate PDF/UA and PDF/A in your browser with veraPDF · Typfolio',
    description: 'Drop a PDF and veraPDF, compiled to WebAssembly, checks it against PDF/UA or PDF/A on the page. No Java, no upload: your files stay in your browser.',
  }),
  component: ValidatePage,
});
