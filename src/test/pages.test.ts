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

/**
 * Load a page into jsdom, wire fetch to the live server, run its script.
 *
 * `search` is how a deep link is opened: the home screen sends people into
 * the dine-in app at `/dine?order=…`, and a page that reads location has to
 * be given one that says something.
 */
async function openPage(file: string, search = ''): Promise<JSDOM> {
  const html = await readFile(join(WEB, file), 'utf8');
  const dom = new JSDOM(html, {
    url: `${base}/${file.replace(/\.html$/, '')}${search}`,
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
    readonly layers: Array<{ id: string; paint?: Record<string, unknown> }> = [];
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
    readonly controls: unknown[] = [];
    addControl(control: unknown) {
      this.controls.push(control);
    }
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
      this.layers.push(layer);
    }
    easeTo() {}
    getCanvas() {
      return canvas;
    }
  }

  class StubGeolocate {
    constructor(readonly options: Record<string, unknown>) {}
    on() {}
    trigger() {}
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
    const dom = await openPage('dine.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);

    const drawn = pins(dom);
    expect(drawn).toHaveLength(seeded.venues);
    expect(drawn.every((f) => f.properties['label'])).toBe(true);
    expect(text(dom)).toContain(`${seeded.venues}/${seeded.venues} ресторан`);
  });

  it('shows a dish with its picture, its station and how long it takes', async () => {
    const dom = await openPage('dine.html');
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
    const dom = await openPage('dine.html');
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

    // The status stays over the map rather than replacing it: someone walking
    // to the restaurant is watching the progress and the route at once.
    expect(dom.window.document.querySelector('.sheet')?.hasAttribute('data-open')).toBe(true);
    expect(dom.window.document.querySelector('#map canvas, #map')).toBeTruthy();

    // Dismissing it leaves a bar carrying the same answer in one line.
    (dom.window.document.querySelector('#sheet-close') as HTMLElement).click();
    await until(dom, 'the order bar', (d) =>
      Boolean(d.querySelector('#orderbar')?.hasAttribute('data-open')),
    );
    expect(dom.window.document.querySelector('#ob-code')?.textContent).toMatch(/^№\d{4}$/);

    // And tapping it brings the detail back.
    (dom.window.document.querySelector('#orderbar') as HTMLElement).click();
    await until(dom, 'the status again', (d) => Boolean(d.querySelector('.status')));
    expect(dom.window.document.querySelector('#orderbar')?.hasAttribute('data-open')).toBe(false);
  });

  it('draws the walk with layers MapLibre can actually paint', async () => {
    // `line-dasharray` takes zoom expressions and nothing else. A `case` on a
    // feature property is invalid, and MapLibre answers by not drawing the
    // layer at all — no error, no warning, an empty map and a distance label
    // sitting next to it saying the route had been found. Filters are the
    // supported way to say the same thing.
    const dom = await openPage('dine.html');
    const mapOf = () =>
      (dom.window as unknown as Record<string, unknown>)['__map'] as
        | { layers: Array<{ id: string; paint?: Record<string, unknown> }> }
        | undefined;
    // Layers are added on 'load', not at construction.
    await until(dom, 'the route layers', () =>
      (mapOf()?.layers ?? []).some((l) => l.id.startsWith('route-')),
    );

    const route = mapOf()!.layers.filter((l) => l.id.startsWith('route-'));
    expect(route.length, 'the walk needs a casing and two states').toBeGreaterThanOrEqual(3);
    for (const layer of route) {
      const dash = layer.paint?.['line-dasharray'];
      if (dash === undefined) continue;
      // A literal array, or a zoom expression. Never a data one.
      expect(Array.isArray(dash) && dash.every((v) => typeof v === 'number'), layer.id).toBe(true);
    }
  });

  it('keeps the tilt when the locate control frames a position', async () => {
    // MapLibre's GeolocateControl fits the accuracy circle, and fitBounds
    // resets pitch to zero unless told otherwise — so locating yourself
    // flattened the city into a plan. The buildings are how somebody
    // recognises where they are, so the tilt is not decoration.
    const dom = await openPage('dine.html');
    await until(dom, 'the map', () =>
      Boolean((dom.window as unknown as Record<string, unknown>)['__map']),
    );
    const map = (dom.window as unknown as Record<string, unknown>)['__map'] as {
      controls: unknown[];
    };
    const located = map.controls.find(
      (c): c is { options?: { fitBoundsOptions?: { pitch?: number } } } =>
        typeof c === 'object' && c !== null && 'options' in c,
    );
    expect(located?.options?.fitBoundsOptions?.pitch).toBeGreaterThan(0);
  });

  it('explains a dark kitchen instead of offering its menu', async () => {
    await inProduction(async () => {
      const dom = await openPage('dine.html');
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

    const dom = await openPage('dine.html');
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
    await getPool().query(`UPDATE dine.kds_device SET last_seen_at = now() - interval '1 day'`);
    try {
      await inProduction(async () => {
        const dom = await openPage('dine.html');
        await until(dom, 'the explanation', (d) => Boolean(d.querySelector('#map .note')));
        expect(text(dom)).toContain('нэг ч гал тогоо холбогдоогүй');
        expect(dom.window.document.querySelector('.note a')?.getAttribute('href')).toBe('/kds');
        // The pins are still drawn — the map is not the thing that failed.
        expect(pins(dom).length).toBe(seeded.venues);
        expect(pins(dom).every((f) => !f.properties['open'])).toBe(true);
      });
    } finally {
      await getPool().query(`UPDATE dine.kds_device SET last_seen_at = now()
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
    const dom = await openPage('dine.html');
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

describe('the Basu home screen', () => {
  it('names what is inside Basu and links into it', async () => {
    // Nobody signed in: a launcher opened by a stranger shows the apps and
    // nothing of anybody's.
    storage.removeItem('basu.guest');
    const home = await openPage('index.html');
    await until(home, 'the app grid', (d) => d.querySelectorAll('.app').length > 0);

    const dine = home.window.document.querySelector('.app[data-app="dine"]') as HTMLAnchorElement;
    expect(dine.getAttribute('href')).toBe('/dine');
    expect(dine.textContent).toContain('Хоол');
    // Every tile draws its own glyph; a launcher waiting on the network to
    // show its icons is a launcher that looks broken on a slow morning.
    expect(dine.querySelector('.tile svg')).toBeTruthy();
    expect(home.window.document.querySelectorAll('.card')).toHaveLength(0);

    // The second app: one entry in the list, and nothing else moved.
    const idesh = home.window.document.querySelector('.app[data-app="idesh"]') as HTMLAnchorElement;
    expect(idesh.getAttribute('href')).toBe('/idesh');
    expect(idesh.textContent).toContain('Идэш');
    expect(idesh.querySelector('.tile svg')).toBeTruthy();
    expect(home.window.document.querySelectorAll('.app')).toHaveLength(2);
  });

  it('carries a live order home, and opens it again from there', async () => {
    // A guest of this test's own, so the strip holds one order and it is ours.
    await ownGuest('+97699003001');
    const guest = await openPage('dine.html');
    // Its own slot: three orders fill one, and the other tests have theirs.
    await orderFromMap(guest, pairedVenue, 'Хуушуур', '13:00');

    const home = await openPage('index.html');
    await until(home, 'the order on the home screen', (d) => d.querySelectorAll('.card').length > 0);

    const card = home.window.document.querySelector('.card') as HTMLAnchorElement;
    expect(card.textContent).toContain(pairedVenue);
    const href = card.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/dine\?order=[0-9a-f-]{36}$/);

    // …and following it lands on that order's status, not on an empty map.
    const back = await openPage('dine.html', href.slice('/dine'.length));
    await until(back, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(back.window.document.querySelector('#sheet-sub')?.textContent).toContain(pairedVenue);
  });

  it('brings a reloaded guest back to their lunch', async () => {
    await ownGuest('+97699003002');
    const guest = await openPage('dine.html');
    await orderFromMap(guest, pairedVenue, 'Хуушуур', '13:30');
    const code = guest.window.document.querySelector('#sheet-name')?.textContent;

    // Same browser, same guest, no deep link: the order is the server's to
    // remember, so a reload finds it again.
    const again = await openPage('dine.html');
    await until(again, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(again.window.document.querySelector('#sheet-name')?.textContent).toBe(code);
  });
});

describe('the kitchen display', () => {
  it('shows the ticket a guest just placed', async () => {
    const guest = await openPage('dine.html');
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

  it('names the kitchen it is watching, and lets the chef change it', async () => {
    // These pages share one store, the way one browser origin does, and the
    // pairing tests move the token about. Start from a tablet we chose.
    storage.setItem('basu.device', await tabletFor(pairedVenue));

    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);

    // An unnamed empty board looks the same whether nothing has been ordered
    // or the tablet is watching somebody else's kitchen.
    expect(kds.window.document.querySelector('#venue')?.textContent).toBe(pairedVenue);

    // A tablet paired to the wrong kitchen must have a way back that is not
    // "clear your browser storage".
    (kds.window.document.querySelector('#swap') as HTMLElement).click();
    await until(kds, 'the pairing screen', (d) => Boolean(d.querySelector('.pair')));
    expect(text(kds)).toContain('Таблетаа холбоно уу');

    // …and picking the all-kitchens view from there works.
    clickText(kds, '.venues button', 'Бүх гал тогоо');
    await until(kds, 'the merged board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(kds.window.document.querySelector('#venue')?.textContent).toBe('Бүх гал тогоо');

    // Put the storage back the way the other tests expect to find it.
    storage.setItem('basu.device', await tabletFor(pairedVenue));
  });

  it('shows every kitchen at once when asked to', async () => {
    // The isolation is real and tested elsewhere; this is the demo view that
    // exists because a walkthrough moves between ten venues and orders placed
    // at nine of them would otherwise be invisible.
    const before = storage.getItem('basu.device');
    storage.setItem('basu.device', 'all-kitchens');
    try {
      const kds = await openPage('kds.html');
      await until(kds, 'the merged board', (d) => d.querySelectorAll('.lane').length === 3);
      expect(kds.window.document.querySelector('#venue')?.textContent).toBe('Бүх гал тогоо');
    } finally {
      if (before) storage.setItem('basu.device', before);
    }
  });

  it('sends a revoked tablet back to the pairing screen', async () => {
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);

    // The manager revoked this tablet — it must stop showing tickets at once.
    await getPool().query(`UPDATE dine.kds_device SET revoked_at = now(), token_hash = NULL`);

    await until(kds, 'the pairing screen', (d) => Boolean(d.querySelector('.pair')), 12_000);
    expect(text(kds)).toContain('Таблетаа холбоно уу');
  });
});

describe('өвлийн идэш', () => {
  /** Buy one whole animal, collected, on the first day it exists. */
  async function buyOne(dom: JSDOM): Promise<string> {
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    const whole = [...dom.window.document.querySelectorAll('.listing')].find(
      (l) => !l.hasAttribute('data-gone') && l.textContent?.includes('бүтэн'),
    ) as HTMLElement;
    whole.click();
    await until(dom, 'the sheet', (d) => Boolean(d.querySelector('#pay')));
    const title = dom.window.document.querySelector('#sheet-name')?.textContent ?? '';
    // Collected, on the day it is ready — the form's own defaults.
    expect(dom.window.document.querySelector('.pick [data-r="pickup"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((dom.window.document.querySelector('#when') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const pay = dom.window.document.querySelector('#pay') as HTMLButtonElement;
    expect(pay.disabled).toBe(false);
    expect(pay.textContent).toMatch(/₮ төлөх/);
    pay.click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    return title;
  }

  it('lists every stall, names the supplier, and says it is under contract', async () => {
    const dom = await openPage('idesh.html');
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);

    for (const row of dom.window.document.querySelectorAll('.listing')) {
      expect(row.querySelector('.art svg')).toBeTruthy();
      expect(row.querySelector('.verified')?.textContent).toBe('гэрээт');
      expect(row.querySelector('.price')?.textContent).toMatch(/₮/);
      expect(row.querySelector('.meta')?.textContent).toMatch(/-р сарын \d+-нөөс/);
    }
    // The filter narrows by animal, never rearranges.
    clickText(dom, '#kinds button', 'Үхэр');
    await until(dom, 'only beef', (d) =>
      [...d.querySelectorAll('.listing')].every((l) => l.getAttribute('data-kind') === 'beef'),
    );
    expect(dom.window.document.querySelectorAll('.listing').length).toBeGreaterThan(0);
  });

  it('walks a guest from a stall to a paid order, and the launcher knows', async () => {
    await ownGuest('+97699004001');
    const dom = await openPage('idesh.html');
    const title = await buyOne(dom);

    // Paid, the code is shown large for the handover, the cancel button says
    // until when, and the supplier is now somebody you can call.
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Төлсөн');
    expect(dom.window.document.querySelector('.handcode b')?.textContent).toMatch(/^\d{4}$/);
    expect(dom.window.document.querySelector('#sheet-foot [data-v="danger"]')?.textContent).toContain(
      'Үнэгүй цуцлах',
    );
    expect(dom.window.document.querySelector('.where a[href^="tel:"]')).toBeTruthy();
    // A pickup has no «Замд» step to leave undone.
    expect(dom.window.document.querySelectorAll('.timeline li')).toHaveLength(4);
    expect(dom.window.document.querySelector('#sheet-sub')?.textContent).toContain(title);

    // …and it sits on the home screen beside whatever lunch there is.
    const home = await openPage('index.html');
    await until(home, 'the order on the home screen', (d) =>
      d.querySelectorAll('.card[data-source="Идэш"]').length > 0,
    );
    const card = home.window.document.querySelector('.card[data-source="Идэш"]') as HTMLAnchorElement;
    expect(card.getAttribute('href')).toMatch(/^\/idesh\?order=[0-9a-f-]{36}$/);
    expect(card.querySelector('.chip')?.textContent).toBe('Төлсөн');
    expect(card.querySelector('.when')?.textContent).toMatch(/^\d{1,2}\/\d{1,2}авах$/);

    // Following it lands on the order, not on the stalls.
    const back = await openPage('idesh.html', card.getAttribute('href')!.slice('/idesh'.length));
    await until(back, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(back.window.document.querySelector('#sheet-name')?.textContent).toMatch(/^№\d{4}$/);
  });

  it('asks for an address only when the meat is to be delivered', async () => {
    await ownGuest('+97699004002');
    const dom = await openPage('idesh.html');
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    const delivered = [...dom.window.document.querySelectorAll('.listing')].find(
      (l) => l.textContent?.includes('хүргэнэ') && !l.hasAttribute('data-gone'),
    ) as HTMLElement;
    delivered.click();
    await until(dom, 'the sheet', (d) => Boolean(d.querySelector('#pay')));
    expect(dom.window.document.querySelector('#address')).toBeNull();

    clickText(dom, '.pick button', 'Хүргүүлэх');
    await until(dom, 'the address field', (d) => Boolean(d.querySelector('#address')));
    // Nothing to pay for until the courier knows where to go.
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;
    expect(pay().disabled).toBe(true);
    expect(pay().textContent).toContain('Хаяг');

    const address = dom.window.document.querySelector('#address') as HTMLTextAreaElement;
    address.value = 'Баянзүрх, 13-р хороолол, 45-12';
    address.dispatchEvent(new dom.window.Event('input'));
    const phone = dom.window.document.querySelector('#phone') as HTMLInputElement;
    phone.value = '+97699112233';
    phone.dispatchEvent(new dom.window.Event('input'));
    await until(dom, 'a price', () => !pay().disabled);
    // The fee is in the number, not a surprise after.
    expect(pay().textContent).toMatch(/₮ төлөх/);
  });

  it('shows the paid order to its supplier, who walks it to the handover', async () => {
    await ownGuest('+97699004003');
    const guest = await openPage('idesh.html');
    await buyOne(guest);
    const code = guest.window.document.querySelector('.handcode b')?.textContent;

    storage.removeItem('basu.supplier');
    const screen = await openPage('supplier.html');
    await until(screen, 'the pairing form', (d) => d.querySelectorAll('.venues button').length > 0);
    expect(screen.window.document.querySelector('.pair h2')?.textContent).toBe('Дэлгэцээ холбоно уу');
    // The demo codes are offered, so nobody copies one out of a terminal.
    expect((screen.window.document.querySelector('.pair input') as HTMLInputElement).value).toMatch(/^\d{8}$/);

    clickText(screen, '.venues button', 'Бүх нийлүүлэгч');
    await until(screen, 'the board', (d) => d.querySelectorAll('.lane').length === 4);
    await until(screen, 'our order', (d) =>
      [...d.querySelectorAll('.ticket')].some((t) => t.textContent?.includes(`№${code}`)),
    );
    const ticket = () =>
      [...screen.window.document.querySelectorAll('.ticket')].find((t) =>
        t.textContent?.includes(`№${code}`),
      )!;
    expect(ticket().getAttribute('data-lane')).toBe('paid');
    expect(ticket().textContent).toContain('Өөрөө ирж авна');

    // Every supplier's board is on this screen, so the button has to be the
    // one on *our* ticket — the first «Бэлтгэж эхлэх» on the page may belong
    // to an order another test just paid for.
    const start = [...ticket().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Бэлтгэж эхлэх'),
    ) as HTMLElement;
    start.click();
    await until(screen, 'the ticket to move', () => ticket()?.getAttribute('data-lane') === 'preparing');

    // The guest's page catches up on its own and the cancel button is gone.
    await until(guest, 'the guest to be told', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'PREPARING');
    // `body.textContent` carries the page's own script, so a phrase that
    // appears in the code cannot be asserted absent from the text. Ask the
    // footer instead.
    expect(guest.window.document.querySelector('#sheet-foot [data-v="danger"]')).toBeNull();
    expect(guest.window.document.querySelector('.status .big')?.textContent).toBe('Бэлтгэж байна');
  });

  it('lets a supplier run their own stall from their screen', async () => {
    storage.removeItem('basu.supplier');
    const screen = await openPage('supplier.html');
    await until(screen, 'the pairing form', (d) => d.querySelectorAll('.venues button').length > 0);
    clickText(screen, '.venues button', seeded.supplierPaired);
    await until(screen, 'the stall', (d) => d.querySelectorAll('.stall .row').length > 0);
    const before = screen.window.document.querySelectorAll('.stall .row[data-listing]').length;
    expect(before).toBeGreaterThan(0);
    expect(screen.window.document.querySelector('.new h3')?.textContent).toBe('Шинэ зар');

    const form = screen.window.document.querySelector('.new')!;
    const set = (name: string, value: string) => {
      const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
      input.value = value;
    };
    set('title', 'Хонь, шинэ зар');
    set('price_mnt', '400000');
    set('approx_kg', '35');
    set('quantity', '5');
    set('origin', 'Архангай');
    (form.querySelector('#add') as HTMLElement).click();

    await until(screen, 'the new row', (d) =>
      d.querySelectorAll('.stall .row[data-listing]').length === before + 1,
    );
    expect(
      [...screen.window.document.querySelectorAll('.stall .row .name')].some((n) =>
        n.textContent?.includes('Хонь, шинэ зар'),
      ),
    ).toBe(true);
    // …and the guests can see it at once.
    const guest = await openPage('idesh.html');
    await until(guest, 'the new stall', (d) =>
      [...d.querySelectorAll('.listing .name')].some((n) => n.textContent === 'Хонь, шинэ зар'),
    );
  });
});

describe('нийлүүлэгч болох', () => {
  it('takes an application on the supplier page, approves it on the ops page, and pairs', async () => {
    // A person of this test's own, signed in the demo way with their number.
    await ownGuest('+97688010011');
    storage.removeItem('basu.supplier');
    const page = await openPage('supplier.html');
    await until(page, 'the pairing form', (d) => Boolean(d.querySelector('#become')));
    (page.window.document.querySelector('#become') as HTMLElement).click();

    await until(page, 'the application form', (d) => Boolean(d.querySelector('#apply')));
    const set = (name: string, value: string) => {
      const input = page.window.document.querySelector(`#apply [name="${name}"]`) as HTMLInputElement;
      input.value = value;
    };
    set('name', 'Хөвсгөл · Түмэн-Өлзий');
    set('tin', '6509876543');
    set('address', 'Сонгинохайрхан, Эмээлтийн зах');
    set('about', 'Хөвсгөлийн үхэр, 11-р сараас');
    (page.window.document.querySelector('#submit') as HTMLElement).click();

    await until(page, 'the waiting card', (d) => d.querySelector('#application .status')?.getAttribute('data-s') === 'applied');
    expect(page.window.document.querySelector('#application .big')?.textContent).toBe('Хүлээгдэж байна');

    // Nothing of theirs is on the guests' page yet.
    const guests = await openPage('idesh.html');
    await until(guests, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    expect(
      [...guests.window.document.querySelectorAll('.listing .from')].some((f) =>
        f.textContent?.includes('Түмэн-Өлзий'),
      ),
    ).toBe(false);

    /* the desk */
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await until(desk, 'the applications', (d) =>
      [...d.querySelectorAll('#applied .row')].some((r) => r.textContent?.includes('Түмэн-Өлзий')),
    );
    const row = [...desk.window.document.querySelectorAll('#applied .row')].find((r) =>
      r.textContent?.includes('Түмэн-Өлзий'),
    )!;
    // The proved phone travels with the application, so ops can ring.
    expect(row.textContent).toContain('+97688010011');
    (row.querySelector('[data-a="approve"]') as HTMLElement).click();
    await until(desk, 'the row to move', (d) =>
      [...d.querySelectorAll('#all .row[data-state="contracted"]')].some((r) =>
        r.textContent?.includes('Түмэн-Өлзий'),
      ),
    );

    /* back on the applicant's page, the yes has arrived with a code */
    const again = await openPage('supplier.html');
    await until(again, 'the pairing form', (d) => Boolean(d.querySelector('#become')));
    (again.window.document.querySelector('#become') as HTMLElement).click();
    await until(again, 'the approval', (d) => d.querySelector('#application .status')?.getAttribute('data-s') === 'contracted');
    expect(again.window.document.querySelector('.code b')?.textContent).toMatch(/^\d{8}$/);
    (again.window.document.querySelector('#pair-now') as HTMLElement).click();
    await until(again, 'the board', (d) => d.querySelectorAll('.lane').length === 4);
    expect(again.window.document.querySelector('#supplier')?.textContent).toBe('Хөвсгөл · Түмэн-Өлзий');
  });

  it('shows the seeded application waiting on the ops page', async () => {
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await until(desk, 'the applications', (d) => d.querySelectorAll('#applied .row').length > 0);
    expect(desk.window.document.querySelector('#applied .row')?.textContent).toContain('Завхан');
  });
});

/**
 * Sign in as somebody nobody else is using.
 *
 * The demo login hands every page the same person, which is right for a
 * walkthrough and wrong for a test about "my orders": one guest's list would
 * carry every other test's lunch.
 */
async function ownGuest(phone: string): Promise<void> {
  const response = await fetch(`${base}/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const { token } = (await response.json()) as { token: string };
  storage.setItem('basu.guest', token);
}

/** A tablet token for a named restaurant, the way the demo hands one out. */
async function tabletFor(name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM dine.restaurant WHERE name = $1',
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
