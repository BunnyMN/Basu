import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Where the website's door sends somebody once they are in: the `next` it
 * was opened with, if that is a page of this site. On its own, in the DOM
 * the browser has, because what matters is what the browser makes of the
 * text — not what the text looks like. And what a page of the website does
 * when a call it made as the person is refused as signed out.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ORIGIN = 'https://basu.burzai.cloud';

let window: JSDOM['window'];
let safeNext: (raw: unknown) => string;

/** site.js as the page loads it, minus the plumbing: its imports are api.js's, which a test plays itself. */
const siteSource = async () =>
  (await readFile(join(WEB, 'site.js'), 'utf8')).replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '').replace(/\bexport\s+/g, '');

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: `${ORIGIN}/login` });
  window = dom.window;
  // safeNext never touches api.js.
  window.eval(`${await siteSource()}\nwindow.__safeNext = safeNext;`);
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

/** A call out to the server, as api.js was asked to make it, waiting for the test to answer it. */
type Call = { path: string; token: string | null; refuse: (code: string) => void };

/**
 * A page of the website with site.js on it, signed in as `old`, and
 * api.js's side played here: the storage every tab of the browser shares
 * (`store`), calls that wait for the test to answer them, and the sessions
 * ended on the server. Leaving for the door shows as jsdom saying it does
 * not navigate.
 */
async function aPage() {
  const virtualConsole = new VirtualConsole();
  const page = {
    store: { guestToken: 'old' as string | null },
    calls: [] as Call[],
    ended: [] as string[],
    left: 0,
    authed: null as unknown as (path: string, options?: object) => Promise<unknown>,
    me: null as unknown as () => Promise<unknown>,
  };
  virtualConsole.on('jsdomError', (error) => {
    if (/navigation/.test(error.message)) page.left += 1;
  });
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: `${ORIGIN}/account`, virtualConsole });
  const scope = dom.window as unknown as Record<string, unknown>;
  const endSession = (token: string | null) => void (token && page.ended.push(token));
  Object.assign(scope, {
    store: page.store,
    authReturn: Promise.resolve(),
    endSession,
    dropSession: () => {
      const token = page.store.guestToken;
      page.store.guestToken = null;
      endSession(token);
    },
    api: (path: string, options: { token?: string | null }) =>
      new Promise((_resolve, reject) => {
        page.calls.push({ path, token: options.token ?? null, refuse: (code) => reject(Object.assign(new Error(code), { status: 401, code })) });
      }),
  });
  dom.window.eval(`${await siteSource()}\nwindow.__authed = authed; window.__me = me;`);
  page.authed = scope['__authed'] as typeof page.authed;
  page.me = scope['__me'] as typeof page.me;
  return page;
}

/** The page's own awaits first: `me` waits for a sign-in by Google to be claimed before it asks. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a call refused as signed out', () => {
  it('forgets the session it went with, ends it where the desk wants a fresh sign-in, and goes to the door', async () => {
    for (const code of ['SIGN_IN_AGAIN', 'UNAUTHORIZED']) {
      const page = await aPage();
      const call = page.authed('/v1/me/sessions/revoke', { method: 'POST' });
      expect(page.calls.map((c) => [c.path, c.token])).toEqual([['/v1/me/sessions/revoke', 'old']]);
      page.calls[0]!.refuse(code);
      // The caller still hears of the refusal.
      await expect(call, code).rejects.toMatchObject({ status: 401, code });
      expect(page.store.guestToken, code).toBeNull();
      // A session the desk wants signed in afresh still opens the website, so it is ended there; one that ended has nothing to end.
      expect(page.ended, code).toEqual(code === 'SIGN_IN_AGAIN' ? ['old'] : []);
      expect(page.left, code).toBe(1);
    }
  });

  it('keeps the session, and the page, when what was refused is a password the person typed', async () => {
    for (const code of ['BAD_PASSWORD', 'BAD_CREDENTIALS']) {
      const page = await aPage();
      const call = page.authed('/v1/idesh/x/refund-account', { method: 'POST' });
      page.calls[0]!.refuse(code);
      // The caller still hears of it, to say so where the password was typed.
      await expect(call, code).rejects.toMatchObject({ status: 401, code });
      expect(page.store.guestToken, code).toBe('old');
      expect(page.ended, code).toEqual([]);
      expect(page.left, code).toBe(0);
    }
  });

  it('never forgets, ends or leaves a sign-in made while the call was out', async () => {
    for (const code of ['SIGN_IN_AGAIN', 'UNAUTHORIZED']) {
      const page = await aPage();
      const call = page.authed('/v1/me/sessions/revoke', { method: 'POST' });
      // Another tab signs somebody in, on the storage every tab shares.
      page.store.guestToken = 'new';
      page.calls[0]!.refuse(code);
      await expect(call, code).rejects.toMatchObject({ status: 401, code });
      expect(page.store.guestToken, code).toBe('new');
      expect(page.ended, code).not.toContain('new');
      expect(page.left, code).toBe(0);
    }
  });

  it('asks who is signed in by the session it holds, and forgets that one alone', async () => {
    for (const moved of [false, true]) {
      const page = await aPage();
      const who = page.me();
      await settled();
      expect(page.calls.map((c) => [c.path, c.token])).toEqual([['/v1/me', 'old']]);
      if (moved) page.store.guestToken = 'new';
      page.calls[0]!.refuse('UNAUTHORIZED');
      expect(await who).toBeNull();
      expect(page.store.guestToken, String(moved)).toBe(moved ? 'new' : null);
    }
  });
});
