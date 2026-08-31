import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool } from '../db/pool.js';
import { DemoClock } from '../demoClock.js';
import { buildServer } from '../api/server.js';
import { seedDemo } from '../seed/demo.js';
import {
  FakeNotifier,
  FakePaymentProvider,
  FakeTaxProvider,
  type Ctx,
} from '../ports.js';

/**
 * The two pages, actually executed.
 *
 * Serving valid HTML proves nothing: the interesting failures are a selector
 * that no longer matches, a field the API renamed, a button wired to the wrong
 * action. So the page scripts run here against the real server, in a real DOM,
 * and the assertions are about what a person would see.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

let app: FastifyInstance;
let base: string;
let clock: DemoClock;
let notifier: FakeNotifier;
let pairedVenue: string;

/**
 * One store for every page, the way a browser keeps one per origin. Handing
 * each page its own would lose the tablet's token between tests and make the
 * kitchen re-pair itself constantly — which is exactly what it must not do.
 */
const storage = memoryStorage();

/**
 * Pages opened by the current test. They are closed afterwards so their polling
 * stops: a jsdom window left running keeps hitting the API and, because the
 * store is shared the way a browser shares an origin, a zombie page can clear
 * the tablet's token out from under the page under test.
 */
const open: JSDOM[] = [];

/** Load a page into jsdom, wire fetch to the live server, run its script. */
async function openPage(file: string): Promise<JSDOM> {
  const html = await readFile(join(WEB, file), 'utf8');
  const dom = new JSDOM(html, {
    url: base,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom has no fetch; point it at the running server and resolve relative
  // paths the way a browser would.
  (window as unknown as { fetch: typeof fetch }).fetch = ((input: string, init?: RequestInit) =>
    fetch(new URL(String(input), base).toString(), init)) as typeof fetch;
  Object.defineProperty(window, 'localStorage', { value: storage, writable: true });

  const shared = (await readFile(join(WEB, 'api.js'), 'utf8')).replace(/\bexport\s+/g, '');
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const page = inline.replace(/import\s*\{[^}]*\}\s*from\s*'\/api\.js';?/, '');

  // The page module and its helper, concatenated and run as one script — the
  // same code the browser loads, minus the module plumbing jsdom lacks.
  window.eval(`(async () => { ${shared}\n${page} })().catch(e => { window.__err = e; });`);
  open.push(dom);
  return dom;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/** Wait until the DOM says what we are waiting for, or give up loudly. */
async function until(
  dom: JSDOM,
  label: string,
  predicate: (doc: Document) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = (dom.window as unknown as { __err?: Error }).__err;
    if (error) throw new Error(`page threw while waiting for ${label}: ${error.message}`);
    if (predicate(dom.window.document)) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(
    `timed out waiting for ${label}\n--- body ---\n${dom.window.document.body.textContent?.slice(0, 900)}`,
  );
}

const text = (dom: JSDOM) => dom.window.document.body.textContent ?? '';

function clickText(dom: JSDOM, selector: string, label: string): void {
  const nodes = [...dom.window.document.querySelectorAll(selector)];
  const target = nodes.find((n) => (n.textContent ?? '').includes(label));
  if (!target) {
    throw new Error(
      `no ${selector} containing "${label}" — saw: ${nodes.map((n) => n.textContent?.trim()).join(' | ')}`,
    );
  }
  (target as HTMLElement).click();
}

beforeAll(async () => {
  clock = new DemoClock();
  clock.setTo('11:40');
  notifier = new FakeNotifier();
  const ctx: Ctx = {
    clock,
    payments: new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier,
  };
  await seedDemo();
  app = await buildServer(ctx, { dev: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // A venue is set up before service, not while a guest is looking at the list.
  // Storing the token is what a real tablet does once, at pairing time.
  const paired = await pairFirstVenue();
  pairedVenue = paired.name;
  storage.setItem('basu.device', paired.token);
});

afterEach(() => {
  for (const dom of open.splice(0)) dom.window.close();
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('the guest app', () => {
  it('walks a person from the venue list to a paid order', async () => {
    const dom = await openPage('index.html');

    await until(dom, 'the venue list', (d) => d.querySelectorAll('.card').length >= 3);
    expect(text(dom)).toContain('Модерн Номадс');
    // The clock strip is what makes lunch demonstrable at any hour.
    expect(dom.window.document.querySelector('.clockbar .now')?.textContent).toBe('11:40');

    // Only the paired restaurant takes orders, and the list says which.
    expect(text(dom)).toContain('одоогоор хаалттай');

    clickText(dom, '.card button', pairedVenue);

    await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);
    expect(text(dom)).toContain('Цуйван');
    expect(text(dom)).toContain('Хуушуур');

    // Two цуйван.
    const rows = [...dom.window.document.querySelectorAll('.item')];
    const tsuivan = rows.find((r) => r.textContent?.includes('Цуйван'))!;
    const plus = tsuivan.querySelector('button[data-d="1"]') as HTMLElement;
    plus.click();
    plus.click();

    await until(dom, 'the pay bar', (d) => Boolean(d.querySelector('.paybar')));
    // Cancellation terms sit next to the money, never buried.
    expect(text(dom)).toContain('гал дээр гарахаас өмнө');
    expect(dom.window.document.querySelector('.paybar button')?.textContent).toContain(
      'Цагаа сонгоно уу',
    );

    clickText(dom, '.slot', '12:30');
    await until(dom, 'the price on the button', (d) =>
      (d.querySelector('.paybar button')?.textContent ?? '').includes('төлөх'),
    );
    expect(dom.window.document.querySelector('.paybar button')?.textContent).toContain('28,000₮');

    (dom.window.document.querySelector('.paybar button') as HTMLElement).click();

    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(text(dom)).toMatch(/№\d{4}/);
    expect(text(dom)).toContain('Ширээ');
    expect(text(dom)).toContain('Үнэгүй цуцлах');
    // The whole journey is visible, not just the current step.
    expect(dom.window.document.querySelectorAll('.timeline li')).toHaveLength(5);
  });

  it('says what to do when no kitchen is watching at all', async () => {
    // Every tablet has gone quiet — the guard is working, but a list of three
    // shut restaurants with no explanation is a dead end for whoever is looking.
    await getPool().query(`UPDATE kds_device SET last_seen_at = now() - interval '1 day'`);
    try {
      const dom = await openPage('index.html');
      await until(dom, 'the explanation', (d) => Boolean(d.querySelector('.note')));
      expect(text(dom)).toContain('нэг ч гал тогоо холбогдоогүй');
      expect(dom.window.document.querySelector('.note a')?.getAttribute('href')).toBe('/kds');
    } finally {
      await getPool().query(`UPDATE kds_device SET last_seen_at = now()
                              WHERE paired_at IS NOT NULL AND revoked_at IS NULL`);
    }
  });

  it('refuses a restaurant with no tablet watching, and says why', async () => {
    const dom = await openPage('index.html');
    await until(dom, 'the venue list', (d) => d.querySelectorAll('.card').length >= 3);

    const closed = [...dom.window.document.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('одоогоор хаалттай'),
    )!;
    (closed.querySelector('button') as HTMLElement).click();

    await until(dom, 'the explanation', (d) =>
      (d.querySelector('#toast')?.textContent ?? '').includes('захиалга авахгүй'),
    );
    // And it did not navigate away from the list.
    expect(dom.window.document.querySelectorAll('.card').length).toBeGreaterThanOrEqual(3);
  });
});

describe('the kitchen display', () => {
  it('shows the ticket a guest just placed', async () => {
    const guest = await openPage('index.html');
    await until(guest, 'the venue list', (d) => d.querySelectorAll('.card').length >= 3);
    clickText(guest, '.card button', pairedVenue);
    await until(guest, 'the menu', (d) => d.querySelectorAll('.item').length > 3);
    const rows = [...guest.window.document.querySelectorAll('.item')];
    (rows
      .find((r) => r.textContent?.includes('Хуушуур'))!
      .querySelector('button[data-d="1"]') as HTMLElement).click();
    await until(guest, 'the pay bar', (d) => Boolean(d.querySelector('.paybar')));
    clickText(guest, '.slot', '12:45');
    await until(guest, 'a price', (d) =>
      (d.querySelector('.paybar button')?.textContent ?? '').includes('төлөх'),
    );
    (guest.window.document.querySelector('.paybar button') as HTMLElement).click();
    await until(guest, 'the status screen', (d) => Boolean(d.querySelector('.status')));

    /* now the kitchen */
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(text(kds)).toContain('Ирж явна');
    expect(text(kds)).toContain('Гал дээр');
    expect(text(kds)).toContain('Бэлэн');

    // The board carries whatever the service has in flight, so find ours.
    await until(kds, 'our ticket', (d) =>
      [...d.querySelectorAll('.ticket')].some((t) => t.textContent?.includes('Хуушуур')),
    );
    const ticket = [...kds.window.document.querySelectorAll('.ticket')].find((t) =>
      t.textContent?.includes('Хуушуур'),
    )!;
    expect(ticket.textContent).toContain('Хүлээн авах');
    expect(ticket.textContent).toContain('Татгалзах');

    // Accepting moves it out of "awaiting the restaurant" and gives the chef
    // the two controls that matter for a ticket that is now scheduled.
    (
      [...ticket.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Хүлээн авах'),
      ) as HTMLElement
    ).click();

    await until(kds, 'the accepted ticket', (d) =>
      [...d.querySelectorAll('.ticket')].some(
        (t) => t.textContent?.includes('Хуушуур') && t.textContent?.includes('Одоо тавь'),
      ),
    );
    const accepted = [...kds.window.document.querySelectorAll('.ticket')].find((t) =>
      t.textContent?.includes('Хуушуур'),
    )!;
    expect(accepted.textContent).toContain('+5 мин');
  });

  it('lets the chef fire by hand and moves the ticket across', async () => {
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    await until(kds, 'a fireable ticket', (d) =>
      [...d.querySelectorAll('.ticket')].some((t) => t.textContent?.includes('Одоо тавь')),
    );

    clickText(kds, '.ticket button', 'Одоо тавь');

    await until(kds, 'the ticket to start cooking', (d) =>
      [...d.querySelectorAll('.ticket')].some((t) => t.textContent?.includes('Бэлэн боллоо')),
    );
    const cooking = [...kds.window.document.querySelectorAll('.ticket')].find((t) =>
      t.textContent?.includes('Бэлэн боллоо'),
    )!;
    expect(cooking.getAttribute('data-lane')).toBe('cooking');
  });

  it('lets a demo tablet pick its kitchen when codes have expired', async () => {
    storage.removeItem('basu.device');
    const kds = await openPage('kds.html');
    await until(kds, 'the pairing form', (d) => d.querySelectorAll('.venues button').length > 0);

    // One of them is already watched — the seed opens a venue for service.
    expect(text(kds)).toContain('захиалга авч байна');

    clickText(kds, '.venues button', pairedVenue);
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(text(kds)).toContain('Ирж явна');
  });

  it('walks a fresh tablet through pairing', async () => {
    // A tablet out of its box: nothing stored, so it must ask to be paired.
    storage.removeItem('basu.device');
    const kds = await openPage('kds.html');

    await until(kds, 'the pairing form', (d) => Boolean(d.querySelector('.pair input')));
    expect(text(kds)).toContain('Таблетаа холбоно уу');
    // The demo codes are offered, so nobody has to copy one out of a terminal.
    const input = kds.window.document.querySelector('.pair input') as HTMLInputElement;
    expect(input.value).toMatch(/^\d{8}$/);

    clickText(kds, '.pair button', 'Холбох');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(text(kds)).toContain('Ирж явна');
  });

  it('sends a revoked tablet back to the pairing screen', async () => {
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);

    // The manager revoked this tablet — it must stop showing tickets at once.
    await getPool().query(`UPDATE kds_device SET revoked_at = now(), token_hash = NULL`);

    await until(kds, 'the pairing screen', (d) => Boolean(d.querySelector('.pair')), 12_000);
    expect(text(kds)).toContain('Таблетаа холбоно уу');
  });
});

/**
 * Pair one restaurant's tablet, leaving the other two dark — which is what
 * makes the "this venue is not taking orders" path visible in the guest list.
 */
async function pairFirstVenue(): Promise<{ name: string; token: string }> {
  const { rows } = await getPool().query<{ code: string; name: string }>(
    `SELECT d.pairing_code AS code, r.name
       FROM kds_device d JOIN restaurant r ON r.id = d.restaurant_id
      WHERE d.paired_at IS NULL ORDER BY r.name LIMIT 1`,
  );
  const device = rows[0]!;
  const response = await fetch(`${base}/v1/kds/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: device.code }),
  });
  const { token } = (await response.json()) as { token: string };
  return { name: device.name, token };
}
