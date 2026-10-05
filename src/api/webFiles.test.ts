import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { buildServer } from './server.js';
import { A_MONTH, cacheControl, FOREVER, precompress } from './webFiles.js';

/**
 * The web's files on their way to a phone: compressed once at build and
 * handed over as the browser reads them, kept as long as their names allow.
 *
 * `built` is a server over a copy of src/web with the build's last step run
 * on it, as dist/web is in production; `bare` is the server under tsx, over
 * src/web itself, where nothing compressed lies beside any file.
 */
const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ctx: Ctx = {
  clock: new VirtualClock(at('11:40')),
  payments: new FakePaymentProvider(),
  tax: new FakeTaxProvider(),
  notifier: new FakeNotifier(),
};
const BROWSER = 'gzip, deflate, br, zstd';
let root: string;
let built: FastifyInstance;
let bare: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'basu-web-'));
  await cp(source, root, { recursive: true });
  await precompress(root);
  built = await buildServer(ctx, { webRoot: root });
  bare = await buildServer(ctx);
});

afterAll(async () => {
  await built?.close();
  await bare?.close();
  await rm(root, { recursive: true, force: true });
  await closePool();
});

const get = (app: FastifyInstance, url: string, encoding?: string, method: 'GET' | 'HEAD' = 'GET') =>
  app.inject({ method, url, headers: encoding === undefined ? {} : { 'accept-encoding': encoding } });

describe('the build compresses the text once', () => {
  it('beside every page, style, script and SVG, at bytes that open to the file exactly', async () => {
    for (const file of ['index.html', 'ops.html', 'app.css', 'api.js', 'site.css', 'vendor/table-core.js', 'brand/supplier-tile.svg']) {
      const raw = await readFile(join(root, file));
      const br = await readFile(join(root, `${file}.br`));
      const gz = await readFile(join(root, `${file}.gz`));
      expect(brotliDecompressSync(br).equals(raw), file).toBe(true);
      expect(gunzipSync(gz).equals(raw), file).toBe(true);
      expect(br.length, file).toBeLessThan(raw.length / 2);
    }
  });

  it('and leaves photos and fonts, compressed already, as they are', () => {
    const variants = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(br|gz)$/.test(f));
    expect(variants.length).toBeGreaterThan(20);
    expect(variants.filter((f) => /\.(webp|jpe?g|png|woff2|avif)\.(br|gz)$/.test(f))).toEqual([]);
  });

  it('replaces what an older build left, and drops a copy whose file is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basu-web-'));
    try {
      await writeFile(join(dir, 'page.html'), '<p>новый</p>'.repeat(50));
      await writeFile(join(dir, 'page.html.br'), 'an older build');
      await writeFile(join(dir, 'gone.js.gz'), 'its file was deleted');
      await writeFile(join(dir, 'data.bin.gz'), 'not ours to touch');
      await precompress(dir);
      expect(brotliDecompressSync(await readFile(join(dir, 'page.html.br'))).toString()).toBe('<p>новый</p>'.repeat(50));
      expect(existsSync(join(dir, 'gone.js.gz'))).toBe(false);
      expect(existsSync(join(dir, 'data.bin.gz'))).toBe(true);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts what it wrote, every file compressed alongside the others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basu-web-'));
    try {
      const names = ['a.css', 'b.js', 'c.html', 'd.svg'];
      for (const [i, name] of names.entries()) await writeFile(join(dir, name), 'Өвлийн идэш '.repeat(200 * (i + 1)));
      const done = await precompress(dir);
      const total = async (suffix: string) => (await Promise.all(names.map(async (n) => (await stat(join(dir, n + suffix))).size))).reduce((a, b) => a + b, 0);
      expect(done).toEqual({ files: 4, bytes: await total(''), br: await total('.br'), gz: await total('.gz') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes no copy that would not be smaller than its file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basu-web-'));
    try {
      await writeFile(join(dir, 'tiny.txt'), 'ok');
      const done = await precompress(dir);
      expect(existsSync(join(dir, 'tiny.txt.br'))).toBe(false);
      expect(existsSync(join(dir, 'tiny.txt.gz'))).toBe(false);
      expect(done).toEqual({ files: 1, bytes: 2, br: 2, gz: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the server hands over the smallest copy the browser reads', () => {
  it('brotli to a browser that reads it, gzip to one that reads only gzip, the file to one that names neither', async () => {
    for (const url of ['/app.css', '/api.js']) {
      const file = await readFile(join(root, url));
      const br = await get(built, url, BROWSER);
      expect(br.statusCode, url).toBe(200);
      expect(br.headers['content-encoding'], url).toBe('br');
      expect(br.headers['content-type'], url).toMatch(url.endsWith('.css') ? /^text\/css/ : /^(text|application)\/javascript/);
      expect(brotliDecompressSync(br.rawPayload).equals(file), url).toBe(true);

      for (const accepts of ['gzip', 'br;q=0, gzip', '*']) {
        const gz = await get(built, url, accepts);
        expect(gz.headers['content-encoding'], `${url} ${accepts}`).toBe('gzip');
        expect(gunzipSync(gz.rawPayload).equals(file), `${url} ${accepts}`).toBe(true);
      }

      for (const accepts of [undefined, 'identity', '']) {
        const plain = await get(built, url, accepts);
        expect(plain.statusCode, `${url} ${accepts}`).toBe(200);
        expect(plain.headers['content-encoding'], `${url} ${accepts}`).toBeUndefined();
        expect(plain.rawPayload.equals(file), `${url} ${accepts}`).toBe(true);
      }
    }
  });

  it('says on every answer, the file itself too, that it depends on Accept-Encoding', async () => {
    for (const accepts of [BROWSER, 'gzip', undefined]) {
      for (const url of ['/app.css', '/login', '/', '/brand/meat/hero.webp']) {
        expect((await get(built, url, accepts)).headers['vary'], `${url} ${accepts}`).toMatch(/accept-encoding/i);
      }
    }
    expect((await get(bare, '/app.css', BROWSER)).headers['vary']).toMatch(/accept-encoding/i);
  });

  it('gives each copy its own ETag, so a cache never answers one with the other', async () => {
    const tags = await Promise.all([BROWSER, 'gzip', undefined].map(async (a) => (await get(built, '/app.css', a)).headers['etag']));
    expect(new Set(tags).size).toBe(3);
    const again = await built.inject({ method: 'GET', url: '/app.css', headers: { 'accept-encoding': BROWSER, 'if-none-match': String(tags[0]) } });
    expect(again.statusCode).toBe(304);
  });

  it('answers HEAD with the headers of the copy a GET would get', async () => {
    const plain = await get(built, '/app.css', undefined, 'HEAD');
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(Number(plain.headers['content-length'])).toBe((await stat(join(root, 'app.css'))).size);
    const br = await get(built, '/app.css', BROWSER, 'HEAD');
    expect(br.headers['content-encoding']).toBe('br');
    expect(Number(br.headers['content-length'])).toBe((await stat(join(root, 'app.css.br'))).size);
    expect(br.body).toBe('');
  });

  it('sends the pages behind their own addresses compressed too, the same bytes the policy hashed', async () => {
    const pages: Array<[string, string]> = [
      ['/', 'index.html'], ['/login', 'login.html'], ['/shop/7a0a3c3e-1f0b-4c55-9f59-3f1f7f0c2a11', 'shop.html'],
      ['/dashboard', 'ops.html'], ['/supplier', 'supplier.html'], ['/idesh', 'idesh.html'], ['/terms', 'terms.html'],
    ];
    for (const [url, file] of pages) {
      const res = await get(built, url, BROWSER);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-encoding'], url).toBe('br');
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      const html = brotliDecompressSync(res.rawPayload);
      expect(html.equals(await readFile(join(root, file))), url).toBe(true);
      // Every inline script the browser will find in what it unpacks is one the policy names.
      const csp = String(res.headers['content-security-policy']);
      for (const m of html.toString('utf8').matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (/\ssrc=/.test(m[1] ?? '') || !(m[2] ?? '').trim()) continue;
        expect(csp, url).toContain(`'sha256-${createHash('sha256').update(m[2]!).digest('base64')}'`);
      }
    }
  });

  it('sends every file as it is under tsx, where nothing is compressed beside it', async () => {
    for (const url of ['/app.css', '/', '/login', '/fonts/Manrope-Regular.v3.woff2']) {
      const res = await get(bare, url, BROWSER);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-encoding'], url).toBeUndefined();
    }
    expect((await get(bare, '/app.css', BROWSER)).rawPayload.equals(readFileSync(join(source, 'app.css')))).toBe(true);
  });
});

describe('how long a browser keeps a file', () => {
  it('a font cut for a year, never asked about again', async () => {
    const res = await get(built, '/fonts/NotoSansDisplay-CondensedExtraBold.v3.woff2', BROWSER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/woff2');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['cache-control']).toBe(FOREVER);
  });

  it('a photo or a tile’s art a month, refreshed in the background a week past it', async () => {
    for (const url of ['/brand/meat/hero.webp', '/brand/food-tile.webp', '/brand/og-dark.jpg', '/brand/apple-touch-icon.png', '/idesh/beef.jpg', '/favicon.ico']) {
      const res = await get(built, url, BROWSER);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe(A_MONTH);
    }
    // The ger tile is text, and goes compressed, kept as long as the picture it is.
    const svg = await get(built, '/brand/supplier-tile.svg', BROWSER);
    expect(svg.headers['content-encoding']).toBe('br');
    expect(svg.headers['cache-control']).toBe(A_MONTH);
  });

  it('a page, a style or a script never: their names stay across releases, so the browser asks each time', async () => {
    for (const url of ['/', '/login', '/dashboard', '/app.css', '/api.js', '/site.css', '/vendor/table-core.js', '/fonts/OFL-Manrope.txt']) {
      for (const app of [built, bare]) {
        expect((await get(app, url, BROWSER)).headers['cache-control'], url).toBe('public, max-age=0');
      }
    }
  });

  it('is read off the path under the web root, a compressed copy as its file', () => {
    expect(cacheControl('fonts/Manrope-SemiBold.v3.woff2')).toBe(FOREVER);
    // A font with no version in its name could change under it: asked about every time.
    expect(cacheControl('fonts/Manrope-SemiBold.woff2')).toBeUndefined();
    expect(cacheControl('brand/meat/cuts.webp')).toBe(A_MONTH);
    expect(cacheControl('brand/supplier-tile.svg.br')).toBe(A_MONTH);
    expect(cacheControl('idesh/horse.jpg')).toBe(A_MONTH);
    expect(cacheControl('app.css.br')).toBeUndefined();
    expect(cacheControl('index.html')).toBeUndefined();
    expect(cacheControl('brand/meat/CREDITS.txt')).toBeUndefined();
  });

  it('names in app.css only font files that are there, each under a versioned name the year’s cache can trust', () => {
    const css = readFileSync(join(source, 'app.css'), 'utf8');
    const urls = [...css.matchAll(/@font-face\s*\{[^}]*url\("?([^")]+)"?\)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    for (const url of urls) {
      expect(url, url).toMatch(/^\/fonts\/[^/]+\.v\d+\.woff2$/);
      expect(existsSync(join(source, url)), url).toBe(true);
      expect(cacheControl(url.slice(1)), url).toBe(FOREVER);
    }
    // And no font file lies there that nothing asks for.
    const files = readdirSync(join(source, 'fonts')).filter((f) => f.endsWith('.woff2'));
    expect(files.map((f) => `/fonts/${f}`).sort()).toEqual([...urls].sort());
  });
});
