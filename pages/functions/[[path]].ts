import { ALIAS_PATH, PRODUCTION_HOME } from '../../src/site';

export const onRequest: PagesFunction<{ SHORTIFY: Fetcher }> = ({ request, env }) => {
  const { pathname, search } = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (pathname === '/') return Response.redirect(PRODUCTION_HOME, 308);

  const asset = ['/redirect.js', '/styles.css', '/favicon.svg', '/robots.txt'].includes(pathname);
  if (!asset && (!ALIAS_PATH.test(pathname) || pathname === '/health')) {
    return new Response(null, { status: 404 });
  }
  // Public reads need no credentials. The existing Worker handles aliases and counts.
  return env.SHORTIFY.fetch(new URL(pathname + search, PRODUCTION_HOME).href, { method: request.method });
};
