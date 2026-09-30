import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { LedgerError, WireError } from '../platform/ledger/index.js';
import { buildServer } from './server.js';
import { contentSecurityPolicy, errorHandler, externalScripts, inlineScriptHashes, limits } from './hardening.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The browser's side of the bargain, and the ceiling on knocking.
 *
 * Every response — a page, a JSON answer, a 404 — carries the same headers,
 * and the policy names each inline script by hash, so an edited page is
 * allowed and an injected script is not.
 */
let app: FastifyInstance;
let ctx: Ctx;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

beforeAll(async () => {
  await truncateAll();
  ctx = {
    clock: new VirtualClock(at('11:40')),
    payments: new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier: new FakeNotifier(),
  };
  app = await buildServer(ctx, { dev: true });
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('security headers', () => {
  it('are on a page, on JSON, and on a miss alike', async () => {
    for (const url of ['/idesh', '/v1/idesh/listings', '/no-such-thing']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toContain("default-src 'self'");
      expect(res.headers['content-security-policy'], url).toContain("frame-ancestors 'none'");
      expect(res.headers['strict-transport-security'], url).toContain('max-age=31536000');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['referrer-policy'], url).toBe('strict-origin-when-cross-origin');
    }
  });

  it('name every inline script on disk by its hash, and nothing else', () => {
    const hashes = inlineScriptHashes(webRoot);
    // One per page with an inline script — the launcher, dine, idesh, supplier, ops, kds…
    expect(hashes.length).toBeGreaterThanOrEqual(5);
    expect(hashes.every((h) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(h))).toBe(true);
    const csp = contentSecurityPolicy(hashes);
    expect(csp).not.toContain("'unsafe-inline' https://cdnjs");
    expect(csp).toMatch(/script-src 'self' 'sha256-/);
    expect(csp).toContain("connect-src 'self'");
  });

  it('names the exact CDN file the pages load, never the CDN host', () => {
    // The map pages load MapLibre from cdnjs; the policy carries that one
    // address, not the host — a host allowed would let any library it serves
    // run here, an old template engine a slipped-through scrap could reach.
    const files = externalScripts(webRoot);
    expect(files).toContain('https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.24.0/maplibre-gl.min.js');
    const csp = contentSecurityPolicy(inlineScriptHashes(webRoot), files);
    const scriptSrc = /script-src([^;]*)/.exec(csp)![1]!;
    expect(scriptSrc).toContain('/maplibre-gl.min.js');
    // The bare host, allowed alone, is what must not be there.
    expect(scriptSrc).not.toMatch(/https:\/\/cdnjs\.cloudflare\.com(\s|$)/);
  });

  it('names every script a page loads from another server, so none is dropped from the policy unseen', () => {
    // The policy is read off the pages, and an address it could not carry
    // whole — a query after it, an odd character in it — is left out, so that
    // page's script would not load. A page under test runs no policy: the map
    // would break in a real browser and nowhere here. Read loosely, every
    // such tag is one the policy names.
    const named = externalScripts(webRoot);
    for (const [page, html] of pages()) {
      for (const tag of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const src = tag[1] ?? tag[2] ?? tag[3] ?? '';
        if (src.startsWith('/') && !src.startsWith('//')) continue;
        expect(named, `${page}: ${src}`).toContain(src);
      }
    }
  });

  it('holds what a page loads from another server to the hash of the file', () => {
    // The policy pins the address, not the bytes: a CDN serving other bytes
    // under it one day — a library swapped, the CDN itself broken into —
    // would run them beside the dashboard's session. With the file's hash on
    // the tag the browser refuses bytes that differ, and asks for them the
    // way a hash can be checked (crossorigin).
    let held = 0;
    for (const [page, html] of pages()) {
      const tags = [
        ...html.matchAll(/<script\b[^>]*?\bsrc="(?:https?:)?\/\/[^"]*"[^>]*>/gi),
        ...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*?\bhref="(?:https?:)?\/\/[^"]*"[^>]*>/gi),
      ].map((m) => m[0]);
      for (const tag of tags) {
        expect(tag, page).toMatch(/\bintegrity="sha(256|384|512)-[A-Za-z0-9+/]+={0,2}"/);
        expect(tag, page).toMatch(/\bcrossorigin="anonymous"/);
        held += 1;
      }
    }
    // MapLibre's script and stylesheet, on each of the two map pages.
    expect(held).toBeGreaterThanOrEqual(4);
  });
});

describe('what somebody is told when a request breaks', () => {
  /** Whatever Postgres, the code or the provider said, none of it is in the answer. */
  const OURS = /uuid|bigint|syntax|22P02|trim|function|sk_live|API key|req_7Hq|srv|invalid input/i;
  const generalWords = { code: 'INTERNAL', message_mn: 'Алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.', message_en: 'internal error' };

  it('is never what Postgres, the code or the payment provider said', async () => {
    // The handler alone, and a route for each way something of ours breaks.
    const server = Fastify();
    server.setErrorHandler(errorHandler);
    server.get('/postgres', async () => getPool().query("SELECT 'not-an-id'::uuid"));
    server.post('/code', async (request) => (request.body as { login: string }).login.trim());
    server.get('/provider', async () => {
      throw new WireError(401, 'invalid_api_key', 'req_7Hq', 'Invalid API key provided: sk_live_****abcd');
    });
    server.get('/ours', async () => {
      throw new LedgerError('NOT_FOUND', 'no such top-up');
    });
    try {
      for (const probe of [
        { method: 'GET' as const, url: '/postgres' },
        { method: 'POST' as const, url: '/code', payload: { login: 42 } },
        // Wire's 401 is Wire refusing our key, not the caller signed out: as itself it would sign a website visitor out.
        { method: 'GET' as const, url: '/provider' },
      ]) {
        const res = await server.inject(probe);
        expect(res.statusCode, probe.url).toBe(500);
        expect(res.json(), probe.url).toEqual({ error: generalWords });
        expect(res.body, probe.url).not.toMatch(OURS);
      }
      // A refusal of ours by its name, as a route would have sent it.
      const ours = await server.inject({ method: 'GET', url: '/ours' });
      expect(ours.statusCode).toBe(404);
      expect(ours.json().error).toMatchObject({ code: 'NOT_FOUND', message_mn: 'Ийм гүйлгээ олдсонгүй.' });
    } finally {
      await server.close();
    }
  });

  it('is general on the real server too, where a route lets Postgres answer', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/dev/login', payload: { phone: '+97699007788' } })).json();
    const res = await app.inject({ method: 'GET', url: '/v1/wallet?before=x', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: generalWords });
    expect(res.body).not.toMatch(OURS);
  });

  it('keeps a refusal of the request itself, with its status, in words about the request', async () => {
    // Fastify's own, before any route runs: its words are about what was sent.
    const json = { 'content-type': 'application/json' };
    const notJson = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: json, payload: '{' });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY', message: "Body is not valid JSON but content-type is set to 'application/json'" });
    const tooLarge = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: json, payload: JSON.stringify({ login: 'x'.repeat(70_000) }) });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    const xml = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    expect(xml.statusCode).toBe(415);

    // The web root's: a path it will not serve, a range the file has not got, a version it is not.
    for (const [request, status] of [
      [{ url: '//api.js' }, 403],
      [{ url: '/brand//favicon.png' }, 403],
      [{ url: '/api.js', headers: { range: 'bytes=99999999-' } }, 416],
      [{ url: '/api.js', headers: { 'if-match': '"not-this-one"' } }, 412],
    ] as const) {
      const res = await app.inject({ method: 'GET', ...request });
      expect(res.statusCode, JSON.stringify(request)).toBe(status);
      expect(res.body, JSON.stringify(request)).not.toContain('INTERNAL');
    }

    // Any other refusal that carries a status keeps it, and says only that status's name.
    const server = Fastify();
    server.setErrorHandler(errorHandler);
    server.get('/refused', async () => {
      throw Object.assign(new Error('Forbidden: /srv/basu/dist/web/.env'), { status: 403, statusCode: 403 });
    });
    try {
      const refused = await server.inject({ method: 'GET', url: '/refused' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' });
      expect(refused.body).not.toMatch(OURS);
    } finally {
      await server.close();
    }
  });
});

/** Every page on disk, by name, as it is served. */
function pages(): Array<[string, string]> {
  return readdirSync(webRoot)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [file, readFileSync(join(webRoot, file), 'utf8')]);
}

describe('a server with no demo in it', () => {
  it('serves every page, and none of the shortcuts past the door', async () => {
    const real = await buildServer(ctx, { dev: false });
    try {
      for (const url of ['/', '/app', '/idesh', '/dine', '/supplier', '/dashboard', '/kds', '/privacy', '/terms', '/api.js', '/app.css',
        '/login', '/home', '/shop', '/shop/7a0a3c3e-1f0b-4c55-9f59-3f1f7f0c2a11', '/orders', '/orders/7a0a3c3e-1f0b-4c55-9f59-3f1f7f0c2a11', '/account', '/site.js', '/site.css']) {
        const res = await real.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }
      for (const url of ['/dev/ops-token', '/dev/clock']) {
        expect((await real.inject({ method: 'GET', url })).statusCode, url).toBe(404);
      }
      expect((await real.inject({ method: 'POST', url: '/dev/login', payload: {} })).statusCode).toBe(404);
    } finally {
      await real.close();
    }
  });
});

describe('rate limits', () => {
  it('shut a code door after too many tries from one address, in the API’s own words', async () => {
    const { max } = limits().otp;
    let last;
    for (let i = 0; i <= max; i++) {
      last = await app.inject({ method: 'POST', url: '/v1/auth/password/code', payload: { login: '99000000' } });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(last!.json().error.message_mn).toContain('Хэт олон');
    expect(last!.headers['retry-after']).toBeTruthy();
  });

  /**
   * Knock on a code door one more time than it allows, from wherever `from`
   * says each knock came: the socket, and the X-Forwarded-For it carried.
   */
  async function knock(server: FastifyInstance, from: (i: number) => { socket: string; forwarded: string }) {
    const { max } = limits().otp;
    let last;
    for (let i = 0; i <= max; i++) {
      const { socket, forwarded } = from(i);
      last = await server.inject({
        method: 'POST',
        url: '/v1/auth/otp',
        payload: {},
        remoteAddress: socket,
        headers: { 'x-forwarded-for': forwarded },
      });
    }
    return last!;
  }

  it('count a caller behind nginx by the address nginx saw, not by one it made up in front', async () => {
    const behind = await buildServer(ctx, { trustProxy: true });
    try {
      // nginx appends the address it saw to whatever the caller wrote there.
      const last = await knock(behind, (i) => ({ socket: '127.0.0.1', forwarded: `10.0.${i}.1, 198.51.100.20` }));
      expect(last.statusCode).toBe(429);
    } finally {
      await behind.close();
    }
  });

  it('keep callers behind nginx apart, whichever loopback nginx comes in on', async () => {
    const behind = await buildServer(ctx, { trustProxy: true });
    try {
      // A listen on `::`, or an upstream written as localhost, brings nginx in
      // from ::1, or with its IPv4 address spelled the IPv6 way. Still nginx:
      // taken for a caller, it would be everybody's one shared count.
      for (const [n, socket] of ['127.0.0.1', '::1', '::ffff:127.0.0.1'].entries()) {
        const last = await knock(behind, (i) => ({ socket, forwarded: `198.51.${100 + n}.${i + 1}` }));
        expect(last.statusCode, socket).not.toBe(429);
      }
    } finally {
      await behind.close();
    }
  });

  it('believe no forwarded address from anybody who is not nginx', async () => {
    const behind = await buildServer(ctx, { trustProxy: true });
    try {
      const last = await knock(behind, (i) => ({ socket: '198.51.100.30', forwarded: `10.1.${i}.1` }));
      expect(last.statusCode).toBe(429);
    } finally {
      await behind.close();
    }
  });

  it('are strict in production and merely present in the demo', () => {
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    expect(limits().otp.max).toBe(10);
    process.env['BASU_MODE'] = 'demo';
    expect(limits().otp.max).toBeGreaterThan(10);
    if (before === undefined) delete process.env['BASU_MODE'];
    else process.env['BASU_MODE'] = before;
  });
});
