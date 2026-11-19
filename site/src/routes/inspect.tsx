import { createFileRoute } from '@tanstack/react-router';
import InspectPage from '../pages/InspectPage.tsx';

export const Route = createFileRoute('/inspect')({
  ssr: false,
  component: InspectPage,
});
