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

  it('is never the door itself, and is home when nothing usable was asked for', () => {
    for (const nothing of ['/login', '/login?next=/login', '/login#x', 'shop', '', null, undefined, 42]) {
      expect(safeNext(nothing), JSON.stringify(nothing)).toBe('/home');
    }
  });
});
