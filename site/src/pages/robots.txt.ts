import type { APIRoute } from 'astro';

// Google may index the content; the editor, admin and API are private, and the game screen
// has no editorial content (AdSense policy), so it is not offered for indexing either.
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('sitemap-index.xml', site).href;
  return new Response(
    ['User-agent: *', 'Disallow: /keystatic', 'Disallow: /admin', 'Disallow: /api/', 'Disallow: /jugar', '', `Sitemap: ${sitemap}`, ''].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
};
