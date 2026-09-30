/* The website's shared parts: the header with the account in its corner,
   the foot, the way to /login and back, and calls made as the person
   signed in. Every page of the website imports this; the app's pages do not. */

import { api, store, dropSession, endSession, authReturn } from '/api.js';

/**
 * Text into markup, for everything a page draws from what people wrote: a
 * listing, a supplier's name and number, a delivery address. Quotes too — a
 * value inside an attribute (a tel: link, an input's value) would otherwise
 * end it and write one of its own.
 */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One element from a string of markup. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const ICON = {
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12v16l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h4"/></svg>',
  shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M6 12v8h12v-8"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.5 3.6-5 7-5s6 1.5 7 5"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
};
export { ICON };

/* ── where to go after signing in ──────────────────────────────────── */

/**
 * A path on this site to come back to — never another site, never the door itself.
 *
 * Asked of the address the browser would open, not of how it is spelled.
 * A browser reads a backslash as a slash and drops a tab or a newline, so
 * `/\evil.com` and `/<tab>/evil.com` look like paths here and go to
 * evil.com there, straight from Basu's own sign-in. So the text is read as
 * the browser reads it (`new URL`), kept only if it stays on this site, and
 * handed back as the path it came to; one with a backslash or a control
 * character in it is not a path anybody typed, and is not read at all.
 *
 * The path handed back is then read once more, by the browser, on its own.
 * Reading drops dot segments, so `/.//evil.com` — this site, as spelled —
 * comes back as `//evil.com`, and on its own that is evil.com. A path with
 * one slash in front stays on this site however it is read; one with two is
 * the address of another, and is refused like any other.
 */
export function safeNext(raw, fallback = '/home') {
  if (typeof raw !== 'string' || !raw.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url;
  try {
    url = new URL(raw, location.origin);
  } catch {
    return fallback;
  }
  const path = url.pathname + url.search + url.hash;
  if (url.origin !== location.origin || path.startsWith('//') || url.pathname.startsWith('/login')) return fallback;
  return path;
}

export const loginUrl = (next = location.pathname + location.search) => `/login?next=${encodeURIComponent(next)}`;

/**
 * A page that is only for somebody signed in. Without a session the person
 * goes to /login and comes back here after; with one, its token.
 */
export function requireSignIn() {
  const token = store.guestToken;
  if (!token) location.replace(loginUrl());
  return token;
}

/**
 * A call as the signed-in person. A session that has ended sends them to
 * sign in again. So does one that Basu's desk wants signed in afresh
 * (SIGN_IN_AGAIN) before it signs anybody out — and that one the server
 * still takes for the rest of the website, so it is ended there as well as
 * forgotten here, the way the dashboard ends it: the person is about to
 * sign in anew, and the old session is left to nobody.
 *
 * The answer is about the session the call went with. The browser may have
 * moved on while the call was out — another tab signed somebody in, on the
 * storage every tab shares — and the sign-in it holds now is not forgotten,
 * nor ended, nor this page sent to the door, for an answer about the one
 * before. The dashboard keeps the same rule (`refused` in ops.html).
 */
export async function authed(path, options = {}) {
  const sent = store.guestToken;
  try {
    return await api(path, { ...options, token: sent });
  } catch (error) {
    if (error.status === 401) {
      if (error.code === 'SIGN_IN_AGAIN') endSession(sent);
      if (store.guestToken === sent) {
        store.guestToken = null;
        location.replace(loginUrl());
      }
    }
    throw error;
  }
}

/* ── the person ────────────────────────────────────────────────────── */

let meAsked = null;
/**
 * Who is signed in: their profile, asked once per page. Null for nobody.
 * A page Google sent somebody back to has them only once the code in its
 * address is claimed (api.js, authReturn), so that comes first. A session
 * refused is forgotten only while it is still the one this browser holds,
 * as with every call (`authed`).
 */
export async function me() {
  await authReturn;
  const sent = store.guestToken;
  if (!sent) return null;
  meAsked ??= api('/v1/me', { token: sent }).catch((error) => {
    if (error.status === 401 && store.guestToken === sent) store.guestToken = null;
    return null;
  });
  return meAsked;
}

export const nameOf = (p) => p?.display_name || p?.email || p?.phone || 'Basu хэрэглэгч';
const initialOf = (p) => (p?.display_name || p?.email || 'B').trim().charAt(0) || 'B';

/** Sign out here — the dashboard too, it is the same person — end the session on the server, and go to the front page. */
export function signOut() {
  dropSession();
  location.href = '/';
}

/**
 * The account in a header's corner: «Нэвтрэх» for nobody, a name with a
 * menu under it for somebody. Used by the website's pages and by the front
 * page, which keeps its own header.
 */
export async function accountSlot(slot) {
  const person = await me();
  if (!person) {
    slot.replaceChildren(el(`<a class="s-btn s-btn-line s-btn-sm" href="${loginUrl(location.pathname === '/' ? '/home' : location.pathname + location.search)}">Нэвтрэх</a>`));
    return null;
  }
  const box = el(`
    <div class="s-acct">
      <button type="button" aria-haspopup="menu" aria-expanded="false"><i class="s-ini" aria-hidden="true">${esc(initialOf(person))}</i><span>${esc(nameOf(person))}</span>${ICON.down}</button>
      <div class="s-menu" role="menu" hidden>
        <div class="who"><b>${esc(nameOf(person))}</b><small>${esc(person.email || person.phone || '')}</small></div>
        <a role="menuitem" href="/home">${ICON.home}Миний Basu</a>
        <a role="menuitem" href="/shop">${ICON.shop}Зах</a>
        <a role="menuitem" href="/orders">${ICON.orders}Миний захиалга</a>
        <a role="menuitem" href="/account">${ICON.person}Бүртгэл</a>
        <hr>
        <button role="menuitem" type="button" data-out>${ICON.out}Гарах</button>
      </div>
    </div>`);
  const toggle = box.querySelector('button');
  const menu = box.querySelector('.s-menu');
  const open = (on) => {
    menu.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
  };
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    open(menu.hidden);
  });
  document.addEventListener('click', (event) => {
    if (!box.contains(event.target)) open(false);
  });
  document.addEventListener('keydown', (event) => event.key === 'Escape' && open(false));
  box.querySelector('[data-out]').addEventListener('click', () => void signOut());
  slot.replaceChildren(box);
  return person;
}

/* ── the frame ─────────────────────────────────────────────────────── */

const NAV = [
  ['home', '/home', 'Нүүр'],
  ['shop', '/shop', 'Зах'],
  ['orders', '/orders', 'Миний захиалга'],
  ['business', '/dashboard', 'Бизнест'],
];

/** The header and the foot, around a page's own <main>. `active` names the header link to mark. */
export function mountFrame(active) {
  const bar = el(`
    <header class="s-bar">
      <div class="s-wrap">
        <a class="s-word" href="${store.guestToken ? '/home' : '/'}">Basu</a>
        <nav class="s-nav" aria-label="Цэс">${NAV.map(
          ([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`,
        ).join('')}</nav>
        <div class="s-right" id="s-account"></div>
      </div>
    </header>`);
  const foot = el(`
    <footer class="s-foot">
      <div class="s-wrap">
        <span>© ${new Date().getFullYear()} Basu · Улаанбаатар · <a href="mailto:basuappmn@gmail.com">basuappmn@gmail.com</a></span>
        <nav aria-label="Холбоос"><a href="/">Basu-гийн тухай</a><a href="/home">Миний Basu</a><a href="/shop">Зах</a><a href="/dashboard">Бизнест</a><a href="/terms">Үйлчилгээний нөхцөл</a><a href="/privacy">Нууцлалын бодлого</a></nav>
      </div>
    </footer>`);
  document.body.prepend(bar);
  document.body.append(foot);
  return accountSlot(bar.querySelector('#s-account'));
}

/** A message at the bottom of the screen, for a moment. */
export function say(message, tone) {
  document.querySelector('.s-toast')?.remove();
  const box = el(`<div class="s-toast" role="status"${tone ? ` data-tone="${tone}"` : ''}></div>`);
  box.textContent = message;
  document.body.append(box);
  setTimeout(() => box.remove(), 4200);
}
