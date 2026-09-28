import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The dashboard's table, on its own: TanStack's table-core underneath, our
 * rendering on top. What a person relies on — the count says how many, a
 * header sorts, a search finds, pages are 25 long, a filter narrows, a
 * server-side filter asks the page to fetch again — held here so a page
 * test does not have to find it out.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

type Table = { el: HTMLElement; setRows: (rows: unknown[]) => void; filters: () => Record<string, string> };
let window: JSDOM['window'];
let dataTable: (options: Record<string, unknown>) => Table;

beforeEach(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  window = dom.window;
  window.eval(await readFile(join(WEB, 'vendor', 'table-core.js'), 'utf8'));
  const source = (await readFile(join(WEB, 'datatable.js'), 'utf8')).replace(/\bexport\s+/g, '');
  window.eval(`${source}\nwindow.__dataTable = dataTable;`);
  dataTable = (window as unknown as { __dataTable: typeof dataTable }).__dataTable;
});

const people = Array.from({ length: 60 }, (_, i) => ({
  id: String(i),
  name: ['Бат', 'Сараа', 'Дорж', 'Туяа'][i % 4] + ` ${i}`,
  amount: (i * 7919) % 1000,
  open: i % 3 !== 0,
}));

const columns = [
  { key: 'name', label: 'Нэр' },
  { key: 'amount', label: 'Дүн', numeric: true, align: 'end' },
];

const names = (t: Table) => [...t.el.querySelectorAll('tbody tr.dt-row td:first-child')].map((td) => td.textContent);
const header = (t: Table, label: string) =>
  [...t.el.querySelectorAll('thead th .dt-sort')].find((b) => b.textContent === label) as HTMLElement;

describe('the dashboard table', () => {
  it('shows the shape of what is coming until the rows arrive, then counts them and pages by 25', () => {
    const t = dataTable({ columns, noun: 'хүн' });
    window.document.body.append(t.el);
    expect(t.el.querySelectorAll('tbody tr.dt-skel').length).toBeGreaterThan(0);
    t.setRows(people);
    expect(t.el.querySelector('.dt-count')?.textContent).toBe('60 хүн');
    expect(t.el.querySelectorAll('tbody tr.dt-row')).toHaveLength(25);
    expect(t.el.querySelector('.dt-range')?.textContent).toBe('1–25 / 60');
    (t.el.querySelector('.dt-pages [aria-label="Дараах"]') as HTMLElement).click();
    expect(t.el.querySelector('.dt-range')?.textContent).toBe('26–50 / 60');
    expect(t.el.querySelector('.dt-pages [aria-current="page"]')?.textContent).toBe('2');
  });

  it('sorts by a header, one way and then the other — amounts biggest first, names from А', () => {
    const t = dataTable({ columns, rows: people });
    const amounts = () => [...t.el.querySelectorAll('tbody tr.dt-row td:last-child')].map((td) => Number(td.textContent));
    header(t, 'Дүн').click();
    expect(amounts()[0]).toBe(Math.max(...people.map((p) => p.amount)));
    expect(amounts()).toEqual([...amounts()].sort((a, b) => b - a));
    expect(t.el.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Дүн');
    header(t, 'Дүн').click();
    expect(amounts()[0]).toBe(Math.min(...people.map((p) => p.amount)));
    header(t, 'Нэр').click();
    expect(names(t)[0]?.startsWith('Бат')).toBe(true);
  });

  it('finds by any column, and says so in the count', () => {
    const t = dataTable({ columns, rows: people, noun: 'хүн' });
    const input = t.el.querySelector('.dt-search input') as HTMLInputElement;
    input.value = 'сараа';
    input.dispatchEvent(new window.Event('input'));
    expect(names(t).every((n) => n?.startsWith('Сараа'))).toBe(true);
    expect(t.el.querySelector('.dt-count')?.textContent).toBe('15 / 60 хүн');
    input.value = 'байхгүй нэр';
    input.dispatchEvent(new window.Event('input'));
    expect(t.el.querySelector('.dt-empty')?.textContent).toContain('Олдсонгүй');
  });

  it('narrows by a filter here, and asks the page to fetch again for one of the server’s', () => {
    const asked: Array<Record<string, string>> = [];
    const t = dataTable({
      columns,
      rows: people,
      filters: [
        { key: 'open', label: 'Төлөв', options: [['all', 'Бүгд'], ['open', 'Нээлттэй']], test: (p: { open: boolean }, v: string) => v === 'all' || p.open },
        { key: 'scope', label: 'Хүрээ', kind: 'select', options: [['live', 'Идэвхтэй'], ['all', 'Бүгд']] },
      ],
      onFilter: (f: Record<string, string>) => asked.push(f),
    });
    const open = [...t.el.querySelectorAll('.dt-seg button')].find((b) => b.textContent === 'Нээлттэй') as HTMLElement;
    open.click();
    expect(t.el.querySelector('.dt-count')?.textContent).toBe(`40 / 60 мөр`);
    expect(asked).toEqual([]);
    const scope = t.el.querySelector('.dt-select') as HTMLSelectElement;
    scope.value = 'all';
    scope.dispatchEvent(new window.Event('change'));
    expect(asked).toEqual([{ open: 'open', scope: 'all' }]);
    expect(t.filters()).toEqual({ open: 'open', scope: 'all' });
  });

  it('opens a row, but not when a button in it was pressed', () => {
    const opened: string[] = [];
    const pressed: string[] = [];
    const t = dataTable({
      columns,
      rows: people.slice(0, 3),
      onRow: (p: { id: string }) => opened.push(p.id),
      actions: (p: { id: string }) => {
        const b = window.document.createElement('button');
        b.textContent = 'Үйлдэл';
        b.addEventListener('click', () => pressed.push(p.id));
        return b;
      },
      rowAttrs: (p: { id: string }) => ({ 'data-person': p.id }),
    });
    const row = t.el.querySelector('tr[data-person="1"]') as HTMLElement;
    (row.querySelector('button') as HTMLElement).click();
    expect(pressed).toEqual(['1']);
    expect(opened).toEqual([]);
    (row.querySelector('td') as HTMLElement).click();
    expect(opened).toEqual(['1']);
  });
});
