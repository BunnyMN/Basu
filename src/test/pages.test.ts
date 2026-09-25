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
  const sideNav = strip(await readFile(join(WEB, 'sidenav.js'), 'utf8'));
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const page = inline.replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '');

  stubMapLibre(window);
  window.eval(
    `(async () => { ${shared}\n${mapLib}\n${sideNav}\n${page} })().catch(e => { window.__err = e; });`,
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
/**
 * A shared runner is two to three times slower than a laptop, and every one
 * of these waits is a page fetching over HTTP while the rest of the suite
 * runs beside it. The deadline is here to fail fast while somebody is
 * watching, not to call a slow machine a broken product.
 */
const PATIENCE = process.env['CI'] ? 25_000 : 8_000;

async function until(
  dom: JSDOM,
  label: string,
  predicate: (doc: Document) => boolean,
  timeoutMs = PATIENCE,
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
      `\n--- body ---\n${dom.window.document.body.textContent?.replace(/\s+/g, " ").slice(0, 2400)}`,
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
    // A guest of its own. This test leaves a live order at the paired
    // kitchen; on the shared demo guest that order was still there when a
    // later test signed back in as the same person, and its menu turned into
    // somebody else's order screen — on CI, where the timing lined up.
    await ownGuest('+97699003009');
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
    const home = await openPage('app.html');
    await until(home, 'the app grid', (d) => d.querySelectorAll('.app').length > 0);

    const dine = home.window.document.querySelector('.app[data-app="dine"]') as HTMLAnchorElement;
    expect(dine.getAttribute('href')).toBe('/dine');
    expect(dine.textContent).toContain('Хоол');
    // Every tile is the app's own art — the same renders the iPhone
    // launcher shows, served from here and sized in the markup so the grid
    // never jumps while they load.
    expect(dine.querySelector('.tile img')?.getAttribute('src')).toBe('/brand/food-tile.webp');
    expect(home.window.document.querySelectorAll('.card')).toHaveLength(0);

    // The second app: one entry in the list, and nothing else moved.
    const idesh = home.window.document.querySelector('.app[data-app="idesh"]') as HTMLAnchorElement;
    expect(idesh.getAttribute('href')).toBe('/idesh');
    expect(idesh.textContent).toContain('Идэш');
    expect(idesh.querySelector('.tile img')?.getAttribute('src')).toBe('/brand/idesh-tile.webp');
    expect(home.window.document.querySelectorAll('.app')).toHaveLength(2);
  });

  it('carries a live order home, and opens it again from there', async () => {
    // A guest of this test's own, so the strip holds one order and it is ours.
    await ownGuest('+97699003001');
    const guest = await openPage('dine.html');
    // Its own slot: three orders fill one, and the other tests have theirs.
    await orderFromMap(guest, pairedVenue, 'Хуушуур', '13:00');

    const home = await openPage('app.html');
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
    // The same ticket the wait just saw — the seed has other хуушуур tickets
    // in other lanes, and which one comes first depends on the clock.
    const accepted = [...kds.window.document.querySelectorAll('.ticket')].find(
      (t) => t.textContent?.includes('Хуушуур') && t.textContent?.includes('Одоо тавь'),
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
    await until(dom, 'the stall screen', (d) => Boolean(d.querySelector('#next')));
    const title = dom.window.document.querySelector('#screen-title')?.textContent ?? '';
    // Collected, on the day it is ready — the form's own defaults.
    expect(dom.window.document.querySelector('.choice[data-r="pickup"]')?.getAttribute('aria-checked')).toBe('true');
    expect((dom.window.document.querySelector('#when') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The four questions are numbered, and a pickup has three of them.
    expect(dom.window.document.querySelectorAll('.step').length).toBe(3);
    const next = dom.window.document.querySelector('#next') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    // Nothing is charged before the person has seen the whole order once.
    await until(dom, 'the review', (d) => Boolean(d.querySelector('#pay')));
    expect(dom.window.document.querySelector('.review .total b')?.textContent).toMatch(/₮$/);
    (dom.window.document.querySelector('#pay') as HTMLElement).click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    return title;
  }

  it('lists every stall, names the supplier, and says it is under contract', async () => {
    const dom = await openPage('idesh.html');
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);

    for (const row of dom.window.document.querySelectorAll('.listing')) {
      expect(row.querySelector('.art img')?.getAttribute('src')).toMatch(/^\/idesh\/(sheep|goat|beef|horse)\.jpg$/);
      // The contract is the trust mark, on every row, before the name.
      expect(row.querySelector('.from .verified')?.textContent).toContain('Гэрээт');
      expect(row.querySelector('.price b')?.textContent).toMatch(/₮$/);
      // What the price is for sits under it: the weight, or the minimum.
      expect(row.querySelector('.price small')?.textContent).toMatch(/кг/);
      expect(row.querySelector('.bits')?.textContent).toMatch(/-р сарын \d+-нөөс/);
      expect(row.querySelector('.left')?.textContent).toMatch(/үлдсэн|Дууссан/);
    }
    // The page says how much there is to choose from, and who stands behind it.
    expect(dom.window.document.querySelector('#tally')?.textContent).toMatch(/^\d+ зар · \d+ гэрээт нийлүүлэгч$/);
    expect(dom.window.document.querySelectorAll('.trust div')).toHaveLength(3);
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

    // Paid, the code is shown large for the handover, and the supplier is now
    // somebody you can call — which is the one button. There is no cancel:
    // money that has moved does not come back at a press.
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expect(dom.window.document.querySelector('.handcode b')?.textContent).toMatch(/^\d{4}$/);
    expect(dom.window.document.querySelector('#screen-foot a[href^="tel:"]')?.textContent).toContain('залгах');
    expect(dom.window.document.querySelector('#screen-foot [data-v="danger"]')).toBeNull();
    expect(dom.window.document.querySelector('.panel a[href^="tel:"]')).toBeTruthy();
    // A pickup has no «Замд» step to leave undone.
    expect(dom.window.document.querySelectorAll('.timeline li')).toHaveLength(4);
    expect(dom.window.document.querySelector('#screen-sub')?.textContent).toContain(title);

    // …and it sits on the home screen beside whatever lunch there is.
    const home = await openPage('app.html');
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
    expect(back.window.document.querySelector('#screen-title')?.textContent).toMatch(/^№\d{4}$/);
  });

  it('asks for an address only when the meat is to be delivered', async () => {
    await ownGuest('+97699004002');
    const dom = await openPage('idesh.html');
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    const delivered = [...dom.window.document.querySelectorAll('.listing')].find(
      (l) => l.textContent?.includes('Хүргэлттэй') && !l.hasAttribute('data-gone'),
    ) as HTMLElement;
    delivered.click();
    await until(dom, 'the stall screen', (d) => Boolean(d.querySelector('#next')));
    expect(dom.window.document.querySelector('#address')).toBeNull();

    (dom.window.document.querySelector('.choice[data-r="delivery"]') as HTMLElement).click();
    await until(dom, 'the address question', (d) => Boolean(d.querySelector('#step-where #address')));
    expect(dom.window.document.querySelectorAll('.step').length).toBe(4);
    // No way on until the courier knows where to go — and the bar says why.
    const pay = () => dom.window.document.querySelector('#next') as HTMLButtonElement;
    expect(pay().disabled).toBe(true);
    expect(dom.window.document.querySelector('#screen-foot .why')?.textContent).toContain('Хаяг');

    const address = dom.window.document.querySelector('#address') as HTMLTextAreaElement;
    address.value = 'Баянзүрх, 13-р хороолол, 45-12';
    address.dispatchEvent(new dom.window.Event('input'));
    const phone = dom.window.document.querySelector('#phone') as HTMLInputElement;
    phone.value = '+97699112233';
    phone.dispatchEvent(new dom.window.Event('input'));
    await until(dom, 'the way on', () => !pay().disabled);
    // The fee is in the number, not a surprise after.
    expect(dom.window.document.querySelector('#screen-foot .sum span')?.textContent).toContain('хүргэлт');
    expect(dom.window.document.querySelector('#screen-foot .sum b')?.textContent).toMatch(/₮$/);
  });

  it('cancels for a reason on the supplier’s screen, and the guest names the account the refund goes to', async () => {
    await ownGuest('+97699004007');
    const guest = await openPage('idesh.html');
    await buyOne(guest);
    const code = guest.window.document.querySelector('.handcode b')?.textContent;
    const total = guest.window.document.querySelector('.panel .mono')?.textContent;

    /* the supplier: why, then how much, then confirm */
    storage.removeItem('basu.supplier');
    const screen = await openPage('supplier.html');
    await pairingCard(screen);
    clickText(screen, '.venues button', 'Бүх нийлүүлэгч');
    const ticket = () =>
      [...screen.window.document.querySelectorAll('.ticket')].find((t) => t.textContent?.includes(`№${code}`));
    await until(screen, 'our order', () => Boolean(ticket()));
    expect(ticket()!.textContent).toContain('Танд очих');
    (ticket()!.querySelector('[data-a="cancel"]') as HTMLElement).click();
    const reasons = ticket()!.querySelector('.reasons')!;
    expect(reasons.querySelector('[data-a="confirm"]')).toHaveProperty('disabled', true);
    const pick = reasons.querySelector('input[value="guest_asked"]') as HTMLInputElement;
    pick.checked = true;
    pick.dispatchEvent(new screen.window.Event('change', { bubbles: true }));
    // Before slaughter: everything back, and the screen says so before the press.
    expect(reasons.querySelector('.money')?.textContent).toContain('бүтнээр');
    (reasons.querySelector('[data-a="confirm"]') as HTMLElement).click();
    await until(screen, 'the ticket to go', () => !ticket());

    /* the guest: told, and asked where the money goes */
    await until(guest, 'the cancel to show', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'CANCELLED');
    expect(guest.window.document.querySelector('.status .cap')?.textContent).toContain('банкны данс');
    const form = guest.window.document.querySelector('#refund')!;
    const send = form.querySelector('#send-account') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const type = (id: string, value: string) => {
      const input = form.querySelector(`#${id}`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new guest.window.Event('input'));
    };
    type('bank', 'Хаан банк');
    type('account', '5012 3456 78');
    expect(send.disabled).toBe(true);
    type('holder', 'Бат Дорж');
    expect(send.disabled).toBe(false);
    send.click();
    // Money is about to go to this account, so the person proves it is still
    // them: the password again, not a code the server cannot send.
    await until(guest, 'the confirm step', (d) => !(d.querySelector('#otp-step') as HTMLElement | null)?.hidden);
    type('otp', GUEST_PASSWORD);
    send.click();
    await until(guest, 'the account to be kept', (d) => d.querySelector('#refund')?.textContent?.includes('5012345678') ?? false);
    expect(guest.window.document.querySelector('#refund')?.textContent).toContain('Basu ажлын өдөрт');

    /* the desk: one line to pay, then paid */
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'pay');
    const line = () =>
      [...desk.window.document.querySelectorAll('#pay .row')].find((r) => r.textContent?.includes(`№${code}`));
    await until(desk, 'the refund to pay', () => Boolean(line()));
    expect(line()!.textContent).toContain('Буцаалт');
    expect(line()!.textContent).toContain('5012345678');
    expect(line()!.querySelector('.amount')?.textContent).toBe(total);
    // Two people, not one: the row offers only «Батлах» until somebody has
    // released it, and only then the button that says the money moved.
    expect(line()!.querySelector('[data-a="paid"]')).toBeNull();
    desk.window.confirm = () => true;
    (line()!.querySelector('[data-a="approve"]') as HTMLElement).click();
    await until(desk, 'the line to be released', () => Boolean(line()?.querySelector('[data-a="paid"]')));
    expect(line()!.textContent).toContain('баталсан');
    desk.window.prompt = () => 'KB-2026-001';
    (line()!.querySelector('[data-a="paid"]') as HTMLElement).click();
    await until(desk, 'the line to be paid', () => line()?.hasAttribute('data-paid') ?? false);
    expect(line()!.textContent).toContain('KB-2026-001');

    await until(guest, 'the guest to see it', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'REFUNDED');
    expect(guest.window.document.querySelector('.status .big')?.textContent).toBe('Мөнгө буцаасан');
  });

  it('shows the paid order to its supplier, who walks it to the handover', async () => {
    await ownGuest('+97699004003');
    const guest = await openPage('idesh.html');
    await buyOne(guest);
    const code = guest.window.document.querySelector('.handcode b')?.textContent;

    storage.removeItem('basu.supplier');
    const screen = await openPage('supplier.html');
    await pairingCard(screen);
    expect(screen.window.document.querySelector('.pair h2')?.textContent).toBe('Дэлгэцээ холбоно уу');
    // The demo codes are offered, so nobody copies one out of a terminal.
    expect((screen.window.document.querySelector('.pair input') as HTMLInputElement).value).toMatch(/^\d{8}$/);

    clickText(screen, '.venues button', 'Бүх нийлүүлэгч');
    await until(screen, 'the work', (d) => Boolean(d.querySelector('#board[data-ready]')));
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

    // The guest's page catches up on its own: the headline moves on, the
    // step is ticked, and the supplier is still the one to ring.
    await until(guest, 'the guest to be told', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'PREPARING');
    expect(guest.window.document.querySelector('.status .big')?.textContent).toBe('Мах бэлтгэгдэж байна');
    expect(guest.window.document.querySelectorAll('.timeline li[data-done]')).toHaveLength(2);
    expect(guest.window.document.querySelector('#screen-foot a[href^="tel:"]')).toBeTruthy();
  });

  it('lets a supplier run their own stall from their screen', async () => {
    storage.removeItem('basu.supplier');
    const screen = await openPage('supplier.html');
    await pairingCard(screen);
    clickText(screen, '.venues button', seeded.supplierPaired);
    // The stall has its own tab now, beside today's work.
    await until(screen, 'the module', (d) => Boolean(d.querySelector('.tabs button[data-tab="stall"]')));
    (screen.window.document.querySelector('.tabs button[data-tab="stall"]') as HTMLElement).click();
    await until(screen, 'the stall', (d) => d.querySelectorAll('.stall .row[data-listing]').length > 0);
    const before = screen.window.document.querySelectorAll('.stall .row[data-listing]').length;
    expect(before).toBeGreaterThan(0);
    expect(screen.window.document.querySelector('.new h3')?.textContent).toBe('Шинэ зар нэмэх');

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
    // Signed in already, the door opens straight onto the application form.
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
    await opsTab(desk, 'suppliers');
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
    // Approved, the same phone now opens the supplier's own module — no
    // code to type: the phone is the proof.
    await until(again, 'the module', (d) => Boolean(d.querySelector('#board[data-ready]')));
    await until(again, 'the name', (d) => d.querySelector('#supplier')?.textContent === 'Хөвсгөл · Түмэн-Өлзий');
    expect(again.window.document.querySelectorAll('.tabs button[data-tab]')).toHaveLength(5);
  });

  it('shows the seeded application waiting on the ops page', async () => {
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'suppliers');
    await until(desk, 'the applications', (d) => d.querySelectorAll('#applied .row').length > 0);
    expect(desk.window.document.querySelector('#applied .row')?.textContent).toContain('Завхан');
  });

  it('opens on the whole house: what needs somebody, what is held, what the day brought', async () => {
    storage.removeItem('basu.ops');
    storage.removeItem('basu.ops.tab');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await until(desk, 'the front page', (d) => d.querySelectorAll('#now .kpi').length === 6);
    const doc = desk.window.document;
    expect(doc.querySelector('.tabs button[data-tab="overview"]')?.hasAttribute('data-on')).toBe(true);
    expect(doc.querySelector('.tabs .grp')?.textContent).toBe('Платформ');
    // The seeded application is waiting, and the page says so before anything else.
    expect([...doc.querySelectorAll('#alerts .alert')].map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('нийлүүлэгчийн өргөдөл')]),
    );
    expect(doc.querySelector('#now')?.textContent).toContain('Зочдын түрийвч');
    expect(doc.querySelector('#cross')?.textContent).toContain('Борлуулалт');
    // The alert's button goes to the section that answers it.
    (doc.querySelector('#alerts button[data-go="suppliers"]') as HTMLElement).click();
    await until(desk, 'the applications', (d) => d.querySelectorAll('#applied .row').length > 0);
  });

  it('finds a guest by phone and opens their file: wallet, lunches, meat, messages', async () => {
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'guests');
    await until(desk, 'the directory', (d) => d.querySelectorAll('#guests tr[data-guest]').length > 0);
    const q = desk.window.document.querySelector('#q') as HTMLInputElement;
    q.value = '99001122';
    q.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
    await until(desk, 'one guest', (d) => d.querySelectorAll('#guests tr[data-guest]').length === 1);
    const row = desk.window.document.querySelector('#guests tr[data-guest]')!;
    expect(row.textContent).toContain('+97699001122');
    (row as HTMLElement).click();
    await until(desk, 'the file', (d) => Boolean(d.querySelector('.detail .facts')));
    const doc = desk.window.document;
    expect(doc.querySelector('.page-head')?.textContent).toContain('+97699001122');
    expect(doc.querySelector('.facts')?.textContent).toContain('Түрийвч');
    expect([...doc.querySelectorAll('.section > h2')].map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['Түрийвчийн хуулга', 'Хоолны захиалга', 'Идэшний захиалга', 'Мэдэгдэл']),
    );
    // The demo's guest has lunch on the books, and the desk can see it.
    expect(doc.querySelectorAll('.section table tbody tr').length).toBeGreaterThan(0);
  });

  it('shows every kitchen with its tablets, then the day’s lunches and one lunch’s story', async () => {
    storage.removeItem('basu.ops');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'venues');
    await until(desk, 'the kitchens', (d) => d.querySelectorAll('#venues [data-venue]').length > 0);
    const doc = desk.window.document;
    const venue = doc.querySelector('#venues [data-venue]')!;
    expect(venue.textContent).toContain('Өнөөдөр');
    expect(venue.querySelector('button[data-a="tablet"]')).not.toBeNull();
    // The menu unfolds under the kitchen, with the switch for each dish.
    (venue.querySelector('button[data-a="menu"]') as HTMLElement).click();
    await until(desk, 'the menu', (d) => d.querySelectorAll('#venues .drawer tbody tr').length > 0);
    expect(doc.querySelector('#venues .drawer button[data-item]')?.textContent).toBe('Нуух');

    await opsTab(desk, 'lunches');
    await until(desk, 'the lunches', (d) => d.querySelectorAll('#lunches tr[data-lunch]').length > 0);
    (doc.querySelector('#lunches tr[data-lunch]') as HTMLElement).click();
    await until(desk, 'one lunch', (d) => Boolean(d.querySelector('.detail .story')));
    expect(doc.querySelector('.page-head h1')?.textContent).toContain('№');
    expect([...doc.querySelectorAll('.section > h2')].map((h) => h.textContent)).toEqual(expect.arrayContaining(['Хоол', 'Явц']));
  });

  it('opens the books: the checks, every account, then the movements with a CSV to take away', async () => {
    storage.removeItem('basu.ops');
    storage.removeItem('basu.ops.money');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'money');
    await until(desk, 'the checks', (d) => d.querySelectorAll('#money .kpi').length === 6);
    const doc = desk.window.document;
    expect(doc.querySelector('#money .kpi')?.textContent).toContain('тэнцсэн');
    expect(doc.querySelector('#money table')?.textContent).toContain('QPay · клиринг');
    expect(doc.querySelector('#run')).not.toBeNull();

    clickText(desk, '.page-head .seg button', 'Гүйлгээ');
    await until(desk, 'the movements', (d) => d.querySelectorAll('#transfers tr').length > 0);
    expect(doc.querySelector('#transfers')?.textContent).toContain('→');
    expect(doc.querySelector('#csv')?.textContent).toBe('CSV татах');
  });

  it('shows what we told people, then how the machine is, and lets an admin turn a knob', async () => {
    storage.removeItem('basu.ops');
    storage.removeItem('basu.ops.notify');
    const desk = await openPage('ops.html');
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'notify');
    await until(desk, 'the log', (d) => d.querySelectorAll('#messages li[data-message]').length > 0);
    const doc = desk.window.document;
    expect(doc.querySelector('#messages li[data-message]')?.textContent).toMatch(/SMS|Push/);

    await opsTab(desk, 'system');
    await until(desk, 'the machine', (d) => d.querySelectorAll('#integrations [data-integration]').length === 4);
    expect(doc.querySelector('#integrations .kpi')?.textContent).toContain('Scheduler');
    expect(doc.querySelector('#settings input[data-key="desk_banner"]')).not.toBeNull();
    const banner = doc.querySelector('#settings input[data-key="desk_banner"]') as HTMLInputElement;
    banner.value = 'Маргааш ажиллахгүй';
    (doc.querySelector('#save-settings') as HTMLElement).click();
    await until(desk, 'the knob turned', (d) => d.querySelector('#settings')?.textContent?.includes('Демо') ?? false);

    // The front page carries the word to everyone at the desk.
    await opsTab(desk, 'overview');
    await until(desk, 'the banner', (d) => Boolean(d.querySelector('#banner')));
    expect(doc.querySelector('#banner')?.textContent).toContain('Маргааш ажиллахгүй');
  });
});

describe('who sees what', () => {
  /** A person of this test's own, signed up the way anybody is; their session, not stored anywhere yet. */
  async function account(phone: string, name: string): Promise<string> {
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: GUEST_PASSWORD, name }),
    });
    return ((await made.json()) as { token: string }).token;
  }
  const as = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
  const deskToken = async () => ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;

  /** A business its owner registered and the desk approved, with the people given, each in a role. */
  async function business(owner: string, name: string, kinds: Record<string, boolean>, people: Array<[string, string]> = []): Promise<string> {
    const made = (await (await fetch(`${base}/v1/orgs`, {
      method: 'POST',
      headers: as(owner),
      body: JSON.stringify({ name, ...kinds, phone: '8811 0001', address: 'Нарантуул, 3-р хаалга' }),
    })).json()) as { id: string };
    await fetch(`${base}/v1/ops/orgs/${made.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${await deskToken()}` } });
    for (const [phone, role] of people) {
      const found = (await (await fetch(`${base}/v1/orgs/${made.id}/lookup?contact=${encodeURIComponent(phone)}`, { headers: as(owner) })).json()) as { guest_id: string };
      await fetch(`${base}/v1/orgs/${made.id}/members`, { method: 'POST', headers: as(owner), body: JSON.stringify({ guest_id: found.guest_id, role }) });
    }
    return made.id;
  }
  const tabs = (dom: JSDOM) => [...dom.window.document.querySelectorAll('.tabs [data-tab]')].map((b) => (b as HTMLElement).dataset['tab']);

  it('opens the dashboard on a butcher’s staff member’s own business: the day and the stall, no money, no menu, no desk', async () => {
    const owner = await account('+97688030001', 'Дорж');
    const staff = await account('+97688030003', 'Бат');
    const orgId = await business(owner, 'Хэрлэн мах · тест', { supplier: true }, [['+97688030003', 'staff']]);
    storage.setItem('basu.ops', staff);
    storage.removeItem('basu.dash.ws');
    const dash = await openPage('ops.html');
    await until(dash, 'the business', (d) => Boolean(d.querySelector('.tabs [data-tab="idesh.today"]')));
    const doc = dash.window.document;
    expect(doc.querySelector('.ws-btn')?.textContent).toContain('Хэрлэн мах · тест');
    expect(doc.querySelector('.ws-btn')?.textContent).toContain('Нийлүүлэгч · Ажилтан');
    expect(tabs(dash)).toEqual(['home', 'idesh.today', 'idesh.orders', 'idesh.stall', 'idesh.profile', 'team', 'profile', 'roles']);
    expect(doc.querySelector('.nav-group[data-group="dine"]')).toBeNull();
    // The supplier's pages are the supplier's own screen, opened for this business.
    expect(doc.querySelector('.tabs a[data-tab="idesh.orders"]')?.getAttribute('href')).toBe(`/supplier?org=${orgId}#orders`);
    // The table of roles marks the staff's own column.
    (doc.querySelector('.tabs [data-tab="roles"]') as HTMLElement).click();
    await until(dash, 'the roles', (d) => Boolean(d.querySelector('.table.roles th.yours')));
    expect(doc.querySelector('.table.roles th.yours')?.textContent).toContain('Ажилтан');
    expect(doc.querySelector('.table.roles')?.textContent).not.toContain('Цэс');
  });

  it('lets an owner bring somebody in from the dashboard, and keeps the record of it', async () => {
    const owner = await account('+97688030011', 'Сараа');
    await account('+97688030013', 'Туяа');
    const orgId = await business(owner, 'Алтан тогоо · тест', { restaurant: true });
    storage.setItem('basu.ops', owner);
    const dash = await openPage('ops.html', `#${orgId}/team`);
    await until(dash, 'the team', (d) => d.querySelectorAll('tr[data-member]').length === 1);
    const doc = dash.window.document;
    // A restaurant: a menu, and no stall.
    expect(tabs(dash)).toEqual(expect.arrayContaining(['dine.orders', 'dine.menu', 'dine.kitchen', 'team', 'log']));
    expect(tabs(dash).some((t) => t?.startsWith('idesh.'))).toBe(false);
    (doc.querySelector('[name="contact"]') as HTMLInputElement).value = '88030013';
    (doc.querySelector('[data-find]') as HTMLElement).click();
    await until(dash, 'the person found', (d) => Boolean(d.querySelector('[data-add-go]')));
    (doc.querySelector('[data-found] select') as HTMLSelectElement).value = 'accountant';
    (doc.querySelector('[data-add-go]') as HTMLElement).click();
    await until(dash, 'the new member', (d) => d.querySelectorAll('tr[data-member]').length === 2);
    expect(doc.querySelector('[data-members]')?.textContent).toContain('Туяа');

    (doc.querySelector('.tabs [data-tab="log"]') as HTMLElement).click();
    await until(dash, 'the record', (d) => d.querySelectorAll('#org-log li').length >= 3);
    expect(doc.querySelector('#org-log li')?.textContent).toContain('Туяа нэмэгдсэн · нягтлан');
  });

  it('gives an accountant the orders and the money on the supplier’s screen, and no counter or stall', async () => {
    const owner = await account('+97688030021', 'Болд');
    const accountant = await account('+97688030024', 'Номин');
    const orgId = await business(owner, 'Туул мах · тест', { supplier: true }, [['+97688030024', 'accountant']]);
    storage.removeItem('basu.supplier');
    storage.setItem('basu.ops', accountant);
    const screen = await openPage('supplier.html', `?org=${orgId}`);
    await until(screen, 'the module', (d) => d.querySelectorAll('.tabbar button[data-tab]').length > 0);
    expect([...screen.window.document.querySelectorAll('.tabbar button[data-tab]')].map((b) => (b as HTMLElement).dataset['tab'])).toEqual(['orders', 'money', 'profile']);
    expect(screen.window.document.querySelector('#supplier')?.textContent).toBe('Туул мах · тест');
    storage.removeItem('basu.ops');
  });

  it('keeps the desk’s own pages to the roles that hold them', async () => {
    const desk = await deskToken();
    const invited = (await (await fetch(`${base}/v1/ops/members`, {
      method: 'POST',
      headers: as(desk),
      body: JSON.stringify({ phone: '+97688030031', name: 'Санхүү', role: 'finance' }),
    })).json()) as { invite_code: string };
    const claimed = (await (await fetch(`${base}/v1/auth/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invited.invite_code, phone: '+97688030031', password: GUEST_PASSWORD, name: 'Санхүү' }),
    })).json()) as { token: string };
    storage.setItem('basu.ops', claimed.token);
    storage.removeItem('basu.dash.ws');
    storage.removeItem('basu.ops.tab');
    const dash = await openPage('ops.html');
    await until(dash, 'the desk', (d) => Boolean(d.querySelector('.tabs [data-tab="money"]')));
    const seen = tabs(dash);
    expect(seen).toEqual(expect.arrayContaining(['overview', 'money', 'pay', 'audit']));
    for (const hidden of ['venues', 'lunches', 'notify', 'system', 'members']) expect(seen).not.toContain(hidden);
    storage.removeItem('basu.ops');
  });
});

/**
 * Sign in as somebody nobody else is using.
 *
 * The demo login hands every page the same person, which is right for a
 * walkthrough and wrong for a test about "my orders": one guest's list would
 * carry every other test's lunch.
 */
/**
 * The supplier page opens on the phone sign-in — a person's door. A tablet
 * goes one step further, to the pairing card with its code.
 */
async function pairingCard(dom: JSDOM): Promise<void> {
  // Whichever card the door showed — sign-in, the application form, or the
  // application's status — carries the way through to the pairing code.
  await until(dom, 'the front door', (d) => Boolean(d.querySelector('.door #back')));
  (dom.window.document.querySelector('.door #back') as HTMLElement).click();
  await until(dom, 'the pairing form', (d) => d.querySelectorAll('.venues button').length > 0);
}

/** The desk opens on the numbers; a test goes to the section it is about. */
async function opsTab(dom: JSDOM, key: string): Promise<void> {
  await until(dom, 'the desk', (d) => Boolean(d.querySelector(`.tabs button[data-tab="${key}"]`)));
  (dom.window.document.querySelector(`.tabs button[data-tab="${key}"]`) as HTMLElement).click();
}

/** Every test guest signs up the way a person does, with the same password. */
const GUEST_PASSWORD = 'туршилтын нууц үг';

async function ownGuest(phone: string): Promise<void> {
  const response = await fetch(`${base}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password: GUEST_PASSWORD }),
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
