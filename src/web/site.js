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

/** The website's line icons: a 24 viewBox, round caps, drawn in currentColor. */
const SVG = (paths, width = 1.7) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  down: SVG('<path d="m6 9 6 6 6-6"/>', 1.8),
  orders: SVG('<path d="M6 4h12v16l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h4"/>'),
  shop: SVG('<path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M6 12v8h12v-8"/>'),
  home: SVG('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'),
  person: SVG('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.5 3.6-5 7-5s6 1.5 7 5"/>'),
  out: SVG('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>'),
  back: SVG('<path d="M15 5l-7 7 7 7"/>', 1.8),
  business: SVG('<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 12.5h17"/>'),
  menu: SVG('<g class="lines"><path d="M4 7h16M4 12h16M4 17h16"/></g><g class="x"><path d="M6 6l12 12M18 6 6 18"/></g>', 1.8),
  check: SVG('<path d="M5 12.5l4.5 4.5L19 7"/>', 2),
  info: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6h.01"/>'),
  alert: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'),
  phone: SVG('<path d="M6 3h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>'),
  key: SVG('<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>'),
  bank: SVG('<path d="M3 9.5 12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17"/>'),
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
 *
 * A 401 that is about what the person typed — the password that confirms a
 * refund's bank account was wrong (BAD_PASSWORD), or a login's
 * (BAD_CREDENTIALS) — says nothing about the session: it is still good, and
 * the person is told where they typed it, not signed out for a typo.
 */
export async function authed(path, options = {}) {
  const sent = store.guestToken;
  try {
    return await api(path, { ...options, token: sent });
  } catch (error) {
    if (error.status === 401 && error.code !== 'BAD_PASSWORD' && error.code !== 'BAD_CREDENTIALS') {
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

/** A Mongolian number the way people read it: +976 9911 2233. Anything else as it came. */
export const phoneShown = (p) => String(p ?? '').replace(/^\+976(\d{4})(\d{4})$/, '+976 $1 $2');
export const nameOf = (p) => p?.display_name || p?.email || phoneShown(p?.phone) || 'Basu хэрэглэгч';
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
  const here = (href) => location.pathname === href || location.pathname.startsWith(`${href}/`);
  const item = (href, icon, label) =>
    `<a role="menuitem" href="${href}"${here(href) ? ' aria-current="page"' : ''}>${ICON[icon]}${label}</a>`;
  const box = el(`
    <div class="s-acct">
      <button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(nameOf(person))} — бүртгэлийн цэс"><i class="s-ini" aria-hidden="true">${esc(initialOf(person))}</i><span>${esc(nameOf(person))}</span>${ICON.down}</button>
      <div class="s-menu" role="menu" hidden>
        <div class="who"><b>${esc(nameOf(person))}</b>${
          // The address under the name, unless the name is the address.
          (person.email || phoneShown(person.phone)) && (person.email || phoneShown(person.phone)) !== nameOf(person)
            ? `<small>${esc(person.email || phoneShown(person.phone))}</small>`
            : ''
        }</div>
        ${item('/home', 'home', 'Миний Basu')}
        ${item('/shop', 'shop', 'Зах')}
        ${item('/orders', 'orders', 'Миний захиалга')}
        ${item('/account', 'person', 'Бүртгэл')}
        <hr>
        <button role="menuitem" type="button" data-out>${ICON.out}Гарах</button>
      </div>
    </div>`);
  const toggle = box.querySelector('button');
  const menu = box.querySelector('.s-menu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const open = (on, focusFirst = false) => {
    menu.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
    if (on && focusFirst) items()[0]?.focus();
  };
  // A press from the keyboard (Enter, Space: a click with no pointer) lands in the menu; a mouse's leaves the focus where it is.
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    open(menu.hidden, event.detail === 0);
  });
  toggle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    open(true, true);
  });
  menu.addEventListener('keydown', (event) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key];
    if (go !== undefined) {
      event.preventDefault();
      list[(go + list.length) % list.length]?.focus();
    } else if (event.key === 'Tab') {
      open(false);
    }
  });
  document.addEventListener('click', (event) => {
    if (!box.contains(event.target)) open(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.hidden) return;
    open(false);
    toggle.focus();
  });
  box.querySelector('[data-out]').addEventListener('click', () => void signOut());
  slot.replaceChildren(box);
  return person;
}

/* ── the frame ─────────────────────────────────────────────────────── */

const NAV = [
  ['home', '/home', 'Нүүр', 'home'],
  ['shop', '/shop', 'Зах', 'shop'],
  ['orders', '/orders', 'Миний захиалга', 'orders'],
  ['business', '/dashboard', 'Бизнест', 'business'],
];

/**
 * The header and the foot, around a page's own <main>. `active` names the
 * header link to mark. On a phone the links fold into a menu under the bar:
 * a button at the end opens it, Esc or a press outside closes it.
 */
export function mountFrame(active) {
  const link = ([key, href, label, icon], withIcon) =>
    `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${withIcon ? ICON[icon] : ''}${label}</a>`;
  const bar = el(`
    <header class="s-bar">
      <div class="s-wrap">
        <a class="s-word" href="${store.guestToken ? '/home' : '/'}">Basu</a>
        <nav class="s-nav" aria-label="Цэс">${NAV.map((n) => link(n, false)).join('')}</nav>
        <div class="s-right" id="s-account"></div>
        <button class="s-burger" type="button" aria-expanded="false" aria-controls="s-drawer" aria-label="Цэс нээх">${ICON.menu}</button>
      </div>
      <nav class="s-drawer" id="s-drawer" aria-label="Цэс" hidden>${NAV.map((n) => link(n, true)).join('')}</nav>
    </header>`);
  const foot = el(`
    <footer class="s-foot">
      <div class="s-wrap">
        <span class="who">© ${new Date().getFullYear()} Basu · Улаанбаатар · <a href="mailto:basuappmn@gmail.com">basuappmn@gmail.com</a></span>
        <nav aria-label="Холбоос"><a href="/">Basu-гийн тухай</a><a href="/home">Миний Basu</a><a href="/shop">Зах</a><a href="/dashboard">Бизнест</a><a href="/terms">Үйлчилгээний нөхцөл</a><a href="/privacy">Нууцлалын бодлого</a></nav>
      </div>
    </footer>`);

  const burger = bar.querySelector('.s-burger');
  const drawer = bar.querySelector('.s-drawer');
  const fold = (open, focus = false) => {
    drawer.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Цэс хаах' : 'Цэс нээх');
    if (open && focus) drawer.querySelector('a')?.focus();
  };
  burger.addEventListener('click', (event) => {
    event.stopPropagation();
    fold(drawer.hidden, event.detail === 0);
  });
  document.addEventListener('click', (event) => {
    if (!drawer.hidden && !bar.contains(event.target)) fold(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || drawer.hidden) return;
    fold(false);
    burger.focus();
  });
  // Tabbing past the last link leaves the menu, and the menu closes behind it.
  drawer.addEventListener('focusout', (event) => {
    if (!drawer.hidden && !drawer.contains(event.relatedTarget) && event.relatedTarget !== burger) fold(false);
  });

  document.body.prepend(bar);
  document.body.append(foot);
  return accountSlot(bar.querySelector('#s-account'));
}

/** A message at the bottom of the screen, for a moment: `good` once something is done, `bad` when it failed. */
export function say(message, tone) {
  document.querySelector('.s-toast')?.remove();
  const box = el(`<div class="s-toast" role="${tone === 'bad' ? 'alert' : 'status'}"${tone ? ` data-tone="${tone}"` : ''}></div>`);
  box.textContent = message;
  document.body.append(box);
  setTimeout(() => box.remove(), tone === 'bad' ? 6000 : 4200);
}

/* ── pieces the pages share ────────────────────────────────────────── */

/** An amount for markup: the digits, and the ₮ set in the sans beside them. Its text is what mnt() says. */
export const tugrik = (value) => `${Number(value).toLocaleString('mn-MN')}<span class="cur">₮</span>`;

/**
 * The tone of an идэш's state, the same on every page that shows one: waiting
 * on the supplier in the route blue, on the fire in honey, done in green.
 * A cancelled or refunded order is over, not an alarm: no tone.
 */
export const ORDER_TONE = { PAID: 'route', PREPARING: 'hi', READY: 'ready', DISPATCHED: 'route', HANDED: 'ready' };
export const statePill = (state, word) =>
  `<span class="s-pill" data-state="${esc(state)}"${ORDER_TONE[state] ? ` data-tone="${ORDER_TONE[state]}"` : ''}>${esc(word)}</span>`;

/**
 * An empty place that says what it is for and gives the one next step:
 * `actions` are [label, href, 'dark' | 'line'] — at most one dark.
 */
export function siteEmpty({ icon = 'info', title, text = '', actions = [], card = false }) {
  return el(`
    <div class="s-empty${card ? ' s-card' : ''}">
      <span class="s-mark" aria-hidden="true">${ICON[icon] ?? ICON.info}</span>
      <b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}
      ${actions.length ? `<div class="s-acts">${actions.map(([label, href, kind = 'line']) => `<a class="s-btn s-btn-${kind}" href="${esc(href)}">${esc(label)}</a>`).join('')}</div>` : ''}
    </div>`);
}

/** How an идэш goes, in the words the front page uses: for wherever somebody is about to start one. */
export function howToBuy() {
  return el(`
    <section class="s-how" aria-labelledby="s-how-title">
      <h2 id="s-how-title">Хэрхэн захиалах вэ</h2>
      <ol>
        <li><b>Зараа сонгоно</b><span>Мал, хэмжээ, авах өдөр, хүргэлтээ сонгоно.</span></li>
        <li><b>QPay-ээр төлнө</b><span>Өөрийн банкны аппаас нэг удаа төлнө.</span></li>
        <li><b>Нийлүүлэгч бэлтгэнэ</b><span>Төлбөр орсны дараа мал нядалж, махыг бэлтгэнэ.</span></li>
        <li><b>Хүлээн авна</b><span>Хаалган дээрээ, эсвэл нийлүүлэгчийн цэгээс кодоо хэлээд авна.</span></li>
      </ol>
    </section>`);
}
