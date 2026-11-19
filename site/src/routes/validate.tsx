import { createFileRoute } from '@tanstack/react-router';
import ValidatePage from '../pages/ValidatePage.tsx';

export const Route = createFileRoute('/validate')({
  ssr: false,
  component: ValidatePage,
});
