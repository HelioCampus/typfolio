import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import InspectPage from '../pages/InspectPage.tsx';

export const Route = createFileRoute('/inspect')({
  ssr: false,
  head: () => pageHead({
    path: '/inspect',
    title: 'Inspect a tagged PDF: tags, warnings and veraPDF verdict · Typfolio',
    description: 'Compile a report in your browser and read its tag tree as a screen reader gets it. Remove structure and see what notices: the compiler, the warnings, or veraPDF.',
  }),
  component: InspectPage,
});
