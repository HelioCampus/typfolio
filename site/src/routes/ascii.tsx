import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../seo.ts';
import AsciiPage from '../pages/AsciiPage.tsx';

export const Route = createFileRoute('/ascii')({
  ssr: false,
  head: () => pageHead({
    path: '/ascii',
    title: 'Variable typographic ASCII as a live PDF · Typfolio',
    description: 'Proportional ASCII art laid out by pretext and compiled by Typst into a fresh PDF as it animates, entirely in your browser.',
  }),
  component: AsciiPage,
});
