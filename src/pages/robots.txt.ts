
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {

  const sitemapUrl = site ? new URL('sitemap-index.xml', site).toString() : '/sitemap-index.xml';

  const body = `User-agent: *
Disallow:

Sitemap: ${sitemapUrl}
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
