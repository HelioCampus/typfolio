import { createFileRoute } from '@tanstack/react-router';
import PerformancePage from '../pages/PerformancePage.tsx';

export const Route = createFileRoute('/performance')({
  ssr: false,
  component: PerformancePage,
});
