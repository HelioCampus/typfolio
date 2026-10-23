import type { ReactNode } from 'react';
import { createRootRoute, HeadContent, Navigate, Outlet, Scripts } from '@tanstack/react-router';
import stylesUrl from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'theme-color', content: '#0b0b12' },
      { name: 'description', content: 'Live text layout and worker batch PDF generation, powered by Pretext and Typfolio in your browser.' },
      { title: 'Typfolio · Browser PDF demos' },
    ],
    links: [{ rel: 'stylesheet', href: stylesUrl }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: () => <Navigate to="/" replace />,
});

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
