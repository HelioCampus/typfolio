import { createFileRoute } from '@tanstack/react-router';
import AsciiPage from '../pages/AsciiPage.tsx';

export const Route = createFileRoute('/')({
  ssr: false,
  component: AsciiPage,
});
