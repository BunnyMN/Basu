/* The dashboard's data tables.

   One way to show a list of anything on the desk: a toolbar (search, the
   filters that matter for that list, how many rows), a table whose headers
   sort, and pages of 25 at a time. What rows there are, how they sort, what
   a search finds and which page is showing is TanStack Table's (table-core
   v8, vendored at /vendor/table-core.js as the global `TableCore`); how it
   looks is ours — the design system's type, hairlines and pills, and on a
   phone every row folds into a card with its column names beside the
   values.

   Kept free of imports, and every top-level name starts with dt or DT, so
   the page tests can inline it beside api.js and sidenav.js without a clash. */

const DT_SIZES = [25, 50, 100];

const DT_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4-4 4 4M8 14l4 4 4-4"/></svg>';
const DT_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>';
const DT_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const DT_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>';
const DT_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
/** The empty list's mark (an inbox) and the «nothing found» one (a lens) — line icons like the menu's. */
const DT_EMPTY = '<svg viewBox="0 0 24 24"><path d="M3.5 13h4.5l1.5 2.5h5l1.5-2.5h4.5"/><path d="M6 5h12l2.5 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5z"/></svg>';
const DT_FOUND_NONE = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>';

/** A moment's month, day and clock in Ulaanbaatar, for `dtCell.when`. */
const DT_UB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function dtEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dtEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** A value as the search reads it: lowercase, and nothing for nothing. */
const dtText = (value) => (value === null || value === undefined ? '' : String(value).toLowerCase());

function dtRemembered(key) {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function dtRemember(key, value) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a private window keeps nothing; the table works the same */
  }
}

/**
 * The cells a list is made of, so every table says the same thing the same
 * way. Each returns HTML; what goes in is escaped here.
 */
export const dtCell = {
  /** A name, and one quiet line under it. */
  two: (title, sub) => `<span class="dt-two"><b>${dtEsc(title)}</b>${sub ? `<small>${dtEsc(sub)}</small>` : ''}</span>`,
  /** The same, when the lines are already HTML. */
  twoHtml: (title, sub) => `<span class="dt-two"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>`,
  /** A state: its word, in the tone the design system gives that state. */
  pill: (state, word) => `<span class="pill" data-s="${dtEsc(state)}">${dtEsc(word)}</span>`,
  /** Tugriks, whole, with the sign after. */
  money: (mnt) =>
    mnt === null || mnt === undefined ? '<span class="dt-none">—</span>' : `<span class="dt-num">${Number(mnt).toLocaleString('en-US')}<span class="cur">₮</span></span>`,
  /** A count, or a figure. */
  num: (n) => (n === null || n === undefined ? '<span class="dt-none">—</span>' : `<span class="dt-num">${Number(n).toLocaleString('en-US')}</span>`),
  /** Anything in the mono face: a phone, a code, a TIN. */
  mono: (text) => (text ? `<span class="mono">${dtEsc(text)}</span>` : '<span class="dt-none">—</span>'),
  /** A Mongolian number as people read it, «+976 9911 2233»; anything else as it came. */
  phone: (value) => {
    if (!value) return '<span class="dt-none">—</span>';
    const m = /^(?:\+?976)?(\d{4})(\d{4})$/.exec(String(value).replace(/[\s-]/g, ''));
    return `<span class="mono dt-phone">${dtEsc(m ? `+976 ${m[1]} ${m[2]}` : value)}</span>`;
  },
  /**
   * A date and its time, as one short run: «9-р сарын 28 · 14:05» — both
   * Ulaanbaatar's, whatever zone the computer is set to (api.js ubParts).
   */
  when: (iso) => {
    if (!iso) return '<span class="dt-none">—</span>';
    const p = Object.fromEntries(DT_UB.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    const time = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
    return `<span class="dt-when">${Number(p.month)}-р сарын ${Number(p.day)}<small>${time}</small></span>`;
  },
  /** Nothing to say. */
  none: () => '<span class="dt-none">—</span>',
};

/**
 * A table of `rows`, drawn from `columns`:
 *
 *   { key, label, value?(row), render?(row), sort?: false, align?: 'end',
 *     width?, phone?: false, sortValue?(row) }
 *
 * `value` is what the column sorts and searches by (the row's `key` field
 * when not given); `render` is what the cell shows, HTML or a node. Options:
 *
 *   search: { placeholder, text?(row) } | false — what a search reads; or
 *           `onSearch(q)` to ask the server instead and `setRows` the answer
 *   filters: [{ key, label, options: [[value, word]], test?(row, value), initial?, kind?: 'seg' | 'select' }]
 *            — a filter without `test` is the server's: a change calls
 *            `onFilter(values)`, and the page fetches and `setRows` again
 *   sort: { key, desc }         the order it opens in
 *   onRow(row, event)           a click on the row
 *   actions(row) → node(s)      the last cell: buttons that are not the row's click
 *   rowAttrs(row) → {attr: v}   extra attributes on the <tr> (hooks for tests and pages)
 *   tools: [node]               buttons at the end of the toolbar: CSV, «Нэмэх»
 *   empty: { title, text, icon?, action? }
 *                               what an empty list says, as the design system's
 *                               empty-state block: `icon` an svg (sidenav's
 *                               NAV_ICON.orders) — an inbox when not given —
 *                               and `action` one node (the next step's button)
 *   noun: 'захиалга'            what one row is, for the count
 *   stateKey                    where the sort and page size are remembered
 *   pageSize                    25 unless said
 *   dense: true                 tighter rows, for long lists read at a glance
 *
 * Returns `{ el, setRows(rows), rows() }`. Rows can arrive later: until the
 * first `setRows` the table shows the shape of what is coming, at the size of
 * the rows that will replace it. A list with nothing in it at all (and
 * nothing searched or filtered) shows its empty block without a header row;
 * a search or a filter that finds nothing — here or on the server — says
 * «Олдсонгүй» and offers to take it back: «Хайлтыг цэвэрлэх», «Шүүлтүүрийг
 * цэвэрлэх» (every filter back to its first choice).
 */
export function dataTable(options) {
  const {
    columns,
    search = { placeholder: 'Хайх…' },
    filters = [],
    onRow = null,
    actions = null,
    rowAttrs = null,
    tools = [],
    empty = { title: 'Алга', text: '' },
    noun = 'мөр',
    stateKey = null,
    onSearch = null,
    onFilter = null,
    dense = false,
  } = options;
  const remembered = dtRemembered(stateKey);
  let all = options.rows ?? null;
  const chosen = Object.fromEntries(filters.map((f) => [f.key, remembered.filters?.[f.key] ?? f.initial ?? f.options[0]?.[0]]));

  const root = dtEl(`
    <section class="dt">
      <div class="dt-bar">
        ${search ? `<label class="dt-search"><input type="search" placeholder="${dtEsc(search.placeholder ?? 'Хайх…')}" aria-label="${dtEsc(search.placeholder ?? 'Хайх')}" autocomplete="off" spellcheck="false"></label>` : ''}
        <div class="dt-filters"></div>
        <div class="dt-tools"></div>
        <span class="dt-count" aria-live="polite"></span>
      </div>
      <div class="dt-wrap"><table class="dt-table"><thead></thead><tbody></tbody></table></div>
      <div class="dt-foot" hidden>
        <span class="dt-range"></span>
        <label class="dt-size"><span>Хуудсанд</span><select aria-label="Хуудсанд хэдэн мөр">${DT_SIZES.map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <div class="dt-pages"></div>
      </div>
    </section>`);
  const $ = (selector) => root.querySelector(selector);
  if (dense) root.setAttribute('data-dense', '');
  for (const tool of tools) if (tool) $('.dt-tools').append(tool);
  // A short list with nothing to search, filter or press says how many rows in its table's own heading, not in a bar of its own.
  if (!search && !filters.length && !tools.filter(Boolean).length) $('.dt-bar').hidden = true;

  /* ── the model: TanStack's ── */

  const sortingFns = {
    // Mongolian names sort as Mongolian; a missing value goes last whichever way.
    mn: (a, b, id) => String(a.getValue(id) ?? '').localeCompare(String(b.getValue(id) ?? ''), 'mn', { numeric: true }),
  };
  const defs = columns.map((c) => ({
    id: c.key,
    header: c.label,
    accessorFn: c.sortValue ?? c.value ?? ((row) => row[c.key]),
    enableSorting: c.sort !== false,
    sortingFn: c.numeric ? 'basic' : 'mn',
    sortUndefined: 'last',
    meta: c,
  }));
  const haystack = new WeakMap();
  const hay = (row) => {
    if (!haystack.has(row)) {
      const parts = search && search.text ? [search.text(row)] : columns.map((c) => (c.value ? c.value(row) : row[c.key]));
      haystack.set(row, parts.flat().map(dtText).join(' '));
    }
    return haystack.get(row);
  };
  const visibleRows = () => (all ?? []).filter((row) => filters.every((f) => !f.test || f.test(row, chosen[f.key])));

  const table = TableCore.createTable({
    data: [],
    columns: defs,
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
    sortingFns,
    getCoreRowModel: TableCore.getCoreRowModel(),
    getSortedRowModel: TableCore.getSortedRowModel(),
    getFilteredRowModel: TableCore.getFilteredRowModel(),
    getPaginationRowModel: TableCore.getPaginationRowModel(),
    getColumnCanGlobalFilter: () => true,
    globalFilterFn: (row, _column, q) => !q || hay(row.original).includes(q),
    autoResetPageIndex: false,
  });
  let state = {
    ...table.initialState,
    sorting: remembered.sort ?? (options.sort ? [{ id: options.sort.key, desc: Boolean(options.sort.desc) }] : []),
    pagination: { pageIndex: 0, pageSize: remembered.size ?? options.pageSize ?? DT_SIZES[0] },
    globalFilter: '',
  };
  const sync = () =>
    table.setOptions((prev) => ({
      ...prev,
      data: visibleRows(),
      state,
      onStateChange: (updater) => {
        state = typeof updater === 'function' ? updater(state) : updater;
        dtRemember(stateKey, { sort: state.sorting, size: state.pagination.pageSize, filters: chosen });
        sync();
        draw();
      },
    }));

  /* ── the toolbar ── */

  /** Each filter's control, shown a choice made from elsewhere — every filter cleared at once — and its control for the focus. */
  const dtShown = {};
  for (const f of filters) {
    if (f.kind === 'select') {
      const select = dtEl(`<select class="input dt-select" aria-label="${dtEsc(f.label)}">${f.options.map(([v, w]) => `<option value="${dtEsc(v)}">${dtEsc(w)}</option>`).join('')}</select>`);
      select.value = chosen[f.key];
      select.addEventListener('change', () => refilter(f.key, select.value));
      $('.dt-filters').append(select);
      dtShown[f.key] = (value) => {
        select.value = String(value);
        return select;
      };
    } else {
      const seg = dtEl(`<div class="seg dt-seg" role="group" aria-label="${dtEsc(f.label)}"></div>`);
      const buttons = [];
      // The chosen one is said to a reader too (aria-pressed), not only drawn (data-on).
      const press = (b, on) => {
        b.toggleAttribute('data-on', on);
        b.setAttribute('aria-pressed', String(on));
      };
      for (const [v, w] of f.options) {
        const b = dtEl(`<button type="button" data-v="${dtEsc(v)}">${dtEsc(w)}</button>`);
        press(b, v === chosen[f.key]);
        b.addEventListener('click', () => {
          for (const other of seg.children) press(other, other === b);
          refilter(f.key, v);
        });
        seg.append(b);
        buttons.push([b, v]);
      }
      $('.dt-filters').append(seg);
      dtShown[f.key] = (value) => {
        for (const [b, v] of buttons) press(b, v === value);
        return buttons.find(([, v]) => v === value)?.[0] ?? null;
      };
    }
  }
  /** A filter's first choice: the list as it opens, and what «Шүүлтүүрийг цэвэрлэх» goes back to. */
  const dtFirst = (f) => f.initial ?? f.options[0]?.[0];
  function refilter(key, value) {
    chosen[key] = value;
    state = { ...state, pagination: { ...state.pagination, pageIndex: 0 } };
    dtRemember(stateKey, { sort: state.sorting, size: state.pagination.pageSize, filters: chosen });
    if (!filters.find((f) => f.key === key)?.test) onFilter?.({ ...chosen });
    sync();
    draw();
  }
  /** Every filter back to its first choice, in one go: one fetch when a server's filter was among them. */
  function unfilter() {
    let server = false;
    let first = null;
    for (const f of filters) {
      if (chosen[f.key] === dtFirst(f)) continue;
      chosen[f.key] = dtFirst(f);
      const control = dtShown[f.key]?.(chosen[f.key]) ?? null;
      first ??= control;
      if (!f.test) server = true;
    }
    state = { ...state, pagination: { ...state.pagination, pageIndex: 0 } };
    dtRemember(stateKey, { sort: state.sorting, size: state.pagination.pageSize, filters: chosen });
    if (server) onFilter?.({ ...chosen });
    sync();
    draw();
    // The button pressed is gone with the row it stood in: the keyboard goes to the first filter it moved.
    first?.focus?.();
  }

  const input = $('.dt-search input');
  if (input) {
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      if (onSearch) {
        timer = setTimeout(() => onSearch(input.value.trim()), 250);
        return;
      }
      table.setGlobalFilter(input.value.trim().toLowerCase());
      table.setPageIndex(0);
    });
  }
  const sizer = $('.dt-size select');
  sizer.value = String(state.pagination.pageSize);
  sizer.addEventListener('change', () => table.setPageSize(Number(sizer.value)));

  /* ── the table ── */

  function drawHead() {
    const tr = document.createElement('tr');
    for (const header of table.getHeaderGroups()[0].headers) {
      const c = header.column.columnDef.meta;
      const th = document.createElement('th');
      th.scope = 'col';
      th.dataset.key = c.key;
      if (c.align === 'end') th.dataset.align = 'end';
      if (c.width) th.style.width = c.width;
      if (c.phone === false) th.dataset.phone = 'off';
      const sorted = header.column.getIsSorted();
      if (header.column.getCanSort()) {
        th.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none');
        const b = dtEl(`<button type="button" class="dt-sort"${sorted ? ` data-sorted="${sorted}"` : ''}><span>${dtEsc(c.label)}</span>${sorted === 'asc' ? DT_UP : sorted === 'desc' ? DT_DOWN : DT_ARROW}</button>`);
        b.addEventListener('click', header.column.getToggleSortingHandler());
        th.append(b);
      } else {
        th.textContent = c.label;
      }
      tr.append(th);
    }
    if (actions) tr.append(dtEl('<th class="dt-act" scope="col"><span class="sr-only">Үйлдэл</span></th>'));
    $('thead').replaceChildren(tr);
  }

  function drawBody() {
    const tbody = $('tbody');
    tbody.replaceChildren();
    // While it loads the table says it is busy; the shape of the rows is for the eye only, never read out as empty cells.
    if (all === null) $('.dt-table').setAttribute('aria-busy', 'true');
    else $('.dt-table').removeAttribute('aria-busy');
    if (all === null) {
      // The shape of what is coming, while it loads, at the size of the rows
      // that will replace it: a name and a line under it first, numbers at
      // the right, the action's button at the end.
      const cells = columns
        .map((c, i) => `<td${c.align === 'end' ? ' data-align="end"' : ''}${c.phone === false ? ' data-phone="off"' : ''}><span class="skel"></span>${i === 0 ? '<span class="skel"></span>' : ''}</td>`)
        .join('');
      for (let i = 0; i < 4; i++) tbody.append(dtEl(`<tr class="dt-skel" aria-hidden="true">${cells}${actions ? '<td class="dt-act"><span class="skel"></span></td>' : ''}</tr>`));
      root.removeAttribute('data-empty');
      root.removeAttribute('data-bare');
      return;
    }
    const rows = table.getRowModel().rows;
    if (!rows.length) {
      const nothing = all.length === 0;
      const query = input?.value.trim() ?? '';
      // What narrowed it: a search, and the filters off their first choice.
      const moved = filters.filter((f) => chosen[f.key] !== dtFirst(f));
      // Nothing at all and nothing narrowing it: the block alone, without a header of columns over nothing.
      const blank = nothing && !query && !moved.length;
      root.toggleAttribute('data-empty', blank);
      // …and, when every filter is this table's own (the server holds nothing more to filter in), no search or filters over it either.
      root.toggleAttribute('data-bare', blank && !onSearch && filters.every((f) => f.test));
      const tr = dtEl(
        `<tr class="dt-empty"><td colspan="${columns.length + (actions ? 1 : 0)}"><div class="empty-state" data-size="sm"><span class="es-mark" aria-hidden="true">${
          blank ? empty.icon ?? DT_EMPTY : DT_FOUND_NONE
        }</span><b class="es-title">${dtEsc(blank ? empty.title : 'Олдсонгүй')}</b><span class="es-text">${dtEsc(
          blank ? empty.text ?? '' : filters.length ? 'Хайлт, шүүлтүүрээ өөрчилж үзнэ үү.' : 'Хайлтаа өөрчилж үзнэ үү.',
        )}</span></div></td></tr>`,
      );
      const box = tr.querySelector('.empty-state');
      // The next step: the page's own on a blank list (an «add» button); on a search or a filter that found
      // nothing — here or on the server — taking it back.
      const next = [];
      if (blank && empty.action instanceof Node) next.push(empty.action);
      if (!blank && query && input) {
        const clear = dtEl('<button type="button" class="btn" data-size="sm" data-clear="search">Хайлтыг цэвэрлэх</button>');
        clear.addEventListener('click', () => {
          input.value = '';
          input.dispatchEvent(new Event('input'));
          input.focus();
        });
        next.push(clear);
      }
      if (!blank && moved.length) {
        const reset = dtEl('<button type="button" class="btn" data-size="sm" data-clear="filters">Шүүлтүүрийг цэвэрлэх</button>');
        reset.addEventListener('click', unfilter);
        next.push(reset);
      }
      if (next.length) {
        const act = dtEl('<div class="es-act"></div>');
        act.append(...next);
        box.append(act);
      }
      tbody.append(tr);
      return;
    }
    root.removeAttribute('data-empty');
    root.removeAttribute('data-bare');
    for (const row of rows) {
      const r = row.original;
      const tr = document.createElement('tr');
      tr.className = 'dt-row';
      for (const [k, v] of Object.entries(rowAttrs?.(r) ?? {})) if (v !== null && v !== undefined && v !== false) tr.setAttribute(k, v === true ? '' : String(v));
      if (onRow) {
        tr.dataset.link = '';
        tr.tabIndex = 0;
        const go = (event) => {
          if (event.target.closest('button,a,select,input,textarea,label,details')) return;
          onRow(r, event);
        };
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => e.key === 'Enter' && go(e));
      }
      for (const cell of row.getVisibleCells()) {
        const c = cell.column.columnDef.meta;
        const td = document.createElement('td');
        td.dataset.label = c.label;
        if (c.align === 'end') td.dataset.align = 'end';
        if (c.phone === false) td.dataset.phone = 'off';
        const shown = c.render ? c.render(r) : cell.getValue();
        if (shown instanceof Node) td.append(shown);
        else if (c.render) td.innerHTML = shown ?? '';
        else td.textContent = shown ?? '—';
        tr.append(td);
      }
      if (actions) {
        const td = document.createElement('td');
        td.className = 'dt-act';
        const made = actions(r);
        for (const node of [made].flat()) if (node) td.append(node);
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  function drawFoot() {
    const total = table.getFilteredRowModel().rows.length;
    const { pageIndex, pageSize } = table.getState().pagination;
    const from = total ? pageIndex * pageSize + 1 : 0;
    const to = Math.min(total, (pageIndex + 1) * pageSize);
    const whole = all?.length ?? 0;
    $('.dt-count').textContent =
      all === null ? '' : total === whole ? `${whole.toLocaleString('en-US')} ${noun}` : `${total.toLocaleString('en-US')} / ${whole.toLocaleString('en-US')} ${noun}`;
    const foot = $('.dt-foot');
    foot.hidden = total <= DT_SIZES[0];
    if (foot.hidden) return;
    $('.dt-range').textContent = `${from}–${to} / ${total.toLocaleString('en-US')}`;
    const pages = $('.dt-pages');
    pages.replaceChildren();
    const count = table.getPageCount();
    const button = (label, index, attrs = '') => {
      const b = dtEl(`<button type="button" class="dt-page"${attrs}>${label}</button>`);
      b.addEventListener('click', () => table.setPageIndex(index));
      return b;
    };
    pages.append(button(DT_PREV, pageIndex - 1, `${table.getCanPreviousPage() ? '' : ' disabled'} aria-label="Өмнөх"`));
    // The first, the last, and two either side of here; gaps as dots.
    const shown = new Set([0, count - 1, pageIndex - 1, pageIndex, pageIndex + 1].filter((i) => i >= 0 && i < count));
    let last = -1;
    for (const i of [...shown].sort((a, b) => a - b)) {
      if (i - last > 1) pages.append(dtEl('<span class="dt-gap">…</span>'));
      pages.append(button(String(i + 1), i, i === pageIndex ? ' aria-current="page"' : ''));
      last = i;
    }
    pages.append(button(DT_NEXT, pageIndex + 1, `${table.getCanNextPage() ? '' : ' disabled'} aria-label="Дараах"`));
  }

  /*
   * The header sticks to the top of the page while the rows scroll under it.
   * A box that clips is what a sticky header sticks to, so the card clips
   * (and scrolls sideways) only when the table is wider than the card.
   */
  const wrap = $('.dt-wrap');
  const fit = () => {
    if (!root.isConnected) return;
    wrap.toggleAttribute('data-scroll', $('.dt-table').offsetWidth > wrap.clientWidth + 1);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(wrap);

  function draw() {
    // The keyboard stays where it was: a heading pressed to sort, or a page chosen, is drawn anew —
    // the focus goes to the new one rather than falling out of the table to the top of the page.
    const was = typeof document !== 'undefined' ? document.activeElement : null;
    const inside = Boolean(was && root.contains(was));
    const sortKey = inside && was.classList.contains('dt-sort') ? was.closest('th')?.dataset.key ?? null : null;
    const pageWas = inside && was.classList.contains('dt-page') ? was.getAttribute('aria-label') ?? '' : null;
    drawHead();
    drawBody();
    drawFoot();
    if (sortKey !== null) [...root.querySelectorAll('thead th')].find((th) => th.dataset.key === sortKey)?.querySelector('.dt-sort')?.focus();
    else if (pageWas !== null) {
      const pages = [...root.querySelectorAll('.dt-pages .dt-page')];
      // «Өмнөх» / «Дараах» while it can still go that way, else the page now open.
      (pages.find((b) => pageWas && b.getAttribute('aria-label') === pageWas && !b.disabled) ?? pages.find((b) => b.getAttribute('aria-current') === 'page'))?.focus();
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
  }

  sync();
  draw();

  return {
    el: root,
    /** New rows — a fresh answer from the server; the sort, search and filters stay. */
    setRows(rows) {
      all = rows ?? [];
      const pages = Math.max(1, Math.ceil(visibleRows().length / state.pagination.pageSize));
      if (state.pagination.pageIndex >= pages) state = { ...state, pagination: { ...state.pagination, pageIndex: 0 } };
      sync();
      draw();
    },
    rows: () => all ?? [],
    /** What each filter is set to — for a page that asks the server with them. */
    filters: () => ({ ...chosen }),
  };
}
