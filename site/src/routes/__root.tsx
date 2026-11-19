import type { ReactNode } from 'react';
import { createRootRoute, HeadContent, Navigate, Outlet, Scripts } from '@tanstack/react-router';
import { siteUrl } from '../seo.ts';
import stylesUrl from '../styles.css?url';

export const Route = createRootRoute({
  // The document shell is generated during the static build, alongside the homepage.
  ssr: true,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'theme-color', content: '#0b0b12' },
      { name: 'color-scheme', content: 'dark' },
      // Titles, descriptions and canonical URLs are set per route, with pageHead.
      { property: 'og:site_name', content: 'Typfolio' },
      { property: 'og:type', content: 'website' },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:image', content: `${siteUrl}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: 'Typfolio: compile PDFs in your browser. Accessible, typed and fast.' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: `${siteUrl}/og.png` },
    ],
    links: [
      { rel: 'stylesheet', href: stylesUrl },
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
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
