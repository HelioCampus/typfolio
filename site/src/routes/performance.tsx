import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import PerformancePage from '../pages/PerformancePage.tsx';

export const Route = createFileRoute('/performance')({
  ssr: false,
  head: () => pageHead({
    path: '/performance',
    title: '1000 PDFs in the browser, on Web Workers · Typfolio',
    description: 'Generate a batch of 1000 tagged PDFs in your browser with Typst on Web Workers. Compare worker pool sizes, watch throughput and open every result. Nothing is uploaded.',
  }),
  component: PerformancePage,
});
