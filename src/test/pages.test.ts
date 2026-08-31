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
let seeded: Awaited<ReturnType<typeof seedDemo>>;

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

  // Every local module the page imports, inlined. jsdom cannot resolve module
  // specifiers, so the pieces are concatenated and run as one script — the same
  // code the browser loads, minus the plumbing.
  const strip = (source: string) => source.replace(/\bexport\s+/g, '');
  const shared = strip(await readFile(join(WEB, 'api.js'), 'utf8'));
  const mapLib = strip(await readFile(join(WEB, 'mapStyle.js'), 'utf8'));
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const page = inline.replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '');

  stubMapLibre(window);
  window.eval(
    `(async () => { ${shared}\n${mapLib}\n${page} })().catch(e => { window.__err = e; });`,
  );
  open.push(dom);
  return dom;
}

/**
 * Just enough MapLibre for the page to run.
 *
 * The real library needs WebGL, which jsdom has none of. Stubbing it keeps the
 * sheet, the menu and the ordering flow under test — the parts a person
 * actually operates — and doubles as a list of what the page depends on: a
 * method that disappears from this stub is a method the page should stop
 * calling.
 */
function stubMapLibre(window: JSDOM['window']): void {
  const canvas = { style: {} as Record<string, string> };

  class StubMap {
    #handlers = new Map<string, Array<(event: unknown) => void>>();
    #sources = new Map<string, { setData: (data: unknown) => void; data: unknown }>();
    readonly layers: string[] = [];
    readonly images: string[] = [];

    constructor() {
      (window as unknown as Record<string, unknown>)['__map'] = this;
      // 'load' is what gates the page's first paint, so it has to arrive — but
      // not after the window is gone: the handler builds pin images against a
      // document that would no longer exist.
      const timer = setTimeout(() => this.#fire('load', {}), 0);
      window.addEventListener('pagehide', () => clearTimeout(timer));
    }
    on(event: string, second: unknown, third?: unknown) {
      const handler = (typeof second === 'function' ? second : third) as (e: unknown) => void;
      const key = typeof second === 'string' ? `${event}:${second}` : event;
      const list = this.#handlers.get(key) ?? [];
      list.push(handler);
      this.#handlers.set(key, list);
    }
    #fire(key: string, event: unknown) {
      for (const handler of this.#handlers.get(key) ?? []) handler(event);
    }
    /** Tests use this to click a pin. */
    clickLayer(layer: string, event: unknown) {
      this.#fire(`click:${layer}`, event);
    }
    addControl() {}
    addImage(id: string) {
      this.images.push(id);
    }
    addSource(id: string, source: { data: unknown }) {
      const entry = { data: source.data, setData: (data: unknown) => (entry.data = data) };
      this.#sources.set(id, entry);
    }
    getSource(id: string) {
      return this.#sources.get(id);
    }
    addLayer(layer: { id: string }) {
      this.layers.push(layer.id);
    }
    easeTo() {}
    getCanvas() {
      return canvas;
    }
  }

  class StubGeolocate {
    on() {}
  }

  const global = window as unknown as Record<string, unknown>;
  global['maplibregl'] = {
    Map: StubMap,
    NavigationControl: class {},
    GeolocateControl: StubGeolocate,
  };
  global['__StubMap'] = StubMap;

  // pinImage draws on a canvas; jsdom has no 2D context, so give it a sink.
  const sink = new Proxy(
    { getImageData: () => ({ data: new Uint8ClampedArray(4) }) },
    { get: (target, key) => (key in target ? (target as never)[key] : () => {}) },
  );
  window.HTMLCanvasElement.prototype.getContext = (() => sink) as never;
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
  const toast = dom.window.document.getElementById('toast')?.textContent;
  throw new Error(
    `timed out waiting for ${label}` +
      (toast ? `\n--- toast --- ${toast}` : '') +
      `\n--- body ---\n${dom.window.document.body.textContent?.slice(0, 900)}`,
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
  seeded = await seedDemo();
  app = await buildServer(ctx, { dev: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // The seed opens one venue for service and hands back its name; take a
  // tablet for that same one, which is what a kitchen does before opening.
  pairedVenue = seeded.paired;
  storage.setItem('basu.device', await tabletFor(pairedVenue));
});

afterEach(async () => {
  const closing = open.splice(0);
  // A browser fires this on the way out and pages use it to stop polling.
  // Without it a torn-down page keeps calling into a dead document.
  for (const dom of closing) dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  // Let requests already in flight land while their document still exists.
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const dom of closing) dom.window.close();
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

/** The pins the map is currently drawing. */
function pins(dom: JSDOM): Array<{ properties: Record<string, unknown> }> {
  const map = (dom.window as unknown as Record<string, unknown>)['__map'] as
    | { getSource: (id: string) => { data: { features: Array<{ properties: Record<string, unknown> }> } } | undefined }
    | undefined;
  return map?.getSource('venues')?.data.features ?? [];
}

/** Tap a restaurant pin, the way a thumb does. */
function tapPin(dom: JSDOM, name: string): void {
  const pin = pins(dom).find((f) => f.properties['label'] === name);
  if (!pin) {
    throw new Error(
      `no pin for "${name}" — saw ${pins(dom)
        .map((f) => String(f.properties['label']))
        .join(', ')}`,
    );
  }
  const map = (dom.window as unknown as Record<string, unknown>)['__map'] as {
    clickLayer: (layer: string, event: unknown) => void;
  };
  map.clickLayer('venue-pin', { features: [{ properties: pin.properties }] });
}

/** Place and pay for an order through the guest page, from a pin. */
async function orderFromMap(
  dom: JSDOM,
  venue: string,
  dish: string,
  slot: string,
): Promise<void> {
  await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
  tapPin(dom, venue);
  await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);
  const row = [...dom.window.document.querySelectorAll('.item')].find((r) =>
    r.textContent?.includes(dish),
  );
  if (!row) throw new Error(`no menu row for ${dish}`);
  (row.querySelector('button[data-d="1"]') as HTMLElement).click();
  await until(dom, 'the pay button', (d) => Boolean(d.querySelector('.sheet footer button')));
  clickText(dom, '.slot', slot);
  await until(dom, 'a price', (d) =>
    (d.querySelector('.sheet footer button')?.textContent ?? '').includes('төлөх'),
  );
  (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
  await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
}

describe('the guest app', () => {
  it('draws every restaurant on the map', async () => {
    const dom = await openPage('index.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);

    const drawn = pins(dom);
    expect(drawn).toHaveLength(seeded.venues);
    expect(drawn.every((f) => f.properties['label'])).toBe(true);
    expect(text(dom)).toContain(`${seeded.venues}/${seeded.venues} ресторан`);
  });

  it('shows a dish with its picture, its station and how long it takes', async () => {
    const dom = await openPage('index.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
    tapPin(dom, pairedVenue);
    await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);

    // A menu is chosen with the eyes: every row carries a picture, and the two
    // numbers the kitchen runs on are on the row rather than hidden.
    for (const row of dom.window.document.querySelectorAll('.item')) {
      expect(row.querySelector('img')?.getAttribute('src')).toMatch(/^\/dishes\/\w+\.svg$/);
      expect(row.querySelector('.meta')?.textContent).toMatch(/\d+ мин/);
      expect(row.querySelector('.price')?.textContent).toMatch(/₮/);
    }
  });

  it('walks a person from a pin to a paid order', async () => {
    const dom = await openPage('index.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);

    tapPin(dom, pairedVenue);
    await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);
    expect(dom.window.document.querySelector('.sheet')?.hasAttribute('data-open')).toBe(true);
    expect(text(dom)).toContain('Цуйван');
    expect(text(dom)).toContain('мин алхаад');

    const rows = [...dom.window.document.querySelectorAll('.item')];
    const tsuivan = rows.find((r) => r.textContent?.includes('Цуйван'))!;
    const plus = tsuivan.querySelector('button[data-d="1"]') as HTMLElement;
    plus.click();
    plus.click();

    await until(dom, 'the pay button', (d) => Boolean(d.querySelector('.sheet footer button')));
    // Cancellation terms sit next to the money, never buried.
    expect(text(dom)).toContain('гал дээр гарахаас өмнө');
    expect(dom.window.document.querySelector('.sheet footer button')?.textContent).toContain(
      'Цагаа сонгоно уу',
    );

    clickText(dom, '.slot', '12:30');
    await until(dom, 'a price', (d) =>
      (d.querySelector('.sheet footer button')?.textContent ?? '').includes('төлөх'),
    );
    expect(dom.window.document.querySelector('.sheet footer button')?.textContent).toContain(
      '28,000₮',
    );

    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();

    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(text(dom)).toMatch(/№\d{4}/);
    expect(text(dom)).toContain('Ширээ');
    expect(text(dom)).toContain('Үнэгүй цуцлах');
    expect(dom.window.document.querySelectorAll('.timeline li')).toHaveLength(5);
    // The sheet is out of the way once the order exists.
    expect(dom.window.document.querySelector('.sheet')?.hasAttribute('data-open')).toBe(false);
  });

  it('explains a dark kitchen instead of offering its menu', async () => {
    await inProduction(async () => {
      const dom = await openPage('index.html');
      await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);

      const shut = pins(dom).find((f) => !f.properties['open']);
      expect(shut, 'every venue was open — the guard was not on').toBeTruthy();
      tapPin(dom, String(shut!.properties['label']));

      await until(dom, 'the explanation', (d) => Boolean(d.querySelector('.sheet .note')));
      expect(text(dom)).toContain('захиалга авахгүй байна');
      // And no menu was offered.
      expect(dom.window.document.querySelectorAll('.sheet .item')).toHaveLength(0);
    });
  });

  it('recovers from a session that outlived its server', async () => {
    // What a browser holds after the demo database is reseeded, or after a
    // session is revoked: a token that looks fine and is worth nothing.
    storage.setItem('basu.guest', 'stale-token-from-a-previous-life');

    const dom = await openPage('index.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
    tapPin(dom, pairedVenue);
    await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);

    const salad = [...dom.window.document.querySelectorAll('.item')].find((r) =>
      r.textContent?.includes('Салат'),
    )!;
    (salad.querySelector('button[data-d="1"]') as HTMLElement).click();
    await until(dom, 'the pay button', (d) => Boolean(d.querySelector('.sheet footer button')));
    clickText(dom, '.slot', '13:15');
    await until(dom, 'a price', (d) =>
      (d.querySelector('.sheet footer button')?.textContent ?? '').includes('төлөх'),
    );
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();

    // Signed in again behind the scenes; the order goes through.
    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(text(dom)).not.toContain('Нэвтэрч орно уу');
    expect(storage.getItem('basu.guest')).not.toBe('stale-token-from-a-previous-life');
  });

  it('says what to do when no kitchen is watching at all', async () => {
    // Every tablet has gone quiet — the guard is working, but a map of grey
    // pins with no explanation is a dead end for whoever is looking.
    await getPool().query(`UPDATE kds_device SET last_seen_at = now() - interval '1 day'`);
    try {
      await inProduction(async () => {
        const dom = await openPage('index.html');
        await until(dom, 'the explanation', (d) => Boolean(d.querySelector('#map .note')));
        expect(text(dom)).toContain('нэг ч гал тогоо холбогдоогүй');
        expect(dom.window.document.querySelector('.note a')?.getAttribute('href')).toBe('/kds');
        // The pins are still drawn — the map is not the thing that failed.
        expect(pins(dom).length).toBe(seeded.venues);
        expect(pins(dom).every((f) => !f.properties['open'])).toBe(true);
      });
    } finally {
      await getPool().query(`UPDATE kds_device SET last_seen_at = now()
                              WHERE paired_at IS NOT NULL AND revoked_at IS NULL`);
    }
  });
});

describe('the map', () => {
  it('gives the tile worker an absolute URL', async () => {
    // MapLibre fetches tiles from a Web Worker, which has no document to
    // resolve a relative path against: '/tiles/{z}/{x}/{y}' reaches
    // `new Request()` unchanged and throws "Failed to parse URL". The map then
    // draws its background colour with the markers still on top, so it reads
    // as a styling problem rather than the transport one it is.
    const dom = await openPage('index.html');
    await until(dom, 'the style', () =>
      Boolean((dom.window as unknown as Record<string, unknown>)['__style']),
    );
    const style = (dom.window as unknown as Record<string, unknown>)['__style'] as {
      sources: { base: { tiles: string[] } };
      glyphs: string;
    };

    for (const url of [...style.sources.base.tiles, style.glyphs]) {
      expect(url, url).toMatch(/^https?:\/\//);
      // …and still on this origin, which is the whole reason for the proxy.
      expect(new URL(url).origin).toBe(new URL(base).origin);
    }
  });
});

describe('the kitchen display', () => {
  it('shows the ticket a guest just placed', async () => {
    const guest = await openPage('index.html');
    await orderFromMap(guest, pairedVenue, 'Хуушуур', '12:45');

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

/** A tablet token for a named restaurant, the way the demo hands one out. */
async function tabletFor(name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM restaurant WHERE name = $1',
    [name],
  );
  const response = await fetch(`${base}/dev/kds-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restaurant_id: rows[0]!.id }),
  });
  const { token } = (await response.json()) as { token: string };
  return token;
}

/**
 * Run something with the is-anyone-watching guard switched on.
 *
 * The guard is production behaviour: demo mode ignores it, because a
 * walkthrough that needs a second tab open before the first one works is a
 * puzzle rather than a demo. These tests are about the guard itself.
 */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env['BASU_MODE'];
  process.env['BASU_MODE'] = 'production';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env['BASU_MODE'];
    else process.env['BASU_MODE'] = before;
  }
}
