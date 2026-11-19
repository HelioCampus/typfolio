import { createFileRoute } from '@tanstack/react-router';
import EditorialPage from '../pages/EditorialPage.tsx';

export const Route = createFileRoute('/editorial')({
  ssr: false,
  component: EditorialPage,
});
