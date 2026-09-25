/* The desk's frame, shared by the dashboard and the supplier's own screen on
   a computer.

   One sidebar for every place a person works — Basu's desk, a business,
   their own corner — drawn from what /v1/access says they may open, and
   nothing else: a page the server would refuse is never drawn, so there is
   no second list here to fall out of step with the server's. At the top the
   place itself, as a switcher; under it the place's menu, one group per
   module, each group folding away; at the foot the person, and the way out.
   On a phone the same sidebar is a drawer behind a menu button.

   Kept free of imports, and every top-level name starts with nav or NAV, so
   the page tests can inline it beside api.js without a clash. */

/** Every icon a menu may name. Line icons on a 24 grid, stroked by the sheet. */
export const NAV_ICON = {
  overview: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
  guests: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.9-3.8 3.5-5.6 7-5.6s6.1 1.8 7 5.6"/></svg>',
  money: '<svg viewBox="0 0 24 24"><path d="M4 7h16v11H4z"/><path d="M4 11h16M8 7V5h8v2"/><circle cx="12" cy="14.5" r="1.6"/></svg>',
  notify: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 10l2 2 2-2 2 2 2-2"/></svg>',
  venues: '<svg viewBox="0 0 24 24"><path d="M4 10l1.5-5h13L20 10"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  lunches: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/></svg>',
  reviews: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M4 19h16M7 16V9M12 16V5M17 16v-6"/></svg>',
  orders: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h4"/></svg>',
  suppliers: '<svg viewBox="0 0 24 24"><path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M6 12v8h12v-8"/></svg>',
  pay: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M15.5 15h2"/></svg>',
  org: '<svg viewBox="0 0 24 24"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-4h6v4M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01"/></svg>',
  members: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2"/><path d="M3 20c.8-3.2 3-4.8 6-4.8s5.2 1.6 6 4.8"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 15.2c2.6.2 4.4 1.6 5 4.8"/></svg>',
  audit: '<svg viewBox="0 0 24 24"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="8.5"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  today: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8 3v4M16 3v4M8 14h3"/></svg>',
  stall: '<svg viewBox="0 0 24 24"><path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M6 12v8h12v-8M10 20v-5h4v5"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.5 3.6-5 7-5s6 1.5 7 5"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M7 4v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V4M9 4v16"/><path d="M16 4c-1.7 1.3-2.5 3.3-2.5 6v3H17V4zM16.5 13v7"/></svg>',
  kitchen: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4M7 9h4M7 12h7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  updown: '<svg viewBox="0 0 24 24"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>',
  burger: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  bowl: '<svg viewBox="0 0 24 24"><path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  layout: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M9 10h12"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>',
  truck: '<svg viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
  away: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};

/**
 * The frame, built once per workspace.
 *
 * `workspaces` and `current` are /v1/access's; `account` is the person, or
 * null for the demo's shared secret. `onPage(item)` is called with the menu
 * item chosen — the page decides what that means, including leaving for the
 * page an item's `href` names. `onWorkspace(ws)` and `onSignOut()` are the
 * switcher's and the foot's; `actions` are extra lines at the bottom of the
 * switcher (register a business), reported through `onAction(key)`.
 *
 * Returns the root to mount, the element pages draw into, and three handles:
 * `select(key)` marks the open page, `badge(key, n, hot)` sets a count, and
 * `title(text)` names the page in the phone's bar.
 */
export function deskFrame({ workspaces, current, account, brand = 'Dashboard', onPage, onWorkspace, onSignOut, actions = [], onAction = () => {} }) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (name) => NAV_ICON[name] ?? NAV_ICON.overview;
  /** Two letters that stand for a name: the first of its first two words. */
  const initials = (name) =>
    String(name ?? '?')
      .replace(/[«»"'.,()·]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';
  const mark = (ws) => `<span class="ws-mark" data-kind="${ws.kind}" aria-hidden="true">${ws.kind === 'desk' ? 'B' : esc(initials(ws.name))}</span>`;

  /* ── folded groups, remembered per kind of place ── */
  const SHUT_KEY = 'basu.nav.shut';
  const shut = (() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(SHUT_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  })();
  const keep = () => {
    try {
      localStorage.setItem(SHUT_KEY, JSON.stringify([...shut]));
    } catch {
      /* private window: the fold lasts as long as the page */
    }
  };
  const shutKey = (group) => `${current.kind}:${group}`;

  /**
   * One page of the menu. At the top a page wears its own icon; under a
   * module the module's icon speaks for all of them, and the page is text
   * on the module's guide line. A link to elsewhere says so, and opens apart.
   */
  const item = (it, sub) => {
    const away = Boolean(it.href && /^https?:/.test(it.href));
    const inner = `${sub ? '' : icon(it.icon)}<span class="t">${esc(it.label)}</span>${away ? `<span class="away" aria-label="шинэ цонхонд">${NAV_ICON.away}</span>` : ''}<span class="n" data-badge="${esc(it.key)}" hidden></span>`;
    const cls = sub ? 'nav-item sub' : 'nav-item';
    return it.href
      ? `<a class="${cls}" data-tab="${esc(it.key)}" href="${esc(it.href)}"${away ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`
      : `<button class="${cls}" type="button" data-tab="${esc(it.key)}">${inner}</button>`;
  };
  const groups = current.menu
    .map((g) => {
      if (!g.label) return `<div class="nav-top">${g.items.map((it) => item(it, false)).join('')}</div>`;
      const id = `nav-${current.kind}-${g.key}`;
      const open = !shut.has(shutKey(g.key));
      return `<section class="nav-mod" data-group="${esc(g.key)}"${open ? '' : ' data-shut'}>
          <button class="mod" type="button" aria-expanded="${open}" aria-controls="${id}">${icon(g.icon)}<span class="t">${esc(g.label)}</span><span class="n" data-mod-badge hidden></span>${NAV_ICON.chev}</button>
          <div class="mod-items" id="${id}" role="group" aria-label="${esc(g.label)}">${g.items.map((it) => item(it, true)).join('')}</div>
        </section>`;
    })
    .join('');

  // A steady order, whichever is open: Basu's desk, the businesses running, the ones waiting, the person's own corner.
  const rank = (w) => (w.kind === 'desk' ? 0 : w.kind === 'org' ? (w.state === 'active' || !w.state ? 1 : 2) : 3);
  const listed = workspaces.map((w, i) => [w, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([w]) => w);
  const who = account ? account.name || account.email || account.phone || 'Нэргүй' : 'Демо';
  const contact = account ? account.email || account.phone || '' : 'Хуваалцсан нууц үг';

  const t = document.createElement('template');
  t.innerHTML = `
    <div class="app desk-frame">
      <header class="deskbar">
        <button class="nav-open" type="button" aria-label="Цэс" aria-controls="sidebar" aria-expanded="false">${NAV_ICON.burger}</button>
        <div class="deskbar-t"><b data-title></b><span>${esc(current.name)}</span></div>
      </header>
      <aside class="side sidebar" id="sidebar" aria-label="Хажуугийн цэс">
        <div class="brand"><b>Basu</b><span>${esc(brand)}</span><button class="nav-close" type="button" aria-label="Цэс хаах">${NAV_ICON.close}</button></div>
        <div class="ws">
          <button class="ws-btn" type="button" aria-haspopup="menu" aria-expanded="false"${workspaces.length > 1 || actions.length ? '' : ' disabled'}>
            ${mark(current)}
            <span class="ws-text"><b>${esc(current.name)}</b><small>${esc(current.sub)}</small></span>
            ${workspaces.length > 1 || actions.length ? NAV_ICON.updown : ''}
          </button>
          <div class="ws-menu" role="menu" hidden>
            <div class="ws-lab">Ажлын орчин</div>
            ${listed
              .map(
                (w) => `<button class="ws-opt" type="button" role="menuitemradio" aria-checked="${w.id === current.id}" data-ws="${esc(w.id)}">
                  ${mark(w)}<span class="ws-text"><b>${esc(w.name)}</b><small>${esc(w.sub)}</small></span>${w.id === current.id ? NAV_ICON.check : ''}
                </button>`,
              )
              .join('')}
            ${actions.length ? `<div class="ws-sep" role="separator"></div>${actions.map((a) => `<button class="ws-act" type="button" role="menuitem" data-act="${esc(a.key)}">${icon(a.icon)}<span>${esc(a.label)}</span></button>`).join('')}` : ''}
          </div>
        </div>
        <nav class="tabs" aria-label="Хэсгүүд">${groups}</nav>
        <div class="acct">
          <span class="av" aria-hidden="true">${esc(initials(who))}</span>
          <span class="who"><b>${esc(who)}</b><small>${esc(contact)}</small></span>
          <button class="out" type="button" id="out" aria-label="Гарах" title="Гарах">${NAV_ICON.out}</button>
        </div>
      </aside>
      <div class="nav-scrim" hidden></div>
      <main class="main"><div class="page" id="view"></div></main>
    </div>`;
  const root = t.content.firstElementChild;
  const side = root.querySelector('.sidebar');
  const scrim = root.querySelector('.nav-scrim');
  const opener = root.querySelector('.nav-open');
  const wsBtn = root.querySelector('.ws-btn');
  const wsMenu = root.querySelector('.ws-menu');

  /* ── the drawer, on a phone ── */
  const drawer = (open) => {
    side.toggleAttribute('data-open', open);
    scrim.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    document.documentElement.toggleAttribute('data-nav-open', open);
  };
  opener.addEventListener('click', () => drawer(true));
  root.querySelector('.nav-close').addEventListener('click', () => drawer(false));
  scrim.addEventListener('click', () => drawer(false));

  /* ── the switcher ── */
  const menu = (open) => {
    wsMenu.hidden = !open;
    wsBtn.setAttribute('aria-expanded', String(open));
    if (open) wsMenu.querySelector('.ws-opt[aria-checked="false"], .ws-act')?.focus();
  };
  wsBtn.addEventListener('click', () => menu(wsMenu.hidden));
  wsMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-ws]');
    const act = e.target.closest('[data-act]');
    if (!opt && !act) return;
    menu(false);
    drawer(false);
    if (act) return onAction(act.dataset.act);
    if (opt.dataset.ws === current.id) return;
    onWorkspace(workspaces.find((w) => w.id === opt.dataset.ws));
  });
  const away = (e) => {
    if (!root.isConnected) return document.removeEventListener('click', away);
    if (!wsMenu.hidden && !e.target.closest('.ws')) menu(false);
  };
  document.addEventListener('click', away);
  root.addEventListener('keydown', (e) => {
    if (!wsMenu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Up and down move through the places and the actions, round and round.
      const lines = [...wsMenu.querySelectorAll('.ws-opt, .ws-act')];
      const at = lines.indexOf(document.activeElement);
      lines[(at + (e.key === 'ArrowDown' ? 1 : -1) + lines.length) % lines.length]?.focus();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Escape') return;
    if (!wsMenu.hidden) {
      menu(false);
      wsBtn.focus();
    } else if (side.hasAttribute('data-open')) drawer(false);
  });

  /* ── the modules fold ── */
  for (const button of root.querySelectorAll('.nav-mod > .mod')) {
    button.addEventListener('click', () => {
      const box = button.parentElement;
      const open = box.hasAttribute('data-shut');
      box.toggleAttribute('data-shut', !open);
      button.setAttribute('aria-expanded', String(open));
      if (open) shut.delete(shutKey(box.dataset.group));
      else shut.add(shutKey(box.dataset.group));
      keep();
    });
  }

  /* ── the pages ── */
  const items = current.menu.flatMap((g) => g.items);
  root.querySelector('.tabs').addEventListener('click', (e) => {
    const node = e.target.closest('[data-tab]');
    if (!node) return;
    const it = items.find((x) => x.key === node.dataset.tab);
    if (!it) return;
    // A link to another page leaves by itself, unless the page says it draws that item here.
    if (node.tagName === 'A') {
      if (node.target === '_blank' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (onPage(it) === false) return;
      e.preventDefault();
    } else onPage(it);
    drawer(false);
  });
  root.querySelector('#out').addEventListener('click', () => onSignOut());

  const title = (text) => {
    root.querySelector('[data-title]').textContent = text ?? '';
  };
  const select = (key) => {
    for (const box of root.querySelectorAll('.nav-mod')) box.removeAttribute('data-here');
    for (const node of root.querySelectorAll('.tabs [data-tab]')) {
      const on = node.dataset.tab === key;
      node.toggleAttribute('data-on', on);
      if (on) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
      if (!on) continue;
      // The open page's module is marked, and never folded shut over it.
      const box = node.closest('.nav-mod');
      if (box) {
        box.setAttribute('data-here', '');
        box.removeAttribute('data-shut');
        box.querySelector('.mod')?.setAttribute('aria-expanded', 'true');
      }
    }
    const it = items.find((x) => x.key === key);
    title(it?.label ?? '');
  };
  /** A count on a page, and the module's total beside its name for when the module is folded. */
  const badge = (key, n, hot) => {
    const b = [...root.querySelectorAll('[data-badge]')].find((node) => node.dataset.badge === key);
    if (!b) return;
    b.hidden = !n;
    b.textContent = String(n);
    b.toggleAttribute('data-hot', Boolean(hot));
    const box = b.closest('.nav-mod');
    if (!box) return;
    const counts = [...box.querySelectorAll('[data-badge]:not([hidden])')];
    const total = counts.reduce((sum, c) => sum + Number(c.textContent || 0), 0);
    const sum = box.querySelector('[data-mod-badge]');
    sum.hidden = !total;
    sum.textContent = String(total);
    sum.toggleAttribute('data-hot', counts.some((c) => c.hasAttribute('data-hot')));
  };
  return { root, view: root.querySelector('#view'), select, badge, title, close: () => drawer(false) };
}
