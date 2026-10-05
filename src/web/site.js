/* The website's shared parts: the header with the account in its corner,
   the foot, the way to /login and back, and calls made as the person
   signed in. Every page of the website imports this; the app's pages do not. */

import { api, store, dropSession, endSession, authReturn, IDESH_LIVE, phoneText, ideshStage, photoOf } from '/api.js';

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
  arrow: SVG('<path d="M5 12h14M13 6l6 6-6 6"/>', 2),
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

/**
 * A Mongolian number the way people read it: +976 9911 2233 — from +97699112233
 * and from the eight digits a delivery phone is kept as (99112233) alike, as
 * api.js phoneText writes it everywhere else. Anything else as it came.
 */
export const phoneShown = (p) => phoneText(p);
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
        ${item('/shop', 'shop', 'Идэш')}
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

/**
 * The website's places: [key, href, name, icon, the bar's word when it is
 * shorter]. /home is «Миний Basu» — in the phone's menu, the account's menu
 * and the foot. The bar alone says «Нүүр»: from 761px, where the links show
 * in it, beside «Миний захиалга» and a long name in the corner (an address,
 * a number) «Миний Basu» broke onto two lines up to about 830px.
 */
const NAV = [
  ['home', '/home', 'Миний Basu', 'home', 'Нүүр'],
  ['shop', '/shop', 'Идэш', 'shop'],
  ['orders', '/orders', 'Миний захиалга', 'orders'],
  ['business', '/dashboard', 'Бизнес', 'business'],
];

/** Basu on the App Store: lunch (Хоол) is ordered in the iPhone app. */
const APP_STORE = 'https://apps.apple.com/app/id6810541939';

/**
 * The website's foot, the front page's too: the wordmark large, four short
 * columns — the market, lunch (the iPhone app's), business, the address —
 * and the year with the two legal pages on a hairline. In the order the eye
 * reads them at every width, so Tab goes the same way. On Android there is
 * no app yet: the column that leads to the App Store is left out.
 */
export function siteFoot() {
  const foot = el(`
    <footer class="s-foot">
      <div class="s-wrap">
        <div class="s-cols">
          <div><a class="s-fword" href="/" aria-label="Basu, нүүр хуудас">Basu</a></div>
          <nav aria-label="Идэш"><b class="s-lab">Идэш</b><ul><li><a href="/shop">Зах</a></li><li><a href="/orders">Миний захиалга</a></li></ul></nav>
          <nav aria-label="Хоол" data-store><b class="s-lab">Хоол</b><ul><li><a href="${APP_STORE}">iPhone апп</a></li></ul></nav>
          <nav aria-label="Бизнес"><b class="s-lab">Бизнес</b><ul><li><a href="/supplier">Нийлүүлэгч</a></li><li><a href="/dashboard?join=business">Бүртгүүлэх</a></li></ul></nav>
          <div><b class="s-lab">Холбоо</b><ul><li><a href="mailto:basuappmn@gmail.com">basuappmn@gmail.com</a></li></ul></div>
        </div>
        <div class="s-fbot"><span>© ${new Date().getFullYear()} Basu · Улаанбаатар</span><nav aria-label="Нөхцөл"><a href="/privacy">Нууцлал</a><a href="/terms">Үйлчилгээний нөхцөл</a></nav></div>
      </div>
    </footer>`);
  if (/Android/i.test(navigator.userAgent)) for (const node of foot.querySelectorAll('[data-store]')) node.hidden = true;
  return foot;
}

/**
 * The header and the foot, around a page's own <main>. `active` names the
 * header link to mark. On a phone the links fold into a menu under the bar:
 * a button at the end opens it, Esc or a press outside closes it.
 *
 * A page draws the bar in its own HTML too, so the first paint already has
 * it and nothing under it moves when this one comes: the same height, the
 * wordmark and the links, no account and no menu button yet —
 *
 *   <header class="s-bar" data-static><div class="s-wrap"><a class="s-word" href="/">Basu</a>
 *     <nav class="s-nav" aria-label="Цэс"><a href="/home">Нүүр</a><a href="/shop">Идэш</a>
 *     <a href="/orders">Миний захиалга</a><a href="/dashboard">Бизнес</a></nav>
 *     <div class="s-right"></div></div></header>
 *
 * (`aria-current="page"` on the page's own link). This one takes its place;
 * a page without one gets the bar put in front of everything.
 *
 * The foot comes once the page has drawn what it was loading — nothing in
 * its <main> still `aria-busy="true"` (or after a few seconds, whatever the
 * page is doing). Put in under a skeleton, it sat in the first screen and was
 * pushed out of it when the page filled.
 */
export function mountFrame(active) {
  const link = ([key, href, label, icon, short], withIcon) =>
    `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${withIcon ? `${ICON[icon]}${label}` : (short ?? label)}</a>`;
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
  const foot = siteFoot();

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

  const drawn = document.querySelector('header.s-bar[data-static]');
  if (drawn) drawn.replaceWith(bar);
  else document.body.prepend(bar);
  // The lines a screen reader hears `say` on, in place before anything is said.
  liveLines();
  // Asked once the page's own script has drawn its first shapes (a microtask on: it runs on until it awaits).
  queueMicrotask(() => {
    const loading = () => Boolean(document.querySelector('main [aria-busy="true"]'));
    if (!loading()) return void document.body.append(foot);
    const put = () => {
      watch.disconnect();
      clearTimeout(late);
      if (!foot.isConnected) document.body.append(foot);
    };
    const watch = new MutationObserver(() => !loading() && put());
    watch.observe(document.querySelector('main') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
    const late = setTimeout(put, 8000);
  });
  return accountSlot(bar.querySelector('#s-account'));
}

/**
 * Where a screen reader hears what `say` shows: two unseen lines kept on the
 * page from its start — `#s-said` (role=status) for what is done, `#s-alarm`
 * (role=alert) for what failed. A live region put in with its words already
 * in it, as the toast is, is often not read out at all; words changed in one
 * that was there before are. mountFrame puts them in.
 */
function liveLines() {
  if (!document.getElementById('s-said')) {
    document.body.append(el('<div class="s-sr" id="s-said" role="status"></div>'), el('<div class="s-sr" id="s-alarm" role="alert"></div>'));
  }
  return { said: document.getElementById('s-said'), alarm: document.getElementById('s-alarm') };
}

/**
 * Words into a live line, to be heard. While a popup is open the page behind
 * it sleeps (api.js puts it `inert`), the live lines with it, and words put
 * into a sleeping line are never read out — `say` is often called from inside
 * a popup's answer, just before it closes. So they wait for the page to wake,
 * and come a moment after, once the line is back where a screen reader looks.
 */
function speak(line, message) {
  if (!line.closest('[inert]')) {
    line.textContent = message;
    return;
  }
  const watch = new MutationObserver(() => {
    if (line.closest('[inert]')) return;
    watch.disconnect();
    setTimeout(() => (line.textContent = message), 120);
  });
  watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['inert'] });
}

/**
 * A message at the bottom of the screen, for a moment: `good` once something
 * is done, `bad` when it failed. The toast is for the eye; the same words go
 * to the live lines for the ear (liveLines), so they are said once.
 */
export function say(message, tone) {
  const { said, alarm } = liveLines();
  said.textContent = '';
  alarm.textContent = '';
  speak(tone === 'bad' ? alarm : said, message);
  document.querySelector('.s-toast')?.remove();
  const box = el(`<div class="s-toast" aria-hidden="true"${tone ? ` data-tone="${tone}"` : ''}></div>`);
  box.textContent = message;
  document.body.append(box);
  setTimeout(() => box.remove(), tone === 'bad' ? 6000 : 4200);
}

/* ── pieces the pages share ────────────────────────────────────────── */

/** An amount for markup: the digits, and the ₮ set in the sans beside them. Its text is what mnt() says. */
export const tugrik = (value) => `${Number(value).toLocaleString('mn-MN')}<span class="cur">₮</span>`;

/**
 * An идэш's state, the same on every page that shows one: its one word and
 * the four bars under it (api.js ideshStage) — paid, being prepared, ready,
 * on the road or handed over. Cancelled and refunded are the word alone.
 */
export const statePill = (state) => ideshStage(state);

/**
 * A cancelled order that is still going on says what its money waits for,
 * in a word and no bars: the guest's bank account — a step that is theirs,
 * in the gold that asks for one — or Basu's transfer, quietly.
 */
export const refundPill = (refund) =>
  refund === 'needs_account'
    ? '<span class="stage" data-s="CANCELLED" data-tone="hold"><b>Данс оруулна уу</b></span>'
    : '<span class="stage" data-s="CANCELLED" data-tone="quiet"><b>Буцаалт хүлээгдэж байна</b></span>';

/**
 * What of the person's is still going on — «Идэвхтэй» on /home and /orders
 * alike: the meat paid for and not yet in their hands (IDESH_LIVE), and a
 * cancelled order whose money is still on its way back. The server's own
 * live list (GET /v1/idesh, the app's launcher's) carries both; it keeps a
 * handed-over order too, until it closes, which the website counts as done.
 * Each order comes with `refund`: null, or for a cancelled one its refund's
 * state, asked of the order itself — «needs_account» while it waits for the
 * guest's bank account, «due» while it waits for Basu's transfer. Nothing,
 * when it cannot be asked.
 */
export async function stillGoing() {
  const token = store.guestToken;
  const ask = (path) => (token ? api(path, { token }).catch(() => null) : Promise.resolve(null));
  const live = (await ask('/v1/idesh'))?.orders ?? [];
  return Promise.all(
    live
      .filter((o) => IDESH_LIVE.includes(o.state) || o.state === 'CANCELLED')
      .map(async (o) => (o.state === 'CANCELLED' ? { ...o, refund: (await ask(`/v1/idesh/${o.id}`))?.refund?.state ?? 'due' } : { ...o, refund: null })),
  );
}

/** An animal's photo at the size a row or a card shows it — not the landing's large one. */
export const meatPhoto = (of) => `/brand/meat/${photoOf(of)}-480.webp`;

/**
 * An empty place that says what it is for and gives the one next step:
 * `actions` are [label, href, 'dark' | 'line'] — at most one dark. `heading`
 * (1 or 2) when the empty place is all the page has to say — a listing or an
 * order that is not there, a page that could not load: its title is then the
 * page's heading, for a screen reader's list of headings, looking the same.
 */
export function siteEmpty({ icon = 'info', title, text = '', actions = [], card = false, heading = 0 }) {
  const tag = heading === 1 || heading === 2 ? `h${heading}` : 'b';
  return el(`
    <div class="s-empty${card ? ' s-card' : ''}">
      <span class="s-mark" aria-hidden="true">${ICON[icon] ?? ICON.info}</span>
      <${tag} class="s-empty-title">${esc(title)}</${tag}>${text ? `<p>${esc(text)}</p>` : ''}
      ${actions.length ? `<div class="s-acts">${actions.map(([label, href, kind = 'line']) => `<a class="s-btn s-btn-${kind}" href="${esc(href)}">${esc(label)}</a>`).join('')}</div>` : ''}
    </div>`);
}

/** What the paying step says, while money can be taken and while it cannot. */
export const PAY_STEP = { open: 'QPay-ээр шууд төл.', closed: 'Онлайн төлбөр одоогоор хаалттай байна.' };

/**
 * How an идэш goes, in the front page's three steps — a verb each, a gold
 * numeral before it: for wherever somebody is about to start one. The paying
 * step says how it stands: while online payment is closed (the listings'
 * `payments_open`) it is not offered as something to do now. `paymentsOpen`
 * when the page has asked already; without it, the listings are asked here.
 */
export function howToBuy({ paymentsOpen } = {}) {
  const box = el(`
    <section class="s-how" aria-labelledby="s-how-title">
      <h2 id="s-how-title">Гурван алхам</h2>
      <ol>
        <li><i aria-hidden="true">1</i><b>Сонгох</b><span>Мал, жин, авах өдрөө сонго.</span></li>
        <li data-pay><i aria-hidden="true">2</i><b>Төлөх</b><span>${paymentsOpen === false ? PAY_STEP.closed : PAY_STEP.open}</span></li>
        <li><i aria-hidden="true">3</i><b>Авах</b><span>Өөрөө ав, эсвэл хүргүүл.</span></li>
      </ol>
    </section>`);
  if (paymentsOpen === undefined) {
    api('/v1/idesh/listings')
      .then((answer) => {
        if (answer?.payments_open === false) box.querySelector('[data-pay] span').textContent = PAY_STEP.closed;
      })
      .catch(() => {});
  }
  return box;
}
