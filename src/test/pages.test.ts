import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool } from '../db/pool.js';
import { DemoClock } from '../demoClock.js';
import { buildServer } from '../api/server.js';
import { handOff } from '../platform/identity/index.js';
import { seedDemo } from '../seed/demo.js';
import {
  FakeMailer,
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
/** What the server talks to. It has no email; a test about letters lends it a mailer while it runs. */
let ctx: Ctx;
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
 * Another browser: somebody else's device with a store of its own — the
 * desk at Basu's office, the tablet on a supplier's counter — beside the one
 * the test's guest is on. One browser holds one person, so two people are
 * two browsers. Given a session, somebody is already signed in on it.
 */
function device(token?: string): ReturnType<typeof memoryStorage> {
  const browser = memoryStorage();
  if (token) browser.setItem('basu.guest', token);
  return browser;
}

/**
 * What a browser keeps beside its storage: the cookies our server set,
 * each sent back with a request to the path it was set for, the way a
 * browser sends them with a page's same-origin fetch.
 */
type Jar = Map<string, { value: string; path: string }>;
const jars = new WeakMap<object, Jar>();
function cookiesOf(browser: object): Jar {
  let jar = jars.get(browser);
  if (!jar) jars.set(browser, (jar = new Map()));
  return jar;
}
/** One `Set-Cookie` line, kept — or dropped, when it says Max-Age=0. */
function keepCookie(jar: Jar, line: string): void {
  const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
  const name = pair.slice(0, pair.indexOf('='));
  const path = attributes.find((a) => /^path=/i.test(a))?.slice('path='.length) ?? '/';
  if (attributes.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
  else jar.set(name, { value: pair.slice(name.length + 1), path });
}

/** A signal of Node's own that aborts when the page's does, and for the same reason. */
function following(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller.signal;
}

/**
 * Back from Google, the way the callback leaves a browser: the page's
 * address carries a code, and the browser holds the cookie the code is good
 * only with. The handoff is the server's own; only the round trip to Google
 * is skipped here — src/api/auth.test.ts walks that.
 */
async function backFromGoogle(guestId: string, browser: object): Promise<string> {
  const { code, binding } = await handOff(guestId, 'Google', clock.now());
  keepCookie(cookiesOf(browser), `basu_handoff=${binding}; Path=/v1/auth/handoff; Max-Age=120; HttpOnly; Secure; SameSite=Lax`);
  return `#auth_code=${code}`;
}

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
 * be given one that says something. `respond` answers a request in place of
 * the server, for a state the seed cannot be put in — an empty market — or
 * loses the server's answer on its way back, the way a patchy connection does.
 */
async function openPage(
  file: string,
  search = '',
  respond?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  browser: ReturnType<typeof memoryStorage> = storage,
): Promise<JSDOM> {
  const html = await readFile(join(WEB, file), 'utf8');
  const dom = new JSDOM(html, {
    url: `${base}/${file.replace(/\.html$/, '')}${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom has no fetch; point it at the running server and resolve relative
  // paths the way a browser would, with the cookies this browser holds.
  const jar = cookiesOf(browser);
  (window as unknown as { fetch: typeof fetch }).fetch = (async (input: string, init?: RequestInit) => {
    const canned = respond?.(String(input), init);
    if (canned) return canned;
    const url = new URL(String(input), base);
    const headers = new Headers(init?.headers);
    const sent = [...jar].filter(([, c]) => url.pathname.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`);
    if (sent.length) headers.set('cookie', sent.join('; '));
    // The page's AbortSignal is jsdom's, and Node's fetch takes only its own:
    // one of those follows it, so a request the page gives up on is given up.
    const response = await fetch(url.toString(), { ...init, headers, signal: init?.signal ? following(init.signal) : null });
    for (const line of response.headers.getSetCookie()) keepCookie(jar, line);
    return response;
  }) as typeof fetch;
  Object.defineProperty(window, 'localStorage', { value: browser, writable: true });

  // Every local module the page imports, inlined. jsdom cannot resolve module
  // specifiers, so the pieces are concatenated and run as one script — the same
  // code the browser loads, minus the plumbing.
  const strip = (source: string) => source.replace(/\bexport\s+/g, '');
  const shared = strip(await readFile(join(WEB, 'api.js'), 'utf8'));
  // The website's pages share site.js on top of api.js; the app's pages do not.
  const site = html.includes("from '/site.js'")
    ? strip((await readFile(join(WEB, 'site.js'), 'utf8')).replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, ''))
    : '';
  const mapLib = strip(await readFile(join(WEB, 'mapStyle.js'), 'utf8'));
  const sideNav = strip(await readFile(join(WEB, 'sidenav.js'), 'utf8'));
  // The dashboard's tables: TanStack's table-core as the global the page's
  // <script src> would have made, and our rendering of it inlined like the rest.
  const tables = html.includes("from '/datatable.js'") ? strip(await readFile(join(WEB, 'datatable.js'), 'utf8')) : '';
  if (tables) window.eval(await readFile(join(WEB, 'vendor', 'table-core.js'), 'utf8'));
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const page = inline.replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '');

  stubMapLibre(window);
  window.eval(
    `(async () => { ${shared}\n${site}\n${mapLib}\n${sideNav}\n${tables}\n${page} })().catch(e => { window.__err = e; });`,
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

/**
 * Answer the popup on top, as a person does: wait for it (and for the fields
 * named, when a second step draws them), type into them, press its button.
 */
async function answerPopup(dom: JSDOM, values: Record<string, string> = {}): Promise<void> {
  const top = () => [...dom.window.document.querySelectorAll('.sheet.popup[data-open]')].pop() as HTMLElement | undefined;
  await until(dom, `a popup with ${Object.keys(values).join(', ') || 'its button'}`, () => {
    const sheet = top();
    return Boolean(sheet) && Object.keys(values).every((name) => Boolean(sheet!.querySelector(`[name="${name}"]`)));
  });
  const sheet = top()!;
  for (const [name, value] of Object.entries(values)) {
    (sheet.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement).value = value;
  }
  (sheet.querySelector('[data-submit]') as HTMLElement).click();
}

beforeAll(async () => {
  clock = new DemoClock();
  clock.setTo('11:40');
  notifier = new FakeNotifier();
  ctx = {
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

  // One venue's cook signs in to its kitchen, which is what a kitchen does
  // before opening; the guest tests order from that same venue.
  pairedVenue = seeded.kitchens[0]!.name;
  storage.setItem('basu.kitchen', await cookFor(pairedVenue));
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

/** The Pay button, ready for a tap: a price on it and no spinner. */
function payable(d: Document): boolean {
  const button = d.querySelector('.sheet footer button');
  return Boolean(button && !button.hasAttribute('data-busy') && button.textContent?.includes('төлөх'));
}

/** A tsuivan at the paired kitchen for `slot`, chosen as far as its Pay button. */
async function chooseLunch(dom: JSDOM, slot: string): Promise<void> {
  await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
  tapPin(dom, pairedVenue);
  await until(dom, 'the menu', (d) => d.querySelectorAll('.item').length > 3);
  const row = [...dom.window.document.querySelectorAll('.item')].find((r) => r.textContent?.includes('Цуйван'))!;
  (row.querySelector('button[data-d="1"]') as HTMLElement).click();
  await until(dom, 'the pay button', (d) => Boolean(d.querySelector('.sheet footer button')));
  clickText(dom, '.slot', slot);
  await until(dom, 'a price', payable);
}

/** Every lunch this number has ordered, paid for or not. */
async function lunchesOf(phone: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dine.dining_order o JOIN identity.guest g ON g.id = o.guest_id WHERE g.phone_e164 = $1`,
    [phone],
  );
  return rows[0]!.n;
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

  it('sends an order under a key made for it, and the same key when Pay is tapped again', async () => {
    await ownGuest('+97699003010');
    // The first Pay is refused, the way a dropped connection or an empty wallet refuses it.
    let refused = false;
    const dom = await openPage('dine.html', '', (path) => {
      if (refused || !/^\/v1\/orders\/[0-9a-f-]{36}\/pay$/.test(path)) return undefined;
      refused = true;
      return new Response(JSON.stringify({ error: { code: 'PAYMENT_FAILED', message_mn: 'Төлбөр амжилтгүй боллоо.' } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    });
    await chooseLunch(dom, '12:15');
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
    await until(dom, 'Pay again, after the refusal', (d) => refused && payable(d));
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));

    // One key, nobody's to guess — not the venue, slot and dishes spelled out…
    const caller = createHash('sha256').update(storage.getItem('basu.guest')!).digest('hex');
    const kept = await getPool().query<{ key: string }>(
      `SELECT key FROM idempotency_answer WHERE caller = $1 AND method = 'POST' AND url = '/v1/orders'`,
      [caller],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.key).toMatch(/^order-[0-9a-f]{32}$/);
    // …and the tap after the refusal was the same attempt: one lunch, not two.
    expect(await lunchesOf('+97699003010')).toBe(1);
  });

  it('never sells a lunch twice when the look at it fails after it is paid for', async () => {
    await ownGuest('+97699003011');
    // The payment goes through and the first look at the lunch is lost, the
    // way a patchy connection loses one. Every look after that waits until
    // the test lets it through, so no poll can draw the lunch meanwhile.
    let lost = false;
    let letThrough!: () => void;
    const later = new Promise<void>((resolve) => (letThrough = resolve));
    const dom = await openPage('dine.html', '', (path, init) => {
      if (!/^\/v1\/orders\/[0-9a-f-]{36}$/.test(path)) return undefined;
      if (lost) return later.then(() => fetch(new URL(path, base).toString(), init));
      lost = true;
      return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message_mn: 'Сүлжээ тасарлаа.' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    await chooseLunch(dom, '12:00');
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
    await until(dom, 'the lost look', (d) => d.getElementById('toast')?.textContent === 'Сүлжээ тасарлаа.');

    // Bought: the sheet waits for the lunch and does not offer to sell it again…
    expect(payable(dom.window.document)).toBe(false);
    expect(dom.window.document.querySelector('.sheet')?.hasAttribute('data-busy')).toBe(true);
    // …and a tap that lands anyway is the same attempt, handed the lunch it bought.
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
    letThrough();
    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(await lunchesOf('+97699003011')).toBe(1);
  });

  it('takes a Pay whose answer was lost for the payment it made, and shows the lunch', async () => {
    await ownGuest('+97699003012');
    // The payment goes through; its answer never reaches the phone.
    let lost = false;
    const dom = await openPage('dine.html', '', (path, init) => {
      if (lost || !/^\/v1\/orders\/[0-9a-f-]{36}\/pay$/.test(path)) return undefined;
      lost = true;
      return fetch(new URL(path, base).toString(), init).then(() => Promise.reject(new TypeError('Failed to fetch')));
    });
    await chooseLunch(dom, '12:45');
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
    await until(dom, 'Pay again, after the lost answer', (d) => lost && payable(d));
    (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();

    // Not «already paid» in front of a Pay button: the payment it made, and the lunch.
    await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
    expect(await lunchesOf('+97699003012')).toBe(1);
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
    // Every kitchen has gone quiet — the guard is working, but a map of grey
    // pins with no explanation is a dead end for whoever is looking.
    const seen = await getPool().query<{ id: string; kitchen_seen_at: Date | null }>('SELECT id, kitchen_seen_at FROM dine.restaurant');
    await getPool().query(`UPDATE dine.restaurant SET kitchen_seen_at = now() - interval '1 day'`);
    try {
      await inProduction(async () => {
        const dom = await openPage('dine.html');
        await until(dom, 'the explanation', (d) => Boolean(d.querySelector('#map .note')));
        expect(text(dom)).toContain('нэг ч гал тогоо нээлттэй биш');
        expect(dom.window.document.querySelector('.note a')?.getAttribute('href')).toBe('/kds');
        // The pins are still drawn — the map is not the thing that failed.
        expect(pins(dom).length).toBe(seeded.venues);
        expect(pins(dom).every((f) => !f.properties['open'])).toBe(true);
      });
    } finally {
      for (const r of seen.rows) {
        await getPool().query('UPDATE dine.restaurant SET kitchen_seen_at = $2 WHERE id = $1', [r.id, r.kitchen_seen_at]);
      }
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

  it('lets a walkthrough sign in as a restaurant’s cook', async () => {
    storage.removeItem('basu.kitchen');
    const kds = await openPage('kds.html');
    await until(kds, 'the door', (d) => d.querySelectorAll('.venues button').length > 0);

    clickText(kds, '.venues button', pairedVenue);
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(kds.window.document.querySelector('#venue')?.textContent).toBe(pairedVenue);
  });

  it('asks a screen nobody has signed in to for a person, not a code', async () => {
    const before = storage.getItem('basu.kitchen');
    storage.removeItem('basu.kitchen');
    try {
      const kds = await openPage('kds.html');
      await until(kds, 'the door', (d) => Boolean(d.querySelector('.door .ways')));
      expect(text(kds)).toContain('Өөрийн бүртгэлээр нэвтэрнэ үү');
      expect(kds.window.document.querySelector('input.code[maxlength="8"]')).toBeNull();
    } finally {
      if (before) storage.setItem('basu.kitchen', before);
    }
  });

  it('names the kitchen it is watching, and signs out in two taps', async () => {
    storage.setItem('basu.kitchen', await cookFor(pairedVenue));
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);

    // An unnamed empty board looks the same whether nothing has been ordered
    // or the screen is signed in at somebody else's kitchen.
    expect(kds.window.document.querySelector('#venue')?.textContent).toBe(pairedVenue);

    // One stray tap asks; the second leaves.
    const out = kds.window.document.querySelector('#out') as HTMLElement;
    out.click();
    expect(out.textContent).toBe('Гарах уу?');
    out.click();
    await until(kds, 'the door', (d) => Boolean(d.querySelector('.door .ways')));

    // Put the storage back the way the other tests expect to find it.
    storage.setItem('basu.kitchen', await cookFor(pairedVenue));
  });

  it('sends a signed-out cook back to the door', async () => {
    const kds = await openPage('kds.html');
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);

    // Signed out everywhere — the screen must stop showing tickets at once.
    const phone = seeded.kitchens.find((k) => k.name === pairedVenue)!.phone;
    await getPool().query(
      `UPDATE identity.guest_session SET revoked_at = now()
        WHERE guest_id IN (SELECT id FROM identity.guest WHERE phone_e164 = $1)`,
      [phone],
    );

    await until(kds, 'the door', (d) => Boolean(d.querySelector('.door .ways')), 12_000);
    storage.setItem('basu.kitchen', await cookFor(pairedVenue));
  });
});

describe('the front page', () => {
  it('works out a winter of meat, in sheep and goats and kilograms', async () => {
    const dom = await openPage('index.html');
    const d = dom.window.document;
    const text = (id: string) => d.getElementById(id)?.textContent;
    const press = (selector: string, times = 1) => {
      for (let i = 0; i < times; i++) (d.querySelector(selector) as HTMLButtonElement).click();
    };
    await until(dom, 'the sums', () => text('kg') !== null);

    // Four people, four months, eating as most do: 4 × 4 × 7.
    expect(text('kg')).toBe('112 кг');
    expect(text('said')).toBe('6 хонь, эсвэл 7 ямаа орчим');
    expect(d.querySelectorAll('#flock svg')).toHaveLength(6);

    press('[data-step="people"][data-by="1"]');
    expect(text('people')).toBe('5 хүн');
    expect(text('kg')).toBe('140 кг');
    press('[data-appetite="high"]');
    expect(d.querySelector('[data-appetite="high"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(d.querySelector('[data-appetite="mid"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(text('kg')).toBe('200 кг');
    expect(text('said')).toBe('10 хонь, эсвэл 13 ямаа орчим');

    // Six months at most, one person at least: the buttons stop where the sums do.
    press('[data-step="months"][data-by="1"]', 5);
    expect(text('months')).toBe('6 сар');
    expect((d.querySelector('[data-step="months"][data-by="1"]') as HTMLButtonElement).disabled).toBe(true);
    press('[data-step="people"][data-by="-1"]', 9);
    expect(text('people')).toBe('1 хүн');
    expect((d.querySelector('[data-step="people"][data-by="-1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text('kg')).toBe('60 кг');
  });

  it('shows the stalls to anybody, signed in or not', async () => {
    storage.removeItem('basu.guest');
    const dom = await openPage('index.html');
    const d = dom.window.document;
    await until(dom, 'the stall board', () => !(d.getElementById('board') as HTMLElement).hidden);
    expect(d.querySelectorAll('.stall').length).toBeGreaterThan(0);
    // The count on each animal a stall sells.
    expect([...d.querySelectorAll('.animal .ktag')].some((t) => /^\d+ зар$/.test(t.textContent ?? ''))).toBe(true);
  });

  it('shows what is on sale from the stalls, and nothing it made up', async () => {
    await ownGuest('+97699004012');
    const dom = await openPage('index.html');
    const d = dom.window.document;
    await until(dom, 'the stall board', () => !d.getElementById('board')?.hidden);

    const stalls = [...d.querySelectorAll('.stall')];
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls.length).toBeLessThanOrEqual(6);
    for (const stall of stalls) {
      expect(stall.getAttribute('href')).toMatch(/^\/shop\/[0-9a-f-]{36}$/);
      expect(stall.querySelector('.money')?.textContent).toMatch(/₮ \/ (толгой|кг)$/);
    }
    expect((d.getElementById('board-empty') as HTMLElement).hidden).toBe(true);
  });

  it('says so plainly when the market is empty', async () => {
    await ownGuest('+97699004013');
    const empty = new Response(JSON.stringify({ today: '2026-09-25', listings: [] }), {
      headers: { 'content-type': 'application/json' },
    });
    const dom = await openPage('index.html', '', (path) => (path.startsWith('/v1/idesh/listings') ? empty : undefined));
    const d = dom.window.document;
    await until(dom, 'the stall board', () => !d.getElementById('board')?.hidden);

    expect(d.querySelectorAll('.stall')).toHaveLength(0);
    expect((d.getElementById('board-empty') as HTMLElement).hidden).toBe(false);
    expect(d.getElementById('board-empty')?.textContent).toContain('Анхны зарууд удахгүй');
  });
});

describe('the website', () => {
  it('signs in by password on its own door, and keeps the session', async () => {
    const phone = '+97699005001';
    await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: GUEST_PASSWORD }),
    });
    storage.removeItem('basu.guest');
    const dom = await openPage('login.html', '?next=/orders');
    const d = dom.window.document;
    await until(dom, 'the door', () => d.documentElement.hasAttribute('data-ready'));
    (d.querySelector('[data-go="password"]') as HTMLButtonElement).click();
    expect((d.querySelector('.l-step[data-step="password"]') as HTMLElement).hidden).toBe(false);

    const form = d.getElementById('pw-form') as HTMLFormElement;
    (form.elements.namedItem('login') as HTMLInputElement).value = phone;
    (form.elements.namedItem('password') as HTMLInputElement).value = 'буруу нууц үг';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(dom, 'the refusal', () => (d.getElementById('pw-error')?.textContent ?? '').length > 0);
    expect(storage.getItem('basu.guest')).toBeNull();

    (form.elements.namedItem('password') as HTMLInputElement).value = GUEST_PASSWORD;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(dom, 'a session', () => Boolean(storage.getItem('basu.guest')));
  });

  it('has a home with the apps’ own tiles, and what of the guest’s is going on', async () => {
    storage.removeItem('basu.guest');
    const stranger = await openPage('home.html');
    const d = stranger.window.document;
    await until(stranger, 'the tiles', () => d.querySelectorAll('.h-app').length >= 2);
    // The same art as the phone's launcher, going where a browser can use it.
    expect(d.querySelector('[data-app="idesh"] img')?.getAttribute('src')).toBe('/brand/idesh-tile.webp');
    expect(d.querySelector('[data-app="idesh"]')?.getAttribute('href')).toBe('/shop');
    expect(d.querySelector('[data-app="dine"] img')?.getAttribute('src')).toBe('/brand/food-tile.webp');
    expect((d.getElementById('live') as HTMLElement).hidden).toBe(true);

    await ownGuest('+97699005003');
    const token = storage.getItem('basu.guest')!;
    const listing = (await (await fetch(`${base}/v1/idesh/listings`, { headers: { authorization: `Bearer ${token}` } })).json()).listings
      .find((l: { unit: string; remaining: number }) => l.unit === 'whole' && l.remaining > 0);
    const made = await (await fetch(`${base}/v1/idesh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'home-1' },
      body: JSON.stringify({ listing_id: listing.id, qty: 1, receive: 'pickup', receive_on: listing.ready_from }),
    })).json();
    await fetch(`${base}/v1/idesh/${made.id}/pay`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

    const home = await openPage('home.html');
    await until(home, 'the order on home', () => Boolean(home.window.document.querySelector(`[data-order="${made.id}"]`)));
    expect(home.window.document.querySelector(`[data-order="${made.id}"]`)?.getAttribute('href')).toBe(`/orders/${made.id}`);
  });

  it('shows the market to anybody, and asks who you are only to pay', async () => {
    storage.removeItem('basu.guest');
    const market = await openPage('shop.html');
    const d = market.window.document;
    await until(market, 'the cards', () => d.querySelectorAll('.sh-card').length >= seeded.listings);
    await until(market, 'the way in', () => Boolean(d.querySelector('#s-account a[href^="/login"]')));

    const id = [...d.querySelectorAll('.sh-card')].find((c) => !c.hasAttribute('data-gone'))!.getAttribute('data-id')!;
    const stall = await openPage('shop.html', `/${id}`);
    const s = stall.window.document;
    await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
    (s.getElementById('next') as HTMLButtonElement).click();
    await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
    expect(s.getElementById('pay')?.textContent).toBe('Нэвтэрч төлөх →');
  });

  it('shows the market as cards, filters it, and orders from a stall', async () => {
    await ownGuest('+97699005002');
    const token = storage.getItem('basu.guest')!;
    const shop = await openPage('shop.html');
    const d = shop.window.document;
    await until(shop, 'the cards', () => d.querySelectorAll('.sh-card').length >= seeded.listings);
    // The account is in the corner, by name or number.
    await until(shop, 'the account', () => Boolean(d.querySelector('.s-acct')));
    expect(d.querySelector('.s-acct')?.textContent).toContain('+97699005002');

    (d.querySelector('#kinds [data-kind="beef"]') as HTMLButtonElement).click();
    const beef = [...d.querySelectorAll('.sh-card')];
    expect(beef.length).toBeGreaterThan(0);
    expect(beef.every((c) => c.getAttribute('data-kind') === 'beef')).toBe(true);

    const whole = (await (await fetch(`${base}/v1/idesh/listings`, { headers: { authorization: `Bearer ${token}` } })).json()).listings
      .find((l: { unit: string; remaining: number }) => l.unit === 'whole' && l.remaining > 0);
    const stall = await openPage('shop.html', `/${whole.id}`);
    const s = stall.window.document;
    await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
    expect(s.querySelector('.sd-title h1')?.textContent).toBe(whole.title);
    // A delivery needs an address before it goes further.
    (s.querySelector('.sd-way[data-r="delivery"]') as HTMLButtonElement | null)?.click();
    if (whole.delivers) {
      (s.getElementById('next') as HTMLButtonElement).click();
      expect(s.getElementById('form-error')?.textContent).toContain('хаяг');
      (s.querySelector('.sd-way[data-r="pickup"]') as HTMLButtonElement).click();
    }
    (s.getElementById('next') as HTMLButtonElement).click();
    await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
    (s.getElementById('pay') as HTMLButtonElement).click();

    let orders: Array<{ id: string; code: string; title: string; state: string }> = [];
    for (let i = 0; i < 80 && !orders.length; i++) {
      orders = (await (await fetch(`${base}/v1/idesh?scope=all`, { headers: { authorization: `Bearer ${token}` } })).json()).orders;
      if (!orders.length) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(orders[0]).toMatchObject({ title: whole.title, state: 'PAID' });

    // …and it is on «Миний захиалга», and on its own page with the code.
    const list = await openPage('orders.html');
    await until(list, 'the order row', () => Boolean(list.window.document.querySelector(`[data-order="${orders[0]!.id}"]`)));
    expect(list.window.document.querySelector(`[data-order="${orders[0]!.id}"]`)?.textContent).toContain(`№${orders[0]!.code}`);
    const one = await openPage('orders.html', `/${orders[0]!.id}`);
    await until(one, 'the handover code', () => one.window.document.querySelector('.od-code b')?.textContent === orders[0]!.code);
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

  it('shows a stranger the stalls — App Review asks for no account before products', async () => {
    storage.removeItem('basu.guest');
    const dom = await openPage('idesh.html');
    const d = dom.window.document;
    await until(dom, 'the stalls', () => d.querySelectorAll('.listing').length >= seeded.listings);
    // No door where the stalls are, and nobody signed in on the way through.
    expect(d.getElementById('gate')).toBeNull();
    expect(storage.getItem('basu.guest')).toBeNull();
  });

  it('says who is signed in, and signs out for real', async () => {
    await ownGuest('+97699004014');
    const token = storage.getItem('basu.guest')!;
    const dom = await openPage('idesh.html');
    const d = dom.window.document;
    await until(dom, 'the account line', () => !(d.getElementById('me') as HTMLElement).hidden);
    expect(d.getElementById('me-name')?.textContent).toBe('+97699004014');
    expect(d.querySelectorAll('.listing').length).toBeGreaterThan(0);

    (d.getElementById('sign-out') as HTMLButtonElement).click();
    await until(dom, 'signed out', () => (d.getElementById('me') as HTMLElement).hidden === true);
    expect(storage.getItem('basu.guest')).toBeNull();
    // Signed out, the stalls stay open to look at.
    expect(d.querySelectorAll('.listing').length).toBeGreaterThan(0);
    // The session is over on the server too, not only forgotten here.
    let status = 0;
    for (let i = 0; i < 40 && status !== 401; i++) {
      status = (await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status;
      if (status !== 401) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(status).toBe(401);
  });

  it('lists every stall, names the supplier, and says it is under contract', async () => {
    await ownGuest('+97699004010');
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
    expect(dom.window.document.querySelectorAll('.trust li')).toHaveLength(3);
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
    const screen = await supplierScreenFor(code!);
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
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'pay');
    // Everything, not only what is left to do: the row stays in view once paid.
    await until(desk, 'the list', (d) => Boolean(d.querySelector('#pay .dt-seg')));
    clickText(desk, '#pay .dt-seg button', 'Бүгд');
    const line = () =>
      [...desk.window.document.querySelectorAll('#pay tr[data-settlement]')].find((r) => r.textContent?.includes(`№${code}`));
    await until(desk, 'the refund to pay', () => Boolean(line()));
    expect(line()!.textContent).toContain('буцаалт');
    expect(line()!.textContent).toContain('5012345678');
    expect(line()!.querySelector('[data-label="Дүн"]')?.textContent).toBe(total);
    // Two people, not one: the row offers only «Батлах» until somebody has
    // released it, and only then the button that says the money moved.
    expect(line()!.querySelector('[data-a="paid"]')).toBeNull();
    (line()!.querySelector('[data-a="approve"]') as HTMLElement).click();
    await answerPopup(desk);
    await until(desk, 'the line to be released', () => Boolean(line()?.querySelector('[data-a="paid"]')));
    expect(line()!.textContent).toContain('баталсан');
    (line()!.querySelector('[data-a="paid"]') as HTMLElement).click();
    await answerPopup(desk, { reason: 'KB-2026-001' });
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

    // The supplier's owner, signed in as themselves — no code, no tablet of Basu's.
    const screen = await supplierScreenFor(code!);
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

    // The button has to be the one on *our* ticket — the first «Бэлтгэж
    // эхлэх» on the page may belong to an order another test just paid for.
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
    const screen = await ownerScreen(seeded.suppliers[0]!.phone);
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
    await ownGuest('+97699004011');
    const guest = await openPage('idesh.html');
    await until(guest, 'the new stall', (d) =>
      [...d.querySelectorAll('.listing .name')].some((n) => n.textContent === 'Хонь, шинэ зар'),
    );
  });
});

describe('a listing put first', () => {
  it('is bought from the stall in a popup, paid, and shown first with its mark everywhere', async () => {
    const screen = await ownerScreen(seeded.suppliers[1]!.phone);
    const d = screen.window.document;
    await until(screen, 'the module', (doc) => Boolean(doc.querySelector('.tabs button[data-tab="stall"]')));
    (d.querySelector('.tabs button[data-tab="stall"]') as HTMLElement).click();
    await until(screen, 'the stall', (doc) => Boolean(doc.querySelector('.stall .row[data-listing] [data-a="promote"]')));
    const row = [...d.querySelectorAll('.stall .row[data-listing]')].find((r) => r.querySelector('[data-a="promote"]')) as HTMLElement;
    const id = row.getAttribute('data-listing')!;
    const title = row.querySelector('.name')!.textContent!.trim();
    (row.querySelector('[data-a="promote"]') as HTMLButtonElement).click();

    // The two tiers at the desk's price; VIP is the one picked to start with.
    await until(screen, 'the tiers', (doc) => doc.querySelectorAll('.promo-opt').length === 2);
    expect([...d.querySelectorAll('.promo-opt .price')].map((p) => p.textContent)).toEqual(['20,000₮', '50,000₮']);
    expect((d.querySelector('.promo-opt[data-tier="vip"] input') as HTMLInputElement).checked).toBe(true);
    (d.querySelector('.popup [data-submit]') as HTMLButtonElement).click();

    // The invoice, then «Төлсөн»: the demo's payments say yes at once.
    await until(screen, 'the invoice', (doc) => doc.querySelector('.popup h2')?.textContent === 'QPay-ээр төлөх');
    expect(d.querySelector('.promo-pay .amount')?.textContent).toBe('50,000₮');
    (d.querySelector('.popup [data-submit]') as HTMLButtonElement).click();
    await until(screen, 'the mark on the row', (doc) =>
      Boolean(doc.querySelector(`.stall .row[data-listing="${id}"] .tier`)?.textContent?.startsWith('VIP')),
    );

    // Guests see it first, with its mark, in the app's list.
    await ownGuest('+97699004015');
    const guest = await openPage('idesh.html');
    await until(guest, 'the stalls', (doc) => doc.querySelectorAll('.listing').length > 0);
    const first = guest.window.document.querySelector('.listing') as HTMLElement;
    expect(first.getAttribute('data-id')).toBe(id);
    expect(first.getAttribute('data-tier')).toBe('vip');
    expect(first.querySelector('.name')?.textContent).toContain(title.split(' ')[0]!);
  });
});

describe('нийлүүлэгч болох', () => {
  it('takes an application on the supplier page, approves it on the ops page, and the applicant runs it', async () => {
    // A person of this test's own, signed in the demo way with their number.
    await ownGuest('+97688010011');
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
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'suppliers');
    await until(desk, 'the applications', (d) =>
      [...d.querySelectorAll('#applied tr[data-supplier]')].some((r) => r.textContent?.includes('Түмэн-Өлзий')),
    );
    const row = [...desk.window.document.querySelectorAll('#applied tr[data-supplier]')].find((r) =>
      r.textContent?.includes('Түмэн-Өлзий'),
    )!;
    // The proved phone travels with the application, so ops can ring.
    expect(row.textContent).toContain('+97688010011');
    (row.querySelector('[data-a="approve"]') as HTMLElement).click();
    await answerPopup(desk);
    await until(desk, 'the row to move', (d) =>
      [...d.querySelectorAll('#all tr[data-state="contracted"]')].some((r) =>
        r.textContent?.includes('Түмэн-Өлзий'),
      ),
    );

    /* back on the applicant's page, the yes has arrived */
    const again = await openPage('supplier.html');
    // Approved, the same phone now opens the supplier's own module — no
    // code to type: the phone is the proof.
    await until(again, 'the module', (d) => Boolean(d.querySelector('#board[data-ready]')));
    await until(again, 'the name', (d) => d.querySelector('#supplier')?.textContent === 'Хөвсгөл · Түмэн-Өлзий');
    expect(again.window.document.querySelectorAll('.tabs button[data-tab]')).toHaveLength(5);
  });

  it('shows the seeded application waiting on the ops page', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'suppliers');
    await until(desk, 'the applications', (d) => d.querySelectorAll('#applied tr[data-supplier]').length > 0);
    expect(desk.window.document.querySelector('#applied tr[data-supplier]')?.textContent).toContain('Завхан');
  });

  it('opens on the whole house: what needs somebody, what is held, what the day brought', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await until(desk, 'the front page', (d) => d.querySelectorAll('#now .kpi').length === 6);
    const doc = desk.window.document;
    expect(doc.querySelector('.tabs button[data-tab="overview"]')?.hasAttribute('data-on')).toBe(true);
    expect(doc.querySelector('.tabs .mod .t')?.textContent).toBe('Платформ');
    // The seeded application is waiting, and the page says so before anything else.
    expect([...doc.querySelectorAll('#alerts .alert')].map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('нийлүүлэгчийн өргөдөл')]),
    );
    expect(doc.querySelector('#now')?.textContent).toContain('Зочдын түрийвч');
    expect(doc.querySelector('#cross')?.textContent).toContain('Борлуулалт');
    // The alert's button goes to the section that answers it.
    (doc.querySelector('#alerts button[data-go="suppliers"]') as HTMLElement).click();
    await until(desk, 'the applications', (d) => d.querySelectorAll('#applied tr[data-supplier]').length > 0);
  });

  it('finds a guest by phone and opens their file: wallet, lunches, meat, messages', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
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

  it('shows every kitchen and whether it is open, then the day’s lunches and one lunch’s story', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'venues');
    await until(desk, 'the kitchens', (d) => d.querySelectorAll('#venues [data-venue]').length > 0);
    const doc = desk.window.document;
    const venue = doc.querySelector('#venues [data-venue]')!;
    expect(doc.querySelector('#venues thead')?.textContent).toContain('Өнөөдөр');
    // No codes to hand out: the people who work there sign in as themselves.
    expect(doc.querySelector('#venues button[data-a="tablet"]')).toBeNull();
    expect(text(desk)).toContain('өөрсдийн бүртгэлээр');
    // A row opens the kitchen's menu, with the switch for each dish.
    (venue as HTMLElement).click();
    await until(desk, 'the menu', (d) => d.querySelectorAll('#menu tbody tr[data-item]').length > 0);
    expect(doc.querySelector('#menu button[data-item]')?.textContent).toBe('Нуух');

    await opsTab(desk, 'lunches');
    await until(desk, 'the lunches', (d) => d.querySelectorAll('#lunches tr[data-lunch]').length > 0);
    (doc.querySelector('#lunches tr[data-lunch]') as HTMLElement).click();
    await until(desk, 'one lunch', (d) => Boolean(d.querySelector('.detail .story')));
    expect(doc.querySelector('.page-head h1')?.textContent).toContain('№');
    expect([...doc.querySelectorAll('.section > h2')].map((h) => h.textContent)).toEqual(expect.arrayContaining(['Хоол', 'Явц']));
  });

  it('opens the books: the checks, every account, then the movements with a CSV to take away', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
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
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) =>
      Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value),
    );
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'notify');
    await until(desk, 'the log', (d) => d.querySelectorAll('#messages tr[data-message]').length > 0);
    const doc = desk.window.document;
    expect(doc.querySelector('#messages tr[data-message]')?.textContent).toMatch(/SMS|Push/);

    await opsTab(desk, 'system');
    await until(desk, 'the machine', (d) => d.querySelectorAll('#integrations [data-integration]').length === 4);
    expect(doc.querySelector('#integrations .kpi')?.textContent).toContain('Scheduler');
    // Read on the page; changed in a popup.
    expect(doc.querySelector('#settings [data-key="desk_banner"]')).not.toBeNull();
    expect(doc.querySelector('#settings input')).toBeNull();
    (doc.querySelector('#edit-settings') as HTMLElement).click();
    await answerPopup(desk, { desk_banner: 'Маргааш ажиллахгүй' });
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
    const dash = await openPage('ops.html', '', undefined, device(staff));
    await until(dash, 'the business', (d) => Boolean(d.querySelector('.tabs [data-tab="idesh.today"]')));
    // Its front page draws: a door to each part the role opens.
    await until(dash, 'the front page', (d) => d.querySelectorAll('.org-doors .org-door').length === 2);
    const doc = dash.window.document;
    expect(doc.querySelector('.ws-btn')?.textContent).toContain('Хэрлэн мах · тест');
    expect(doc.querySelector('.ws-btn')?.textContent).toContain('Нийлүүлэгч · Ажилтан');
    expect(tabs(dash)).toEqual(['home', 'idesh.today', 'idesh.orders', 'idesh.stall', 'idesh.profile', 'team', 'profile', 'roles']);
    expect(doc.querySelector('.nav-mod[data-group="dine"]')).toBeNull();
    // The module is a row of its own, its pages beneath it.
    expect(doc.querySelector('.nav-mod[data-group="idesh"] .mod .t')?.textContent).toBe('Идэш');
    expect(doc.querySelectorAll('.nav-mod[data-group="idesh"] .mod-items [data-tab]')).toHaveLength(4);
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
    const dash = await openPage('ops.html', `#${orgId}/team`, undefined, device(owner));
    await until(dash, 'the team', (d) => d.querySelectorAll('tr[data-member]').length === 1);
    const doc = dash.window.document;
    // A restaurant: a menu, and no stall.
    expect(tabs(dash)).toEqual(expect.arrayContaining(['dine.orders', 'dine.menu', 'dine.kitchen', 'team', 'log']));
    expect(tabs(dash).some((t) => t?.startsWith('idesh.'))).toBe(false);
    // Two steps of one popup: the person by what they sign in with, then the role.
    (doc.querySelector('#team-add') as HTMLElement).click();
    await answerPopup(dash, { contact: '88030013' });
    await answerPopup(dash, { role: 'accountant' });
    await until(dash, 'the new member', (d) => d.querySelectorAll('tr[data-member]').length === 2);
    expect(doc.querySelector('[data-members]')?.textContent).toContain('Туяа');

    (doc.querySelector('.tabs [data-tab="log"]') as HTMLElement).click();
    await until(dash, 'the record', (d) => d.querySelectorAll('#org-log tr[data-entry]').length >= 3);
    expect(doc.querySelector('#org-log tr[data-entry]')?.textContent).toContain('Туяа нэмэгдсэн · Нягтлан');
  });

  it('gives an accountant the orders and the money on the supplier’s screen, and no counter or stall', async () => {
    const owner = await account('+97688030021', 'Болд');
    const accountant = await account('+97688030024', 'Номин');
    const orgId = await business(owner, 'Туул мах · тест', { supplier: true }, [['+97688030024', 'accountant']]);
    const screen = await openPage('supplier.html', `?org=${orgId}`, undefined, device(accountant));
    await until(screen, 'the module', (d) => d.querySelectorAll('.tabbar button[data-tab]').length > 0);
    expect([...screen.window.document.querySelectorAll('.tabbar button[data-tab]')].map((b) => (b as HTMLElement).dataset['tab'])).toEqual(['orders', 'money', 'profile']);
    expect(screen.window.document.querySelector('#supplier')?.textContent).toBe('Туул мах · тест');
  });

  it('keeps the desk’s own pages to the roles that hold them', async () => {
    const desk = await deskToken();
    // A seat is given, with a role, by an admin who chose the account from Basu's users.
    const finance = await account('+97688030031', 'Санхүү');
    const { account: chosen } = (await (await fetch(`${base}/v1/ops/whoami`, { headers: as(finance) })).json()) as { account: { id: string } };
    await fetch(`${base}/v1/ops/members`, { method: 'POST', headers: as(desk), body: JSON.stringify({ guest_id: chosen.id, role: 'finance' }) });
    const dash = await openPage('ops.html', '', undefined, device(finance));
    await until(dash, 'the desk', (d) => Boolean(d.querySelector('.tabs [data-tab="money"]')));
    const seen = tabs(dash);
    expect(seen).toEqual(expect.arrayContaining(['overview', 'money', 'pay', 'audit']));
    for (const hidden of ['venues', 'lunches', 'notify', 'system', 'members']) expect(seen).not.toContain(hidden);
  });

  it('shows a person nothing to ask of Basu’s desk: their corner has their businesses, and the way home', async () => {
    const dash = await openPage('ops.html', '', undefined, device(await account('+97688030041', 'Энгийн хүн')));
    await until(dash, 'the corner', (d) => Boolean(d.querySelector('#org-list')));
    const doc = dash.window.document;
    expect(doc.querySelector('#view')?.textContent).not.toMatch(/ops эрх|Ops эрх|ops-ийн хэсэг/);
    expect(doc.querySelector('#ask-open')).toBeNull();
    expect([...doc.querySelectorAll('.ws-act')].map((b) => (b as HTMLElement).dataset['act'])).toEqual(['new-org']);
    // Out of the dashboard, to Basu's front page, in one press.
    expect(doc.querySelector('#go-home')?.getAttribute('href')).toBe('/');
    expect(doc.querySelector('.brand-home')?.getAttribute('href')).toBe('/');
  });

  it('seats somebody an admin chose from Basu’s users, and the desk opens for them', async () => {
    const chosen = await account('+97688030051', 'Сонгосон ажилтан');
    const desk = await openPage('ops.html', '', undefined, device(await deskToken()));
    await opsTab(desk, 'members');
    const doc = desk.window.document;
    await until(desk, 'the members page', (d) => Boolean(d.querySelector('#add-member')));
    (doc.querySelector('#add-member') as HTMLElement).click();
    await until(desk, 'Basu’s users to choose from', (d) => d.querySelectorAll('#member-new .popup-pick-row').length > 0);
    const search = doc.querySelector('#member-new .popup-pick input[type="search"]') as HTMLInputElement;
    search.value = 'Сонгосон';
    search.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
    await until(desk, 'the one looked for', (d) => {
      const rows = [...d.querySelectorAll('#member-new .popup-pick-row')];
      return rows.length === 1 && Boolean(rows[0]!.textContent?.includes('Сонгосон ажилтан'));
    });
    (doc.querySelector('#member-new .popup-pick-row input') as HTMLInputElement).click();
    (doc.querySelector('#member-new [name="role"]') as HTMLSelectElement).value = 'viewer';
    (doc.querySelector('#member-new [data-submit]') as HTMLElement).click();
    await until(desk, 'the new member in the table', (d) => [...d.querySelectorAll('#members tr[data-member]')].some((r) => r.textContent?.includes('Сонгосон ажилтан')));

    // The person opens the dashboard and the desk is there, in the role given.
    const theirs = await openPage('ops.html', '', undefined, device(chosen));
    await until(theirs, 'the desk', (d) => Boolean(d.querySelector('.tabs [data-tab="overview"]')));
    expect(theirs.window.document.querySelector('.ws-btn')?.textContent).toContain('Зөвхөн харах');

    // Switched off, the desk closes to them and nothing else does: the popup says just that, and it is so.
    const row = () => [...doc.querySelectorAll('#members tr[data-member]')].find((r) => r.textContent?.includes('Сонгосон ажилтан'))!;
    (row().querySelector('[data-a="active"]') as HTMLElement).click();
    await until(desk, 'the question', (d) => Boolean(d.querySelector('.sheet.popup[data-open]')));
    const asked = [...doc.querySelectorAll('.sheet.popup[data-open]')].pop()!;
    expect(asked.textContent).toContain('нэвтэрсэн хэвээр үлдэнэ');
    expect(asked.textContent).toContain('нээлттэй байгаа ops хэсэг нь ч дараагийн алхамд хаагдана');
    // The dashboard itself stays open for them: it drops to their own corner.
    expect(asked.textContent).not.toMatch(/нэвтрэлт нь хаагдана|dashboard нь ч/);
    (asked.querySelector('[data-submit]') as HTMLElement).click();
    await until(desk, 'the seat off', () => Boolean(row()?.hasAttribute('data-off')));
    const auth = { authorization: `Bearer ${chosen}` };
    expect((await fetch(`${base}/v1/ops/me`, { headers: auth })).status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: auth })).status).toBe(200);
  });
});

describe('one browser, one person', () => {
  /*
   * The dashboard kept its sign-in under a key of its own, and nothing on
   * the website replaced or cleared it: a browser where the admin had opened
   * the desk opened it again for whoever signed in there next, with any
   * account at all. These are that browser.
   *
   * And every page took a session from its address, which is how Google's
   * sign-in came back: whoever opened a link carrying somebody's session
   * became them. A page takes a code there now, and only the browser that
   * went to Google can trade it.
   */
  async function account(phone: string, name: string): Promise<string> {
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: GUEST_PASSWORD, name }),
    });
    return ((await made.json()) as { token: string }).token;
  }
  /** Somebody an admin gave a seat at the desk, signed in. */
  async function seated(phone: string, name: string): Promise<string> {
    const token = await account(phone, name);
    const as = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
    const desk = ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;
    const { account: who } = (await (await fetch(`${base}/v1/ops/whoami`, { headers: as(token) })).json()) as { account: { id: string } };
    await fetch(`${base}/v1/ops/members`, { method: 'POST', headers: as(desk), body: JSON.stringify({ guest_id: who.id, role: 'admin' }) });
    return token;
  }
  /** Whether the server has ended this session. A page's sign-out does not wait for the answer, so give it a moment. */
  async function ended(token: string): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status === 401) return true;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return false;
  }
  /** Whose session this is. */
  const guestOf = async (token: string) =>
    ((await (await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string }).id;
  const noDesk = (dom: JSDOM) => dom.window.document.querySelector('.ws-opt[data-ws="desk"]') === null;
  const nameOn = (dom: JSDOM) => dom.window.document.querySelector('.ws-btn')?.textContent ?? '';

  it('drops the desk session an older page kept, ends it, and shows whoever is signed in now their own corner', async () => {
    const admin = await seated('+97688050001', 'Админ Нэг');
    const next = await account('+97688050002', 'Дараагийн хүн');
    // What the old dashboard left: the admin's desk under its own key, and the next person signed in on the website.
    const browser = device(next);
    browser.setItem('basu.ops', admin);
    const dash = await openPage('ops.html', '', undefined, browser);
    await until(dash, 'the corner', (d) => Boolean(d.querySelector('#org-list')));
    expect(nameOn(dash)).toContain('Дараагийн хүн');
    expect(noDesk(dash)).toBe(true);
    expect(browser.getItem('basu.ops')).toBeNull();
    expect(browser.getItem('basu.guest')).toBe(next);
    expect(await ended(admin)).toBe(true);
  });

  it('takes a sign-in that comes back from Google as the person, whoever was signed in before', async () => {
    const admin = await seated('+97688050011', 'Админ Хоёр');
    const next = await account('+97688050012', 'Google-ийн хүн');
    const browser = device(admin);
    const dash = await openPage('ops.html', await backFromGoogle(await guestOf(next), browser), undefined, browser);
    await until(dash, 'the corner', (d) => Boolean(d.querySelector('#org-list')));
    expect(nameOn(dash)).toContain('Google-ийн хүн');
    expect(noDesk(dash)).toBe(true);
    // The session the code became — nobody's from before — and nothing of it left in the address.
    const now = browser.getItem('basu.guest')!;
    expect([admin, next]).not.toContain(now);
    expect(await guestOf(now)).toBe(await guestOf(next));
    expect(dash.window.location.hash).not.toContain('auth');
    expect(cookiesOf(browser).has('basu_handoff')).toBe(false);
    expect(await ended(admin)).toBe(true);
  });

  it('signs in on the website’s own door with the code Google sent back to it', async () => {
    const before = await account('+97688050061', 'Өмнөх хүн');
    const person = await account('+97688050062', 'Google-ээр орсон хүн');
    const browser = device(before);
    const login = await openPage('login.html', await backFromGoogle(await guestOf(person), browser), undefined, browser);
    await until(login, 'the session the code became', () => ![null, before].includes(browser.getItem('basu.guest')));
    expect(await guestOf(browser.getItem('basu.guest')!)).toBe(await guestOf(person));
    expect(login.window.location.hash).not.toContain('auth');
    expect(await ended(before)).toBe(true);
  });

  it('takes no session from the address: a link carrying somebody’s signs nobody in', async () => {
    const stranger = await account('+97688050071', 'Холбоос явуулсан хүн');
    // Nobody signed in: nobody still, and the address wiped.
    const fresh = device();
    const door = await openPage('login.html', `#auth=${stranger}`, undefined, fresh);
    await until(door, 'the door', (d) => d.documentElement.hasAttribute('data-ready'));
    expect(fresh.getItem('basu.guest')).toBeNull();
    expect(door.window.location.hash).not.toContain('auth');

    // Somebody signed in: still them, on the dashboard as everywhere.
    const own = await account('+97688050072', 'Хөтчийн эзэн');
    const theirs = device(own);
    const dash = await openPage('ops.html', `#auth=${stranger}`, undefined, theirs);
    await until(dash, 'the corner', (d) => Boolean(d.querySelector('#org-list')));
    expect(nameOn(dash)).toContain('Хөтчийн эзэн');
    expect(theirs.getItem('basu.guest')).toBe(own);
  });

  it('opens nothing with a code that came back to another browser, and says so', async () => {
    const stranger = await account('+97688050081', 'Өөр хөтчийн хүн');
    // The round trip was the stranger's: the cookie is in their browser, the code in a link.
    const link = await backFromGoogle(await guestOf(stranger), device());
    const mine = device();
    const login = await openPage('login.html', link, undefined, mine);
    await until(login, 'the refusal', (d) => (d.getElementById('email-error')?.textContent ?? '').length > 0);
    expect(mine.getItem('basu.guest')).toBeNull();
    expect(login.window.document.getElementById('toast')?.textContent).toBe('Google-ээр нэвтрэлт хүчингүй болсон байна. Дахин нэвтэрнэ үү.');
  });

  it('gives up on a claim the server never answers, and draws the door rather than nothing', async () => {
    const person = await account('+97688050141', 'Гацсан холболттой хүн');
    const browser = device();
    // The claim goes out and no answer comes: the page's own limit ends the
    // wait, and fetch fails the way it fails when that limit is reached.
    let signal: AbortSignal | null | undefined;
    const dash = await openPage(
      'ops.html',
      await backFromGoogle(await guestOf(person), browser),
      (path, init) => {
        if (path !== '/v1/auth/handoff') return undefined;
        signal = init?.signal;
        return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      },
      browser,
    );
    await until(dash, 'the door', (d) => Boolean(d.querySelector('.door')));
    // Sent with a limit, not left to wait for an answer for ever.
    expect(signal).toBeInstanceOf(dash.window.AbortSignal);
    expect(browser.getItem('basu.guest')).toBeNull();
    expect(dash.window.document.getElementById('toast')?.textContent).toBe('Google-ээр нэвтэрч чадсангүй. Дахин оролдоно уу.');
  });

  it('gives a Google sign-in on the kitchen screen to the kitchen, and leaves the browser’s guest alone', async () => {
    const guest = await account('+97688050091', 'Гал тогооны хөтчийн зочин');
    const cook = await cookFor(pairedVenue);
    const browser = device(guest);
    const kds = await openPage('kds.html', await backFromGoogle(await guestOf(cook), browser), undefined, browser);
    await until(kds, 'the board', (d) => d.querySelectorAll('.lane').length === 3);
    expect(kds.window.document.querySelector('#venue')?.textContent).toBe(pairedVenue);
    expect(await guestOf(browser.getItem('basu.kitchen')!)).toBe(await guestOf(cook));
    expect(browser.getItem('basu.guest')).toBe(guest);
  });

  it('opens the supplier’s screen for whoever came back from Google to it', async () => {
    const person = await account('+97688050101', 'Нийлүүлэгч болох хүн');
    const browser = device();
    const screen = await openPage('supplier.html', await backFromGoogle(await guestOf(person), browser), undefined, browser);
    await until(screen, 'the application form', (d) => Boolean(d.querySelector('#apply')));
    expect(await guestOf(browser.getItem('basu.guest')!)).toBe(await guestOf(person));
  });

  it('makes whoever signs in on the website the dashboard’s person too', async () => {
    const admin = await seated('+97688050021', 'Админ Гурав');
    await account('+97688050022', 'Вэбийн хүн');
    const browser = device();
    browser.setItem('basu.ops', admin);
    const login = await openPage('login.html', '?next=/dashboard', undefined, browser);
    const d = login.window.document;
    await until(login, 'the door', () => d.documentElement.hasAttribute('data-ready'));
    (d.querySelector('[data-go="password"]') as HTMLButtonElement).click();
    const form = d.getElementById('pw-form') as HTMLFormElement;
    (form.elements.namedItem('login') as HTMLInputElement).value = '+97688050022';
    (form.elements.namedItem('password') as HTMLInputElement).value = GUEST_PASSWORD;
    form.dispatchEvent(new login.window.Event('submit', { cancelable: true }));
    await until(login, 'a session', () => Boolean(browser.getItem('basu.guest')));
    expect(await ended(admin)).toBe(true);

    const dash = await openPage('ops.html', '', undefined, browser);
    await until(dash, 'the corner', (doc) => Boolean(doc.querySelector('#org-list')));
    expect(nameOn(dash)).toContain('Вэбийн хүн');
    expect(noDesk(dash)).toBe(true);
  });

  it('signs out of the desk on the server, not only in the browser', async () => {
    const admin = await seated('+97688050031', 'Админ Дөрөв');
    const browser = device(admin);
    const dash = await openPage('ops.html', '', undefined, browser);
    await until(dash, 'the desk', (d) => Boolean(d.querySelector('.ws-opt[data-ws="desk"]')));
    (dash.window.document.querySelector('#out') as HTMLElement).click();
    await until(dash, 'the door', (d) => Boolean(d.querySelector('.door')));
    expect(browser.getItem('basu.guest')).toBeNull();
    expect(await ended(admin)).toBe(true);
  });

  it('leaves no desk behind when the person signs out on the website', async () => {
    const admin = await seated('+97688050041', 'Админ Тав');
    const browser = device(admin);
    const page = await openPage('account.html', '', undefined, browser);
    await until(page, 'the account', (d) => Boolean(d.querySelector('#out')));
    (page.window.document.querySelector('#out') as HTMLElement).click();
    expect(await ended(admin)).toBe(true);
    expect(browser.getItem('basu.guest')).toBeNull();

    const dash = await openPage('ops.html', '', undefined, browser);
    await until(dash, 'the door', (d) => Boolean(d.querySelector('.door')));
    expect(noDesk(dash)).toBe(true);
  });

  /** Signed in thirteen hours ago by the server's clock: a desk left open on some machine overnight. */
  const longAgo = (token: string) =>
    getPool().query('UPDATE identity.guest_session SET created_at = $2 WHERE token_hash = $1', [
      createHash('sha256').update(token).digest('hex'),
      new Date(clock.now().getTime() - 13 * 60 * 60 * 1000),
    ]);

  it('shows a desk seat signed in more than twelve hours ago the door, saying why, and signs that session out', async () => {
    const admin = await seated('+97688050111', 'Админ Долоо');
    await longAgo(admin);
    const browser = device(admin);
    const dash = await openPage('ops.html', '', undefined, browser);
    await until(dash, 'the door, saying why', (d) => Boolean(d.querySelector('.door #door-why')));
    expect(dash.window.document.querySelector('#door-why')?.textContent).toBe('Аюулгүй байдлын үүднээс ops-д дахин нэвтэрнэ үү.');
    expect(dash.window.document.querySelectorAll('.door')).toHaveLength(1);
    expect(noDesk(dash)).toBe(true);
    expect(browser.getItem('basu.guest')).toBeNull();
    expect(await ended(admin)).toBe(true);
  });

  it('shows the door from the books’ CSV too', async () => {
    const admin = await seated('+97688050131', 'Админ Ес');
    const browser = device(admin);
    // The movements, as last left: the page draws them and nothing before them.
    browser.setItem('basu.ops.money', 'transfers');
    const dash = await openPage('ops.html', '', undefined, browser);
    await opsTab(dash, 'money');
    await until(dash, 'the CSV', (d) => Boolean(d.querySelector('#csv')));

    // The desk left open overnight, and the first thing pressed in the morning is the CSV.
    await longAgo(admin);
    (dash.window.document.querySelector('#csv') as HTMLElement).click();
    await until(dash, 'the door, saying why', (d) => Boolean(d.querySelector('.door #door-why')));
    expect(browser.getItem('basu.guest')).toBeNull();
    expect(await ended(admin)).toBe(true);
  });

  it('never ends a sign-in the browser took while a refused call was on its way', async () => {
    const admin = await seated('+97688050121', 'Админ Найм');
    await longAgo(admin);
    const next = await account('+97688050122', 'Шинэ таб');
    const browser = device(admin);
    // The page asks as the admin; before the answer comes, another tab signs somebody else in.
    let swapped = false;
    let answered = false;
    const dash = await openPage(
      'ops.html',
      '',
      (path) => {
        if (swapped || !path.startsWith('/v1/access')) return undefined;
        swapped = true;
        browser.setItem('basu.guest', next);
        return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${admin}` } }).then((r) => {
          answered = true;
          return r;
        }) as unknown as Response;
      },
      browser,
    );
    await until(dash, 'the admin’s answer', () => answered);
    // The moment the page takes to act on it — a sign-out it sends does not wait.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(browser.getItem('basu.guest')).toBe(next);
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${next}` } })).status).toBe(200);

    // The browser tells the page its person changed, as it does across tabs, and the page follows.
    dash.window.dispatchEvent(new dash.window.StorageEvent('storage', { key: 'basu.guest' }));
    await until(dash, 'the new person’s corner', (d) => Boolean(d.querySelector('#org-list')));
    expect(nameOn(dash)).toContain('Шинэ таб');
  });

  it('never lends the supplier’s screen a session the browser no longer holds', async () => {
    const admin = await seated('+97688050051', 'Админ Зургаа');
    const browser = device();
    browser.setItem('basu.ops', admin);
    const screen = await openPage('supplier.html', '', undefined, browser);
    await until(screen, 'the way in', (d) => Boolean(d.querySelector('#signin')));
    expect(browser.getItem('basu.ops')).toBeNull();
    expect(browser.getItem('basu.guest')).toBeNull();
    expect(await ended(admin)).toBe(true);
  });
});

describe('a first password, on the account page', () => {
  /*
   * An account made by an address, Google or Apple has no password, and the
   * session looking at the page is no proof of who holds it: the first one
   * is set with a code sent to the address on the account.
   */
  const json = { 'content-type': 'application/json' };
  const passwordRow = (dom: JSDOM) => dom.window.document.querySelector('.account-ways [data-row="password"]');

  it('takes a code to the account’s own address, then the code and the password, in one popup', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    try {
      await fetch(`${base}/v1/auth/email/start`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'tuya@example.mn' }) });
      const verified = await fetch(`${base}/v1/auth/email/verify`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email: 'tuya@example.mn', code: mailer.codeFor('tuya@example.mn') }),
      });
      const { token } = (await verified.json()) as { token: string };

      const page = await openPage('account.html', '', undefined, device(token));
      await until(page, 'the password row', () => Boolean(passwordRow(page)?.querySelector('[data-open="password"]')));
      expect(passwordRow(page)!.textContent).toContain('Тохируулаагүй');
      (passwordRow(page)!.querySelector('[data-open="password"]') as HTMLElement).click();

      // The first step asks for nothing but says where the code goes.
      await until(page, 'the popup', (d) => Boolean(d.querySelector('.sheet.popup[data-open]')));
      const popupSays = () => page.window.document.querySelector('.sheet.popup[data-open] header .sub')?.textContent ?? '';
      expect(popupSays()).toContain('tuya@example.mn');
      await answerPopup(page);
      await until(page, 'the letter', () => mailer.to('tuya@example.mn')?.subject.includes('нууц үг тохируулах') ?? false);
      await answerPopup(page, { code: mailer.codeFor('tuya@example.mn')!, next: 'туяагийн нууц үг' });

      await until(page, 'the row to say it is set', () => passwordRow(page)?.textContent?.includes('Тохируулсан.') ?? false);
      const signedIn = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ login: 'tuya@example.mn', password: 'туяагийн нууц үг' }),
      });
      expect(signedIn.status).toBe(200);
      expect(mailer.to('tuya@example.mn')!.subject).toBe('Basu · Нууц үг тохирууллаа');
    } finally {
      delete ctx.mailer;
    }
  });

  it('sends another code from the same popup when the first does not do, and says so there when it cannot', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    try {
      await fetch(`${base}/v1/auth/email/start`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'oyun@example.mn' }) });
      const verified = await fetch(`${base}/v1/auth/email/verify`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email: 'oyun@example.mn', code: mailer.codeFor('oyun@example.mn') }),
      });
      const { token } = (await verified.json()) as { token: string };

      // The second time a code is asked for, the server says no; after that it is asked properly.
      let asked = 0;
      const refusal = () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message_mn: 'Хэт олон удаа оролдлоо. Хэсэг хүлээгээд дахин оролдоно уу.', message_en: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      const page = await openPage(
        'account.html',
        '',
        (path) => (path === '/v1/me/password/code' && ++asked === 2 ? refusal() : undefined),
        device(token),
      );
      await until(page, 'the password row', () => Boolean(passwordRow(page)?.querySelector('[data-open="password"]')));
      (passwordRow(page)!.querySelector('[data-open="password"]') as HTMLElement).click();
      await answerPopup(page);
      const letters = () => mailer.sent.filter((m) => m.subject.includes('нууц үг тохируулах')).length;
      await until(page, 'the first letter', () => letters() === 1);

      const sheet = () => page.window.document.querySelector('.sheet.popup[data-open]') as HTMLElement;
      const again = () => sheet().querySelector('[data-resend]') as HTMLElement;
      await until(page, '«Код дахин авах»', () => Boolean(again()));
      expect(again().textContent).toBe('Код дахин авах');

      // Refused: said inside the popup, which stays on its second step.
      again().click();
      await until(page, 'the refusal in the popup', () => !(sheet().querySelector('.popup-error') as HTMLElement).hidden);
      expect(sheet().querySelector('.popup-error')!.textContent).toContain('Хэт олон удаа оролдлоо');
      expect(sheet().querySelector('[name="code"]')).not.toBeNull();

      // Asked again: a second letter, and its code sets the password.
      again().click();
      await until(page, 'the second letter', () => letters() === 2);
      await until(page, 'the refusal to go', () => (sheet().querySelector('.popup-error') as HTMLElement).hidden === true);
      await answerPopup(page, { code: mailer.codeFor('oyun@example.mn')!, next: 'оюуны нууц үг' });
      await until(page, 'the row to say it is set', () => passwordRow(page)?.textContent?.includes('Тохируулсан.') ?? false);
      const signedIn = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ login: 'oyun@example.mn', password: 'оюуны нууц үг' }),
      });
      expect(signedIn.status).toBe(200);
    } finally {
      delete ctx.mailer;
    }
  });

  it('asks an account with no address to add one first', async () => {
    const page = await openPage('account.html', '', undefined, device(await devLogin('+97688060001', 'Вэб')));
    await until(page, 'the password row', () => Boolean(passwordRow(page)));
    expect(passwordRow(page)!.textContent).toContain('Эхлээд имэйлээ холбоно уу');
    expect((passwordRow(page)!.querySelector('[data-open="password"]') as HTMLElement).hidden).toBe(true);
    expect((page.window.document.querySelector('.account-ways [data-open="email"]') as HTMLElement).hidden).toBe(false);
  });

  it('opens the button in the letter that says a password changed on the step that replaces it, signed in or not', async () => {
    ctx.mailer = new FakeMailer();
    try {
      const login = await openPage('login.html', '?forgot', undefined, device(await devLogin('+97688060002', 'Вэб')));
      await until(login, 'the door', (d) => d.documentElement.hasAttribute('data-ready'));
      expect((login.window.document.querySelector('.l-step[data-step="forgot"]') as HTMLElement).hidden).toBe(false);
    } finally {
      delete ctx.mailer;
    }
  });
});

describe('the desk’s record', () => {
  it('shows under each name the account and the device that acted, as text', async () => {
    const desk = ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;
    // Somebody at the desk, signed in on a device that named itself with markup.
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+97688039001', password: GUEST_PASSWORD, name: 'Түүхч', device: '<img src=x onerror="window.__owned=1">' }),
    });
    const { token, guest_id: guestId } = (await made.json()) as { token: string; guest_id: string };
    const seated = await fetch(`${base}/v1/ops/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${desk}` },
      body: JSON.stringify({ guest_id: guestId, role: 'finance' }),
    });
    expect(seated.status).toBe(201);
    // They do something the record keeps.
    expect((await fetch(`${base}/v1/ops/money/topups.csv`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    const dash = await openPage('ops.html', '', undefined, device(token));
    await opsTab(dash, 'audit');
    const theirs = (d: Document) => [...d.querySelectorAll('#audit tr.dt-row')].find((r) => r.querySelector('.dt-two b')?.textContent === 'Түүхч');
    await until(dash, 'their line in the record', (d) => Boolean(theirs(d)));
    const who = theirs(dash.window.document)!.querySelector('.dt-two')!;
    // The account by its number, and the device by the name it gave — shown, never run.
    expect(who.querySelector('small')?.textContent).toBe('+97688039001 · <img src=x onerror="window.__owned=1">');
    expect(dash.window.document.querySelector('#audit img')).toBeNull();
    expect((dash.window as unknown as { __owned?: number }).__owned).toBeUndefined();
    expect(who.getAttribute('title')).toMatch(/^Бүртгэл: Түүхч, \+97688039001\nНэвтрэлт: <img src=x onerror="window.__owned=1">, .+-д нэвтэрсэн$/);

    // The seat was given with the demo's shared secret: nobody's account, so the name alone.
    const demo = [...dash.window.document.querySelectorAll('#audit tr.dt-row .dt-two')].find((c) => c.querySelector('b')?.textContent === 'Демо');
    expect(demo).toBeDefined();
    expect(demo!.querySelector('small')).toBeNull();
    expect(demo!.hasAttribute('title')).toBe(false);
  });
});

describe('Basu decides who may do what', () => {
  /** The demo's desk: the shared secret, prefilled, one press. */
  async function theDesk(): Promise<JSDOM> {
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    return desk;
  }
  const deskToken = async () => ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;

  it('makes a role in a popup, module by module and then page by page, an action bringing its page along', async () => {
    const desk = await theDesk();
    await opsTab(desk, 'roles');
    await until(desk, 'the roles', (d) => d.querySelectorAll('#roles-table tr[data-role]').length >= 4);
    const doc = desk.window.document;
    (doc.querySelector('#role-new') as HTMLElement).click();
    await until(desk, 'an empty role in the popup', (d) => (d.querySelector('#role-edit[role="dialog"] [name="name"]') as HTMLInputElement | null)?.value === '');
    const name = doc.querySelector('#role-edit [name="name"]') as HTMLInputElement;
    name.value = 'Туслах · тест';
    name.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
    const level = (module: string) => doc.querySelector(`#role-edit .role-mod[data-module="${module}"]`)?.getAttribute('data-level');
    const ticked = () => [...doc.querySelectorAll('#role-edit .role-pages input:checked')].map((i) => (i as HTMLInputElement).value).sort();
    expect(level('platform')).toBe('none');

    // A whole module to read, at one press: every page of it, none of its actions.
    (doc.querySelector('#role-edit .role-mod[data-module="platform"] .role-level [data-level="view"]') as HTMLElement).click();
    expect(level('platform')).toBe('view');
    expect(ticked()).toEqual(['desk.guests', 'desk.money', 'desk.notify']);

    // Then one page out of it, and one action in another module — which brings its page along.
    const tick = (value: string, on: boolean) => {
      const box = doc.querySelector(`#role-edit input[value="${value}"]`) as HTMLInputElement;
      box.checked = on;
      box.dispatchEvent(new desk.window.Event('change', { bubbles: true }));
    };
    tick('desk.money', false);
    tick('desk.orders:manage', true);
    expect(level('platform')).toBe('some');
    expect((doc.querySelector('#role-edit input[value="desk.orders"]') as HTMLInputElement).checked).toBe(true);
    (doc.querySelector('#role-edit [data-save]') as HTMLElement).click();

    // The popup closes and the table has the role; opening it shows what was saved.
    const row = () => [...doc.querySelectorAll('#roles-table tr[data-role]')].find((r) => r.textContent?.includes('Туслах · тест')) as HTMLElement | undefined;
    await until(desk, 'the new role in the table', () => Boolean(row()) && !doc.querySelector('#role-edit'));
    row()!.click();
    await until(desk, 'the role in the popup', (d) => (d.querySelector('#role-edit [name="name"]') as HTMLInputElement | null)?.value === 'Туслах · тест');
    expect(ticked()).toEqual(['desk.guests', 'desk.notify', 'desk.orders', 'desk.orders:manage']);

    // A copy starts from the same pages, under a name of its own.
    (doc.querySelector('#role-edit [data-copy]') as HTMLElement).click();
    expect((doc.querySelector('#role-edit [name="name"]') as HTMLInputElement).value).toBe('Туслах · тест (хуулбар)');
    expect(ticked()).toEqual(['desk.guests', 'desk.notify', 'desk.orders', 'desk.orders:manage']);
  });

  it('renames a module and hides a page, and the sidebar follows the moment it is saved', async () => {
    const desk = await theDesk();
    await opsTab(desk, 'menus');
    await until(desk, 'the menu', (d) => d.querySelectorAll('#menu-board .menu-mod').length >= 6);
    const doc = desk.window.document;
    // The page is read; each change is a popup, saved as it closes.
    expect(doc.querySelector('#menu-board input')).toBeNull();
    (doc.querySelector('.menu-mod[data-module="platform"] [data-edit-mod]') as HTMLElement).click();
    await answerPopup(desk, { name: 'Үндсэн үйлчилгээ' });
    await until(desk, 'the sidebar renamed', (d) => d.querySelector('.nav-mod[data-group="platform"] .mod .t')?.textContent === 'Үндсэн үйлчилгээ');
    await until(desk, 'the menu again', (d) => Boolean(d.querySelector('.menu-page[data-page="reviews"] [data-edit-page]')));
    (doc.querySelector('.menu-page[data-page="reviews"] [data-edit-page]') as HTMLElement).click();
    await answerPopup(desk, { shown: '0' });
    await until(desk, 'the page gone from the sidebar', (d) => !d.querySelector('.tabs [data-tab="reviews"]'));
    expect(doc.querySelector('.menu-page[data-page="reviews"]')?.hasAttribute('data-off')).toBe(true);
    // Put it back for whoever comes next.
    await fetch(`${base}/v1/ops/menus/desk`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await deskToken()}` },
      body: JSON.stringify({ modules: [{ key: 'platform', name: 'Платформ' }], pages: [{ key: 'reviews', hidden: false }] }),
    });
  });

  it('opens a business from the desk and gives somebody there another role', async () => {
    const reg = async (phone: string, name: string) =>
      ((await (await fetch(`${base}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: GUEST_PASSWORD, name }) })).json()) as { token: string }).token;
    const owner = await reg('+97688040001', 'Эзэн · тест');
    await reg('+97688040003', 'Ажилтан · тест');
    const as = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
    const made = (await (await fetch(`${base}/v1/orgs`, { method: 'POST', headers: as(owner), body: JSON.stringify({ name: 'Эрхийн мах · тест', supplier: true, phone: '8811 0001', address: 'Нарантуул' }) })).json()) as { id: string };
    await fetch(`${base}/v1/ops/orgs/${made.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${await deskToken()}` } });
    const found = (await (await fetch(`${base}/v1/orgs/${made.id}/lookup?contact=88040003`, { headers: as(owner) })).json()) as { guest_id: string };
    await fetch(`${base}/v1/orgs/${made.id}/members`, { method: 'POST', headers: as(owner), body: JSON.stringify({ guest_id: found.guest_id, role: 'staff' }) });

    const desk = await theDesk();
    await opsTab(desk, 'orgs');
    await until(desk, 'the business', (d) => [...d.querySelectorAll('#orgs tr[data-org]')].some((r) => r.textContent?.includes('Эрхийн мах · тест')));
    const row = [...desk.window.document.querySelectorAll('#orgs tr[data-org]')].find((r) => r.textContent?.includes('Эрхийн мах · тест'))!;
    (row.querySelector('[data-a="access"]') as HTMLElement).click();
    await until(desk, 'its people', (d) => d.querySelectorAll('[data-people] tr[data-member]').length === 2);
    (desk.window.document.querySelector(`[data-people] tr[data-member="${found.guest_id}"] [data-a="role"]`) as HTMLElement).click();
    await answerPopup(desk, { role: 'accountant' });
    await until(desk, 'the role saved', (d) => (d.getElementById('toast')?.textContent ?? '').includes('Нягтлан'));
    const now = (await (await fetch(`${base}/v1/orgs/${made.id}`, { headers: as(owner) })).json()) as { members: Array<{ guest_id: string; role: string }> };
    expect(now.members.find((m) => m.guest_id === found.guest_id)?.role).toBe('accountant');
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
 * A supplier's own screen, as its owner opens it from the dashboard: their
 * own device and session, and `?org=` naming the business. The guest pages
 * in the same test stay on the guest's.
 */
async function ownerScreen(phone: string): Promise<JSDOM> {
  const token = await devLogin(phone, 'Нийлүүлэгч');
  const seat = (await (await fetch(`${base}/v1/supplier/seat`, { headers: { authorization: `Bearer ${token}` } })).json()) as { org_id: string };
  return openPage('supplier.html', `?org=${seat.org_id}`, undefined, device(token));
}

/** The screen of whoever sold the order with this code. */
async function supplierScreenFor(code: string): Promise<JSDOM> {
  const { rows } = await getPool().query<{ phone: string }>(
    `SELECT g.phone_e164 AS phone FROM idesh.idesh_order o
       JOIN idesh.supplier s ON s.id = o.supplier_id
       JOIN identity.guest g ON g.id = s.owner_guest_id
      WHERE o.code = $1`,
    [code],
  );
  return ownerScreen(rows[0]!.phone);
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

/** A session for this number, the walkthrough's way. */
async function devLogin(phone: string, device: string): Promise<string> {
  const response = await fetch(`${base}/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, device }),
  });
  const { token } = (await response.json()) as { token: string };
  return token;
}

/** The seeded cook of that venue, signed in. */
async function cookFor(name: string): Promise<string> {
  return devLogin(seeded.kitchens.find((k) => k.name === name)!.phone, 'Гал тогоо');
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
