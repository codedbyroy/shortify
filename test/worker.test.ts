import { createPagesEventContext, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import migration from '../migrations/0001_init.sql?raw';
import * as codes from '../src/codes';
import worker from '../src/index';
import { onRequest as shortHost } from '../pages/functions/[[path]]';

declare global {
  namespace Cloudflare {
    interface Env { DB: D1Database; ASSETS: Fetcher }
  }
}

const origin = 'https://brief.test';
const productionHome = 'https://brief-links-roy.leggeth069.workers.dev/';

async function session() {
  const response = await SELF.fetch(`${origin}/api/links`);
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(response.headers.get('Set-Cookie')).toContain('Secure');
  return cookie;
}

function create(cookie: string, body: unknown, ip = '203.0.113.10') {
  return SELF.fetch(`${origin}/api/links`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  for (const statement of migration.split(';').filter((part) => part.trim())) await env.DB.prepare(statement).run();
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM links'), env.DB.prepare('DELETE FROM rate_limits')]);
});

describe('short link lifecycle', () => {
  it('creates a link, shows a safe countdown, counts GET only, and keeps history private', async () => {
    const owner = await session();
    const other = await session();
    const destination = 'https://example.com/a?x=hello%20world&y=2#section';
    const created = await create(owner, { url: destination, alias: 'Hello' });
    expect(created.status).toBe(201);
    const { link } = await created.json<{ link: { code: string; url: string } }>();
    expect(link.code).toBe('hello');
    expect(link.url).toBe(`${origin}/hello`);

    const head = await SELF.fetch(link.url, { method: 'HEAD', redirect: 'manual' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Location')).toBeNull();
    expect(await head.text()).toBe('');
    const redirect = await SELF.fetch(`${origin}/HELLO`, { redirect: 'manual' });
    expect(redirect.status).toBe(200);
    expect(redirect.headers.get('Location')).toBeNull();
    expect(redirect.headers.get('Cache-Control')).toBe('no-store');
    expect(redirect.headers.get('X-Robots-Tag')).toBe('noindex');
    const html = await redirect.text();
    expect(html).toContain('Your link opens automatically after five seconds.');
    expect(html).toContain('/redirect.js');
    expect(html).toContain('href="https://example.com/a?x=hello%20world&amp;y=2#section"');
    expect(html).toContain('<noscript>');

    const history = await SELF.fetch(`${origin}/api/links`, { headers: { Cookie: owner } });
    expect(await history.json()).toMatchObject({ links: [{ code: 'hello', clicks: 1 }], totals: { links: 1, clicks: 1 } });
    const privateHistory = await SELF.fetch(`${origin}/api/links`, { headers: { Cookie: other } });
    expect(await privateHistory.json()).toMatchObject({ links: [], totals: { links: 0, clicks: 0 } });
    const forbidden = await SELF.fetch(`${origin}/api/links/hello`, { method: 'DELETE', headers: { Cookie: other, Origin: origin } });
    expect(forbidden.status).toBe(404);

    const removed = await SELF.fetch(`${origin}/api/links/hello`, { method: 'DELETE', headers: { Cookie: owner, Origin: origin } });
    expect(removed.status).toBe(200);
    const missing = await SELF.fetch(link.url);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('This link came');
  });

  it('generates distinct names and prevents conflicting aliases, including simultaneous creates', async () => {
    const owner = await session();
    const responses = await Promise.all([create(owner, { url: 'https://example.com/1', alias: 'hello' }), create(owner, { url: 'https://example.com/2', alias: 'HELLO' })]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const automatic = await create(owner, { url: 'https://example.com/3' });
    expect(automatic.status).toBe(201);
    const data = await automatic.json<{ link: { code: string } }>();
    expect(data.link.code).toMatch(/^[bdfghjklmnprstvz][aeiou][bdfghjklmnprstvz][aeiou][bdfghjklmnprstvz]$/);
  });

  it('accepts a four-letter word and preserves existing long codes and aliases', async () => {
    const owner = await session();
    const created = await create(owner, { url: 'https://example.com', alias: 'MOON' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ link: { code: 'moon' } });
    for (const code of ['deafbeef', 'my-campaign', 'sitemap', 'sitemap-xml', 'sitemap_xml']) {
      await env.DB.prepare('INSERT INTO links (code, destination, owner_hash) SELECT ?, ?, owner_hash FROM links WHERE code = ?').bind(code, 'https://example.com/legacy', 'moon').run();
      const head = await SELF.fetch(`${origin}/${code}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(await head.text()).toBe('');
      const response = await SELF.fetch(`${origin}/${code.toUpperCase()}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      const html = await response.text();
      expect(html).toContain('href="https://example.com/legacy"');
      expect(html).toContain('Your link opens automatically after five seconds.');
      expect(await env.DB.prepare('SELECT clicks FROM links WHERE code = ?').bind(code).first()).toEqual({ clicks: 1 });
    }
    for (const code of ['my-campaign', 'sitemap']) {
      const removed = await SELF.fetch(`${origin}/api/links/${code}`, { method: 'DELETE', headers: { Cookie: owner, Origin: origin } });
      expect(removed.status).toBe(200);
      expect((await SELF.fetch(`${origin}/${code}`)).status).toBe(404);
    }
  });

  it('escapes destinations in the countdown markup', async () => {
    const created = await create(await session(), { url: "https://example.com/a'/?q='test'&a=1", alias: 'safe' });
    const { link } = await created.json<{ link: { url: string } }>();
    const page = await SELF.fetch(link.url);
    const html = await page.text();
    expect(html).toContain('href="https://example.com/a&#39;/?q=%27test%27&amp;a=1"');
    expect(html).not.toContain("?q='test'");
  });
});

describe('short sharing hostname', () => {
  const share = 'https://share.test';
  function visit(path: string, method = 'GET') {
    const context = createPagesEventContext<PagesFunction<Cloudflare.Env>>({
      request: new Request(share + path, { method }), params: {}, data: {},
    });
    return shortHost({ ...context, env: { ...context.env, SHORTIFY: SELF } });
  }

  it('keeps one homepage, exposes the countdown assets and serves no management interface', async () => {
    for (const method of ['GET', 'HEAD']) {
      const home = await visit('/?next=elsewhere', method);
      expect(home.status).toBe(308);
      expect(home.headers.get('Location')).toBe(productionHome);
    }
    for (const [path, type] of [['/styles.css', 'css'], ['/redirect.js', 'javascript'], ['/favicon.svg', 'svg'], ['/robots.txt', 'text/plain']]) {
      const res = await visit(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain(type);
    }
    for (const path of ['/api/links', '/health', '/sitemap.xml', '/app.js', '/index.html']) {
      expect((await visit(path)).status).toBe(404);
    }
    expect((await visit('/api/links', 'POST')).status).toBe(405);
    expect((await visit('/api/links/moon', 'DELETE')).status).toBe(405);
  });

  it('shares old and new records through both hosts with the original owner and click totals', async () => {
    const cookie = await session();
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const destination = 'https://example.com/p?q=two%20words&x=2#part';
    const management = (path: string, method = 'GET', body?: string) =>
      worker.fetch(new Request(origin + path, { method, headers, body }), { ...env, SHORT_LINK_ORIGIN: share });
    // Pre-cutover owners can have longer legacy aliases than today's creation form accepts.
    await create(cookie, { url: destination, alias: 'oldly' });
    await env.DB.prepare("UPDATE links SET code = 'old-link_7' WHERE code = 'oldly'").run();
    const created = await management('/api/links', 'POST', JSON.stringify({ url: destination, alias: 'moon' }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ link: { url: share + '/moon' } });
    const history = await management('/api/links');
    expect(await history.json()).toMatchObject({ links: [{ url: share + '/moon' }, { url: share + '/old-link_7' }] });
    for (const path of ['/moon', '/old-link_7']) {
      const head = await visit(path, 'HEAD');
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      for (const response of [await visit(path), await SELF.fetch(origin + path)]) {
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(response.headers.get('Set-Cookie')).toBeNull();
        expect(await response.text()).toContain('href="https://example.com/p?q=two%20words&amp;x=2#part"');
      }
    }
    expect(await (await management('/api/links')).json()).toMatchObject({ totals: { links: 2, clicks: 4 } });
    expect((await management('/api/links', 'POST', JSON.stringify({ url: share + '/moon' }))).status).toBe(400);
    expect((await management('/api/links/old-link_7', 'DELETE')).status).toBe(200);
    expect((await visit('/old-link_7')).status).toBe(404);
    expect((await SELF.fetch(origin + '/old-link_7')).status).toBe(404);
  });
});

describe('search discovery', () => {
  it('serves XML containing only the fixed production homepage, even when links exist', async () => {
    const owner = await session();
    expect((await create(owner, { url: 'https://example.com/private', alias: 'hello' })).status).toBe(201);
    const response = await SELF.fetch(`${origin}/sitemap.xml?url=https://untrusted.test/`, { headers: { 'X-Forwarded-Host': 'untrusted.test' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const xml = await response.text();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\s*<url>\s*<loc>[^<]+<\/loc>\s*<\/url>\s*<\/urlset>\s*$/);
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual([productionHome]);
    expect(await env.DB.prepare('SELECT code, clicks FROM links').all()).toMatchObject({ results: [{ code: 'hello', clicks: 0 }] });
  });

  it('advertises the production sitemap and preserves the API crawl restriction', async () => {
    const response = await SELF.fetch(`${origin}/robots.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const lines = (await response.text()).trim().split('\n').filter(Boolean);
    expect(lines).toEqual(['User-agent: *', 'Disallow: /api/', `Sitemap: ${productionHome}sitemap.xml`]);
  });

  it.each(['/sitemap.xml', '/robots.txt'])('supports GET and bodyless HEAD for %s without a session', async (path) => {
    const get = await SELF.fetch(`${origin}${path}`);
    const head = await SELF.fetch(`${origin}${path}`, { method: 'HEAD' });
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(await get.text()).not.toBe('');
    expect(await head.text()).toBe('');
    for (const response of [get, head]) {
      expect(response.headers.get('Content-Type')).toBe(get.headers.get('Content-Type'));
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('Location')).toBeNull();
      expect(response.headers.get('X-Robots-Tag')).toBeNull();
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it.each(['/sitemap.xml', '/robots.txt'])('rejects unsupported methods on %s', async (path) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await SELF.fetch(`${origin}${path}`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(await response.json()).toEqual({ error: 'That action is not supported.' });
    }
  });

  it('does not turn similarly named or nested paths into discovery files', async () => {
    for (const path of ['/sitemap.xml/', '/sitemap.xml/extra', '/sitemap.xml.bak', '/robots.txt/']) {
      const response = await SELF.fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toContain('text/html');
    }
  });

  it('skips reserved names if a generator returns one', async () => {
    const owner = await session();
    const generator = vi.spyOn(codes, 'memorableCode').mockReturnValueOnce('sitemap').mockReturnValueOnce('index').mockReturnValueOnce('pavon');
    try {
      const response = await worker.fetch(new Request(`${origin}/api/links`, {
        method: 'POST',
        headers: { Cookie: owner, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      }), env);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ link: { code: 'pavon' } });
      expect(generator).toHaveBeenCalledTimes(3);
      expect(await env.DB.prepare('SELECT code FROM links').all()).toMatchObject({ results: [{ code: 'pavon' }] });
    } finally {
      generator.mockRestore();
    }
  });
});

describe('validation and request boundaries', () => {
  it.each(['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com/file', 'https://user:secret@example.com', 'https://brief.test/other', 'not-a-url'])('rejects unsafe or invalid destination %s', async (url) => {
    const response = await create(await session(), { url });
    expect(response.status).toBe(400);
  });

  it.each(['ab', 'abc', 'api', 'health', 'index', 'bad name', '<script>', 'a_b-c', 'launch', 'sitemap', 'SITEMAP', 'sitemap.xml', 'sitemap-xml', 'sitemap_xml'])('rejects invalid or reserved name %s', async (alias) => {
    expect((await create(await session(), { url: 'https://example.com', alias })).status).toBe(400);
  });

  it('rejects cross-origin writes, missing sessions, malformed JSON and oversized bodies', async () => {
    const cookie = await session();
    const crossOrigin = await SELF.fetch(`${origin}/api/links`, { method: 'POST', headers: { Origin: 'https://evil.test', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    expect(crossOrigin.status).toBe(403);
    const noSession = await create('', { url: 'https://example.com' });
    expect(noSession.status).toBe(401);
    for (const [body, expected] of [['{', 400], ['x'.repeat(9000), 413]] as const) {
      const response = await SELF.fetch(`${origin}/api/links`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(expected);
    }
  });

  it('limits new links by IP across browser sessions', async () => {
    const owner = await session();
    const second = await session();
    const window = Math.floor(Date.now() / 1000 / 3600);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`brief:${window}:203.0.113.99`));
    const bucket = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO rate_limits VALUES (?, 29, ?)').bind(bucket, (window + 1) * 3600).run();
    expect((await create(owner, { url: 'https://example.com' }, '203.0.113.99')).status).toBe(201);
    const limited = await create(second, { url: 'https://example.com' }, '203.0.113.99');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('serves the two-color interface, applies security headers and checks the database', async () => {
    const home = await SELF.fetch(origin);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('<h1 id="hero-title">URL shortener.');
    expect(home.headers.get('X-Robots-Tag')).toBeNull();
    expect(home.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const css = await SELF.fetch(`${origin}/styles.css`);
    expect(css.status).toBe(200);
    const colors = new Set((await css.text()).match(/#[a-f\d]{6}\b/gi)?.map((color) => color.toUpperCase()));
    expect([...colors].sort()).toEqual(['#142B43', '#FFFFFF']);
    const script = await SELF.fetch(`${origin}/redirect.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toContain('javascript');
    const health = await SELF.fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });
});
