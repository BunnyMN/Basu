import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Where the website's door sends somebody once they are in: the `next` it
 * was opened with, if that is a page of this site. On its own, in the DOM
 * the browser has, because what matters is what the browser makes of the
 * text — not what the text looks like.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ORIGIN = 'https://basu.burzai.cloud';

let window: JSDOM['window'];
let safeNext: (raw: unknown) => string;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: `${ORIGIN}/login` });
  window = dom.window;
  // site.js as the page loads it, minus the plumbing: its imports are api.js's, which safeNext never touches.
  const source = (await readFile(join(WEB, 'site.js'), 'utf8'))
    .replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '')
    .replace(/\bexport\s+/g, '');
  window.eval(`${source}\nwindow.__safeNext = safeNext;`);
  safeNext = (window as unknown as { __safeNext: typeof safeNext }).__safeNext;
});

describe('where the door sends somebody after signing in', () => {
  it('is a page of this site, as it was asked for, fragment and all', () => {
    expect(safeNext('/dashboard#desk/overview')).toBe('/dashboard#desk/overview');
    expect(safeNext('/orders/7a0a3c3e-1f0b-4c55-9f59-3f1f7f0c2a11?new=1')).toBe('/orders/7a0a3c3e-1f0b-4c55-9f59-3f1f7f0c2a11?new=1');
    expect(safeNext('/shop')).toBe('/shop');
  });

  it('is never another site, however the address is spelled', () => {
    // What the browser makes of them: another site, straight from Basu's door.
    for (const spelled of ['/\\evil.com', '/\t/evil.com']) {
      expect(new window.URL(spelled, ORIGIN).origin, JSON.stringify(spelled)).toBe('https://evil.com');
    }
    for (const elsewhere of [
      '/\\evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r\n/evil.com',
      '/\\/evil.com',
      '//evil.com',
      '///evil.com',
      'https://evil.com/',
      'javascript:alert(1)',
      '/\u0000/evil.com',
      '/shop\u007f',
    ]) {
      expect(safeNext(elsewhere), JSON.stringify(elsewhere)).toBe('/home');
    }
  });

  it('is never another site once the browser reads the path it is handed', () => {
    // Each stays on this site as spelled, and its path, with the dot segments
    // gone, starts with two slashes: what is handed on is read once more, and
    // then it is another site.
    for (const spelled of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/.%2e//evil.com', '/%2E%2E//evil.com/x?y#z', '/a/..//evil.com']) {
      const read = new window.URL(spelled, ORIGIN);
      expect(read.origin, JSON.stringify(spelled)).toBe(ORIGIN);
      expect(new window.URL(read.pathname + read.search + read.hash, ORIGIN).origin, JSON.stringify(spelled)).toBe('https://evil.com');
      expect(safeNext(spelled), JSON.stringify(spelled)).toBe('/home');
    }
  });

  it('is a page of this site however many dot segments it took to get there', () => {
    expect(safeNext('/a/../dashboard#desk/overview')).toBe('/dashboard#desk/overview');
    expect(safeNext('/./shop?x=1')).toBe('/shop?x=1');
    // Two slashes further in are a path on this site, not an address.
    expect(safeNext('/shop//evil.com')).toBe('/shop//evil.com');
  });

  it('is never the door itself, and is home when nothing usable was asked for', () => {
    for (const nothing of ['/login', '/login?next=/login', '/login#x', 'shop', '', null, undefined, 42]) {
      expect(safeNext(nothing), JSON.stringify(nothing)).toBe('/home');
    }
  });
});
