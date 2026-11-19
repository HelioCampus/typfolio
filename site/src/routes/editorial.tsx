import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import EditorialPage from '../pages/EditorialPage.tsx';

export const Route = createFileRoute('/editorial')({
  ssr: false,
  head: () => pageHead({
    path: '/editorial',
    title: 'Editorial layout flowing around obstacles, as a PDF · Typfolio',
    description: 'Drag the orbs and watch three columns of text reflow around them. Pretext breaks the lines and Typst renders the page as a PDF, live in your browser.',
  }),
  component: EditorialPage,
});
