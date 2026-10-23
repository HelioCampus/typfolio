import { createFileRoute } from '@tanstack/react-router';
import HomePage from '../pages/HomePage.tsx';

export const Route = createFileRoute('/')({
  // Rendered to index.html at build time; no application server is deployed.
  ssr: true,
  component: HomePage,
});
