import type { ReactNode } from 'react';
import { createRootRoute, HeadContent, Navigate, Outlet, Scripts } from '@tanstack/react-router';
import stylesUrl from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'theme-color', content: '#0b0b12' },
      { name: 'description', content: 'Compile a Typst template and typed data into a tagged PDF in your browser, with no PDF server. Explore live layout and worker batch demos with Typfolio.' },
      { title: 'Typfolio · Compile PDFs in your browser' },
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
