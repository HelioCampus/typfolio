// Head tags for one page. Every route calls this, so each prerendered entry page carries its own title, description
// and canonical URL even though the demos themselves render only in the browser.
export const siteUrl = 'https://typfolio.kerematam.com';

interface PageHead {
  /** The route path, '/' for the homepage. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

export function pageHead({ path, title, description }: PageHead) {
  const url = path === '/' ? `${siteUrl}/` : `${siteUrl}${path}`;
  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
    links: [{ rel: 'canonical', href: url }],
  };
}
