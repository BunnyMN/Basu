import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { contentSecurityPolicy, inlineScriptHashes, limits } from './hardening.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
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
    expect(csp).toMatch(/script-src 'self' https:\/\/cdnjs\.cloudflare\.com 'sha256-/);
    expect(csp).toContain("connect-src 'self'");
  });
});

describe('rate limits', () => {
  it('shut the pairing door after too many tries from one address, in the API’s own words', async () => {
    const { max } = limits().pair;
    let last;
    for (let i = 0; i <= max; i++) {
      last = await app.inject({ method: 'POST', url: '/v1/supplier/pair', payload: { pairing_code: '00000000' } });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(last!.json().error.message_mn).toContain('Хэт олон');
    expect(last!.headers['retry-after']).toBeTruthy();
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
