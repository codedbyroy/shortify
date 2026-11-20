import { memorableCode } from './codes';
import { ALIAS_PATH, PRODUCTION_HOME } from './site';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SHORT_LINK_ORIGIN?: string;
}

interface Link {
  code: string;
  destination: string;
  created_at: string;
  clicks: number;
}

const COOKIE = 'brief_owner';
const MAX_BODY_BYTES = 8192;
const RESERVED = new Set(['api', 'assets', 'health', 'robots', 'sitemap', 'favicon', 'index', 'styles', 'app']);
const HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function randomToken(size: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (n) => n.toString(16).padStart(2, '0')).join('');
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}

function ownerToken(request: Request) {
  const token = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function requireOwner(request: Request) {
  const token = ownerToken(request);
  if (!token) throw new HttpError(401, 'Refresh the page to start your link history.');
  return hash(token);
}

function requireSameOrigin(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new HttpError(403, 'Open this page again before making changes.');
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send link details as JSON.');
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'That request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Enter a destination URL.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'That request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Those link details could not be read.');
  }
}

function destinationUrl(value: unknown, origin: string, shareOrigin: string) {
  if (typeof value !== 'string' || value.trim().length > 4096) {
    throw new HttpError(400, 'Enter a URL with 4,096 characters or fewer.');
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'Enter a complete URL starting with https:// or http://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new HttpError(400, 'Use an http:// or https:// URL without a username or password.');
  }
  if (url.origin === origin || url.origin === shareOrigin) throw new HttpError(400, 'Enter the original destination, rather than another brief link.');
  return url.href;
}

function aliasCode(value: unknown) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{4,5}$/.test(value)) {
    throw new HttpError(400, 'Use 4–5 letters or numbers for your custom word.');
  }
  const code = value.toLowerCase();
  if (RESERVED.has(code)) throw new HttpError(400, 'That name is reserved. Try another.');
  return code;
}

async function rateLimit(request: Request, env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 3600);
  // Cloudflare supplies this header in production. No raw IP addresses are stored.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const bucket = await hash(`brief:${window}:${ip}`);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 RETURNING hits',
  ).bind(bucket, (window + 1) * 3600).first<{ hits: number }>();
  if (!row || row.hits > 30) {
    throw new HttpError(429, 'You’ve reached 30 new links this hour. Please try again next hour.', { 'Retry-After': String((window + 1) * 3600 - now) });
  }
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
}

function present(link: Link, origin: string) {
  return { code: link.code, url: `${origin}/${link.code}`, destination: link.destination, createdAt: link.created_at, clicks: link.clicks };
}

async function api(request: Request, env: Env, url: URL) {
  const shareBase = env.SHORT_LINK_ORIGIN && URL.canParse(env.SHORT_LINK_ORIGIN) ? new URL(env.SHORT_LINK_ORIGIN) : null;
  const shareOrigin = shareBase?.protocol === 'https:' && shareBase.href === shareBase.origin + '/' ? shareBase.origin : url.origin;
  if (url.pathname === '/api/links' && request.method === 'GET') {
    const existing = ownerToken(request);
    const token = existing ?? randomToken(32);
    const owner = await hash(token);
    const links = await env.DB.prepare('SELECT code, destination, created_at, clicks FROM links WHERE owner_hash = ? ORDER BY id DESC LIMIT 100').bind(owner).all<Link>();
    const totals = await env.DB.prepare('SELECT count(*) AS links, coalesce(sum(clicks), 0) AS clicks FROM links WHERE owner_hash = ?').bind(owner).first();
    const response = json({ links: links.results.map((link) => present(link, shareOrigin)), totals });
    if (!existing) {
      response.headers.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}`);
    }
    return response;
  }

  if (url.pathname === '/api/links' && request.method === 'POST') {
    requireSameOrigin(request);
    const owner = await requireOwner(request);
    const data = await readJson(request);
    const destination = destinationUrl(data.url, url.origin, shareOrigin);
    const custom = aliasCode(data.alias);
    await rateLimit(request, env);
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = custom ?? memorableCode();
      if (RESERVED.has(code)) continue;
      // Only the code collision is ignored. Other database failures still fail the request.
      const link = await env.DB.prepare(
        'INSERT INTO links (code, destination, owner_hash) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING RETURNING code, destination, created_at, clicks',
      ).bind(code, destination, owner).first<Link>();
      if (link) return json({ link: present(link, shareOrigin) }, 201);
      if (custom) throw new HttpError(409, 'That custom name is taken. Try another.');
    }
    throw new HttpError(503, 'Could not reserve a link just now. Please try again.');
  }

  const match = url.pathname.match(/^\/api\/links\/([a-zA-Z0-9_-]{3,32})$/);
  if (match && request.method === 'DELETE') {
    requireSameOrigin(request);
    const owner = await requireOwner(request);
    const result = await env.DB.prepare('DELETE FROM links WHERE code = ? AND owner_hash = ? RETURNING code').bind(match[1], owner).first();
    if (!result) throw new HttpError(404, 'That link was not found in your history.');
    return json({ deleted: true });
  }
  if (url.pathname === '/api/links' || match) throw new HttpError(405, 'That action is not supported.');
  throw new HttpError(404, 'Page not found.');
}

function missingPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found · brief</title><link rel="stylesheet" href="/styles.css"></head><body><main class="missing"><a class="wordmark" href="/">brief<span aria-hidden="true">↗</span></a><p class="eyebrow">404 / LINK NOT FOUND</p><h1>This link came<br>up short.</h1><p>It may have been removed, or the address may be wrong.</p><a class="button" href="/">Create a new link <span aria-hidden="true">↗</span></a></main></body></html>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function redirectPage(destination: string) {
  const safeDestination = escapeHtml(destination);
  const hostname = escapeHtml(new URL(destination).hostname);
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#142B43">
    <title>A short pause · brief</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/styles.css">
    <script src="/redirect.js" defer></script>
  </head>
  <body class="redirect-page">
    <header class="site-header wrap"><a class="wordmark" href="/" aria-label="brief home">brief<span aria-hidden="true">↗</span></a><span class="header-note">A LITTLE PAUSE. THEN ONWARD.</span></header>
    <main class="redirect-main wrap" aria-labelledby="redirect-title">
      <section class="redirect-copy">
        <p class="eyebrow"><span class="square" aria-hidden="true"></span> YOU'RE ON YOUR WAY</p>
        <h1 id="redirect-title">A short pause.<br>Then you're <span class="underlined">there.</span></h1>
        <p class="hero-description">Your link opens automatically after five seconds.<br>A moment to see where you're headed.</p>
        <a class="text-button" href="/">Create your own short link ↗</a>
      </section>
      <section class="redirect-card" aria-label="Destination and countdown">
        <div class="card-heading"><span class="eyebrow">NEXT STOP</span><span aria-hidden="true">02 / ↗</span></div>
        <p class="destination-host">${hostname}</p>
        <p class="redirect-destination">${safeDestination}</p>
        <div class="countdown-panel" id="countdown-panel" hidden>
          <div class="countdown-row"><span class="countdown-number" id="countdown" role="timer" aria-label="Seconds remaining">5</span><span class="countdown-label" id="countdown-label">SECONDS<br>UNTIL YOU ARRIVE ↗</span></div>
          <progress class="countdown-progress" id="countdown-progress" max="5" value="0" aria-label="Time before opening destination"></progress>
          <p class="form-message" id="redirect-status" role="status">Opening the destination in 5 seconds.</p>
          <button class="button" type="button" id="pause-redirect">Stay here <span aria-hidden="true">Ⅱ</span></button>
        </div>
        <a class="button primary" id="continue-link" href="${safeDestination}" rel="noreferrer noopener">Continue to site <span aria-hidden="true">↗</span></a>
        <noscript><p class="field-hint">JavaScript is off. Use Continue to site to open your destination.</p></noscript>
      </section>
    </main>
    <footer class="site-footer wrap"><a class="wordmark" href="/">brief<span aria-hidden="true">↗</span></a><span>SHORT LINK. CLEAR DESTINATION.</span></footer>
  </body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return api(request, env, url);
  if (url.pathname === '/health') {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    await env.DB.prepare('SELECT 1 FROM links LIMIT 1').all();
    return json({ status: 'ok' });
  }
  // Match only the dotted discovery paths: legacy aliases such as /sitemap still resolve below.
  if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'That action is not supported.', { Allow: 'GET, HEAD' });
    const sitemap = url.pathname === '/sitemap.xml';
    return new Response(sitemap
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${PRODUCTION_HOME}</loc></url>\n</urlset>\n`
      : `User-agent: *\nDisallow: /api/\n\nSitemap: ${PRODUCTION_HOME}sitemap.xml\n`, {
      headers: { 'Content-Type': sitemap ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'That action is not supported.');
  if (url.pathname === '/' || ['/app.js', '/redirect.js', '/styles.css', '/favicon.svg'].includes(url.pathname)) {
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  }
  if (!ALIAS_PATH.test(url.pathname)) return missingPage();
  const code = url.pathname.slice(1);
  const link = request.method === 'HEAD'
    ? await env.DB.prepare('SELECT destination FROM links WHERE code = ?').bind(code).first<{ destination: string }>()
    : await env.DB.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ? RETURNING destination').bind(code).first<{ destination: string }>();
  if (!link) return missingPage();
  return redirectPage(link.destination);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) response = json({ error: error.message }, error.status, error.headers);
      else {
        // Do not log destinations, cookies or database error messages.
        console.error('Request failed', { method: request.method, api: new URL(request.url).pathname.startsWith('/api/') });
        response = json({ error: 'Something went wrong. Please try again shortly.' }, 500);
      }
    }
    const secured = new Response(request.method === 'HEAD' ? null : response.body, response);
    for (const [key, value] of Object.entries(HEADERS)) secured.headers.set(key, value);
    if (new URL(request.url).protocol === 'https:') secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return secured;
  },
} satisfies ExportedHandler<Env>;
