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
import { addListingPhoto, cancelIdesh } from '../idesh/index.js';
import { handOff } from '../platform/identity/index.js';
import { seedDemo } from '../seed/demo.js';
import {
  ClosedPaymentProvider,
  FakeMailer,
  FakeNotifier,
  FakePaymentProvider,
  HostedFakePaymentProvider,
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
  keepCookie(cookiesOf(browser), `__Host-basu_handoff=${binding}; Max-Age=120; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return `#auth_code=${code}`;
}

/**
 * Pages opened by the current test. They are closed afterwards so their polling
 * stops: a jsdom window left running keeps hitting the API and, because the
 * store is shared the way a browser shares an origin, a zombie page can clear
 * the tablet's token out from under the page under test.
 */
const open: JSDOM[] = [];

/** A page's requests to the server: how many it has made, how many have not come back. */
const trafficOf = new WeakMap<JSDOM, { made: number; pending: number }>();

/**
 * Load a page into jsdom, wire fetch to the live server, run its script.
 *
 * `search` is how a deep link is opened: the home screen sends people into
 * the dine-in app at `/dine?order=…`, and a page that reads location has to
 * be given one that says something. `respond` answers a request in place of
 * the server, for a state the seed cannot be put in — an empty market — or
 * loses the server's answer on its way back, the way a patchy connection does.
 * `now` sets the page's own clock — what `new Date()` and `Date.now()` say
 * in it, still ticking — for a test about the day a computer thinks it is.
 */
async function openPage(
  file: string,
  search = '',
  respond?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  browser: ReturnType<typeof memoryStorage> = storage,
  userAgent?: string,
  now?: string,
  /** What the page finds before it runs — the app's bridge, for one inside the app. */
  before?: (window: JSDOM['window']) => void,
): Promise<JSDOM> {
  const html = await readFile(join(WEB, file), 'utf8');
  const dom = new JSDOM(html, {
    url: `${base}/${file.replace(/\.html$/, '')}${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom has no fetch; point it at the running server and resolve relative
  // paths the way a browser would, with the cookies this browser holds. The
  // requests are counted, for a test that waits until nothing more is on its
  // way (`settled`).
  const jar = cookiesOf(browser);
  const traffic = { made: 0, pending: 0 };
  trafficOf.set(dom, traffic);
  (window as unknown as { fetch: typeof fetch }).fetch = (async (input: string, init?: RequestInit) => {
    const canned = respond?.(String(input), init);
    if (canned) return canned;
    traffic.made += 1;
    traffic.pending += 1;
    try {
      const url = new URL(String(input), base);
      const headers = new Headers(init?.headers);
      const sent = [...jar].filter(([, c]) => url.pathname.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`);
      if (sent.length) headers.set('cookie', sent.join('; '));
      // The page's AbortSignal is jsdom's, and Node's fetch takes only its own:
      // one of those follows it, so a request the page gives up on is given up.
      const response = await fetch(url.toString(), { ...init, headers, signal: init?.signal ? following(init.signal) : null });
      for (const line of response.headers.getSetCookie()) keepCookie(jar, line);
      return response;
    } finally {
      traffic.pending -= 1;
    }
  }) as typeof fetch;
  Object.defineProperty(window, 'localStorage', { value: browser, writable: true });
  // Another browser's own words for itself — Facebook's, which Google will not sign anybody in from.
  if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });

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
  // Calls in a scope of their own: call.js keeps short names (esc, ICON) the pages have too.
  const calls = html.includes("from '/call.js'")
    ? `const { callButton, listenForCalls } = (() => { ${strip((await readFile(join(WEB, 'call.js'), 'utf8')).replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, ''))}\nreturn { callButton, listenForCalls }; })();`
    : '';
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const page = inline.replace(/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/gm, '');

  stubMapLibre(window);
  if (now) {
    window.eval(`(() => {
      const Real = Date;
      const shift = ${Date.parse(now)} - Real.now();
      globalThis.Date = class extends Real {
        constructor(...at) { super(...(at.length ? at : [Real.now() + shift])); }
        static now() { return Real.now() + shift; }
      };
    })();`);
  }
  before?.(window);
  window.eval(
    `(async () => { ${shared}\n${site}\n${mapLib}\n${sideNav}\n${tables}\n${calls}\n${page} })().catch(e => { window.__err = e; });`,
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

/**
 * Wait until a page has had nothing on its way to or from the server for a
 * moment — whatever a view asked for has come back and been drawn, and
 * whatever that asked for next has too. With `since` (a count of requests
 * made, read before a search was typed) it waits for the page to have asked
 * at all first: a search asks only once the typing pauses.
 */
async function settled(dom: JSDOM, label: string, since?: number): Promise<void> {
  const traffic = trafficOf.get(dom)!;
  let quiet = 0;
  await until(dom, `${label}, with nothing more on its way`, () => {
    const done = traffic.pending === 0 && (since === undefined || traffic.made > since);
    quiet = done ? quiet + 1 : 0;
    return quiet >= 3;
  });
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
  await until(dom, 'a time chosen', (d) => orderable(d));
  (dom.window.document.querySelector('.sheet footer button') as HTMLElement).click();
  await until(dom, 'the status screen', (d) => Boolean(d.querySelector('.status')));
}

/**
 * The basket's «Захиалах», ready to take the money: a time is chosen (until
 * then it says «Цагаа сонгоно уу» and is off). It pays as it orders.
 */
function orderable(d: Document): boolean {
  const button = d.querySelector('.sheet footer button') as HTMLButtonElement | null;
  return Boolean(button && !button.disabled && button.textContent?.trim() === 'Захиалах');
}

/** The Pay button, ready for a tap: a time chosen and no spinner. */
function payable(d: Document): boolean {
  const button = d.querySelector('.sheet footer button');
  return Boolean(button && !button.hasAttribute('data-busy') && orderable(d));
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

/**
 * The stall selling whole animals with the most of them left: a test that
 * buys there, twice if it needs to, never finds it sold out by the ones
 * before it.
 */
async function fullestStall(): Promise<string> {
  const { listings } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
    listings: Array<{ id: string; unit: string; remaining: number }>;
  };
  return listings.filter((l) => l.unit === 'whole').sort((a, b) => b.remaining - a.remaining)[0]!.id;
}

/** Every идэш this number has made, paid for or not, and the payments taken for them. */
async function ideshOf(phone: string): Promise<{ orders: number; payments: number }> {
  const { rows } = await getPool().query<{ orders: number; payments: number }>(
    `SELECT count(DISTINCT o.id)::int AS orders, count(t.id)::int AS payments
       FROM idesh.idesh_order o
       JOIN identity.guest g ON g.id = o.guest_id
       LEFT JOIN ledger.transfer t ON t.kind = 'purchase' AND t.subject = 'idesh' AND t.subject_id = o.id
      WHERE g.phone_e164 = $1`,
    [phone],
  );
  return rows[0]!;
}

/**
 * A connection that loses one answer on its way back. The first request
 * `picked` chooses reaches the server and is carried out there; the page
 * hears only that the network failed, the way a phone on a patchy
 * connection does. Everything after it goes through.
 */
function losingOne(picked: (path: string, init?: RequestInit) => boolean) {
  let lost = false;
  return {
    get lost() {
      return lost;
    },
    respond(path: string, init?: RequestInit): Promise<Response> | undefined {
      if (lost || !picked(path, init)) return undefined;
      lost = true;
      return fetch(new URL(path, base).toString(), init).then(() => Promise.reject(new TypeError('Failed to fetch')));
    },
  };
}

/**
 * What the scheduler does to a draft nobody paid for in half an hour: gives
 * its animal back. Here at once, and only to this number's drafts.
 */
async function lapseDrafts(phone: string): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT o.id FROM idesh.idesh_order o JOIN identity.guest g ON g.id = o.guest_id
      WHERE g.phone_e164 = $1 AND o.state = 'DRAFT'`,
    [phone],
  );
  expect(rows.length, 'a draft to lapse').toBeGreaterThan(0);
  for (const { id } of rows) await cancelIdesh(ctx, id, { actor: 'system:scheduler', role: 'system' }, 'draft_expired');
}

/** Who the server keeps answers for: the session signed in here, as a hash. */
const callerHere = () => createHash('sha256').update(storage.getItem('basu.guest')!).digest('hex');

/** Where and under which key the server kept answers for the person signed in here, oldest first. */
async function keysKept(): Promise<Array<{ url: string; key: string }>> {
  const { rows } = await getPool().query<{ url: string; key: string }>(
    `SELECT url, key FROM idempotency_answer WHERE caller = $1 ORDER BY created_at, url`,
    [callerHere()],
  );
  return rows;
}

/**
 * One attempt at an идэш, as the server kept it: the order under a key
 * nobody could guess, and its payment under the attempt's own — one random
 * nonce between them, however many times either was sent.
 */
function expectOneAttempt(kept: Array<{ url: string; key: string }>): void {
  expect(kept.map((k) => k.url)).toEqual(['/v1/idesh', expect.stringMatching(/^\/v1\/idesh\/[0-9a-f-]{36}\/pay$/)]);
  const [made, paid] = kept;
  expect(made!.key).toMatch(/^idesh-[0-9a-f]{32}$/);
  expect(paid!.key).toBe(made!.key.replace(/^idesh-/, 'pay-'));
}

/**
 * The server forgetting answers it kept for the person signed in here, to
 * the addresses matching `to`: past the day a retry can come in, or never
 * written because its store failed.
 */
async function forgetAnswers(to: string): Promise<void> {
  const { rowCount } = await getPool().query(`DELETE FROM idempotency_answer WHERE caller = $1 AND url ~ $2`, [callerHere(), to]);
  expect(rowCount, 'an answer to forget').toBeGreaterThan(0);
}

/** Making an идэш, and paying for one: the two calls whose answers a test loses. */
const makingIdesh = (path: string, init?: RequestInit) => init?.method === 'POST' && path === '/v1/idesh';
const payingIdesh = (path: string, init?: RequestInit) =>
  init?.method === 'POST' && /^\/v1\/idesh\/[0-9a-f-]{36}\/pay$/.test(path);

/**
 * How many times a page has sent the browser to another page. jsdom loads
 * no other document, it only says that a page asked it to — which is enough
 * to know the page handed the person on rather than stopping to complain.
 */
function departures(dom: JSDOM): { count: number } {
  const left = { count: 0 };
  dom.virtualConsole.on('jsdomError', (error) => {
    if (/^Not implemented: navigation/.test(error.message)) left.count++;
  });
  return left;
}

/**
 * A connection that holds one answer on its way back. The first request
 * `picked` chooses reaches the server and is carried out there; the page
 * hears nothing of it until the test lets the answer through. It is the
 * answer slow enough in coming that the person goes back and presses again.
 */
function holdingOne(picked: (path: string, init?: RequestInit) => boolean) {
  let held = false;
  let arrived!: () => void;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    /** Settles once the server has carried the request out: the order exists. */
    answered: new Promise<void>((resolve) => (arrived = resolve)),
    /** Lets the answer through to the page. */
    release,
    respond(path: string, init?: RequestInit): Promise<Response> | undefined {
      if (held || !picked(path, init)) return undefined;
      held = true;
      return fetch(new URL(path, base).toString(), init).then(async (response) => {
        arrived();
        await released;
        return response;
      });
    },
  };
}

/**
 * Somebody else buying at the same stall, in the middle of it: the listing's
 * row is theirs until `done`, and an order made there waits at the server
 * for it. That is an answer as slow as it gets, with nothing kept yet for a
 * second press to be handed back.
 */
async function busyStall(listing: string): Promise<{ done: () => Promise<void> }> {
  const other = await getPool().connect();
  await other.query('BEGIN');
  await other.query('SELECT id FROM idesh.listing WHERE id = $1 FOR UPDATE', [listing]);
  return {
    async done() {
      await other.query('COMMIT');
      other.release();
    },
  };
}

/** How many of the server's queries are waiting for a row somebody else holds. */
async function waitingOnRows(): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
}

/**
 * The most of the server's queries seen waiting for a row at once, from now
 * until `n` are or `ms` have gone by: long enough for a request on its way
 * to have arrived and joined the queue.
 */
async function mostWaiting(n: number, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  let most = 0;
  while (Date.now() < deadline && most < n) {
    most = Math.max(most, await waitingOnRows());
    await new Promise((r) => setTimeout(r, 30));
  }
  return most;
}

/** The server ending every session this number has — signed out elsewhere, or simply over. */
async function endSessions(phone: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE identity.guest_session SET revoked_at = now()
      WHERE revoked_at IS NULL AND guest_id = (SELECT id FROM identity.guest WHERE phone_e164 = $1)`,
    [phone],
  );
  expect(rowCount, 'a session to end').toBeGreaterThan(0);
}

/**
 * Signing in on the app's page, as `phone`: the page asks `/dev/login` where
 * the phone app shows the shell's own sheet, and whoever is holding the
 * phone signs in there — the same person again, or somebody else.
 */
const signingInAs = (phone: string) => (path: string) =>
  path === '/dev/login'
    ? fetch(`${base}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) })
    : undefined;

/** What a page says when the network, not the server, let a request down. */
const CONNECTION_LOST = 'Холболт тасарлаа. Дахин оролдоно уу.';
/** What a stall says, before anything is filled in, while the server cannot take money. */
const PAYMENTS_CLOSED = 'Онлайн төлбөр одоогоор хаалттай байна.';

/** Money into a guest's Basu wallet, the way a top-up goes in while payments are open. */
async function topUp(token: string, amountMnt: number): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const started = await fetch(`${base}/v1/wallet/topup`, { method: 'POST', headers, body: JSON.stringify({ amount_mnt: amountMnt }) });
  expect(started.status, await started.clone().text()).toBe(200);
  const { topup_id: id } = (await started.json()) as { topup_id: string };
  const settled = await fetch(`${base}/v1/wallet/topup/${id}/settle`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  expect(settled.status, await settled.clone().text()).toBe(200);
}

/** What a page says when the order bought is the one from before the person changed it. */
const EARLIER_ORDER = 'Өмнөх захиалга тань төлөгдсөн байна';

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
      expect(row.querySelector('img')?.getAttribute('src')).toMatch(/^\/dishes\/\w+\.svg\?look=dark$/);
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
    await until(dom, 'a time chosen', orderable);
    // The basket says what the one button is about to charge, and for when.
    expect(dom.window.document.querySelector('#sheet-foot .basket')?.textContent).toContain('28,000₮');
    expect(dom.window.document.querySelector('#sheet-foot .basket')?.textContent).toContain('12:30');

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
    await until(dom, 'a time chosen', orderable);
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
        // Said to the guest in the guest's words. The kitchen's own screen is
        // staff's: a link to its sign-in inside the guest's app was a dead end.
        expect(dom.window.document.querySelector('#map .note')?.textContent).toContain('захиалга авахгүй байна');
        expect(dom.window.document.querySelector('a[href="/kds"]')).toBeNull();
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

  it('says plainly when there is no restaurant at all: no map of other businesses, no kitchen door, a way on', async () => {
    // What production showed its first guests: a city of other people's
    // cafés with nothing of ours on it, and a link to the kitchen's sign-in.
    storage.removeItem('basu.guest');
    const none = () => new Response(JSON.stringify({ restaurants: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const dom = await openPage('dine.html', '', (path) => (path === '/v1/restaurants' ? none() : undefined));
    const d = dom.window.document;
    await until(dom, 'the empty page', () => d.getElementById('blank')?.getAttribute('data-kind') === 'none' && !(d.getElementById('blank') as HTMLElement).hidden);
    expect(text(dom)).toContain('Одоогоор ресторан алга');
    // The way on: the app that has something in it, and the way home.
    expect(d.querySelector('#blank a[href="/idesh"]')).toBeTruthy();
    expect(d.querySelector('#blank [data-home]')).toBeTruthy();
    // No city downloaded for nobody: the map is not even made.
    expect((dom.window as unknown as Record<string, unknown>)['__map']).toBeUndefined();
    expect(d.querySelector('a[href="/kds"]')).toBeNull();
  });

  it('says the connection is lost rather than drawing a blank map, and draws the map once it is back', async () => {
    storage.removeItem('basu.guest');
    let down = true;
    const dom = await openPage('dine.html', '', (path) =>
      down && path === '/v1/restaurants' ? Promise.reject(new TypeError('Failed to fetch')) : undefined,
    );
    const d = dom.window.document;
    await until(dom, 'the failure, said', () => d.getElementById('blank')?.getAttribute('data-kind') === 'offline' && !(d.getElementById('blank') as HTMLElement).hidden);
    expect(text(dom)).toContain('Холболт тасарлаа');
    expect(d.querySelector('#blank [data-home]')).toBeTruthy();
    expect(pins(dom)).toHaveLength(0);

    down = false;
    (d.querySelector('#blank [data-retry]') as HTMLElement).click();
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
    expect((d.getElementById('blank') as HTMLElement).hidden).toBe(true);
  });

  it('offers only the times still ahead on the server’s clock', async () => {
    // The demo's clock stands at 11:40 for this file. 11:30 has begun, and a
    // lunch nobody can arrive for is not offered; noon is.
    const dom = await openPage('dine.html');
    await until(dom, 'pins on the map', () => pins(dom).length >= seeded.venues);
    tapPin(dom, pairedVenue);
    await until(dom, 'the times', (d) => d.querySelectorAll('.slot').length > 0);
    const offered = [...dom.window.document.querySelectorAll('.slot')].map((s) => s.textContent?.trim());
    expect(offered).not.toContain('11:30');
    expect(offered).toContain('12:00');
  });

  it('asks before it cancels a paid lunch, says what happens to the money, and cancels on yes', async () => {
    await ownGuest('+97699003013');
    const dom = await openPage('dine.html');
    await orderFromMap(dom, pairedVenue, 'Цуйван', '13:15');
    const d = dom.window.document;
    clickText(dom, '#sheet-foot button', 'Үнэгүй цуцлах');
    await until(dom, 'the question', () => Boolean(d.querySelector('.sheet.popup[data-open]')));
    const ask = d.querySelector('.sheet.popup[data-open]')!;
    expect(ask.textContent).toContain('Захиалгаа цуцлах уу?');
    expect(ask.textContent).toContain('бүтнээрээ буцаагдана');
    // Asking cancels nothing.
    expect(['CANCELLED', 'REFUNDED']).not.toContain(d.querySelector('.status')?.getAttribute('data-s'));
    (ask.querySelector('[data-submit]') as HTMLElement).click();
    await until(dom, 'the lunch, cancelled', () =>
      ['CANCELLED', 'REFUNDED'].includes(d.querySelector('.status')?.getAttribute('data-s') ?? ''),
    );
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

  it('draws the city at night whatever the phone is set to', async () => {
    // Every Basu page is dark. The map used to follow the phone's own setting,
    // and a phone set to light drew a daylight city under the dark sheet — most
    // of the lunch page went light. One palette now: the charcoal ground, and
    // no colour on it but the pins.
    const dom = await openPage('dine.html');
    await until(dom, 'the style', () => Boolean((dom.window as unknown as Record<string, unknown>)['__style']));
    const style = (dom.window as unknown as Record<string, unknown>)['__style'] as {
      layers: Array<{ id: string; paint?: Record<string, unknown> }>;
    };
    const paint = (id: string, key: string) => style.layers.find((l) => l.id === id)?.paint?.[key];
    expect(paint('bg', 'background-color')).toBe('#141110');
    expect(paint('road-primary', 'line-color')).toBe('#3E3431');
    expect(paint('water', 'fill-color')).toBe('#111518');
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
    // Waiting on the kitchen, the corner gives the time the guest comes, in
    // the words the iPhone's launcher and lock screen use.
    expect(card.querySelector('.when')?.textContent).toBe('13:00ирэх');
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

    // Refusing sends the guest's money back and cannot be undone: it asks
    // first, and «Болих» leaves the ticket where it was.
    ([...ticket.querySelectorAll('button')].find((b) => b.textContent?.includes('Татгалзах')) as HTMLElement).click();
    await until(kds, 'the question', (d) => Boolean(d.querySelector('#reject-order')));
    expect(kds.window.document.querySelector('#reject-order')?.textContent).toContain('бүтнээр');
    (kds.window.document.querySelector('#reject-order [data-cancel]') as HTMLElement).click();
    await until(kds, 'the question to go', (d) => !d.querySelector('.sheet.popup[data-open]'));
    expect(
      [...kds.window.document.querySelectorAll('.ticket')].some(
        (t) => t.textContent?.includes('Хуушуур') && t.textContent?.includes('Хүлээн авах'),
      ),
    ).toBe(true);

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
  it('shows the stalls to anybody, signed in or not', async () => {
    storage.removeItem('basu.guest');
    const dom = await openPage('index.html');
    const d = dom.window.document;
    await until(dom, 'the stall board', () => !(d.getElementById('board') as HTMLElement).hidden);
    expect(d.querySelectorAll('.stall').length).toBeGreaterThan(0);
    // The count on each animal a stall sells, and the cheapest of it under its name.
    expect([...d.querySelectorAll('.animal .ktag')].some((t) => /^\d+ зар$/.test(t.textContent ?? ''))).toBe(true);
    expect([...d.querySelectorAll('.animal .m em')].some((t) => /^[\d,]+₮(\/кг)?$/.test(t.textContent ?? ''))).toBe(true);
    // One listing of them floats on the opening, a press away.
    expect((d.getElementById('chip') as HTMLElement).hidden).toBe(false);
    expect(d.getElementById('chip')?.getAttribute('href')).toMatch(/^\/shop\/[0-9a-f-]{36}$/);
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
      // The price in the display face, and what it is for: a kilo, or a whole animal's rough weight.
      expect(stall.querySelector('.pr .money')?.textContent).toMatch(/^[\d,]+₮$/);
      expect(stall.querySelector('.pr small')?.textContent).toMatch(/^(\/кг|≈\d+ кг|)$/);
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
    // «Миний Basu» in the phone's menu, as in the account's menu and the foot; the bar, where four links and a name share a line, says «Нүүр».
    expect(d.querySelector('#s-drawer a[href="/home"]')?.textContent).toBe('Миний Basu');
    expect(d.querySelector('.s-nav a[href="/home"]')?.textContent).toBe('Нүүр');
    expect(d.querySelector('.s-nav a[href="/home"]')?.getAttribute('aria-current')).toBe('page');
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

  it('speaks of paying at the door only to whoever came from a stall’s «Нэвтэрч төлөх →»', async () => {
    storage.removeItem('basu.guest');
    const id = await fullestStall();
    const lead = async (search: string) => {
      const door = await openPage('login.html', search);
      await until(door, 'the door', (d) => d.documentElement.hasAttribute('data-ready'));
      return door.window.document.querySelector('.l-step[data-step="start"] .l-lead')?.textContent ?? '';
    };
    // The header's «Нэвтрэх» on a stall: back to the listing, nothing about paying.
    const fromHeader = await lead(`?next=${encodeURIComponent(`/shop/${id}`)}`);
    expect(fromHeader).toContain('Нэвтэрмэгц үзэж байсан зар руугаа буцна.');
    expect(fromHeader).not.toContain('төлөх');
    // The review's own button sends `for=pay` with it.
    expect(await lead(`?next=${encodeURIComponent(`/shop/${id}`)}&for=pay`)).toContain('Захиалгаа төлөхийн тулд нэвтэрнэ үү');
  });

  it('prints the courier’s number on an order as people read it, the eight digits a stall sends included', async () => {
    await ownGuest('+97699005037');
    const token = storage.getItem('basu.guest')!;
    const { listings, today } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      today: string;
      listings: Array<{ id: string; delivers: boolean; unit: string; remaining: number; ready_from: string }>;
    };
    const stall = listings.find((l) => l.delivers && l.unit === 'whole' && l.remaining > 0)!;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const made = await fetch(`${base}/v1/idesh`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'courier-number-1' },
      // What the stall sends: «9911 2233» as typed, the space taken out.
      body: JSON.stringify({ listing_id: stall.id, qty: 1, receive: 'delivery', receive_on: stall.ready_from > today ? stall.ready_from : today, address: 'Баянзүрх, 3-р хороо', address_phone: '99112233' }),
    });
    const order = (await made.json()) as { id: string };
    expect(made.status, JSON.stringify(order)).toBe(201);
    expect((await fetch(`${base}/v1/idesh/${order.id}/pay`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    const page = await openPage('orders.html', `/${order.id}`);
    await until(page, 'the order', (d) => Boolean(d.querySelector('.od-box')));
    const line = [...page.window.document.querySelectorAll('.od-box small')].map((s) => s.textContent).find((t) => t?.startsWith('Залгах утас'));
    expect(line).toBe('Залгах утас: +976 9911 2233');
  });

  it('opens on the animal the address names, and on all of them for a name that is none of the four', async () => {
    storage.removeItem('basu.guest');
    const beef = await openPage('shop.html', '?kind=beef');
    await until(beef, 'the beef', (d) => d.querySelectorAll('.sh-card').length > 0);
    expect([...beef.window.document.querySelectorAll('.sh-card')].every((c) => c.getAttribute('data-kind') === 'beef')).toBe(true);
    // Something every object answers to is not an animal: no «function Object()» over an empty grid.
    const odd = await openPage('shop.html', '?kind=constructor');
    const d = odd.window.document;
    await until(odd, 'the market', () => d.querySelectorAll('.sh-card').length > 0 || Boolean(d.querySelector('#grid .s-empty')));
    expect(d.getElementById('grid')?.textContent).not.toContain('function');
    expect(d.querySelectorAll('.sh-card').length).toBeGreaterThanOrEqual(seeded.listings);
    expect(d.querySelector('#kinds [data-kind="all"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts back a form kept before signing in as words, never as markup', async () => {
    await ownGuest('+97699005031');
    const id = await fullestStall();
    const stall = await openPage('shop.html', `/${id}`);
    // Kept in this browser before the sign-in: a day that is not one.
    stall.window.sessionStorage.setItem(`basu.shop.${id}`, JSON.stringify({ receiveOn: '2026-09-12" data-planted="1' }));
    const s = stall.window.document;
    await until(stall, 'the order form', () => Boolean(s.getElementById('when')));
    expect(s.querySelector('[data-planted]')).toBeNull();
    expect(s.getElementById('when')?.getAttribute('value')).toBe('2026-09-12" data-planted="1');
  });

  it('says payments are closed before anything is filled in or signed into, and sets nothing aside', async () => {
    storage.removeItem('basu.guest');
    const id = await fullestStall();
    const left = async () => ((await (await fetch(`${base}/v1/idesh/listings/${id}`)).json()) as { listing: { remaining: number } }).listing.remaining;
    const before = await left();
    // Production with no payment provider, and somebody just looking.
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      // The market says it over the cards, before a stall is opened…
      const market = await openPage('shop.html');
      const d = market.window.document;
      await until(market, 'the cards', () => d.querySelectorAll('.sh-card').length > 0);
      expect(d.querySelector('#grid .sh-closed b')?.textContent).toBe(PAYMENTS_CLOSED);

      // …and a stall at the top of its order box, with what can be done meanwhile:
      // the address to write to, no date, nothing promised.
      const stall = await openPage('shop.html', `/${id}`);
      const s = stall.window.document;
      await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
      expect(s.querySelector('#buy .sh-closed b')?.textContent).toBe(PAYMENTS_CLOSED);
      expect(s.querySelector('#buy .sh-closed a[href="mailto:basuappmn@gmail.com"]')).toBeTruthy();
      // «Захиалах» is grey, with the reason right under it…
      const next = s.getElementById('next') as HTMLButtonElement;
      expect(next.textContent).toBe('Захиалах');
      expect(next.disabled).toBe(true);
      expect((s.getElementById('next-why') as HTMLElement).hidden).toBe(false);
      expect(s.getElementById('next-why')?.textContent).toContain('хаалттай');
      // …and so is the bar at the thumb's.
      expect((s.querySelector('.sd-dock button') as HTMLButtonElement).disabled).toBe(true);
      expect(s.querySelector('.sd-dock [data-what]')?.textContent).toBe('Онлайн төлбөр хаалттай');
      // Pressed anyway: no review, no way on to a sign-in that would end at «хаалттай».
      const gone = departures(stall);
      next.click();
      expect(s.getElementById('pay')).toBeNull();
      expect(gone.count).toBe(0);
      expect(await left()).toBe(before);
    } finally {
      ctx.payments = open;
    }
  });

  it('says it at the review somebody comes back to after signing in, and keeps «Төлөх» grey', async () => {
    await ownGuest('+97699005032');
    const id = await fullestStall();
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      // Back from the sign-in with the order kept, the walkthrough's way — and a new account's empty wallet.
      const stall = await openPage('shop.html', `/${id}`);
      stall.window.sessionStorage.setItem(`basu.shop.${id}`, JSON.stringify({ qty: 1, receive: 'pickup', receiveOn: '2099-01-01', review: true }));
      const s = stall.window.document;
      await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
      const pay = s.getElementById('pay') as HTMLButtonElement;
      expect(pay.disabled).toBe(true);
      expect(s.querySelector('.sd-review .sh-closed b')?.textContent).toBe(PAYMENTS_CLOSED);
      expect(s.getElementById('pay-why')?.textContent).toContain('хаалттай');
      // Over the button it is about's foot, where the eye is — not under «Засах».
      expect(pay.compareDocumentPosition(s.getElementById('pay-why')!) & stall.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(s.getElementById('pay-why')!.compareDocumentPosition(s.getElementById('edit')!) & stall.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      pay.click();
      await settled(stall, 'whatever the press asked');
      expect(await ideshOf('+97699005032')).toEqual({ orders: 0, payments: 0 });
    } finally {
      ctx.payments = open;
    }
  });

  it('still sells to a wallet that covers the order while payments are closed, and says it pays from there', async () => {
    await ownGuest('+97699005034');
    const token = storage.getItem('basu.guest')!;
    // Money put into Basu while payments were open.
    await topUp(token, 2_000_000);
    await topUp(token, 2_000_000);
    const id = await fullestStall();
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      const stall = await openPage('shop.html', `/${id}`);
      const s = stall.window.document;
      await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
      expect((s.getElementById('next') as HTMLButtonElement).disabled).toBe(false);
      expect(s.querySelector('#buy .sh-closed')).toBeNull();
      expect(s.querySelector('#buy .sd-wallet')?.textContent).toContain('түрийвч');
      (s.getElementById('next') as HTMLButtonElement).click();
      await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
      expect((s.getElementById('pay') as HTMLButtonElement).disabled).toBe(false);
      const left = departures(stall);
      (s.getElementById('pay') as HTMLButtonElement).click();
      await until(stall, 'the way to the order', () => left.count > 0);
      expect(await ideshOf('+97699005034')).toEqual({ orders: 1, payments: 1 });
    } finally {
      ctx.payments = open;
    }
  });

  it('says how far a wallet short of the order reaches while payments are closed, not only that they are', async () => {
    await ownGuest('+97699005036');
    const token = storage.getItem('basu.guest')!;
    const id = await fullestStall();
    const { listing } = (await (await fetch(`${base}/v1/idesh/listings/${id}`)).json()) as { listing: { price_mnt: number; min_qty: number } };
    // Enough for the least the stall sells, and not one head more.
    for (let left = listing.price_mnt * listing.min_qty + 1000; left > 0; left -= 2_000_000) await topUp(token, Math.min(left, 2_000_000));
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      const stall = await openPage('shop.html', `/${id}`);
      const s = stall.window.document;
      await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
      expect((s.getElementById('next') as HTMLButtonElement).disabled).toBe(false);
      // One head more than the wallet holds: grey, and the reason says how far the wallet does reach.
      (s.querySelector('.sd-qty [data-d="1"]') as HTMLButtonElement).click();
      expect((s.getElementById('next') as HTMLButtonElement).disabled).toBe(true);
      expect(s.getElementById('next-why')?.textContent).toBe(`Basu түрийвч тань ${listing.min_qty} толгойд л хүрэлцэнэ — онлайн төлбөр хаалттай.`);
      expect(s.querySelector('.sd-dock [data-what]')?.textContent).toBe('Түрийвч хүрэлцэхгүй');
      // Back to what it covers: on again, saying it pays from the wallet.
      (s.querySelector('.sd-qty [data-d="-1"]') as HTMLButtonElement).click();
      expect((s.getElementById('next') as HTMLButtonElement).disabled).toBe(false);
      expect(s.querySelector('#buy .sd-wallet')?.textContent).toContain('түрийвч');
    } finally {
      ctx.payments = open;
    }
  });

  it('keeps the filter bar in its place while the market loads, and draws none for an empty market', async () => {
    storage.removeItem('basu.guest');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const market = await openPage('shop.html', '', (path) => (path === '/v1/idesh/listings' ? held.then(() => fetch(`${base}${path}`)) : undefined));
    const d = market.window.document;
    await until(market, 'the frame of the market', () => Boolean(d.getElementById('sh-bar')));
    // Laid out from the start, its chips as shapes: the cards do not jump down when it fills in.
    expect((d.getElementById('sh-bar') as HTMLElement).hidden).toBe(false);
    expect(d.querySelectorAll('#kinds .s-skel').length).toBeGreaterThan(0);
    // A filter changed before the answer waits for it, rather than calling the market empty.
    (d.getElementById('delivers') as HTMLInputElement).click();
    expect(d.querySelector('#grid .s-empty')).toBeNull();
    release();
    await until(market, 'the cards', () => d.querySelectorAll('.sh-card').length > 0);
    expect(d.querySelectorAll('#kinds .s-skel')).toHaveLength(0);
    expect((d.getElementById('sh-bar') as HTMLElement).hidden).toBe(false);

    const none = await openPage('shop.html', '', (path) =>
      path === '/v1/idesh/listings'
        ? new Response(JSON.stringify({ today: '2026-10-01', payments_open: true, listings: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : undefined,
    );
    await until(none, 'the empty market', (doc) => Boolean(doc.querySelector('#grid .s-empty')));
    expect((none.window.document.getElementById('sh-bar') as HTMLElement).hidden).toBe(true);
  });

  it('says on a whole animal’s card roughly what it weighs and what that makes a kilo', async () => {
    storage.removeItem('basu.guest');
    const { listings } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      listings: Array<{ id: string; unit: string; approx_kg: number; price_mnt: number; min_qty: number }>;
    };
    const market = await openPage('shop.html');
    const d = market.window.document;
    await until(market, 'the cards', () => d.querySelectorAll('.sh-card').length >= listings.length);
    for (const l of listings) {
      const per = d.querySelector(`.sh-card[data-id="${l.id}"] .per`)?.textContent;
      if (l.unit === 'whole') {
        const kilo = Math.round(l.price_mnt / l.approx_kg / 100) * 100;
        expect(per).toBe(`≈${l.approx_kg} кг · ≈${kilo.toLocaleString('mn-MN')}₮/кг`);
      } else {
        expect(per).toBe(`доод тал нь ${l.min_qty} кг`);
      }
    }
    // The photo comes at the width it is shown at; the first is asked for first.
    const first = d.querySelector('.sh-card img') as HTMLImageElement;
    expect(first.getAttribute('srcset')).toMatch(/^\/brand\/meat\/(sheep|goat|beef|horse)-480\.webp 480w, \/brand\/meat\/\1-720\.webp 720w, \/brand\/meat\/\1\.webp 960w$/);
    expect(first.getAttribute('sizes')).toBeTruthy();
    expect(first.getAttribute('fetchpriority')).toBe('high');
    expect(d.querySelectorAll('.sh-card img[fetchpriority]')).toHaveLength(1);
  });

  it('keeps the market’s filter in its address, and «‹ Бүх зар» goes back to it', async () => {
    storage.removeItem('basu.guest');
    const market = await openPage('shop.html', '?kind=beef&delivery=1&sort=cheap');
    const d = market.window.document;
    await until(market, 'the cards', () => d.querySelectorAll('.sh-card').length > 0);
    expect((d.getElementById('delivers') as HTMLInputElement).checked).toBe(true);
    expect((d.getElementById('sort') as HTMLSelectElement).value).toBe('cheap');
    expect([...d.querySelectorAll('.sh-card')].every((c) => c.getAttribute('data-kind') === 'beef')).toBe(true);
    // Another animal keeps the rest of the address.
    (d.querySelector('#kinds [data-kind="all"]') as HTMLButtonElement).click();
    expect(market.window.location.search).toBe('?delivery=1&sort=cheap');
    (d.querySelector('#kinds [data-kind="beef"]') as HTMLButtonElement).click();
    expect(market.window.location.search).toBe('?kind=beef&delivery=1&sort=cheap');

    // A card opened keeps where the market was…
    const card = d.querySelector('.sh-card') as HTMLAnchorElement;
    card.click();
    const kept = market.window.sessionStorage.getItem('basu.shop.back');
    expect(JSON.parse(kept!)).toMatchObject({ url: '/shop?kind=beef&delivery=1&sort=cheap' });

    // …and the stall's crumb goes back there, not to the whole market.
    const stall = await openPage('shop.html', `/${card.getAttribute('data-id')}`);
    stall.window.sessionStorage.setItem('basu.shop.back', kept!);
    await until(stall, 'the stall', (doc) => Boolean(doc.querySelector('.sd-title')));
    expect(stall.window.document.querySelector('.s-crumb')?.getAttribute('href')).toBe('/shop?kind=beef&delivery=1&sort=cheap');
    expect(stall.window.document.querySelector('.s-crumb')?.textContent).toBe('Бүх зар');
    // Anything else kept there is never followed.
    const odd = await openPage('shop.html', `/${card.getAttribute('data-id')}`);
    odd.window.sessionStorage.setItem('basu.shop.back', JSON.stringify({ url: 'https://elsewhere.example/', y: 0 }));
    await until(odd, 'the stall', (doc) => Boolean(doc.querySelector('.sd-title')));
    expect(odd.window.document.querySelector('.s-crumb')?.getAttribute('href')).toBe('/shop');
  });

  it('reads the courier’s number back the way people read it, on the review', async () => {
    storage.removeItem('basu.guest');
    const { listings } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      listings: Array<{ id: string; delivers: boolean; remaining: number }>;
    };
    const delivering = listings.find((l) => l.delivers && l.remaining > 0)!;
    const stall = await openPage('shop.html', `/${delivering.id}`);
    const s = stall.window.document;
    await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
    (s.querySelector('.sd-way[data-r="delivery"]') as HTMLButtonElement).click();
    const type = (id: string, value: string) => {
      const input = s.getElementById(id) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new stall.window.Event('input', { bubbles: true }));
    };
    type('address', 'Баянзүрх дүүрэг, 26-р хороо, 15-р байр, 48 тоот');
    type('phone', '99112233');
    // Grouped as it is typed, after the +976 in front of it.
    expect((s.getElementById('phone') as HTMLInputElement).value).toBe('9911 2233');
    (s.getElementById('next') as HTMLButtonElement).click();
    await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
    expect(s.querySelector('.sd-review')?.textContent).toContain('+976 9911 2233');
    expect(s.querySelector('.sd-review')?.textContent).not.toContain('99112233');
  });

  it('shows the market as cards, filters it, and orders from a stall', async () => {
    await ownGuest('+97699005002');
    const token = storage.getItem('basu.guest')!;
    const shop = await openPage('shop.html');
    const d = shop.window.document;
    await until(shop, 'the cards', () => d.querySelectorAll('.sh-card').length >= seeded.listings);
    // The account is in the corner, by name or number — the number the way people read it.
    await until(shop, 'the account', () => Boolean(d.querySelector('.s-acct')));
    expect(d.querySelector('.s-acct')?.textContent).toContain('+976 9900 5002');

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

  /**
   * A stall's page with the order as it opens — one whole animal, collected,
   * on the first day — looked over, as far as «Төлөх»: at `listing`, or at
   * the stall with the most left.
   */
  async function reviewAtStall(respond?: Parameters<typeof openPage>[2], listing?: string): Promise<JSDOM> {
    const stall = await openPage('shop.html', `/${listing ?? (await fullestStall())}`, respond);
    const s = stall.window.document;
    await until(stall, 'the order form', () => Boolean(s.getElementById('next')));
    (s.getElementById('next') as HTMLButtonElement).click();
    await until(stall, 'the review', () => Boolean(s.getElementById('pay')));
    return stall;
  }

  it('sells one animal when the answer to the order is lost and «Төлөх» is pressed again', async () => {
    await ownGuest('+97699005004');
    const network = losingOne(makingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);

    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));
    // In words the person reads, not the browser's «Failed to fetch».
    expect(s.getElementById('pay-error')?.textContent).toBe(CONNECTION_LOST);
    // Pressed twice, in a hurry: still one press.
    pay().click();
    pay().click();
    await until(stall, 'the way to the order', () => left.count > 0);

    // One attempt, and the press after the lost answer went under its key:
    // the order the server had made, paid for once.
    expectOneAttempt(await keysKept());
    expect(await ideshOf('+97699005004')).toEqual({ orders: 1, payments: 1 });
  });

  it('takes a «Төлөх» whose answer was lost for the payment it made, and goes to the order', async () => {
    await ownGuest('+97699005005');
    const network = losingOne(payingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);

    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));
    pay().click();
    // Not «the state has changed» under a button to pay again: the payment it
    // made, and the way on to the order.
    await until(stall, 'the way to the order', () => left.count > 0);
    expect(s.getElementById('pay-error')?.textContent).toBe('');
    expectOneAttempt(await keysKept());
    expect(await ideshOf('+97699005005')).toEqual({ orders: 1, payments: 1 });
  });

  it('goes to the animal bought when the server kept no answer to the lost «Төлөх» either', async () => {
    await ownGuest('+97699005009');
    const network = losingOne(payingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);
    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));

    // Nothing to hand the retry back: the order is simply paid for already.
    await forgetAnswers('/pay$');
    pay().click();
    await until(stall, 'the way to the order', () => left.count > 0);
    expect(await ideshOf('+97699005009')).toEqual({ orders: 1, payments: 1 });
  });

  it('goes to the animal a lost «Төлөх» bought, rather than selling a changed order beside it', async () => {
    await ownGuest('+97699005007');
    const network = losingOne(payingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);
    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));

    // The failure is taken for a failure, and the order changed: two animals.
    (s.getElementById('edit') as HTMLButtonElement).click();
    (s.querySelector('.sd-qty [data-d="1"]') as HTMLButtonElement).click();
    (s.getElementById('next') as HTMLButtonElement).click();
    pay().click();

    // The first was paid for: the way goes to it, and nothing is sold beside it.
    await until(stall, 'the way to the order', () => left.count > 0);
    expect(await ideshOf('+97699005007')).toEqual({ orders: 1, payments: 1 });
  });

  it('starts afresh when the order a lost answer made has lapsed unpaid', async () => {
    await ownGuest('+97699005008');
    const network = losingOne(makingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);
    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));

    // Half an hour on, the draft that answer was about has given its animal
    // back. Pressed again, the attempt finds its order lapsed and ends; the
    // press after that is a new attempt, not the lapsed order handed back.
    await lapseDrafts('+97699005008');
    pay().click();
    await until(stall, 'the lapsed order', () => !pay().hasAttribute('data-busy'));
    pay().click();
    await until(stall, 'the way to the order', () => left.count > 0);
    expect(await ideshOf('+97699005008')).toEqual({ orders: 2, payments: 1 });
  });

  it('sells a second animal to somebody who comes back from the first and buys the same again', async () => {
    await ownGuest('+97699005006');
    const stall = await reviewAtStall();
    const s = stall.window.document;
    const left = departures(stall);
    (s.getElementById('pay') as HTMLButtonElement).click();
    await until(stall, 'the way to the first order', () => left.count === 1);

    // Back from the order, a browser shows this page as it was left. The same
    // animal, the same way, on the same day, looked over and paid for again,
    // is a second one somebody meant.
    (s.getElementById('edit') as HTMLButtonElement).click();
    (s.getElementById('next') as HTMLButtonElement).click();
    await until(stall, 'the review again', () => Boolean(s.getElementById('pay')));
    (s.getElementById('pay') as HTMLButtonElement).click();
    await until(stall, 'the way to the second order', () => left.count === 2);
    expect(await ideshOf('+97699005006')).toEqual({ orders: 2, payments: 2 });
  });

  it('sells one animal when a changed order is paid for while the first press is still on its way', async () => {
    await ownGuest('+97699005010');
    const network = holdingOne(makingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);

    pay().click();
    // The order is made at the server and its answer is slow in coming. The
    // person does not wait for it: back to the form, one more, and «Төлөх».
    await network.answered;
    (s.getElementById('edit') as HTMLButtonElement).click();
    (s.querySelector('.sd-qty [data-d="1"]') as HTMLButtonElement).click();
    (s.getElementById('next') as HTMLButtonElement).click();
    pay().click();
    network.release();

    // The second press waited for the first, and the animal the first bought
    // is the one bought: both presses go to it.
    await until(stall, 'the way to the order, from both presses', () => left.count === 2);
    expect(await ideshOf('+97699005010')).toEqual({ orders: 1, payments: 1 });
  });

  it('sells one animal when «Төлөх» is pressed again while the first is held up at the server', async () => {
    await ownGuest('+97699005011');
    const listing = await fullestStall();
    const stall = await reviewAtStall(undefined, listing);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);

    const other = await busyStall(listing);
    try {
      pay().click();
      expect(await mostWaiting(1, PATIENCE), 'the first press, waiting at the server').toBe(1);
      // The same order, looked over again and pressed for, under the same key:
      // with nothing kept for it yet, a second request would make a second order.
      (s.getElementById('edit') as HTMLButtonElement).click();
      (s.getElementById('next') as HTMLButtonElement).click();
      pay().click();
      expect(await mostWaiting(2, 1500), 'requests waiting at the server').toBe(1);
    } finally {
      await other.done();
    }
    await until(stall, 'the way to the order, from both presses', () => left.count === 2);
    expect(await ideshOf('+97699005011')).toEqual({ orders: 1, payments: 1 });
  });

  it('goes to the animal a lost «Төлөх» bought when the server kept no answer to making it either', async () => {
    await ownGuest('+97699005012');
    const network = losingOne(payingIdesh);
    const stall = await reviewAtStall(network.respond);
    const s = stall.window.document;
    const pay = () => s.getElementById('pay') as HTMLButtonElement;
    const left = departures(stall);
    pay().click();
    await until(stall, '«Төлөх» again, after the lost answer', () => network.lost && !pay().hasAttribute('data-busy'));

    // A day on, or a store that failed: the order's own key has nothing to
    // hand back, and the order it made is known — and paid for.
    await forgetAnswers('^/v1/idesh$');
    pay().click();
    await until(stall, 'the way to the order', () => left.count > 0);
    expect(await ideshOf('+97699005012')).toEqual({ orders: 1, payments: 1 });
  });

  it('says on the order it hands over to when that order is the one from before a change', async () => {
    await ownGuest('+97699005013');
    const stall = await reviewAtStall();
    const left = departures(stall);
    (stall.window.document.getElementById('pay') as HTMLButtonElement).click();
    await until(stall, 'the way to the order', () => left.count > 0);
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT o.id FROM idesh.idesh_order o JOIN identity.guest g ON g.id = o.guest_id WHERE g.phone_e164 = $1`,
      ['+97699005013'],
    );

    // Handed over as bought, the order's page says the payment went through…
    const bought = await openPage('orders.html', `/${rows[0]!.id}?new=1`);
    await until(bought, 'the word on it', (d) => d.querySelector('.od-new b')?.textContent === 'Төлбөр амжилттай');
    // …and handed over as the order before a change, it says that instead:
    // the person looked over another quantity a moment ago.
    const earlier = await openPage('orders.html', `/${rows[0]!.id}?new=1&earlier=1`);
    await until(earlier, 'the word on it', (d) => d.querySelector('.od-new b')?.textContent === EARLIER_ORDER);
    expect(earlier.window.location.search).toBe('');
  });

  it('keeps the person signed in, and the popup open, when the refund’s account comes with a wrong password', async () => {
    // Somebody with a password buys a whole animal, and its supplier cancels it: the refund waits for an account.
    await ownGuest('+97699005014');
    const token = storage.getItem('basu.guest')!;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const { listing, today } = (await (await fetch(`${base}/v1/idesh/listings/${await fullestStall()}`)).json()) as {
      listing: { id: string; ready_from: string };
      today: string;
    };
    const made = (await (
      await fetch(`${base}/v1/idesh`, {
        method: 'POST',
        headers: { ...auth, 'idempotency-key': 'refund-wrong-password' },
        body: JSON.stringify({ listing_id: listing.id, qty: 1, receive: 'pickup', receive_on: listing.ready_from > today ? listing.ready_from : today }),
      })
    ).json()) as { id: string };
    const paid = await fetch(`${base}/v1/idesh/${made.id}/pay`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(paid.status, await paid.text()).toBe(200);
    const { rows } = await getPool().query<{ seller: string }>(
      `SELECT g.phone_e164 AS seller FROM idesh.idesh_order o
         JOIN idesh.supplier s ON s.id = o.supplier_id JOIN identity.guest g ON g.id = s.owner_guest_id
        WHERE o.id = $1`,
      [made.id],
    );
    const asSeller = { 'content-type': 'application/json', authorization: `Bearer ${await devLogin(rows[0]!.seller, 'Нийлүүлэгч')}` };
    const cancelled = await fetch(`${base}/v1/supplier/orders/${made.id}/cancel`, { method: 'POST', headers: asSeller, body: JSON.stringify({ reason: 'guest_asked' }) });
    expect(cancelled.status, await cancelled.text()).toBe(200);

    const page = await openPage('orders.html', `/${made.id}`);
    const d = page.window.document;
    await until(page, 'the way to give an account', () => Boolean(d.querySelector('[data-account]')));
    (d.querySelector('[data-account]') as HTMLElement).click();
    await answerPopup(page, { bank: 'Хаан банк', account: '5012345678', holder: 'Туршилт Хүн', password: 'буруу нууц үг' });
    const sheet = () => d.querySelector('.sheet.popup[data-open]') as HTMLElement | null;
    const typed = () => sheet()?.querySelector('[name="password"]') as HTMLInputElement | null;
    await until(page, 'the refusal under the password', () => typed()?.getAttribute('aria-invalid') === 'true');
    // Said under the field it was typed in — not over the bank's name at the top of the popup.
    expect(typed()!.closest('.field')?.querySelector('.help[data-error]')?.textContent).toBe('Нууц үг буруу байна.');
    expect((sheet()!.querySelector('.popup-error') as HTMLElement).hidden).toBe(true);
    // A typo in the password is not a session that ended: still signed in, still here, the popup open for another try.
    expect(storage.getItem('basu.guest')).toBe(token);
    expect(d.querySelector('.sheet.popup[data-open]')).not.toBeNull();

    // The right one keeps the account, and the order says where the money goes.
    await answerPopup(page, { password: GUEST_PASSWORD });
    await until(page, 'the account on the order', () => !d.querySelector('[data-account]') && (d.querySelector('.od-refund')?.textContent ?? '').includes('5012345678'));
    expect(storage.getItem('basu.guest')).toBe(token);
  });
});

describe('өвлийн идэш', () => {
  /**
   * Buy one whole animal, collected, on the first day it exists: at `stall`,
   * or at the first that has any left.
   */
  async function buyOne(dom: JSDOM, stall?: string): Promise<string> {
    const title = await chooseOne(dom, stall);
    (dom.window.document.querySelector('#pay') as HTMLElement).click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    return title;
  }

  /** The same, as far as its Pay button: chosen, and the order looked over. */
  async function chooseOne(dom: JSDOM, stall?: string): Promise<string> {
    await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    const whole = [...dom.window.document.querySelectorAll('.listing')].find((l) =>
      stall ? l.getAttribute('data-id') === stall : !l.hasAttribute('data-gone') && l.textContent?.includes('бүтэн'),
    ) as HTMLElement;
    whole.click();
    await until(dom, 'the stall screen', (d) => Boolean(d.querySelector('#next')));
    const title = dom.window.document.querySelector('#screen-title')?.textContent ?? '';
    // Collected, on the day it is ready — the form's own defaults.
    expect(dom.window.document.querySelector('.choice[data-r="pickup"]')?.getAttribute('aria-checked')).toBe('true');
    expect((dom.window.document.querySelector('#when') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A pickup has three questions — how much, how it arrives, when — and a stall that offers a задаргаа asks one more.
    expect(dom.window.document.querySelectorAll('.step:not(#step-breakdown)').length).toBe(3);
    const next = dom.window.document.querySelector('#next') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    // One verb for starting an order, as on the website.
    expect(next.textContent).toBe('Захиалах');
    // The photo is Basu's, not this supplier's meat, and says so.
    expect(dom.window.document.querySelector('.hero .sample')?.textContent).toBe('Жишээ зураг');
    next.click();
    // Nothing is charged before the person has seen the whole order once.
    await until(dom, 'the review', (d) => Boolean(d.querySelector('#pay')));
    expect(dom.window.document.querySelector('.review .total b')?.textContent).toMatch(/₮$/);
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

  it('says the connection is lost rather than waiting for ever, and draws the stalls once it is back', async () => {
    storage.removeItem('basu.guest');
    let down = true;
    const dom = await openPage('idesh.html', '', (path) =>
      down && path === '/v1/idesh/listings' ? Promise.reject(new TypeError('Failed to fetch')) : undefined,
    );
    const d = dom.window.document;
    await until(dom, 'the failure, said', () => d.getElementById('blank')?.getAttribute('data-kind') === 'offline' && !(d.getElementById('blank') as HTMLElement).hidden);
    expect(text(dom)).toContain('Холболт тасарлаа');
    // Not a skeleton waiting for an answer that is not coming.
    expect(d.querySelector('#listings[aria-busy="true"]')).toBeNull();
    expect(d.querySelector('#blank [data-home]')).toBeTruthy();

    down = false;
    (d.querySelector('#blank [data-retry]') as HTMLElement).click();
    await until(dom, 'the stalls', () => d.querySelectorAll('.listing').length >= seeded.listings);
    expect((d.getElementById('blank') as HTMLElement).hidden).toBe(true);
  });

  it('says plainly when nothing is on sale, and draws no filter that filters nothing', async () => {
    storage.removeItem('basu.guest');
    const market = (listings: unknown[]) =>
      new Response(JSON.stringify({ today: '2026-10-01', listings }), { status: 200, headers: { 'content-type': 'application/json' } });
    const empty = await openPage('idesh.html', '', (path) => (path === '/v1/idesh/listings' ? market([]) : undefined));
    const d = empty.window.document;
    await until(empty, 'the empty market', () => d.getElementById('blank')?.getAttribute('data-kind') === 'none' && !(d.getElementById('blank') as HTMLElement).hidden);
    expect(text(empty)).toContain('Одоогоор зар алга');
    expect((d.getElementById('kinds') as HTMLElement).hidden).toBe(true);
    // What happens after a purchase is said even while there is nothing to buy.
    expect((d.getElementById('how') as HTMLElement).hidden).toBe(false);

    // Two stalls of one kind — production's market: a list, and no «Бүгд» over it.
    const { listings } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as { listings: Array<{ kind: string }> };
    const beef = listings.filter((l) => l.kind === 'beef').slice(0, 2);
    const two = await openPage('idesh.html', '', (path) => (path === '/v1/idesh/listings' ? market(beef) : undefined));
    await until(two, 'two stalls', (doc) => doc.querySelectorAll('.listing').length === 2);
    expect((two.window.document.getElementById('kinds') as HTMLElement).hidden).toBe(true);
    expect(two.window.document.querySelector('#tally')?.textContent).toMatch(/^2 зар · \d+ гэрээт нийлүүлэгч$/);
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

    // One stall's listings of the same animal do not all wear one picture: each has its own of the
    // example photographs — a file that is there — and no two of them the same, while there are enough.
    const worn = new Map<string, string[]>();
    for (const row of dom.window.document.querySelectorAll('.listing')) {
      const src = row.querySelector('.art img')?.getAttribute('src') ?? '';
      expect(src).toMatch(/^\/idesh\/(sheep|goat|beef|horse)(-[2-7])?\.jpg$/);
      await expect(readFile(join(WEB, src))).resolves.toBeTruthy();
      const stall = `${row.querySelector('.from')?.textContent} ${src.replace(/(-\d)?\.jpg$/, '')}`;
      worn.set(stall, [...(worn.get(stall) ?? []), src]);
    }
    for (const [stall, photos] of worn) expect(new Set(photos).size, stall).toBe(Math.min(photos.length, 4));
    for (const row of dom.window.document.querySelectorAll('.listing')) {
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
    // Right after paying the supplier has not started: the step ahead waits for them, it does not say «Бэлтгэж байна».
    const ahead = dom.window.document.querySelector('.timeline li[data-next]');
    expect(ahead?.textContent).toContain('Нийлүүлэгч бэлтгэхийг хүлээж байна');
    expect(ahead?.textContent).not.toContain('Бэлтгэж байна');
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

  it('asks how the animal is taken apart where the stall offers it, charges the cutting, and tells the supplier', async () => {
    await ownGuest('+97699004077');
    const { listings } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      listings: Array<{ id: string; price_mnt: number; remaining: number; breakdown: { cut_fee_mnt: number; styles: Array<{ id: string }> } | null }>;
    };
    // A stall that offers every way, and charges for the knife.
    const stall = listings.find((l) => l.remaining > 0 && l.breakdown?.styles.length === 3 && l.breakdown.cut_fee_mnt > 0)!;
    const fee = stall.breakdown!.cut_fee_mnt;

    const dom = await openPage('idesh.html');
    const d = dom.window.document;
    await until(dom, 'the stalls', () => d.querySelectorAll('.listing').length >= seeded.listings);
    (d.querySelector(`.listing[data-id="${stall.id}"]`) as HTMLElement).click();
    await until(dom, 'the breakdown step', () => Boolean(d.querySelector('#step-breakdown .bd-way')));

    // Jointed until the guest says otherwise — the way it was handed over before there was a question — and no fee.
    const chosen = () => d.querySelector('.bd-way[aria-checked="true"]')?.getAttribute('data-way');
    const sum = () => d.querySelector('#screen-foot .sum')?.textContent ?? '';
    expect([...d.querySelectorAll('.bd-way')].map((w) => w.getAttribute('data-way'))).toEqual(['carcass', 'jointed', 'cut', 'custom']);
    expect(chosen()).toBe('jointed');
    expect((d.querySelector('.bd-parts') as HTMLElement).hidden).toBe(true);
    expect(sum()).not.toContain('жижиглэх');
    expect(sum()).toContain(stall.price_mnt.toLocaleString('mn-MN'));

    // Part by part: the legs stay whole, the ribs are cut small — and the knife has its price.
    (d.querySelector('.bd-way[data-way="custom"]') as HTMLElement).click();
    expect((d.querySelector('.bd-parts') as HTMLElement).hidden).toBe(false);
    expect(d.querySelectorAll('.bd-part')).toHaveLength(6);
    expect(sum()).not.toContain('жижиглэх');
    (d.querySelector('.bd-part[data-part="ribs"] [data-cut="1"]') as HTMLElement).click();
    expect(d.querySelector('.bd-part[data-part="ribs"] [data-cut="1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(d.querySelector('.bd-part[data-part="fore"] [data-cut="0"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(sum()).toContain('жижиглэх');
    expect(sum()).toContain((stall.price_mnt + fee).toLocaleString('mn-MN'));
    const wish = d.querySelector('.bd-note input') as HTMLInputElement;
    wish.value = 'Ууцыг бүтэн үлдээгээрэй';
    wish.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // The whole order once before any money moves: the choice in words, the fee on its own line.
    (d.querySelector('#next') as HTMLElement).click();
    await until(dom, 'the review', () => Boolean(d.querySelector('#pay')));
    const review = d.querySelector('#review-breakdown')?.textContent ?? '';
    expect(review).toContain('Хэсгээр');
    expect(review).toContain('Жижиглэнэ: хавирга, өвчүү.');
    expect(review).toContain('«Ууцыг бүтэн үлдээгээрэй»');
    expect([...d.querySelectorAll('.review .r')].some((r) => r.textContent?.startsWith('Жижиглэх'))).toBe(true);

    (d.querySelector('#pay') as HTMLElement).click();
    await until(dom, 'the status', () => Boolean(d.querySelector('.handcode b')));
    expect(d.querySelector('#order-breakdown')?.textContent).toContain('Хэсгээр');
    expect(d.querySelector('#order-breakdown')?.textContent).toContain('«Ууцыг бүтэн үлдээгээрэй»');

    const code = d.querySelector('.handcode b')!.textContent!;
    const { rows } = await getPool().query<{ breakdown: string; cut_parts: string[]; breakdown_note: string; cut_fee_mnt: string; total_mnt: string }>(
      'SELECT breakdown, cut_parts, breakdown_note, cut_fee_mnt, total_mnt FROM idesh.idesh_order WHERE code = $1',
      [code],
    );
    expect(rows[0]).toMatchObject({ breakdown: 'parts', cut_parts: ['ribs'], breakdown_note: 'Ууцыг бүтэн үлдээгээрэй' });
    expect(Number(rows[0]!.cut_fee_mnt)).toBe(fee);
    expect(Number(rows[0]!.total_mnt)).toBe(stall.price_mnt + fee);

    // The supplier reads it on the order, before the knife.
    const screen = await supplierScreenFor(code);
    await until(screen, 'the order with its breakdown', (doc) => Boolean(doc.querySelector('.ticket .cutup')));
    expect(screen.window.document.querySelector('.ticket .cutup')?.textContent).toContain('Хэсгээр');
  });

  it('shows a supplier’s own photographs of the animal in place of the example, swiped through on its stall', async () => {
    storage.removeItem('basu.guest');
    // A stall with two photographs of its own, put up as its supplier would.
    const { rows } = await getPool().query<{ id: string; supplier_id: string; title: string }>(
      `SELECT l.id, l.supplier_id, l.title FROM idesh.listing l
        WHERE l.active AND l.unit = 'whole' AND l.sold < l.quantity
          AND NOT EXISTS (SELECT 1 FROM idesh.listing_photo p WHERE p.listing_id = l.id)
        ORDER BY l.created_at DESC LIMIT 1`,
    );
    const stall = rows[0]!;
    const jpeg = (fill: number) => ({ type: 'image/jpeg' as const, bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, fill)]) });
    const cover = await addListingPhoto(stall.supplier_id, stall.id, { photo: jpeg(1), thumb: jpeg(1) }, new Date());
    const side = await addListingPhoto(stall.supplier_id, stall.id, { photo: jpeg(2), thumb: jpeg(2) }, new Date());

    const dom = await openPage('idesh.html');
    const d = dom.window.document;
    await until(dom, 'the stalls', () => d.querySelectorAll('.listing').length >= seeded.listings);
    const card = d.querySelector(`.listing[data-id="${stall.id}"]`) as HTMLElement;
    // On the card, the cover's small copy; every other stall still wears an example.
    expect(card.querySelector('.art img')?.getAttribute('src')).toBe(`/v1/idesh/photos/${cover}?size=thumb`);
    expect([...d.querySelectorAll('.listing .art img')].filter((img) => img.getAttribute('src')?.startsWith('/idesh/')).length).toBe(d.querySelectorAll('.listing').length - 1);

    card.click();
    await until(dom, 'the stall', () => Boolean(d.querySelector('#next')));
    // Both photographs, as they are looked at, and where in the row the guest is. They are of this animal: nothing says «Жишээ зураг».
    expect([...d.querySelectorAll('.hero[data-own] .reel img')].map((img) => img.getAttribute('src'))).toEqual([`/v1/idesh/photos/${cover}`, `/v1/idesh/photos/${side}`]);
    expect(d.querySelector('.hero .count')?.textContent).toBe('1/2');
    expect(d.querySelector('.hero')?.textContent).not.toContain('Жишээ зураг');
    expect(d.querySelector('.hero .reel img')?.getAttribute('alt')).toBe(`${stall.title} — 1-р зураг`);

    // The website's stall: the cover large, the two small under it, and the one pressed shown.
    const shop = await openPage('shop.html', `/${stall.id}`);
    await until(shop, 'the website’s stall', (doc) => Boolean(doc.querySelector('#sd-shot')));
    const sd = shop.window.document;
    expect(sd.querySelector('#sd-shot')?.getAttribute('src')).toBe(`/v1/idesh/photos/${cover}`);
    expect(sd.querySelector('.sd-photo figcaption')).toBeNull();
    expect(sd.querySelectorAll('.sd-shots button')).toHaveLength(2);
    (sd.querySelector('.sd-shots button[data-shot="1"]') as HTMLElement).click();
    expect(sd.querySelector('#sd-shot')?.getAttribute('src')).toBe(`/v1/idesh/photos/${side}`);
    expect(sd.querySelector('.sd-shots button[data-shot="1"]')?.getAttribute('aria-pressed')).toBe('true');

    // Left as it was found: later tests count on the seed's stalls.
    await getPool().query('DELETE FROM idesh.listing_photo WHERE listing_id = $1', [stall.id]);
  });

  it('pays in the app’s own sheet where the app can, and tells it once the animal is bought', async () => {
    await ownGuest('+97699004011');
    const open = ctx.payments;
    const hosted = new HostedFakePaymentProvider();
    ctx.payments = hosted;
    try {
      const posted: Array<{ type: string; invoice?: { amount_mnt: number; qpay: { qr: string; banks: Array<{ link: string }> } } }> = [];
      const dom = await openPage('idesh.html', '', undefined, storage, undefined, undefined, (window) => {
        Object.assign(window, { webkit: { messageHandlers: { basu: { postMessage: (m: never) => posted.push(m) } } }, __basuPays: true });
      });
      await chooseOne(dom);
      (dom.window.document.querySelector('#pay') as HTMLElement).click();
      await until(dom, 'the invoice handed to the app', () => posted.some((m) => m.type === 'pay'));
      const handed = posted.find((m) => m.type === 'pay')!.invoice!;
      // QPay's QR and bank apps for the app to draw — no page was raised, none opened.
      expect(handed.qpay.qr).toMatch(/^BASU-DEMO:/);
      expect(handed.qpay.banks[0]!.link).toMatch(/^basu-demo:\/\/pay\//);
      expect(handed.amount_mnt).toBeGreaterThan(0);
      expect(dom.window.location.pathname).toBe('/idesh');
      // The page's own way back to it opens the sheet again, rather than a page.
      expect(dom.window.document.querySelector('#qpay-open')?.tagName).toBe('BUTTON');

      hosted.pay(hosted.authorized.at(-1)!, clock.now());
      // «Төлсөн, шалгах» in the app's sheet asks through the page.
      (dom.window as unknown as { __basuCheckPay: () => void }).__basuCheckPay();
      await until(dom, 'the order bought', (d) => Boolean(d.querySelector('.status')));
      expect(posted.at(-1)?.type === 'paid' || posted.some((m) => m.type === 'paid')).toBe(true);
    } finally {
      ctx.payments = open;
    }
  });

  it('says payments are closed on the stall, before any sign-in, and greys «Захиалах» with the reason', async () => {
    storage.removeItem('basu.guest');
    const id = await fullestStall();
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      const dom = await openPage('idesh.html');
      const d = dom.window.document;
      await until(dom, 'the stalls', () => Boolean(d.querySelector(`.listing[data-id="${id}"]`)));
      (d.querySelector(`.listing[data-id="${id}"]`) as HTMLElement).click();
      await until(dom, 'the stall screen', () => Boolean(d.querySelector('#next')));
      expect(d.querySelector('#closed b')?.textContent).toBe(PAYMENTS_CLOSED);
      expect(d.querySelector('#closed a[href="mailto:basuappmn@gmail.com"]')).toBeTruthy();
      expect((d.querySelector('#next') as HTMLButtonElement).disabled).toBe(true);
      expect(d.querySelector('#screen-foot .why')?.textContent).toBe('Онлайн төлбөр хаалттай');
      // Nobody was asked to sign in on the way to being told.
      expect(storage.getItem('basu.guest')).toBeNull();
      expect(d.querySelector('#pay')).toBeNull();
    } finally {
      ctx.payments = open;
    }
  });

  it('sells from a wallet that covers the order while payments are closed, and says that is where it pays from', async () => {
    await ownGuest('+97699004032');
    const token = storage.getItem('basu.guest')!;
    await topUp(token, 2_000_000);
    await topUp(token, 2_000_000);
    const id = await fullestStall();
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      const dom = await openPage('idesh.html');
      const d = dom.window.document;
      await until(dom, 'the stalls', () => Boolean(d.querySelector(`.listing[data-id="${id}"]`)));
      (d.querySelector(`.listing[data-id="${id}"]`) as HTMLElement).click();
      await until(dom, 'the stall screen', () => Boolean(d.querySelector('#next')));
      expect(d.querySelector('#closed')).toBeNull();
      (d.querySelector('#next') as HTMLButtonElement).click();
      await until(dom, 'the review', () => Boolean(d.querySelector('#pay')));
      // No QPay to fall back on: the wallet, and only the wallet.
      expect(d.querySelector('#screen-foot .sum span')?.textContent).toBe('Түрийвчнээс');
      (d.querySelector('#pay') as HTMLButtonElement).click();
      await until(dom, 'the status', () => Boolean(d.querySelector('.status')));
      expect(d.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    } finally {
      ctx.payments = open;
    }
  });

  it('sells one animal when the answer to the order is lost and Pay is tapped again', async () => {
    await ownGuest('+97699004016');
    const network = losingOne(makingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;

    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);
    // In words the guest reads, not the browser's «Failed to fetch» — and
    // above the button it is about, not in a toast lying over that button.
    expect(dom.window.document.querySelector('#screen-foot .why[data-tone="stop"]')?.textContent).toBe(CONNECTION_LOST);
    expect(dom.window.document.getElementById('toast')?.hasAttribute('data-show') ?? false).toBe(false);
    // Tapped twice, in a hurry: still one tap.
    pay().click();
    pay().click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));

    // One attempt, and the tap after the lost answer went under its key: the
    // order the server had made, paid for once.
    expectOneAttempt(await keysKept());
    expect(await ideshOf('+97699004016')).toEqual({ orders: 1, payments: 1 });
  });

  it('says payments are closed above «Захиалах» to a guest whose wallet is short, and sets nothing aside', async () => {
    await ownGuest('+97699004031');
    const id = await fullestStall();
    const left = async () => ((await (await fetch(`${base}/v1/idesh/listings/${id}`)).json()) as { listing: { remaining: number } }).listing.remaining;
    const before = await left();
    // Production with no payment provider, and a new account's empty wallet.
    const open = ctx.payments;
    ctx.payments = new ClosedPaymentProvider();
    try {
      const dom = await openPage('idesh.html');
      const d = dom.window.document;
      await until(dom, 'the stalls', () => Boolean(d.querySelector(`.listing[data-id="${id}"]`)));
      (d.querySelector(`.listing[data-id="${id}"]`) as HTMLElement).click();
      await until(dom, 'the stall screen', () => Boolean(d.querySelector('#next')));
      // Said on the stall, before a question is answered — not at «Төлөх».
      expect(d.querySelector('#closed b')?.textContent).toBe(PAYMENTS_CLOSED);
      const next = d.querySelector('#next') as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      const why = d.querySelector('#screen-foot .why');
      expect(why?.textContent).toBe('Онлайн төлбөр хаалттай');
      expect(why!.compareDocumentPosition(next) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // More of it is no nearer: the reason stays, the button stays grey.
      (d.querySelector('#step-qty [data-d="1"]') as HTMLButtonElement).click();
      expect((d.querySelector('#next') as HTMLButtonElement).disabled).toBe(true);
      next.click();
      expect(d.querySelector('#pay')).toBeNull();
      expect(await left()).toBe(before);
      expect(await ideshOf('+97699004031')).toEqual({ orders: 0, payments: 0 });
    } finally {
      ctx.payments = open;
    }
  });

  it('takes a Pay whose answer was lost for the payment it made, and shows the order', async () => {
    await ownGuest('+97699004017');
    const network = losingOne(payingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;

    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);
    pay().click();
    // Not «the state has changed» in front of a Pay button: the payment it
    // made, and the order.
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expectOneAttempt(await keysKept());
    expect(await ideshOf('+97699004017')).toEqual({ orders: 1, payments: 1 });
  });

  it('shows the animal bought when the server kept no answer to the lost Pay either', async () => {
    await ownGuest('+97699004022');
    const network = losingOne(payingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);

    // Nothing to hand the retry back: the order is simply paid for already.
    await forgetAnswers('/pay$');
    pay().click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expect(await ideshOf('+97699004022')).toEqual({ orders: 1, payments: 1 });
  });

  it('shows the animal a lost Pay bought, rather than selling a changed order beside it', async () => {
    await ownGuest('+97699004020');
    const network = losingOne(payingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const d = dom.window.document;
    const pay = () => d.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);

    // The failure is taken for a failure, and the order changed: two animals.
    (d.getElementById('screen-back') as HTMLElement).click();
    await until(dom, 'the form again', (doc) => Boolean(doc.querySelector('#step-qty [data-d="1"]')));
    (d.querySelector('#step-qty [data-d="1"]') as HTMLButtonElement).click();
    (d.querySelector('#next') as HTMLButtonElement).click();
    await until(dom, 'the review again', () => Boolean(pay()) && !pay().disabled);
    pay().click();

    // The first was paid for: it is the one shown, and nothing is sold beside
    // it. The guest looked over two a moment ago, and is told why it is one.
    await until(dom, 'the status', (doc) => Boolean(doc.querySelector('.status')));
    await until(dom, 'the word about it', (doc) => doc.getElementById('toast')?.textContent === `${EARLIER_ORDER}.`);
    expect(d.querySelector('#screen-sub')?.textContent).toMatch(/×1$/);
    expect(await ideshOf('+97699004020')).toEqual({ orders: 1, payments: 1 });
  });

  it('starts afresh when the order a lost answer made has lapsed unpaid', async () => {
    await ownGuest('+97699004021');
    const network = losingOne(makingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const d = dom.window.document;
    const pay = () => d.querySelector('#pay') as HTMLButtonElement | null;
    pay()!.click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay()!.disabled);

    // Half an hour on, the draft that answer was about has given its animal
    // back. Tapped again, the attempt finds its order lapsed and ends; the
    // tap after that is a new attempt, not the lapsed order handed back.
    await lapseDrafts('+97699004021');
    pay()!.click();
    await until(dom, 'the lapsed order', () => Boolean(pay()) && !pay()!.disabled);
    pay()!.click();
    await until(dom, 'the status', (doc) => Boolean(doc.querySelector('.status')));
    expect(d.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expect(await ideshOf('+97699004021')).toEqual({ orders: 2, payments: 1 });
  });

  it('never sells an animal twice when the look at it fails after it is paid for', async () => {
    await ownGuest('+97699004018');
    // The payment goes through and the first look at the order is lost. Every
    // look after that waits until the test lets it through.
    let lost = false;
    let letThrough!: () => void;
    const later = new Promise<void>((resolve) => (letThrough = resolve));
    const dom = await openPage('idesh.html', '', (path, init) => {
      if (!/^\/v1\/idesh\/[0-9a-f-]{36}$/.test(path)) return undefined;
      if (lost) return later.then(() => fetch(new URL(path, base).toString(), init));
      lost = true;
      return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message_mn: 'Сүлжээ тасарлаа.' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'the lost look', (d) => d.getElementById('toast')?.textContent === 'Сүлжээ тасарлаа.');

    // Bought: the review waits for the order and does not offer to sell it again…
    expect(pay().disabled).toBe(true);
    // …and the next look draws the order, as soon as the network lets it.
    letThrough();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(await ideshOf('+97699004018')).toEqual({ orders: 1, payments: 1 });
  });

  it('sells a second animal to a guest who buys the same again once the first is on the screen', async () => {
    await ownGuest('+97699004019');
    const dom = await openPage('idesh.html');
    const d = dom.window.document;
    const stall = await fullestStall();
    await buyOne(dom, stall);
    const first = { what: d.querySelector('#screen-sub')?.textContent, code: d.querySelector('.handcode b')?.textContent };

    // Back to the stalls, and the same animal, the same way, on the same day
    // again: somebody who has seen the first means a second.
    (d.getElementById('screen-back') as HTMLElement).click();
    await until(dom, 'the stalls again', (doc) => !doc.getElementById('screen')?.hasAttribute('data-open'));
    await buyOne(dom, stall);
    expect(d.querySelector('#screen-sub')?.textContent).toBe(first.what);
    expect(d.querySelector('.handcode b')?.textContent).not.toBe(first.code);
    expect(await ideshOf('+97699004019')).toEqual({ orders: 2, payments: 2 });
  });

  it('sells one animal when a changed order is paid for while the first tap is still on its way', async () => {
    await ownGuest('+97699004023');
    const network = holdingOne(makingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const d = dom.window.document;
    const pay = () => d.querySelector('#pay') as HTMLButtonElement;

    pay().click();
    // The order is made at the server and its answer is slow in coming. The
    // guest does not wait for it: back to the form, one more, and Pay.
    await network.answered;
    (d.getElementById('screen-back') as HTMLElement).click();
    await until(dom, 'the form again', (doc) => Boolean(doc.querySelector('#step-qty [data-d="1"]')));
    (d.querySelector('#step-qty [data-d="1"]') as HTMLButtonElement).click();
    (d.querySelector('#next') as HTMLButtonElement).click();
    await until(dom, 'the review again', () => Boolean(pay()) && !pay().disabled);
    pay().click();
    network.release();

    // The second tap waited for the first, and the animal the first bought is
    // the one bought: it is the one shown, and the guest is told why.
    await until(dom, 'the word about it', (doc) => doc.getElementById('toast')?.textContent === `${EARLIER_ORDER}.`);
    expect(d.querySelector('.status')).not.toBeNull();
    expect(d.querySelector('#screen-sub')?.textContent).toMatch(/×1$/);
    expect(await ideshOf('+97699004023')).toEqual({ orders: 1, payments: 1 });
  });

  it('sells one animal when Pay is tapped again while the first is held up at the server', async () => {
    await ownGuest('+97699004024');
    const listing = await fullestStall();
    const dom = await openPage('idesh.html');
    await chooseOne(dom, listing);
    const d = dom.window.document;
    const pay = () => d.querySelector('#pay') as HTMLButtonElement;

    const other = await busyStall(listing);
    try {
      pay().click();
      expect(await mostWaiting(1, PATIENCE), 'the first tap, waiting at the server').toBe(1);
      // Back, on again to the same order, and Pay, under the same key: with
      // nothing kept for it yet, a second request would make a second order.
      (d.getElementById('screen-back') as HTMLElement).click();
      await until(dom, 'the form again', (doc) => Boolean(doc.querySelector('#next')));
      (d.querySelector('#next') as HTMLButtonElement).click();
      await until(dom, 'the review again', () => Boolean(pay()) && !pay().disabled);
      pay().click();
      expect(await mostWaiting(2, 1500), 'requests waiting at the server').toBe(1);
    } finally {
      await other.done();
    }
    await until(dom, 'the status', (doc) => Boolean(doc.querySelector('.status')));
    expect(await ideshOf('+97699004024')).toEqual({ orders: 1, payments: 1 });
  });

  it('shows the animal a lost Pay bought when the guest has had to sign in again since', async () => {
    await ownGuest('+97699004025');
    const network = losingOne(payingIdesh);
    const signIn = signingInAs('+97699004025');
    const dom = await openPage('idesh.html', '', (path, init) => signIn(path) ?? network.respond(path, init));
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);

    // The session ends meanwhile, and the tap after it signs the guest in
    // again: a session the server has kept no answer for.
    const before = storage.getItem('basu.guest');
    await endSessions('+97699004025');
    pay().click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(storage.getItem('basu.guest')).not.toBe(before);
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expect(await ideshOf('+97699004025')).toEqual({ orders: 1, payments: 1 });
  });

  it('shows the animal a lost Pay bought when the server kept no answer to making it either', async () => {
    await ownGuest('+97699004026');
    const network = losingOne(payingIdesh);
    const dom = await openPage('idesh.html', '', network.respond);
    await chooseOne(dom, await fullestStall());
    const pay = () => dom.window.document.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);

    // A day on, or a store that failed: the order's own key has nothing to
    // hand back, and the order it made is known — and paid for.
    await forgetAnswers('^/v1/idesh$');
    pay().click();
    await until(dom, 'the status', (d) => Boolean(d.querySelector('.status')));
    expect(dom.window.document.querySelector('.status .big')?.textContent).toBe('Захиалга баталгаажлаа');
    expect(await ideshOf('+97699004026')).toEqual({ orders: 1, payments: 1 });
  });

  it('lets whoever signs in after a lost Pay buy their own, rather than stop at an order not theirs', async () => {
    await ownGuest('+97699004027');
    const network = losingOne(payingIdesh);
    const signIn = signingInAs('+97699004028');
    const dom = await openPage('idesh.html', '', (path, init) => signIn(path) ?? network.respond(path, init));
    await chooseOne(dom, await fullestStall());
    const d = dom.window.document;
    const pay = () => d.querySelector('#pay') as HTMLButtonElement;
    pay().click();
    await until(dom, 'Pay again, after the lost answer', () => network.lost && !pay().disabled);

    // The first guest's session ends, and somebody else signs in on the
    // phone, wanting two. The order the tap before made is not theirs to see.
    await endSessions('+97699004027');
    (d.getElementById('screen-back') as HTMLElement).click();
    await until(dom, 'the form again', (doc) => Boolean(doc.querySelector('#step-qty [data-d="1"]')));
    (d.querySelector('#step-qty [data-d="1"]') as HTMLButtonElement).click();
    (d.querySelector('#next') as HTMLButtonElement).click();
    await until(dom, 'the review again', () => Boolean(pay()) && !pay().disabled);
    pay().click();

    await until(dom, 'the status', (doc) => Boolean(doc.querySelector('.status')));
    expect(d.querySelector('#screen-sub')?.textContent).toMatch(/×2$/);
    expect(await ideshOf('+97699004027')).toEqual({ orders: 1, payments: 1 });
    expect(await ideshOf('+97699004028')).toEqual({ orders: 1, payments: 1 });
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
    expect(dom.window.document.querySelectorAll('.step:not(#step-breakdown)').length).toBe(4);
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
    // Why, asked in a popup over the board: the reason decides the money.
    await until(screen, 'the reasons', (d) => Boolean(d.querySelector('#cancel-order .reasons')));
    const asked = screen.window.document.querySelector('#cancel-order')!;
    const confirm = asked.querySelector('[data-submit]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const pick = asked.querySelector('.reasons input[value="guest_asked"]') as HTMLInputElement;
    pick.checked = true;
    pick.dispatchEvent(new screen.window.Event('change', { bubbles: true }));
    // Before slaughter: everything back, and the popup says so before the press.
    expect(asked.querySelector('.reasons .refund')?.textContent).toContain('бүтнээр');
    expect(confirm.disabled).toBe(false);
    confirm.click();
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
    // The IBAN a bank's app hands out is taken too, in either case — by the
    // rule the server holds every account to; one too short for an IBAN is not.
    type('account', 'mn12 0005 0050 1234 5678');
    expect(send.disabled).toBe(false);
    type('account', 'MN12 0005 0050 1234');
    expect(send.disabled).toBe(true);
    expect(form.querySelector('#refund-why')?.textContent).toContain('MN-ээр эхэлсэн IBAN');
    type('account', '5012 3456 78');
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
    // Starting is the slaughter: the press asks first, and says in money what a cancel leaves from then on.
    await until(screen, 'the question', (d) => Boolean(d.querySelector('#prepare-order[data-open]')));
    const asked = screen.window.document.querySelector('#prepare-order')!;
    expect(asked.textContent).toContain(`№${code}`);
    expect(asked.textContent).toContain('10%');
    expect(asked.textContent).toContain('танд үлдэнэ');
    expect(ticket().getAttribute('data-lane')).toBe('paid');
    (asked.querySelector('[data-submit]') as HTMLElement).click();
    await until(screen, 'the ticket to move', () => ticket()?.getAttribute('data-lane') === 'preparing');

    // The guest's page catches up on its own: the headline moves on, the
    // step is ticked, and the supplier is still the one to ring.
    await until(guest, 'the guest to be told', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'PREPARING');
    expect(guest.window.document.querySelector('.status .big')?.textContent).toBe('Мах бэлтгэгдэж байна');
    expect(guest.window.document.querySelectorAll('.timeline li[data-done]')).toHaveLength(2);
    expect(guest.window.document.querySelector('#screen-foot a[href^="tel:"]')).toBeTruthy();

    // Ready, then handed over. Handing over cannot be taken back, so it asks
    // first — with the code the guest's phone shows, to check against.
    const press = (label: string) =>
      ([...ticket().querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLElement).click();
    // A whole animal has no certificate until it is slaughtered: the supplier writes the shipment's in,
    // and «Бэлэн боллоо» asks which one this meat came with — the guest then reads its number.
    const owner = { authorization: `Bearer ${screen.window.localStorage.getItem('basu.guest')}`, 'content-type': 'application/json' };
    const paper = await fetch(`${base}/v1/supplier/certificates`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ number: `ТЕСТ-${code}`, issuer: 'Сонгинохайрхан дүүргийн мал эмнэлгийн тасаг', issued_on: clock.now().toISOString().slice(0, 10) }),
    });
    expect(paper.status, await paper.clone().text()).toBe(201);
    const { certificate } = (await paper.json()) as { certificate: { id: string } };
    press('Бэлэн боллоо');
    await until(screen, 'the certificate to be asked for', (d) => Boolean(d.querySelector(`#ready-order[data-open] [name="certificate_id"] option[value="${certificate.id}"]`)));
    expect(ticket().getAttribute('data-lane')).toBe('preparing');
    await answerPopup(screen, { certificate_id: certificate.id });
    await until(screen, 'the meat to be ready', () => ticket()?.getAttribute('data-lane') === 'ready');
    expect(ticket().textContent).toContain(`№ТЕСТ-${code}`);
    await until(guest, 'the guest to read the certificate', (d) => d.querySelector('#screen-body')?.textContent?.includes(`№ТЕСТ-${code}`) ?? false);
    expect(guest.window.document.querySelector('#screen-body')?.textContent).toContain('нийлүүлэгчийн оруулсан');
    press('Хүлээлгэн өгсөн');
    await until(screen, 'the code to check', (d) => d.querySelector('#hand-order .hand-code b')?.textContent === code);
    expect(ticket()?.getAttribute('data-lane')).toBe('ready');
    (screen.window.document.querySelector('#hand-order [data-submit]') as HTMLElement).click();
    await until(screen, 'the ticket to be done', () => !ticket());
    await until(guest, 'the guest to have it', (d) => d.querySelector('.status')?.getAttribute('data-s') === 'HANDED');

    // The day's numbers moved with the work, on the same page: what the server says now, not what it said on opening.
    const asOwner = { authorization: `Bearer ${screen.window.localStorage.getItem('basu.guest')}` };
    const home = (await (await fetch(`${base}/v1/supplier/home`, { headers: asOwner })).json()) as {
      lanes: Record<'paid' | 'preparing' | 'ready' | 'dispatched', number>;
      season: { handed: number };
    };
    const todo = home.lanes.paid + home.lanes.preparing + home.lanes.ready + home.lanes.dispatched;
    await until(screen, 'the numbers to follow', (d) => {
      const figures = [...d.querySelectorAll('#home .kpi b')].map((b) => b.textContent);
      return figures[0] === String(todo) && figures[1] === String(home.season.handed);
    });

    // «When does Basu pay me?» right after it: the order, under what comes next, with the day its payout opens.
    (screen.window.document.querySelector('.tabs button[data-tab="money"]') as HTMLElement).click();
    await until(screen, 'the money on its way', (d) =>
      [...d.querySelectorAll('#coming [data-coming]')].some((r) => r.textContent?.includes(`№${code}`)),
    );
    const coming = [...screen.window.document.querySelectorAll('#coming [data-coming]')].find((r) => r.textContent?.includes(`№${code}`))!;
    expect(coming.textContent).toMatch(/олголт \d+-р сарын \d+-нөөс/);
    expect(coming.querySelector('.chip')?.textContent).toBe('Удахгүй');
    expect(screen.window.document.querySelector('#coming-sum .lab')?.textContent).toBe('Удахгүй олгох');
  });

  it('lets a supplier run their own stall from their screen', async () => {
    const screen = await ownerScreen(seeded.suppliers[0]!.phone);
    // The stall has its own tab now, beside today's work.
    await until(screen, 'the module', (d) => Boolean(d.querySelector('.tabs button[data-tab="stall"]')));
    (screen.window.document.querySelector('.tabs button[data-tab="stall"]') as HTMLElement).click();
    await until(screen, 'the stall', (d) => d.querySelectorAll('.stall .row[data-listing]').length > 0);
    const before = screen.window.document.querySelectorAll('.stall .row[data-listing]').length;
    expect(before).toBeGreaterThan(0);

    // The page only shows the stall; a new listing is a popup from its head.
    (screen.window.document.querySelector('#add') as HTMLElement).click();
    await until(screen, 'the new listing', (d) => d.querySelector('#listing-new h2')?.textContent === 'Шинэ зар нэмэх');
    await answerPopup(screen, { title: 'Хонь, шинэ зар', price_mnt: '400000', approx_kg: '35', quantity: '5', origin: 'Архангай' });

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

  /** The supplier's stall, open, with its «Зар нэмэх» at hand. */
  async function stallOf(phone: string): Promise<JSDOM> {
    const screen = await ownerScreen(phone);
    await until(screen, 'the module', (d) => Boolean(d.querySelector('.tabs button[data-tab="stall"]')));
    (screen.window.document.querySelector('.tabs button[data-tab="stall"]') as HTMLElement).click();
    await until(screen, 'the stall', (d) => Boolean(d.querySelector('.stall .row[data-listing]') && d.querySelector('#add')));
    return screen;
  }
  const rowNamed = (dom: JSDOM, title: string) =>
    [...dom.window.document.querySelectorAll('.stall .row[data-listing]')].find((r) => r.querySelector('.name')?.textContent?.includes(title));
  /**
   * Type into the open popup's fields as a person does — each field hears it
   * changed, so one that was refused takes its word back — without pressing
   * the popup's button.
   */
  const fill = (sheet: Element, values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      const input = sheet.querySelector(`[name="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    }
  };
  /** What the popup says is wrong with one field: the line under that field, where every popup says it. */
  const refusalOf = (sheet: Element, name: string) =>
    sheet.querySelector(`[name="${name}"]`)?.closest('.field')?.querySelector('.help[data-error]')?.textContent ?? null;
  const overTheFields = (sheet: Element) => (sheet.querySelector('.popup-error') as HTMLElement | null)?.hidden === false;

  it('takes a listing’s numbers as typed: a half kilo stays a half, and a count kept in wholes refuses a fraction', async () => {
    const screen = await stallOf(seeded.suppliers[0]!.phone);
    const d = screen.window.document;

    // A weight with a decimal point is that weight, not ten times it; a price
    // grouped in thousands is the thousands.
    (d.querySelector('#add') as HTMLElement).click();
    await answerPopup(screen, { title: 'Хонь, хагас кг', price_mnt: '410 000', approx_kg: '38.5', quantity: '3', origin: 'Төв' });
    await until(screen, 'the new row', (doc) => Boolean(rowNamed(screen, 'Хонь, хагас кг')) && !doc.querySelector('.sheet.popup[data-open]'));
    expect(rowNamed(screen, 'Хонь, хагас кг')!.querySelector('.sub')?.textContent).toContain('~38.5 кг');
    expect(rowNamed(screen, 'Хонь, хагас кг')!.querySelector('.num')?.textContent).toBe('410,000₮толгой бүр');

    // Kilos are sold in whole kilos: «2.5» and «120.5» are refused in words,
    // under the field that is wrong, which is where the cursor goes, and
    // nothing is sent.
    const before = d.querySelectorAll('.stall .row[data-listing]').length;
    (d.querySelector('#add') as HTMLElement).click();
    await until(screen, 'the popup', (doc) => Boolean(doc.querySelector('#listing-new [name="unit"]')));
    const sheet = d.querySelector('#listing-new')!;
    const unit = sheet.querySelector('[name="unit"]') as HTMLSelectElement;
    unit.value = 'kg';
    unit.dispatchEvent(new screen.window.Event('change', { bubbles: true }));
    fill(sheet, { title: 'Үхрийн мах, кг', price_mnt: '24000', min_qty: '2.5', quantity: '120.5', origin: 'Төв' });
    (sheet.querySelector('[data-submit]') as HTMLElement).click();
    await until(screen, 'the minimum refused', () => refusalOf(sheet, 'min_qty') !== null);
    expect(refusalOf(sheet, 'min_qty')).toContain('Доод захиалгыг бүхэл кг-аар бичнэ үү.');
    expect(overTheFields(sheet)).toBe(false);
    expect(d.activeElement?.getAttribute('name')).toBe('min_qty');
    // Typing the minimum again takes its word back.
    fill(sheet, { min_qty: '2' });
    expect(refusalOf(sheet, 'min_qty')).toBeNull();
    expect(sheet.querySelector('[name="min_qty"]')?.hasAttribute('aria-invalid')).toBe(false);
    (sheet.querySelector('[data-submit]') as HTMLElement).click();
    await until(screen, 'the amount refused', () => refusalOf(sheet, 'quantity')?.includes('бүхэл тоогоор') ?? false);
    expect(refusalOf(sheet, 'quantity')).toContain('Хэдэн кг байгааг бүхэл тоогоор бичнэ үү.');
    expect(d.activeElement?.getAttribute('name')).toBe('quantity');
    expect(sheet.querySelector('[name="quantity"]')?.getAttribute('aria-invalid')).toBe('true');
    (sheet.querySelector('[data-cancel]') as HTMLElement).click();
    await until(screen, 'the popup to go', (doc) => !doc.querySelector('.sheet.popup[data-open]'));
    expect(d.querySelectorAll('.stall .row[data-listing]')).toHaveLength(before);
  });

  it('offers delivery only once it is ticked, and then asks what it costs — when adding a listing and when changing one', async () => {
    const screen = await stallOf(seeded.suppliers[0]!.phone);
    const d = screen.window.document;

    // Off until ticked: no fee to type, nothing promised to the whole city.
    (d.querySelector('#add') as HTMLElement).click();
    await until(screen, 'the popup', (doc) => Boolean(doc.querySelector('#listing-new [name="delivers"]')));
    const adding = d.querySelector('#listing-new')!;
    expect((adding.querySelector('[name="delivers"]') as HTMLInputElement).checked).toBe(false);
    expect((adding.querySelector('[name="delivery_fee_mnt"]') as HTMLInputElement).disabled).toBe(true);
    expect((adding.querySelector('[name="delivery_fee_mnt"]')!.closest('.field') as HTMLElement).hidden).toBe(true);
    await answerPopup(screen, { title: 'Хонь, өөрөө авна', price_mnt: '300000', approx_kg: '28', quantity: '4', origin: 'Төв' });
    await until(screen, 'the pick-up listing', (doc) => Boolean(rowNamed(screen, 'Хонь, өөрөө авна')) && !doc.querySelector('.sheet.popup[data-open]'));
    expect(rowNamed(screen, 'Хонь, өөрөө авна')!.querySelector('.sub')?.textContent).toContain('хүргэхгүй');

    // Changing it: a listing that did not deliver has no fee to keep, so
    // ticking delivery asks for one rather than promising it free.
    (rowNamed(screen, 'Хонь, өөрөө авна')!.querySelector('[data-a="edit"]') as HTMLElement).click();
    await until(screen, 'the edit', (doc) => Boolean(doc.querySelector('#listing-edit [name="delivers"]')));
    const editing = d.querySelector('#listing-edit')!;
    const delivers = editing.querySelector('[name="delivers"]') as HTMLInputElement;
    const fee = editing.querySelector('[name="delivery_fee_mnt"]') as HTMLInputElement;
    expect(fee.value).toBe('');
    delivers.checked = true;
    delivers.dispatchEvent(new screen.window.Event('change', { bubbles: true }));
    expect(fee.disabled).toBe(false);
    (editing.querySelector('[data-submit]') as HTMLElement).click();
    await until(screen, 'the fee asked for', () => refusalOf(editing, 'delivery_fee_mnt') !== null);
    expect(refusalOf(editing, 'delivery_fee_mnt')).toContain('Хүргэлтийн төлбөрөө бичнэ үү');
    expect(overTheFields(editing)).toBe(false);
    expect(d.activeElement).toBe(fee);
    fill(editing, { delivery_fee_mnt: '15000' });
    expect(refusalOf(editing, 'delivery_fee_mnt')).toBeNull();
    (editing.querySelector('[data-submit]') as HTMLElement).click();
    await until(screen, 'the delivery kept', (doc) =>
      !doc.querySelector('.sheet.popup[data-open]') && (rowNamed(screen, 'Хонь, өөрөө авна')?.querySelector('.sub')?.textContent?.includes('хүргэлт 15,000₮') ?? false),
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
    // The proved phone travels with the application, so ops can ring — read as a number is read.
    expect(row.textContent).toContain('+976 8801 0011');
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

  it('says a payout account the server would refuse under its own field, before anything is sent', async () => {
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'suppliers');
    await until(desk, 'the way to register one', (d) => Boolean(d.querySelector('#add-supplier')));
    const count = async () => (await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM idesh.supplier')).rows[0]!.n;
    const before = await count();
    (desk.window.document.querySelector('#add-supplier') as HTMLElement).click();
    // Neither an IBAN (MN and 18 digits) nor a plain 6–20 digit number.
    await answerPopup(desk, { name: 'Дансны шалгалт · тест', phone: '9911 0099', address: 'Нарантуул', bank_name: 'Хаан банк', bank_account: 'MN12 3456' });
    const field = () => desk.window.document.querySelector('#new-supplier [name="bank_account"]');
    await until(desk, 'the word under the account', () => field()?.getAttribute('aria-invalid') === 'true');
    expect(field()!.closest('.field')?.querySelector('.help[data-error]')?.textContent).toBe('IBAN бол MN-ээр эхэлсэн 20 тэмдэгт, эсвэл 6–20 оронтой дансны дугаар бичнэ үү.');
    expect(desk.window.document.querySelector('#new-supplier[data-open]')).not.toBeNull();
    expect(await count()).toBe(before);
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
      expect.arrayContaining([expect.stringContaining('нийлүүлэгчийн хүсэлт')]),
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
    // The number reads the way people read it, in the row and on the file; the link still dials it whole.
    expect(row.textContent).toContain('+976 9900 1122');
    (row as HTMLElement).click();
    await until(desk, 'the file', (d) => Boolean(d.querySelector('.detail .facts')));
    const doc = desk.window.document;
    expect(doc.querySelector('.page-head')?.textContent).toContain('+976 9900 1122');
    expect(doc.querySelector('.page-head a.tel')?.getAttribute('href')).toBe('tel:+97699001122');
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

  it('names a lunch’s and an идэш’s state in the one word the guest’s pages, the launcher and the supplier say', async () => {
    // api.js's words (headlineWord, IDESH_STATE), written out on purpose: a word of the desk's own for a
    // state — «Батлагдсан», «Хаагдсан», «Өгсөн» — reads one order as two and fails here.
    const LUNCH: Record<string, string> = {
      PLACED: 'Хүлээгдэж байна', ACCEPTED: 'Баталгаажсан', SCHEDULED: 'Хүлээн авсан', ARMED: 'Хөдлөх цаг', HELD: 'Хүлээж байна',
      FIRED: 'Гал дээр', COOKING: 'Гал дээр', READY: 'Бэлэн', SERVED: 'Үйлчилсэн', RESLOTTED: 'Цаг шилжсэн',
      CLOSED: 'Дууссан', CANCELLED: 'Цуцлагдсан', REFUNDED: 'Буцаасан', REJECTED: 'Татгалзсан', NO_SHOW: 'Ирээгүй',
    };
    const IDESH: Record<string, string> = {
      PAID: 'Төлсөн', PREPARING: 'Бэлтгэж байна', READY: 'Бэлэн', DISPATCHED: 'Замд', HANDED: 'Хүлээлгэн өгсөн',
      CLOSED: 'Дууссан', CANCELLED: 'Цуцлагдсан', REFUNDED: 'Буцаасан',
    };
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    const doc = desk.window.document;
    // The desk's first page drawn: a tab pressed while it still loads would draw its page twice.
    await until(desk, 'the overview', (d) => Boolean(d.querySelector('#now')));
    const said = (list: string) => [...doc.querySelectorAll(`#${list} tbody .pill`)].map((p) => [(p as HTMLElement).dataset['s'], p.textContent]);
    // An идэш's state is a word and its meter (api.js ideshStage): the word is the stage's <b>, the meter says nothing.
    const staged = (list: string) =>
      [...doc.querySelectorAll(`#${list} tbody .stage`)].map((p) => [(p as HTMLElement).dataset['s'], p.querySelector(':scope > b')?.textContent]);

    // Every lunch, going on and over: the demo's history closed some, other tests left some on the fire.
    // A list's first answer lands before another is asked for: the later answer of two in flight is the one drawn.
    const answered = (list: string) => (d: Document) => Boolean(d.querySelector(`#${list} .dt-seg`)) && !d.querySelector(`#${list} tbody tr.dt-skel`);
    await opsTab(desk, 'lunches');
    await until(desk, 'the lunches', answered('lunches'));
    (doc.querySelector('#lunches .dt-seg button[data-v="all"]') as HTMLElement).click();
    await until(desk, 'a lunch that is over', (d) => Boolean(d.querySelector('#lunches tbody .pill[data-s="CLOSED"]')));
    for (const [state, word] of said('lunches')) expect(word, state).toBe(LUNCH[state!]);
    expect(doc.querySelector('#lunches tbody .pill[data-s="CLOSED"]')?.textContent).toBe('Дууссан');

    // An идэш of this test's own, bought and over — closed, as the scheduler closes one a day after the
    // handover — among whatever else is going on.
    await ownGuest('+97699008031');
    const code = await buyPickup(await openPage('idesh.html'));
    await getPool().query(`UPDATE idesh.idesh_order SET state = 'CLOSED', closed_at = now() WHERE code = $1`, [code]);
    await opsTab(desk, 'orders');
    await until(desk, 'the идэш orders', answered('orders'));
    (doc.querySelector('#orders .dt-seg button[data-v="all"]') as HTMLElement).click();
    const ours = () => [...doc.querySelectorAll('#orders tr[data-order]')].find((r) => r.textContent?.includes(`№${code}`));
    await until(desk, 'the идэш that is over', () => Boolean(ours()));
    expect(said('orders')).toEqual([]);
    expect(staged('orders').length).toBeGreaterThan(0);
    for (const [state, word] of staged('orders')) expect(word, state).toBe(IDESH[state!]);
    expect(ours()!.querySelector('.stage > b')?.textContent).toBe('Дууссан');
    // Over, it has gone the whole way: four bars of four, none of them the crimson's «now».
    expect(ours()!.querySelectorAll('.stage .meter > i[data-on]').length).toBe(4);
  });

  it('says a guest with no name quietly in the lunch, order and message lists, as the guests’ table does', async () => {
    // Signed up with a number and nothing else: the server calls them «···8032» where a name would go.
    await ownGuest('+97699008032');
    await orderFromMap(await openPage('dine.html'), pairedVenue, 'Цуйван', '12:30');
    const code = await buyPickup(await openPage('idesh.html'));
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    const doc = desk.window.document;
    await until(desk, 'the overview', (d) => Boolean(d.querySelector('#now')));
    const theirs = (selector: string) => [...doc.querySelectorAll(selector)].filter((r) => r.textContent?.includes('+976 9900 8032'));
    const quiet = (rows: Element[]) => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.querySelector('.dt-two .dt-unnamed')?.textContent).toBe('Нэр оруулаагүй');
        expect(row.textContent).not.toContain('···');
      }
    };

    await opsTab(desk, 'lunches');
    await until(desk, 'their lunch', () => theirs('#lunches tr[data-lunch]').length > 0);
    quiet(theirs('#lunches tr[data-lunch]'));

    await opsTab(desk, 'orders');
    await until(desk, 'their идэш', () => theirs('#orders tr[data-order]').some((r) => r.textContent?.includes(`№${code}`)));
    quiet(theirs('#orders tr[data-order]'));
    // On the order's own file, too: the facts say it, the related link is the guest's file.
    (theirs('#orders tr[data-order]').find((r) => r.textContent?.includes(`№${code}`)) as HTMLElement).click();
    await until(desk, 'the order', (d) => Boolean(d.querySelector('.detail .facts')));
    expect(doc.querySelector('.detail .facts')?.textContent).toContain('Нэр оруулаагүй');
    expect(doc.querySelector('.detail')?.textContent).not.toContain('···');

    await opsTab(desk, 'notify');
    await until(desk, 'what they were told', () => theirs('#messages tr[data-message]').length > 0);
    quiet(theirs('#messages tr[data-message]'));
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
    expect(doc.querySelector('#integrations .kpi')?.textContent).toContain('Хуваарьлагч');
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

  /** The answers a page gets from production: the demo's shortcuts are not there. */
  const asInProduction = (path: string) => (path.startsWith('/dev/') ? new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404, headers: { 'content-type': 'application/json' } }) : undefined);

  it('takes somebody who came to register a business from its own door to the popup, «Идэшний нийлүүлэгч» ticked, and says a missing kind under the boxes', async () => {
    // Signed out: the door says this is the way to register, and what comes after signing in.
    const door = await openPage('ops.html', '?join=business', asInProduction, device());
    await until(door, 'the door', (d) => Boolean(d.querySelector('.door .door-card h1')));
    expect(door.window.document.querySelector('.door .door-card h1')?.textContent).toBe('Бизнесээ бүртгүүлэх');
    expect(door.window.document.querySelector('.door .door-for')?.textContent).toContain('бүртгэлийн цонх нээгдэнэ');
    // Without the wish it is the plain door.
    const plain = await openPage('ops.html', '', asInProduction, device());
    await until(plain, 'the door', (d) => Boolean(d.querySelector('.door .door-card h1')));
    expect(plain.window.document.querySelector('.door .door-card h1')?.textContent).toBe('Нэвтрэх');

    // Signed in: their own corner, the registration open on it, the supplier ticked — and the wish taken, once.
    const person = await account('+97688030091', 'Баатар');
    const dash = await openPage('ops.html', '?join=business', undefined, device(person));
    await until(dash, 'the registration', (d) => Boolean(d.querySelector('#org-form[data-open]')));
    const form = dash.window.document.querySelector('#org-form')!;
    expect((form.querySelector('[name="supplier"]') as HTMLInputElement).checked).toBe(true);
    expect((form.querySelector('[name="restaurant"]') as HTMLInputElement).checked).toBe(false);
    expect(dash.window.location.search).toBe('');

    // No kind ticked: said under the boxes, where the person is, the first box marked — and nothing is sent.
    (form.querySelector('[name="name"]') as HTMLInputElement).value = 'Баатарын мах · тест';
    (form.querySelector('[name="supplier"]') as HTMLInputElement).checked = false;
    (form.querySelector('[data-submit]') as HTMLElement).click();
    const kinds = form.querySelector('.popup-checks')!.closest('.field')!;
    await until(dash, 'the refusal', () => Boolean(kinds.querySelector('.help[data-error]')));
    expect(kinds.querySelector('.help[data-error]')?.textContent).toContain('Юу хийдгээ сонгоно уу');
    expect(form.querySelector('[name="supplier"]')?.getAttribute('aria-invalid')).toBe('true');
    expect((form.querySelector('.popup-error') as HTMLElement).hidden).toBe(true);
    const made = await getPool().query("SELECT 1 FROM org.organization WHERE name = 'Баатарын мах · тест'");
    expect(made.rowCount).toBe(0);
  });

  it('names on a new supplier’s home what it still lacks, each button opening its popup on the supplier’s screen at once', async () => {
    const owner = await account('+97688030071', 'Ганбат');
    const orgId = await business(owner, 'Шинэ мах · тест', { supplier: true });
    const dash = await openPage('ops.html', `#${orgId}/home`, undefined, device(owner));
    await until(dash, 'what it lacks', (d) => d.querySelectorAll('#nudges .nudge').length === 2);
    // Nothing sold yet: no band of zeros over the steps.
    await until(dash, 'no band of zeros', (d) => !d.querySelector('#org-kpis'));
    const doc = dash.window.document;
    const listing = doc.querySelector('#nudge-listing a.btn')!;
    const bank = doc.querySelector('#nudge-bank a.btn')!;
    expect(listing.getAttribute('href')).toBe(`/supplier?org=${orgId}#stall/new`);
    expect(bank.getAttribute('href')).toBe(`/supplier?org=${orgId}#profile/bank`);
    // One primary button, the off-white pill: the first thing to do.
    expect(listing.getAttribute('data-v')).toBe('primary');
    expect(bank.hasAttribute('data-v')).toBe(false);

    // Followed: the stall opens on the new listing's popup — no second press — and a reload would not open it again.
    const stall = await openPage('supplier.html', `?org=${orgId}#stall/new`, undefined, device(owner));
    await until(stall, 'the new listing', (d) => d.querySelector('#listing-new h2')?.textContent === 'Шинэ зар нэмэх');
    expect(stall.window.location.hash).toBe('#stall');
    // The account's: its popup over the profile.
    const profile = await openPage('supplier.html', `?org=${orgId}#profile/bank`, undefined, device(owner));
    await until(profile, 'the account’s popup', (d) => Boolean(d.querySelector('.profile-page')) && Boolean(d.querySelector('.sheet.popup[data-open]')));
    expect(profile.window.location.hash).toBe('#profile');
  });

  it('says on the day why no order comes while payments are closed, and that the payouts have nowhere to go yet', async () => {
    const owner = await account('+97688030081', 'Чулуун');
    const orgId = await business(owner, 'Хаалттай мах · тест', { supplier: true });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    // The listings say it when they carry it; else the wallet's top-ups, which the same provider closes.
    const closedByListings = (path: string) => (path.startsWith('/v1/idesh/listings') ? json({ today: '2026-09-02', listings: [], payments_open: false }) : undefined);
    const closedByWallet = (path: string) =>
      path.startsWith('/v1/idesh/listings')
        ? json({ today: '2026-09-02', listings: [] })
        : path.startsWith('/v1/wallet')
          ? json({ balance_mnt: 0, currency: 'MNT', topups_open: false, next: null, lines: [] })
          : undefined;
    for (const closed of [closedByListings, closedByWallet]) {
      const screen = await openPage('supplier.html', `?org=${orgId}`, closed, device(owner));
      await until(screen, 'the day’s notes', (d) => Boolean(d.querySelector('#notes:not([hidden]) #payments-closed')) && Boolean(d.querySelector('#bank-missing')));
      const d = screen.window.document;
      expect(d.querySelector('#payments-closed')?.textContent).toContain('төлбөр түр хаалттай');
      expect(d.querySelector('#bank-missing b')?.textContent).toBe('Олголт очих данс алга');
      expect(d.querySelector('#bank-missing #bank-add')?.textContent).toBe('Данс нэмэх');
    }
    // Open, the day says nothing of it.
    const open = await openPage('supplier.html', `?org=${orgId}`, undefined, device(owner));
    await until(open, 'the day', (d) => Boolean(d.querySelector('#board[data-ready]')) && Boolean(d.querySelector('#bank-missing')));
    expect(open.window.document.querySelector('#payments-closed')).toBeNull();
  });

  it('says the same on the supplier’s home on the dashboard, and nothing while payments are open or nobody answers', async () => {
    const owner = await account('+97688030095', 'Оюун');
    const orgId = await business(owner, 'Хаалттай гэр · тест', { supplier: true });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const closedByListings = (path: string) => (path.startsWith('/v1/idesh/listings') ? json({ today: '2026-09-02', listings: [], payments_open: false }) : undefined);
    const closedByWallet = (path: string) =>
      path.startsWith('/v1/idesh/listings')
        ? json({ today: '2026-09-02', listings: [] })
        : path.startsWith('/v1/wallet')
          ? json({ balance_mnt: 0, currency: 'MNT', topups_open: false, next: null, lines: [] })
          : undefined;
    for (const closed of [closedByListings, closedByWallet]) {
      const home = await openPage('ops.html', `#${orgId}/home`, closed, device(owner));
      await until(home, 'the note', (d) => Boolean(d.querySelector('#org-notes:not([hidden]) #payments-closed')));
      const d = home.window.document;
      expect(d.querySelector('#payments-closed')?.textContent).toContain('төлбөр түр хаалттай');
      // Said before the numbers and what the business still lacks.
      expect(d.querySelector('#org-notes')!.compareDocumentPosition(d.querySelector('#nudges')!) & home.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Open — or nobody answering — says nothing of it.
    const down = (path: string) => (path.startsWith('/v1/idesh/listings') || path.startsWith('/v1/wallet') ? json({ error: { code: 'DOWN', message_mn: 'Түр саатал.' } }, 503) : undefined);
    for (const answer of [undefined, down]) {
      const home = await openPage('ops.html', `#${orgId}/home`, answer, device(owner));
      await until(home, 'the home', (d) => d.querySelectorAll('#nudges .nudge').length === 2 && !d.querySelector('#org-notes'));
      expect(home.window.document.querySelector('#payments-closed')).toBeNull();
    }
  });

  it('says on a guest whose own number a delivery’s number found that it was the delivery’s, and dates the order’s story by Ulaanbaatar’s day', async () => {
    const buyer = await account('+97688030097', 'Нараа');
    const { listings, today } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      today: string;
      listings: Array<{ id: string; delivers: boolean; unit: string; remaining: number; ready_from: string }>;
    };
    const stall = listings.find((l) => l.delivers && l.unit === 'whole' && l.remaining > 0)!;
    const made = await fetch(`${base}/v1/idesh`, {
      method: 'POST',
      headers: as(buyer),
      body: JSON.stringify({ listing_id: stall.id, qty: 1, receive: 'delivery', receive_on: stall.ready_from > today ? stall.ready_from : today, address: 'Сүхбаатар, 1-р хороо', address_phone: '+976 9907 5522' }),
    });
    const order = (await made.json()) as { id: string; code: string };
    expect(made.status, JSON.stringify(order)).toBe(201);
    expect((await fetch(`${base}/v1/idesh/${order.id}/pay`, { method: 'POST', headers: as(buyer), body: '{}' })).status).toBe(200);
    // Made and paid at 07:15 in Ulaanbaatar: 23:15 the day before in UTC, the first ten characters of the stamp.
    await getPool().query(`UPDATE idesh.order_event SET created_at = '2026-09-01T23:15:00Z' WHERE order_id = $1`, [order.id]);

    const desk = await openPage('ops.html', '', undefined, device(await deskToken()));
    const doc = desk.window.document;
    await opsTab(desk, 'guests');
    await until(desk, 'the guests', (d) => Boolean(d.querySelector('#guests .dt-search input')));
    const q = doc.querySelector('#guests .dt-search input') as HTMLInputElement;
    q.value = '9907 5522';
    q.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
    await until(desk, 'the buyer', (d) => {
      const rows = [...d.querySelectorAll('#guests tr[data-guest]')];
      return rows.length === 1 && Boolean(rows[0]!.textContent?.includes('Нараа'));
    });
    // Their own number, and under it why the row is there: the number the desk typed was the delivery's.
    const row = doc.querySelector('#guests tr[data-guest] td:nth-child(2)')!;
    expect(row.textContent).toContain('+976 8803 0097');
    expect(row.textContent).toContain('хүргэлтийн утсаар олдсон: +976 9907 5522');

    await opsTab(desk, 'orders');
    await until(desk, 'the order', (d) => Boolean(d.querySelector(`#orders tr[data-order="${order.id}"]`)));
    (doc.querySelector(`#orders tr[data-order="${order.id}"]`) as HTMLElement).click();
    await until(desk, 'the story', (d) => d.querySelectorAll('.detail .story li').length >= 2);
    const times = [...doc.querySelectorAll('.detail .story li .t')].map((t) => t.textContent);
    expect(times.every((t) => t === '9-р сарын 2 07:15'), times.join(' | ')).toBe(true);
  });

  it('finds a caller who signed up by email by the number they gave for a delivery, on the guests and on the orders', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    let caller: string;
    try {
      await fetch(`${base}/v1/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'saraa.dalgar@example.mn' }) });
      const code = /(\d{6})/.exec(mailer.to('saraa.dalgar@example.mn')!.text)![1];
      caller = ((await (await fetch(`${base}/v1/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'saraa.dalgar@example.mn', code, device: 'Вэб' }),
      })).json()) as { token: string }).token;
    } finally {
      delete ctx.mailer;
    }
    // A delivery, paid, then cancelled by the supplier: an order that has ended, which «Идэвхтэй» would hide.
    const { listings, today } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
      today: string;
      listings: Array<{ id: string; delivers: boolean; unit: string; remaining: number; ready_from: string; supplier: { id: string } }>;
    };
    const stall = listings.find((l) => l.delivers && l.unit === 'whole' && l.remaining > 0)!;
    const receiveOn = stall.ready_from > today ? stall.ready_from : today;
    const made = await fetch(`${base}/v1/idesh`, {
      method: 'POST',
      headers: as(caller),
      body: JSON.stringify({ listing_id: stall.id, qty: 1, receive: 'delivery', receive_on: receiveOn, address: 'Баянзүрх, 26-р хороо', address_phone: '+976 9907 4411' }),
    });
    const order = (await made.json()) as { id: string; code: string };
    expect(made.status, JSON.stringify(order)).toBe(201);
    const paid = await fetch(`${base}/v1/idesh/${order.id}/pay`, { method: 'POST', headers: as(caller), body: '{}' });
    expect(paid.status, await paid.text()).toBe(200);
    const { rows } = await getPool().query<{ phone: string }>('SELECT g.phone_e164 AS phone FROM idesh.supplier s JOIN identity.guest g ON g.id = s.owner_guest_id WHERE s.id = $1', [stall.supplier.id]);
    const seller = await devLogin(rows[0]!.phone, 'Нийлүүлэгч');
    expect((await fetch(`${base}/v1/supplier/orders/${order.id}/cancel`, { method: 'POST', headers: as(seller), body: JSON.stringify({ reason: 'cannot_fulfil' }) })).status).toBe(200);

    const desk = await openPage('ops.html', '', undefined, device(await deskToken()));
    const doc = desk.window.document;
    const search = async (box: string, q: string) => {
      const input = doc.querySelector(`${box} .dt-search input`) as HTMLInputElement;
      input.value = q;
      input.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
    };
    // The guests: found by the delivery's number, said to be that.
    await opsTab(desk, 'guests');
    await until(desk, 'the guests', (d) => Boolean(d.querySelector('#guests .dt-search input')));
    await search('#guests', '9907 4411');
    // The answer to the search, not the list of everybody it replaces: one row, the caller's.
    await until(desk, 'the caller', (d) => {
      const rows = [...d.querySelectorAll('#guests tr[data-guest]')];
      return rows.length === 1 && Boolean(rows[0]!.textContent?.includes('saraa.dalgar@example.mn'));
    });
    const guest = doc.querySelector('#guests tr[data-guest]')!;
    expect(guest.textContent).toContain('+976 9907 4411');
    expect(guest.textContent).toContain('хүргэлтийн утсаар олдсон');

    // The orders: a search looks through every order, ended ones too, and the guest with no name is their address.
    await opsTab(desk, 'orders');
    await until(desk, 'the orders', (d) => Boolean(d.querySelector('#orders .dt-seg button[data-v="live"][data-on]')));
    await search('#orders', '99074411');
    await until(desk, 'every order searched', (d) => Boolean(d.querySelector('#orders .dt-seg button[data-v="all"][data-on]')));
    await until(desk, 'the ended order', (d) => Boolean(d.querySelector(`#orders tr[data-order="${order.id}"]`)));
    const row = doc.querySelector(`#orders tr[data-order="${order.id}"]`)!;
    expect(row.textContent).toContain('saraa.dalgar@example.mn');
    expect(row.textContent).not.toContain('Нэр оруулаагүй');
    // Cleared, the list goes back to where it was.
    await search('#orders', '');
    await until(desk, 'the scope back', (d) => Boolean(d.querySelector('#orders .dt-seg button[data-v="live"][data-on]')));
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
    // Signed up with a phone and a password: the seat keeps no number, and the table shows the one the account typed, said to be unproved.
    const seated = [...doc.querySelectorAll('#members tr[data-member]')].find((r) => r.textContent?.includes('Сонгосон ажилтан'))!;
    expect(seated.textContent).toContain('+976 8803 0051');
    expect(seated.textContent).toContain('баталгаагүй');
    expect(seated.textContent).not.toContain('Баталгаажсан утас, имэйл алга');

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
    expect(asked.textContent).toContain('нээлттэй байгаа ширээ нь ч дараагийн алхамд хаагдана');
    // The dashboard itself stays open for them: it drops to their own corner.
    expect(asked.textContent).not.toMatch(/нэвтрэлт нь хаагдана|dashboard нь ч/);
    (asked.querySelector('[data-submit]') as HTMLElement).click();
    await until(desk, 'the seat off', () => Boolean(row()?.hasAttribute('data-off')));
    const auth = { authorization: `Bearer ${chosen}` };
    expect((await fetch(`${base}/v1/ops/me`, { headers: auth })).status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: auth })).status).toBe(200);
  });

  it('leaves out of a business’s menu a link stored with quotes, and nothing on the page grows from it', async () => {
    const desk = await deskToken();
    const owner = await account('+97688030061', 'Цэцэг');
    await business(owner, 'Цэцэгийн мах · тест', { supplier: true });
    // Two links in every business's menu, given to its owners: an ordinary one, and one written in with quotes
    // before a link was refused them. The server leaves such a link out of the menu it hands a page (`linkHref`),
    // and the page would not draw one that came (`navHref`); either way no quote in it can end an attribute.
    const link = async (name: string) =>
      ((await (
        await fetch(`${base}/v1/ops/menus/org/links`, { method: 'POST', headers: as(desk), body: JSON.stringify({ name, href: '/help', module: 'org' }) })
      ).json()) as { key: string }).key;
    const plain = await link('Тусламж');
    const quoted = await link('Хуучин холбоос');
    await getPool().query(`UPDATE access.page SET href = $2 WHERE scope = 'org' AND key = $1`, [quoted, '/help"onmouseover="window.__owned=1']);
    const { roles } = (await (await fetch(`${base}/v1/ops/access/org`, { headers: as(desk) })).json()) as { roles: Array<{ key: string; permissions: string[] }> };
    const owners = roles.find((r) => r.key === 'owner')!;
    const given = await fetch(`${base}/v1/ops/roles/org/owner`, {
      method: 'PATCH',
      headers: as(desk),
      body: JSON.stringify({ permissions: [...owners.permissions, `org.${plain}`, `org.${quoted}`] }),
    });
    expect(given.status).toBe(200);
    try {
      const dash = await openPage('ops.html', '', undefined, device(owner));
      const door = (d: Document, name: string) => [...d.querySelectorAll('.org-doors .door-link')].find((a) => a.querySelector('span')?.textContent === name);
      // The doors are drawn, Basu's links among them, once the ordinary one is there.
      await until(dash, 'the ordinary link among the business’s doors', (d) => Boolean(door(d, 'Тусламж')));
      const doc = dash.window.document;
      expect(door(doc, 'Тусламж')!.getAttribute('href')).toBe('/help');
      // The one with quotes is nowhere, the sidebar included, and no element carries an attribute out of it.
      expect(door(doc, 'Хуучин холбоос')).toBeUndefined();
      expect(doc.getElementById('root')?.textContent ?? '').not.toContain('Хуучин холбоос');
      expect(doc.querySelector('[onmouseover]')?.outerHTML ?? null).toBeNull();
      expect([...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h?.includes('"'))).toEqual([]);
    } finally {
      // Gone, and no role opens them any more: the other businesses here keep the menu they had.
      for (const key of [plain, quoted]) await fetch(`${base}/v1/ops/menus/org/links/${key}`, { method: 'DELETE', headers: { authorization: `Bearer ${desk}` } });
    }
  });

  describe('Ulaanbaatar’s day, whatever zone the computer is in', () => {
    /*
     * 06:30 on 2 October in Ulaanbaatar is 22:30 on 1 October in UTC: a
     * stamp's first ten characters, and the day of a computer set to UTC (a
     * phone abroad, a CI runner), are the day before. Every page says the
     * day and the time Ulaanbaatar reads, run here on a machine set to UTC.
     */
    const DAWN = '2026-10-01T22:30:00Z';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    /** The server's own answer to a page's GET for `path`, changed on its way back. */
    const changed =
      (match: (path: string) => boolean, change: (body: Record<string, any>) => void) =>
      (path: string, init?: RequestInit): Promise<Response> | undefined =>
        match(path) && (init?.method ?? 'GET') === 'GET'
          ? (async () => {
              const real = await fetch(new URL(path, base), { headers: new Headers(init?.headers) });
              const body = (await real.json()) as Record<string, any>;
              change(body);
              return json(body, real.status);
            })()
          : undefined;
    /** One whole animal, collected, bought and paid for by `buyer`: the order's id. */
    async function paidOrder(buyer: string): Promise<string> {
      const { listings, today } = (await (await fetch(`${base}/v1/idesh/listings`)).json()) as {
        today: string;
        listings: Array<{ id: string; unit: string; remaining: number; ready_from: string }>;
      };
      const stall = listings.find((l) => l.unit === 'whole' && l.remaining > 0)!;
      const made = await fetch(`${base}/v1/idesh`, {
        method: 'POST',
        headers: as(buyer),
        body: JSON.stringify({ listing_id: stall.id, qty: 1, receive: 'pickup', receive_on: stall.ready_from > today ? stall.ready_from : today }),
      });
      const order = (await made.json()) as { id: string };
      expect(made.status, JSON.stringify(order)).toBe(201);
      expect((await fetch(`${base}/v1/idesh/${order.id}/pay`, { method: 'POST', headers: as(buyer), body: '{}' })).status).toBe(200);
      return order.id;
    }

    it('puts a new listing’s ready day a week from Ulaanbaatar’s today when the server has not said which day it is', async () => {
      const owner = await account('+97688031001', 'Үүрийн');
      const orgId = await business(owner, 'Үүрийн мах · тест', { supplier: true });
      // Neither the day's numbers nor the board answer: the page has only its own clock to go by.
      const down = (path: string) =>
        path.startsWith('/v1/supplier/home') || path.startsWith('/v1/supplier/board') ? json({ error: { code: 'DOWN', message_mn: 'Түр саатал.' } }, 503) : undefined;
      await inZone('UTC', async () => {
        const stall = await openPage('supplier.html', `?org=${orgId}#stall/new`, down, device(owner), undefined, DAWN);
        await until(stall, 'the new listing', (d) => Boolean(d.querySelector('#listing-new [name="ready_from"]')));
        expect((stall.window.document.querySelector('#listing-new [name="ready_from"]') as HTMLInputElement).value).toBe('2026-10-09');
      });
    });

    it('says on the supplier’s board the day a guest may be called absent from, and the time it last reached the server', async () => {
      const owner = await account('+97688031002', 'Үүрээ');
      const orgId = await business(owner, 'Үүрийн гэр · тест', { supplier: true });
      const ticket = {
        id: '00000000-0000-4000-8000-000000000001',
        code: 'K7Q2',
        title: 'Хонь, бүтэн',
        qty: 1,
        unit: 'whole',
        state: 'READY',
        receive: 'pickup',
        receive_on: '2026-10-02',
        total_mnt: 460000,
        payout_mnt: 414000,
        guest: 'Нараа',
        // 06:30 on the 4th in Ulaanbaatar.
        no_show_from: '2026-10-03T22:30:00Z',
      };
      // The board answers once, then the line drops.
      let boards = 0;
      const board = (path: string) => {
        if (!path.startsWith('/v1/supplier/board')) return undefined;
        boards += 1;
        return boards === 1
          ? json({ today: '2026-10-02', supplier: { name: 'Үүрийн гэр · тест' }, lanes: { paid: [], preparing: [], ready: [ticket], dispatched: [] }, listings: [] })
          : json({ error: { code: 'DOWN', message_mn: 'Түр саатал.' } }, 503);
      };
      await inZone('UTC', async () => {
        const screen = await openPage('supplier.html', `?org=${orgId}`, board, device(owner), undefined, DAWN);
        await until(screen, 'the ticket', (d) => Boolean(d.querySelector('.ticket .grace')));
        expect(screen.window.document.querySelector('.ticket .grace')?.textContent).toContain('Ирэхгүй бол 10-р сарын 4-нөөс');
        // Lost, the strip says when the board was last right: 06:30 here, not 22:30.
        await until(screen, 'the lost line', (d) => Boolean(d.querySelector('#conn:not([hidden])')));
        expect(screen.window.document.querySelector('#conn .mono')?.textContent).toBe('06:30');
      });
    });

    it('dates a listing’s paid place and the supplier’s payouts by Ulaanbaatar’s day', async () => {
      const owner = await account('+97688031003', 'Тэлмэн');
      const orgId = await business(owner, 'Тэлмэн мах · тест', { supplier: true });
      const listing = {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'sheep',
        unit: 'whole',
        title: 'Хонь, залуу ирэг',
        price_mnt: 460000,
        approx_kg: 38,
        min_qty: null,
        quantity: 5,
        sold: 0,
        remaining: 5,
        ready_from: '2026-10-05',
        origin: 'Архангай',
        delivers: false,
        delivery_fee_mnt: 0,
        active: true,
        note: null,
        tier: 'featured',
        // Its place ends at 06:30 on the 9th in Ulaanbaatar.
        tier_until: '2026-10-08T22:30:00Z',
      };
      const settlement = { id: '00000000-0000-4000-8000-000000000003', order_code: 'K7Q2', memo: 'Хонь ×1', state: 'paid', amount_mnt: 414000, created_at: '2026-10-01T21:00:00Z', paid_at: DAWN, reference: 'ХААН-1' };
      const answers = (path: string, init?: RequestInit) =>
        changed((p) => p.startsWith('/v1/supplier/listings'), (body) => (body['listings'] = [listing]))(path, init) ??
        changed((p) => p.startsWith('/v1/supplier/money'), (body) => (body['settlements'] = [settlement]))(path, init);
      await inZone('UTC', async () => {
        const stall = await openPage('supplier.html', `?org=${orgId}#stall`, answers, device(owner));
        await until(stall, 'the listing', (d) => Boolean(d.querySelector('.chip.tier')));
        expect(stall.window.document.querySelector('.chip.tier')?.textContent).toBe('Онцгой · 10-р сарын 9 хүртэл');
        const money = await openPage('supplier.html', `?org=${orgId}#money`, answers, device(owner));
        await until(money, 'the payout', (d) => Boolean(d.querySelector(`[data-settlement="${settlement.id}"] .sub`)));
        expect(money.window.document.querySelector(`[data-settlement="${settlement.id}"] .sub`)?.textContent).toBe('Шилжүүлсэн 10/2 06:30 · ХААН-1');
      });
    });

    it('times an order’s steps and its refund on the app’s page and the website’s by Ulaanbaatar’s clock', async () => {
      const buyer = await account('+97688031004', 'Сарнай');
      const id = await paidOrder(buyer);
      const isOrder = (path: string) => path === `/v1/idesh/${id}` || path.startsWith(`/v1/idesh/${id}?`);
      const paidAtDawn = changed(isOrder, (o) => (o['paid_at'] = DAWN));
      const refunded = changed(isOrder, (o) => {
        o['state'] = 'CANCELLED';
        o['refund'] = { state: 'paid', amount_mnt: 460000, bank_name: 'Хаан банк', bank_account: '5000123456', bank_holder: 'Сарнай', paid_at: DAWN };
      });
      await inZone('UTC', async () => {
        const app = await openPage('idesh.html', `?order=${id}`, paidAtDawn, device(buyer));
        await until(app, 'the steps', (d) => Boolean(d.querySelector('.timeline li[data-done] .t')));
        expect(app.window.document.querySelector('.timeline li[data-done] .t')?.textContent).toBe('06:30');
        const back = await openPage('idesh.html', `?order=${id}`, refunded, device(buyer));
        await until(back, 'the refund', (d) => Boolean(d.querySelector('#refund small')));
        expect(back.window.document.querySelector('#refund small')?.textContent).toContain('Шилжүүлсэн 10/2 06:30');
        const site = await openPage('orders.html', `/${id}`, paidAtDawn, device(buyer));
        await until(site, 'the steps', (d) => Boolean(d.querySelector('li[data-done] time')));
        expect(site.window.document.querySelector('li[data-done] time')?.textContent).toBe('10/2 06:30');
      });
    });

    it('says on the account page today, yesterday and the day joined as Ulaanbaatar counts them', async () => {
      const person = await account('+97688031005', 'Номин');
      const answers = (path: string, init?: RequestInit) =>
        changed((p) => p === '/v1/me', (me) => (me['member_since'] = DAWN))(path, init) ??
        changed(
          (p) => p === '/v1/me/sessions',
          (body) => {
            // Seen at 06:30 today and at 23:00 last night, Ulaanbaatar's; the computer's clock reads 07:00.
            body['sessions'] = [
              { ...body['sessions'][0], last_seen_at: DAWN },
              { ...body['sessions'][0], id: '00000000-0000-4000-8000-000000000004', current: false, label: 'iPhone', last_seen_at: '2026-10-01T15:00:00Z' },
            ];
          },
        )(path, init);
      await inZone('UTC', async () => {
        const page = await openPage('account.html', '', answers, device(person), undefined, '2026-10-01T23:00:00Z');
        await until(page, 'the devices', (d) => d.querySelectorAll('#sa li small').length === 2);
        const seen = [...page.window.document.querySelectorAll('#sa li small')].map((s) => s.textContent);
        expect(seen).toEqual(['Сүүлд: Өнөөдөр 06:30', 'Сүүлд: Өчигдөр 23:00']);
        expect(page.window.document.querySelector('#sa')?.textContent).toContain('2026 оны 10-р сарын 2');
      });
    });
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
    expect(cookiesOf(browser).has('__Host-basu_handoff')).toBe(false);
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

  it('asks a desk seat signed in too long ago to sign in again before it signs anybody out on the website, and ends that session', async () => {
    const admin = await seated('+97688050151', 'Админ Арав');
    // The same admin, signed in again this morning somewhere else: the one at the desk now.
    const signedIn = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: '+97688050151', password: GUEST_PASSWORD }),
    });
    const atTheDesk = ((await signedIn.json()) as { token: string }).token;
    await longAgo(admin);
    const browser = device(admin);
    const page = await openPage('account.html', '', undefined, browser);
    await until(page, 'another device to sign out of', (d) => (d.querySelector('#others') as HTMLButtonElement | null)?.disabled === false);

    (page.window.document.querySelector('#others') as HTMLElement).click();
    // Signing the others out is asked first, in a popup.
    await answerPopup(page);
    await until(page, 'the session let go', () => browser.getItem('basu.guest') === null);
    expect(await ended(admin)).toBe(true);
    // Nobody was signed out by it: the admin at the desk still is.
    expect((await fetch(`${base}/v1/ops/me`, { headers: { authorization: `Bearer ${atTheDesk}` } })).status).toBe(200);
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
      // Set for itself, with no step after it to say so, the password says it was kept.
      expect(page.window.document.getElementById('toast')?.textContent).toContain('Нууц үг хадгалагдлаа.');
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

  it('says in place, with the way to try again, when the account page cannot be loaded', async () => {
    const page = await openPage(
      'account.html',
      '',
      (path) => (path === '/v1/me/sessions' ? new Response(JSON.stringify({ error: { code: 'INTERNAL', message_mn: 'Түр алдаа гарлаа.' } }), { status: 500, headers: { 'content-type': 'application/json' } }) : undefined),
      device(await devLogin('+97688060003', 'Вэб')),
    );
    const d = page.window.document;
    await until(page, 'the trouble, said', () => Boolean(d.querySelector('#sa .s-empty')));
    expect(d.querySelector('#sa .s-empty b')?.textContent).toBe('Бүртгэлийг ачаалж чадсангүй');
    expect(d.querySelector('#sa .s-empty p')?.textContent).toBe('Түр алдаа гарлаа.');
    expect(d.querySelector('#sa .s-empty a[href="/account"]')?.textContent).toBe('Дахин ачаалах');
    // No skeleton left standing, and the page is not said to be loading any more.
    expect(d.querySelector('#sa .s-skel')).toBeNull();
    expect(d.getElementById('sa')?.hasAttribute('aria-busy')).toBe(false);
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

describe('a first password, where money is about to go', () => {
  /*
   * A refund's account and a supplier's payout account are confirmed with the
   * account's password. An account made by an address, Google or Apple has
   * none: the button that asks for the account sets one first, in a popup —
   * a code to the address on the account, then the password — and the
   * account's popup or form follows with it, not a trip to another page.
   */
  const json = { 'content-type': 'application/json' };

  /** Somebody who signed in with a code to this address: no password. Their session. */
  async function byAddress(mailer: FakeMailer, email: string): Promise<string> {
    await fetch(`${base}/v1/auth/email/start`, { method: 'POST', headers: json, body: JSON.stringify({ email }) });
    const verified = await fetch(`${base}/v1/auth/email/verify`, { method: 'POST', headers: json, body: JSON.stringify({ email, code: mailer.codeFor(email) }) });
    return ((await verified.json()) as { token: string }).token;
  }

  /** A whole animal bought by this session and cancelled by its supplier: the refund waits for an account. */
  async function cancelledFor(token: string, key: string): Promise<string> {
    const auth = { authorization: `Bearer ${token}`, ...json };
    const { listing, today } = (await (await fetch(`${base}/v1/idesh/listings/${await fullestStall()}`)).json()) as {
      listing: { id: string; ready_from: string };
      today: string;
    };
    const made = (await (
      await fetch(`${base}/v1/idesh`, {
        method: 'POST',
        headers: { ...auth, 'idempotency-key': key },
        body: JSON.stringify({ listing_id: listing.id, qty: 1, receive: 'pickup', receive_on: listing.ready_from > today ? listing.ready_from : today }),
      })
    ).json()) as { id: string };
    const paid = await fetch(`${base}/v1/idesh/${made.id}/pay`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(paid.status, await paid.text()).toBe(200);
    const { rows } = await getPool().query<{ seller: string }>(
      `SELECT g.phone_e164 AS seller FROM idesh.idesh_order o
         JOIN idesh.supplier s ON s.id = o.supplier_id JOIN identity.guest g ON g.id = s.owner_guest_id
        WHERE o.id = $1`,
      [made.id],
    );
    const asSeller = { ...json, authorization: `Bearer ${await devLogin(rows[0]!.seller, 'Нийлүүлэгч')}` };
    const cancelled = await fetch(`${base}/v1/supplier/orders/${made.id}/cancel`, { method: 'POST', headers: asSeller, body: JSON.stringify({ reason: 'guest_asked' }) });
    expect(cancelled.status, await cancelled.text()).toBe(200);
    return made.id;
  }

  const popupOnTop = (dom: JSDOM) => [...dom.window.document.querySelectorAll('.sheet.popup[data-open]')].pop() as HTMLElement | undefined;
  const passwordLetters = (mailer: FakeMailer, to: string) => mailer.sent.filter((m) => m.to === to && m.subject.includes('нууц үг тохируулах')).length;

  it('keeps a cancelled order waiting for its account under «Идэвхтэй», and sets the password and the account from the order in one go', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    try {
      const token = await byAddress(mailer, 'saraa@example.mn');
      const id = await cancelledFor(token, 'refund-first-password');

      // The list: still going on — the money has not come back — and saying what it waits for.
      const list = await openPage('orders.html', '', undefined, device(token));
      await until(list, 'the row', (d) => Boolean(d.querySelector(`[data-order="${id}"]`)));
      expect(list.window.document.querySelector('#tabs [data-tab="live"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(list.window.document.querySelector(`[data-order="${id}"]`)?.textContent).toContain('Данс оруулна уу');

      // The order: one button, which sets the password first and then asks for the account.
      const page = await openPage('orders.html', `/${id}`, undefined, device(token));
      const d = page.window.document;
      await until(page, 'the way to give an account', () => Boolean(d.querySelector('.od-refund [data-account]')));
      expect(d.querySelector('.od-refund a[href="/account"]')).toBeNull();
      expect(d.querySelector('.od-refund .s-note')?.textContent).toContain('нууц үг');
      (d.querySelector('[data-account]') as HTMLElement).click();
      await until(page, 'the password popup', () => popupOnTop(page)?.querySelector('h2')?.textContent === 'Нууц үг тохируулах');
      expect(popupOnTop(page)!.querySelector('header .sub')?.textContent).toContain('saraa@example.mn');
      await answerPopup(page);
      await until(page, 'the letter', () => passwordLetters(mailer, 'saraa@example.mn') === 1);
      await answerPopup(page, { code: mailer.codeFor('saraa@example.mn')!, next: 'сараагийн нууц үг' });

      // Straight on to the account, the password just chosen in hand: not asked for again.
      await until(page, 'the account popup', () => Boolean(popupOnTop(page)?.querySelector('[name="bank"]')));
      expect(popupOnTop(page)!.querySelector('[name="password"]')).toBeNull();
      await answerPopup(page, { bank: 'Хаан банк', account: '5012345678', holder: 'Сараа Бат' });
      await until(page, 'the account on the order', () => !d.querySelector('[data-account]') && (d.querySelector('.od-refund')?.textContent ?? '').includes('5012345678'));
      // One word at the end for both — not the password's toast left standing under the account's.
      expect(d.querySelector('.s-toast')?.textContent).toBe('Нууц үг, данс хоёулаа хадгалагдлаа. Шилжүүлмэгц мэдэгдэл ирнэ.');
      expect(d.getElementById('toast')?.hasAttribute('data-show') ?? false).toBe(false);

      // The password is the account's now: it signs in.
      const signedIn = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'saraa@example.mn', password: 'сараагийн нууц үг' }) });
      expect(signedIn.status).toBe(200);
    } finally {
      delete ctx.mailer;
    }
  });

  it('sets the password in the app when «Данс илгээх» needs one, and sends the account with it', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    try {
      const token = await byAddress(mailer, 'tsetseg@example.mn');
      const id = await cancelledFor(token, 'app-refund-first-password');
      const page = await openPage('idesh.html', `?order=${id}`, undefined, device(token));
      await until(page, 'the refund form', (d) => Boolean(d.querySelector('#refund #send-account')));
      const form = page.window.document.querySelector('#refund')!;
      const send = form.querySelector('#send-account') as HTMLButtonElement;
      const type = (field: string, value: string) => {
        const input = form.querySelector(`#${field}`) as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new page.window.Event('input'));
      };
      type('bank', 'Хаан банк');
      type('account', '5098765432');
      type('holder', 'Цэцэг Болд');
      expect(send.disabled).toBe(false);
      send.click();

      // No password to type: the popup sets one, and the account goes the moment it is set.
      await until(page, 'the password popup', () => popupOnTop(page)?.querySelector('h2')?.textContent === 'Нууц үг тохируулах');
      await answerPopup(page);
      await until(page, 'the letter', () => passwordLetters(mailer, 'tsetseg@example.mn') === 1);
      await answerPopup(page, { code: mailer.codeFor('tsetseg@example.mn')!, next: 'цэцэгийн нууц үг' });
      await until(page, 'the account to be kept', (d) => d.querySelector('#refund')?.textContent?.includes('5098765432') ?? false);
      // One word at the end for both: no toast of the password's own stacked under it.
      expect(page.window.document.getElementById('toast')?.textContent).toBe('Нууц үг, данс хоёулаа хадгалагдлаа. Шилжүүлмэгц мэдэгдэл ирнэ.');
      expect(page.window.document.querySelector('.toast-old')).toBeNull();
      expect(page.window.document.querySelector('#refund')?.textContent).toContain('мэдэгдэл');
      expect(page.window.document.querySelector('#refund')?.textContent).not.toContain('SMS');
    } finally {
      delete ctx.mailer;
    }
  });

  it('wakes «Данс илгээх» in the app as the password is typed after a refusal', async () => {
    await ownGuest('+97699005015');
    const id = await cancelledFor(storage.getItem('basu.guest')!, 'app-refund-wrong-password');
    const page = await openPage('idesh.html', `?order=${id}`);
    await until(page, 'the refund form', (d) => Boolean(d.querySelector('#refund #send-account')));
    const form = page.window.document.querySelector('#refund')!;
    const send = form.querySelector('#send-account') as HTMLButtonElement;
    const type = (field: string, value: string) => {
      const input = form.querySelector(`#${field}`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new page.window.Event('input'));
    };
    type('bank', 'Хаан банк');
    type('account', '5012345678');
    type('holder', 'Туршилт Хүн');
    // An account with a password is asked for it, in its own field — calmly — and a wrong one is refused there, in the stop colour.
    send.click();
    await until(page, 'the password field', (d) => !(d.querySelector('#otp-step') as HTMLElement).hidden && !send.disabled);
    const why = form.querySelector('#refund-why') as HTMLElement;
    expect(why.hasAttribute('data-calm')).toBe(true);
    expect(why.dataset.tone).toBeUndefined();
    type('otp', 'буруу нууц үг');
    send.click();
    await until(page, 'the refusal', () => (why.textContent ?? '').includes('Нууц үг буруу') && !send.disabled);
    expect(why.dataset.tone).toBe('stop');
    expect(why.hasAttribute('data-calm')).toBe(false);
    // Cleared, the button waits and says why, calm again; typed again, it wakes and the refusal goes.
    type('otp', '');
    expect(send.disabled).toBe(true);
    expect(why.textContent).toContain('Нууц үгээ бичнэ үү.');
    expect(why.dataset.tone).toBeUndefined();
    type('otp', GUEST_PASSWORD);
    expect(send.disabled).toBe(false);
    expect((form.querySelector('#refund-why') as HTMLElement).hidden).toBe(true);
    send.click();
    await until(page, 'the account to be kept', (d) => d.querySelector('#refund')?.textContent?.includes('5012345678') ?? false);
  });

  it('sets the owner’s first password in front of the payout account, and goes on to the account', async () => {
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    try {
      // An owner signed in by their number: no password, and no address for its code to go to yet.
      const screen = await ownerScreen(seeded.suppliers[3]!.phone);
      const d = screen.window.document;
      const profileTab = () => d.querySelector('.tabs button[data-tab="profile"], .tabbar button[data-tab="profile"]') as HTMLElement | null;
      await until(screen, 'the module', () => Boolean(profileTab()));
      profileTab()!.click();
      await until(screen, 'the payout account', () => Boolean(d.querySelector('#bank-edit')));
      (d.querySelector('#bank-edit') as HTMLElement).click();

      // An address first, then the password — never «go to the profile» and back.
      await until(screen, 'the address popup', () => popupOnTop(screen)?.querySelector('h2')?.textContent === 'Имэйл холбох');
      // Saying why an address, when the button said «Данс нэмэх»: the account takes a password, and its code comes by email.
      const reason = popupOnTop(screen)!.querySelector('.popup-text')?.textContent ?? '';
      expect(reason).toContain('Олголт очих дансыг өөрийн нууц үгээр баталгаажуулна');
      expect(reason).toContain('Нууц үгийн код имэйлээр ирдэг');
      await answerPopup(screen, { email: 'malchin@example.mn' });
      await until(screen, 'the address letter', () => Boolean(mailer.codeFor('malchin@example.mn')));
      await answerPopup(screen, { code: mailer.codeFor('malchin@example.mn')! });
      await until(screen, 'the password popup', () => popupOnTop(screen)?.querySelector('h2')?.textContent === 'Нууц үг тохируулах');
      expect(popupOnTop(screen)!.textContent).toContain('Олголт очих данс');
      await answerPopup(screen);
      await until(screen, 'the password letter', () => passwordLetters(mailer, 'malchin@example.mn') === 1);
      await answerPopup(screen, { code: mailer.codeFor('malchin@example.mn')!, next: 'малчны нууц үг' });

      // The account's popup, without asking for the password just chosen.
      await until(screen, 'the account popup', () => Boolean(d.querySelector('#bank-change [name="bank_account"]')));
      expect(d.querySelector('#bank-change [name="password"]')).toBeNull();
      // The change reaches every owner as their notices do — by email first — so no message is promised: SMS is off.
      expect(d.querySelector('#bank-change')?.textContent).toContain('Солигдсон тухай эзэн бүрт мэдэгдэл ирнэ.');
      expect(d.querySelector('#bank-change')?.textContent).not.toMatch(/мессеж|SMS/);
      await answerPopup(screen, { bank_name: 'Хаан банк', bank_account: '5011223344', bank_holder: 'Малчин Бат' });
      await until(screen, 'the new account on the card', () => (d.querySelector('#bank')?.textContent ?? '').includes('5011223344'));
      // One word at the end for the password and the account both, not two toasts one over the other.
      expect(d.getElementById('toast')?.textContent).toBe('Нууц үг, данс хоёулаа хадгалагдлаа. Basu санхүү шалгаж баталгаажуулна.');
      expect([...d.querySelectorAll('.toast-old')].some((t) => t.textContent?.includes('Нууц үг хадгалагдлаа'))).toBe(false);

      // With the password now on the account, a wrong one typed for the next change is said under its own field.
      (d.querySelector('#bank-edit') as HTMLElement).click();
      await until(screen, 'the account popup asking for the password', () => Boolean(d.querySelector('#bank-change[data-open] [name="password"]')));
      await answerPopup(screen, { bank_account: '5011223355', password: 'буруу нууц үг' });
      const typed = () => d.querySelector('#bank-change [name="password"]') as HTMLInputElement | null;
      await until(screen, 'the refusal under the password', () => typed()?.getAttribute('aria-invalid') === 'true');
      expect(typed()!.closest('.field')?.querySelector('.help[data-error]')?.textContent).toBe('Нууц үг буруу байна.');
      expect((d.querySelector('#bank-change .popup-error') as HTMLElement).hidden).toBe(true);
    } finally {
      delete ctx.mailer;
    }
  });

  it('says why an address comes first when an account with only a phone number gives its refund account on the website', async () => {
    const token = await devLogin('+97699005093', 'Вэб');
    const id = await cancelledFor(token, 'web-refund-no-address');
    const page = await openPage('orders.html', `/${id}`, undefined, device(token));
    const d = page.window.document;
    await until(page, 'the way to give an account', () => Boolean(d.querySelector('.od-refund [data-account]')));
    // Before the press: no password, and no address for its code to go to — and what happens here about it.
    expect(d.querySelector('.od-refund .s-note')?.textContent).toContain('түүний код очих имэйл ч алга');
    (d.querySelector('[data-account]') as HTMLElement).click();
    await until(page, 'the address popup', () => popupOnTop(page)?.querySelector('h2')?.textContent === 'Имэйл холбох');
    const reason = popupOnTop(page)!.querySelector('.popup-text')?.textContent ?? '';
    expect(reason).toContain('Мөнгө тань руу очих дансыг нууц үгээр баталгаажуулдаг');
    expect(reason).toContain('Нууц үгийн код имэйлээр ирдэг');
  });
});

describe('an order’s steps on the website', () => {
  it('says the preparing step waits for the supplier until they start, as the app says it', async () => {
    await ownGuest('+97699005016');
    const token = storage.getItem('basu.guest')!;
    const { listing, today } = (await (await fetch(`${base}/v1/idesh/listings/${await fullestStall()}`)).json()) as {
      listing: { id: string; ready_from: string };
      today: string;
    };
    const made = (await (
      await fetch(`${base}/v1/idesh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'steps-honest' },
        body: JSON.stringify({ listing_id: listing.id, qty: 1, receive: 'pickup', receive_on: listing.ready_from > today ? listing.ready_from : today }),
      })
    ).json()) as { id: string };
    await fetch(`${base}/v1/idesh/${made.id}/pay`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

    const page = await openPage('orders.html', `/${made.id}`);
    await until(page, 'the steps', (d) => Boolean(d.querySelector('.od-steps li[data-next]')));
    const next = page.window.document.querySelector('.od-steps li[data-next]')!;
    // Paid, and nobody has touched the meat yet: the ringed step says what it waits for.
    expect(next.querySelector('b')?.textContent).toBe('Бэлтгэл');
    expect(next.querySelector('span')?.textContent).toBe('Нийлүүлэгч бэлтгэхийг хүлээж байна');
    expect(page.window.document.querySelector('.od-steps')?.textContent).not.toContain('Бэлтгэж байна');
  });
});

describe('paying, said as it stands', () => {
  /** The listings as production answers them while no payment provider is set up. */
  const closed = (path: string) =>
    path.startsWith('/v1/idesh/listings')
      ? new Response(JSON.stringify({ today: '2026-10-02', payments_open: false, listings: [] }), { headers: { 'content-type': 'application/json' } })
      : undefined;

  it('does not offer QPay as something to do now while online payment is closed', async () => {
    const home = await openPage('home.html', '', closed, device());
    await until(home, 'the way it goes, said as it stands', (d) => d.querySelector('.s-how [data-pay] span')?.textContent === 'Онлайн төлбөр одоогоор хаалттай байна.');
    const front = await openPage('index.html', '', closed, device());
    await until(front, 'the front page’s steps, said as they stand', (d) => d.querySelector('#how [data-pay] span')?.textContent === 'Онлайн төлбөр одоогоор хаалттай байна.');
  });

  it('says the market’s paying step from the market’s own answer, asking for the listings once — and a stall only for itself', async () => {
    const asked: string[] = [];
    const market = await openPage('shop.html', '', (path) => {
      if (path.startsWith('/v1/idesh/listings')) asked.push(path);
      return closed(path);
    }, device());
    await until(market, 'the way it goes, said as it stands', (d) => d.querySelector('.s-how [data-pay] span')?.textContent === 'Онлайн төлбөр одоогоор хаалттай байна.');
    await settled(market, 'the market');
    expect(asked).toEqual(['/v1/idesh/listings']);

    const id = await fullestStall();
    const stallAsked: string[] = [];
    const stall = await openPage('shop.html', `/${id}`, (path) => {
      if (path.startsWith('/v1/idesh/listings')) stallAsked.push(path);
      return undefined;
    }, device());
    await until(stall, 'the order form', (d) => Boolean(d.getElementById('next')));
    await settled(stall, 'the stall');
    expect(stallAsked).toEqual([`/v1/idesh/listings/${id}`]);
  });
});

describe('Facebook’s and Instagram’s own browsers', () => {
  /** Facebook's browser on an iPhone, as a link shared there opens. */
  const FACEBOOK = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/512.0.0.41.97;FBBV/700000000;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBSS/3;FBCR/;FBID/phone;FBLC/mn_MN;FBOP/80]';
  /** Google is open on this server, as it is in production. */
  const withGoogle = (path: string) =>
    path === '/v1/auth/methods'
      ? new Response(JSON.stringify({ password: true, email: true, google: true, apple: true, sms: false }), { headers: { 'content-type': 'application/json' } })
      : undefined;

  it('lead the door with the code by email and say where Google works, instead of Google’s English refusal', async () => {
    const login = await openPage('login.html', '', withGoogle, device(), FACEBOOK);
    const d = login.window.document;
    await until(login, 'the door', () => d.documentElement.hasAttribute('data-ready'));
    expect(d.documentElement.hasAttribute('data-in-app')).toBe(true);
    expect(d.getElementById('in-app')?.textContent).toBe('Google-ээр нэвтрэх бол Safari эсвэл Chrome-д нээнэ үү.');
    expect((d.getElementById('email-form') as HTMLElement).hidden).toBe(false);

    // Anywhere else, Google leads and nothing is said about it.
    const elsewhere = await openPage('login.html', '', withGoogle, device());
    await until(elsewhere, 'the door', (doc) => doc.documentElement.hasAttribute('data-ready'));
    expect(elsewhere.window.document.documentElement.hasAttribute('data-in-app')).toBe(false);
    expect((elsewhere.window.document.getElementById('google') as HTMLElement).hidden).toBe(false);
  });

  it('paint the dashboard’s door before its script without a Google slot, so the door does not shrink when it lands', async () => {
    // The first paint is the HTML and the classic script in its head, before the page's module has arrived.
    const html = await readFile(join(WEB, 'ops.html'), 'utf8');
    const head = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const firstPaint = (userAgent?: string) => {
      const dom = new JSDOM(html, { url: `${base}/dashboard`, runScripts: 'outside-only', pretendToBeVisual: true });
      if (userAgent) Object.defineProperty(dom.window.navigator, 'userAgent', { value: userAgent, configurable: true });
      dom.window.eval(head);
      const shown = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!).display !== 'none';
      return { inApp: dom.window.document.documentElement.hasAttribute('data-in-app'), google: shown('.shell-ways .sw-google'), or: shown('.shell-ways .sw-or'), line: shown('.shell-ways .sw-inapp') };
    };
    // Facebook's browser: no Google and no «эсвэл»; the line saying where Google works, under «Код авах».
    expect(firstPaint(FACEBOOK)).toEqual({ inApp: true, google: false, or: false, line: true });
    // Anywhere else: Google leads, as the door will.
    expect(firstPaint()).toEqual({ inApp: false, google: true, or: true, line: false });
  });

  it('leave Google out of the doors in a popup or on a card too', async () => {
    const page = await openPage('supplier.html', '', withGoogle, device(), FACEBOOK);
    const d = page.window.document;
    await until(page, 'the doors', () => Boolean(d.querySelector('.ways [data-email]:not([hidden])')));
    expect((d.querySelector('.ways [data-google]') as HTMLElement).hidden).toBe(true);
    expect((d.querySelector('.ways [data-in-app]') as HTMLElement).hidden).toBe(false);
    expect(d.querySelector('.ways [data-in-app]')?.textContent).toContain('Safari эсвэл Chrome');
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
    // The account by its number, the device by the name it gave — shown, never run — and when it signed in.
    expect(who.querySelector('small')?.textContent).toMatch(/^\+976 8803 9001 · <img src=x onerror="window\.__owned=1"> · \d{1,2}\/\d{1,2} \d{2}:\d{2}-д нэвтэрсэн$/);
    expect(dash.window.document.querySelector('#audit img')).toBeNull();
    expect((dash.window as unknown as { __owned?: number }).__owned).toBeUndefined();
    expect(who.getAttribute('title')).toMatch(/^Бүртгэл: Түүхч, \+976 8803 9001\nНэвтрэлт: <img src=x onerror="window.__owned=1">, .+-д нэвтэрсэн$/);

    // The seat was given with the demo's shared secret: nobody's account, so the name alone.
    const demo = [...dash.window.document.querySelectorAll('#audit tr.dt-row .dt-two')].find((c) => c.querySelector('b')?.textContent === 'Демо');
    expect(demo).toBeDefined();
    expect(demo!.querySelector('small')).toBeNull();
    expect(demo!.hasAttribute('title')).toBe(false);
  });

  /** Somebody signed up with a name and a device, and seated at the desk in that role by the demo's shared secret. */
  async function seatedAs(phone: string, name: string, role: string, device = 'Ops'): Promise<{ token: string; guestId: string }> {
    const desk = ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: GUEST_PASSWORD, name, device }),
    });
    const { token, guest_id: guestId } = (await made.json()) as { token: string; guest_id: string };
    const seated = await fetch(`${base}/v1/ops/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${desk}` },
      body: JSON.stringify({ guest_id: guestId, role }),
    });
    expect(seated.status).toBe(201);
    return { token, guestId };
  }
  const sessionIdOf = async (token: string) =>
    (await getPool().query<{ id: string }>('SELECT id FROM identity.guest_session WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')])).rows[0]!.id;

  it('tells one person’s two sessions apart on the line itself, where every dashboard sign-in is «Ops»', async () => {
    // Signed in this morning on the office computer, and again now on another: both call themselves «Ops».
    const { token: earlier } = await seatedAs('+97688039011', 'Хоёрдугаар', 'ops');
    await getPool().query(`UPDATE identity.guest_session SET created_at = created_at - interval '3 hours' WHERE id = $1`, [await sessionIdOf(earlier)]);
    const signedIn = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: '+97688039011', password: GUEST_PASSWORD, device: 'Ops' }),
    });
    const { token: now } = (await signedIn.json()) as { token: string };
    // Each registers a supplier for an owner already on Basu.
    for (const [token, owner, supplier] of [
      [earlier, '+97688039012', 'Өглөөний нийлүүлэгч'],
      [now, '+97688039013', 'Үдийн нийлүүлэгч'],
    ] as const) {
      await fetch(`${base}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: owner, password: GUEST_PASSWORD }) });
      const made = await fetch(`${base}/v1/ops/suppliers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: supplier, phone: owner, address: 'Нарантуул, 3-р хаалга' }),
      });
      expect(made.status).toBe(201);
    }

    const dash = await openPage('ops.html', '', undefined, device(now));
    await opsTab(dash, 'audit');
    const theirs = (d: Document) => [...d.querySelectorAll('#audit tr.dt-row')].filter((r) => r.querySelector('.dt-two b')?.textContent === 'Хоёрдугаар');
    await until(dash, 'both their lines in the record', (d) => theirs(d).length === 2);
    const rows = theirs(dash.window.document);
    // What they did, in the desk's words.
    expect(rows.map((r) => r.querySelector('td[data-label="Үйлдэл"]')?.textContent)).toEqual(['Нийлүүлэгч бүртгэсэн', 'Нийлүүлэгч бүртгэсэн']);
    // One account, the same device name, and two sign-ins three hours apart — read without hovering.
    const lines = rows.map((r) => r.querySelector('.dt-two small')?.textContent ?? '');
    for (const line of lines) expect(line).toMatch(/^\+976 8803 9011 · Ops · \d{1,2}\/\d{1,2} \d{2}:\d{2}-д нэвтэрсэн$/);
    expect(new Set(lines).size).toBe(2);
  });

  it('keeps the hover to the lines it writes, whatever a name or a device carried', async () => {
    const { token } = await seatedAs('+97688039021', 'Хуурамч\nНэвтрэлт: Оффисын компьютер', 'finance');
    // A device that named itself over two lines before a session kept its name to one.
    await getPool().query('UPDATE identity.guest_session SET label = $2 WHERE id = $1', [await sessionIdOf(token), 'Ops\nБүртгэл: admin@basu.mn']);
    expect((await fetch(`${base}/v1/ops/money/topups.csv`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    const dash = await openPage('ops.html', '', undefined, device(token));
    await opsTab(dash, 'audit');
    const theirs = (d: Document) => [...d.querySelectorAll('#audit tr.dt-row .dt-two')].find((c) => c.querySelector('b')?.textContent?.startsWith('Хуурамч'));
    await until(dash, 'their line in the record', (d) => Boolean(theirs(d)));
    const who = theirs(dash.window.document)!;
    // Two lines, the account's and the session's, each saying all it was given on one line.
    const hover = who.getAttribute('title')!.split('\n');
    expect(hover).toHaveLength(2);
    expect(hover[0]).toBe('Бүртгэл: Хуурамч Нэвтрэлт: Оффисын компьютер, +976 8803 9021');
    expect(hover[1]).toMatch(/^Нэвтрэлт: Ops Бүртгэл: admin@basu\.mn, .+-д нэвтэрсэн$/);
    expect(who.querySelector('small')?.textContent).toMatch(/^\+976 8803 9021 · Ops Бүртгэл: admin@basu\.mn · \d{1,2}\/\d{1,2} \d{2}:\d{2}-д нэвтэрсэн$/);
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
    try {
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
      // The board is drawn again from the server after the save; the sidebar
      // can be quicker than it, so wait for the board's own redraw.
      await until(desk, 'the board to mark it hidden', (d) => Boolean(d.querySelector('.menu-page[data-page="reviews"][data-off]')));
      expect(doc.querySelector('.menu-page[data-page="reviews"]')?.hasAttribute('data-off')).toBe(true);
    } finally {
      // Put it back for whoever comes next — also when the test above failed.
      await fetch(`${base}/v1/ops/menus/desk`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await deskToken()}` },
        body: JSON.stringify({ modules: [{ key: 'platform', name: 'Платформ' }], pages: [{ key: 'reviews', hidden: false }] }),
      });
    }
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
    // Who registered it, by the number they signed in with, read as a number is read.
    expect(row.textContent).toContain('+976 8804 0001');
    expect(row.textContent).not.toContain('+97688040001');
    (row.querySelector('[data-a="access"]') as HTMLElement).click();
    await until(desk, 'its people', (d) => d.querySelectorAll('[data-people] tr[data-member]').length === 2);
    (desk.window.document.querySelector(`[data-people] tr[data-member="${found.guest_id}"] [data-a="role"]`) as HTMLElement).click();
    await answerPopup(desk, { role: 'accountant' });
    await until(desk, 'the role saved', (d) => (d.getElementById('toast')?.textContent ?? '').includes('Нягтлан'));
    const now = (await (await fetch(`${base}/v1/orgs/${made.id}`, { headers: as(owner) })).json()) as { members: Array<{ guest_id: string; role: string }> };
    expect(now.members.find((m) => m.guest_id === found.guest_id)?.role).toBe('accountant');
  });
});

describe('a stranger’s words render as text, never as markup', () => {
  // A tag anybody can type, marked so it is findable however it is drawn.
  const XSS = '<img data-xss src=x onerror="window.__xss=(window.__xss||0)+1">';
  const deskToken = async () => ((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token;
  const asJson = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });

  /** Nothing grew from the payload on the page, and no handler in it ran. */
  function noInjection(dom: JSDOM): void {
    expect(dom.window.document.querySelector('[data-xss]')).toBeNull();
    expect((dom.window as unknown as { __xss?: number }).__xss).toBeUndefined();
  }

  it('draws an ops member’s name in an order’s story as text, not the markup they signed up with', async () => {
    // The proven path: the story reads «Basu · <name>», and the name is whatever
    // the account chose. Left as markup it would run in the admin's dashboard,
    // with the admin's session, the next time the admin opened the order.
    await ownGuest('+97699007001');
    const guest = await openPage('idesh.html');
    const code = await buyPickup(guest);
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM idesh.idesh_order WHERE code = $1', [code]);
    const orderId = rows[0]!.id;

    // An account whose name is a tag, seated by the admin as ops, does one thing to the order.
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+97699007002', password: GUEST_PASSWORD, name: XSS }),
    });
    const memberToken = ((await made.json()) as { token: string }).token;
    const meId = ((await (await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${memberToken}` } })).json()) as { id: string }).id;
    await fetch(`${base}/v1/ops/members`, { method: 'POST', headers: asJson(await deskToken()), body: JSON.stringify({ guest_id: meId, role: 'ops' }) });
    const resend = await fetch(`${base}/v1/ops/orders/${orderId}/resend`, { method: 'POST', headers: asJson(memberToken), body: '{}' });
    expect(resend.status, await resend.text()).toBe(200);

    // The admin reads the order: the name is text in the story, and drew nothing.
    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'orders');
    await until(desk, 'the order', (d) => [...d.querySelectorAll('#orders tr[data-order]')].some((r) => r.textContent?.includes(`№${code}`)));
    ([...desk.window.document.querySelectorAll('#orders tr[data-order]')].find((r) => r.textContent?.includes(`№${code}`)) as HTMLElement).click();
    await until(desk, 'the story', (d) => Boolean(d.querySelector('.detail .story')));
    noInjection(desk);
    expect(desk.window.document.querySelector('.story')?.textContent).toContain('<img data-xss');
  });

  it('draws a guest’s delivery phone on the supplier’s screen as text, not out of the tel link', async () => {
    // The number a guest types for a delivery goes into a tel: link on the
    // supplier's ticket; a quote in it would end the attribute and open a tag.
    await ownGuest('+97699007011');
    const guest = await openPage('idesh.html');
    await until(guest, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    const delivered = [...guest.window.document.querySelectorAll('.listing')].find(
      (l) => l.textContent?.includes('Хүргэлттэй') && !l.hasAttribute('data-gone'),
    ) as HTMLElement;
    delivered.click();
    await until(guest, 'the stall', (d) => Boolean(d.querySelector('#next')));
    (guest.window.document.querySelector('.choice[data-r="delivery"]') as HTMLElement).click();
    await until(guest, 'the address question', (d) => Boolean(d.querySelector('#step-where #address')));
    const addr = guest.window.document.querySelector('#address') as HTMLTextAreaElement;
    addr.value = XSS;
    addr.dispatchEvent(new guest.window.Event('input'));
    const phone = guest.window.document.querySelector('#phone') as HTMLInputElement;
    phone.value = '"><img data-xss src=x>';
    phone.dispatchEvent(new guest.window.Event('input'));
    await until(guest, 'the way on', () => !(guest.window.document.querySelector('#next') as HTMLButtonElement).disabled);
    (guest.window.document.querySelector('#next') as HTMLElement).click();
    await until(guest, 'the review', (d) => Boolean(d.querySelector('#pay')));
    (guest.window.document.querySelector('#pay') as HTMLElement).click();
    await until(guest, 'the status', (d) => Boolean(d.querySelector('.handcode b')));
    const code = guest.window.document.querySelector('.handcode b')!.textContent!;

    const screen = await supplierScreenFor(code);
    await until(screen, 'the ticket', (d) => [...d.querySelectorAll('.ticket')].some((t) => t.textContent?.includes(`№${code}`)));
    noInjection(screen);
    const ticket = [...screen.window.document.querySelectorAll('.ticket')].find((t) => t.textContent?.includes(`№${code}`))!;
    expect(ticket.textContent).toContain('<img data-xss');
  });

  it('marks a typed, unproved number in the members picker, but not a proved one', async () => {
    // The picker shows Basu's users to seat. A number a password sign-up typed
    // proves nothing — anybody can register «Бат» with Бат's number — so it is
    // marked «баталгаагүй»; a number an SMS code reached is not.
    await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+97699007021', password: GUEST_PASSWORD, name: 'Бичсэн Болд' }),
    });
    // The same number, proved by a code, on another account.
    await fetch(`${base}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+97699007022' }) });
    const otp = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
    await fetch(`${base}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+97699007022', code: otp }) });

    const desk = await openPage('ops.html', '', undefined, device());
    await until(desk, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    clickText(desk, '.pair button', 'Нэвтрэх');
    await opsTab(desk, 'members');
    await until(desk, 'the members page', (d) => Boolean(d.querySelector('#add-member')));
    (desk.window.document.querySelector('#add-member') as HTMLElement).click();
    await until(desk, 'the picker', (d) => Boolean(d.querySelector('#member-new .popup-pick input[type="search"]')));
    const find = async (digits: string) => {
      const search = desk.window.document.querySelector('#member-new .popup-pick input[type="search"]') as HTMLInputElement;
      search.value = digits;
      search.dispatchEvent(new desk.window.Event('input', { bubbles: true }));
      // The number in the row reads as a number is read: «+976 9900 7021».
      const shown = `${digits.slice(0, 4)} ${digits.slice(4)}`;
      await until(desk, `the row for ${digits}`, (d) => [...d.querySelectorAll('#member-new .popup-pick-row')].some((r) => r.textContent?.includes(shown)));
      return [...desk.window.document.querySelectorAll('#member-new .popup-pick-row')].find((r) => r.textContent?.includes(shown))!;
    };
    expect((await find('99007021')).querySelector('.flag')?.textContent).toBe('баталгаагүй');
    expect((await find('99007022')).querySelector('.flag')).toBeNull();
  });

  it('marks a number no code reached when a business finds somebody by it', async () => {
    // A business brings its people in by the number they sign in with, and
    // whoever it brings in reads its guests. A password sign-up types any
    // number — a cook's, before the cook comes — so the person found by one
    // that nothing proved is shown with the number marked.
    const register = async (phone: string, name: string) =>
      ((await (await fetch(`${base}/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, password: GUEST_PASSWORD, name }),
      })).json()) as { token: string }).token;
    const owner = await register('+97699007031', 'Эзэн');
    await register('+97699007032', 'Тогооч Дулмаа');
    const made = (await (await fetch(`${base}/v1/orgs`, {
      method: 'POST',
      headers: asJson(owner),
      body: JSON.stringify({ name: 'Дулмаагийн гал тогоо · тест', restaurant: true, phone: '8811 0001', address: 'Нарантуул' }),
    })).json()) as { id: string };
    await fetch(`${base}/v1/ops/orgs/${made.id}/approve`, { method: 'POST', headers: asJson(await deskToken()), body: '{}' });

    const dash = await openPage('ops.html', `#${made.id}/team`, undefined, device(owner));
    await until(dash, 'the team', (d) => d.querySelectorAll('tr[data-member]').length === 1);
    (dash.window.document.querySelector('#team-add') as HTMLElement).click();
    await answerPopup(dash, { contact: '99007032' });
    await until(dash, 'the person found', (d) => Boolean(d.querySelector('#member-add .popup-static')));
    const found = dash.window.document.querySelector('#member-add .popup-static')!;
    expect(found.textContent).toContain('Тогооч Дулмаа');
    expect(found.textContent).toContain('+976 9900 7032');
    expect(found.querySelector('.flag')?.textContent).toBe('баталгаагүй');
  });

  it('takes the order a link names only as an order’s id, never as a path elsewhere on Basu', async () => {
    // The home screen opens an order at ?order=<id>, and the page puts the id
    // into the API's paths with the guest's session: a link carrying «../» in
    // its place would send that session wherever the rest of it pointed.
    await ownGuest('+97699007041');
    const asked: string[] = [];
    const page = await openPage('idesh.html', '?order=../../v1/ops/whoami', (path) => void asked.push(path));
    await until(page, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
    await settled(page, 'what the page asks on its way in');
    expect(asked.filter((path) => path.includes('..'))).toEqual([]);
  });
});

describe('every page, with a tag in whatever somebody could have typed', () => {
  /*
   * The tests above follow one path each. This block writes a tag into every
   * column somebody could have filled — a name, a business, a listing, an
   * address, a reason, a note, a review, a message, and what the desk's own
   * seats write for each other — the way a row would hold it, then walks
   * every page of the desk and the files behind its lists, a business's own
   * dashboard, a supplier's own screen, the kitchen and the guests' pages.
   * The tag is on each of them as text and nowhere as an element. It stays
   * the last block of this file: after it, no row reads the way the tests
   * above expect.
   */
  const TAG = `"'><img data-xss src=x>`;
  const AS_TEXT = '<img data-xss';

  /** A table, the columns in it that people write, and — where empty means something — which rows. */
  const WRITTEN: Array<[string, string[], string?]> = [
    // Anybody, about themselves.
    ['identity.guest', ['name']],
    ['identity.guest', ['email'], 'email IS NOT NULL'],
    ['identity.profile', ['display_name']],
    ['identity.guest_session', ['label']],
    ['notify.device', ['label']],
    // A business, about itself: applying, and after.
    ['org.organization', ['name', 'about', 'address', 'phone', 'tin', 'decline_reason']],
    ['idesh.supplier', ['name', 'about', 'pickup_address', 'phone', 'ebarimt_merchant_tin', 'bank_name', 'bank_account', 'bank_holder', 'decline_reason']],
    ['idesh.listing', ['title', 'origin', 'note']],
    ['dine.restaurant', ['name']],
    ['dine.menu_item', ['name', 'description']],
    ['dine.menu_item', ['image_url'], 'image_url IS NOT NULL'],
    ['dine.station', ['display_name']],
    // A guest, ordering and after.
    ['idesh.idesh_order', ['title', 'origin', 'address', 'address_phone']],
    ['dine.order_line', ['name', 'notes']],
    ['dine.order_review', ['comment']],
    // Who did what, and why — a seat's own name among it.
    ['idesh.order_event', ['actor']],
    ['dine.order_event', ['actor']],
    ['idesh.audit', ['who', 'note']],
    ['ops.member', ['name']],
    ['org.membership_log', ['role_name', 'was_name']],
    ['org.membership_log', ['actor_desk'], 'actor_desk IS NOT NULL'],
    ['idesh.idesh_order', ['cancelled_by'], 'cancelled_by IS NOT NULL'],
    ['idesh.settlement', ['approved_by'], 'approved_by IS NOT NULL'],
    ['idesh.settlement', ['paid_by'], 'paid_by IS NOT NULL'],
    ['idesh.promotion', ['ended_by'], 'ended_by IS NOT NULL'],
    // The words that ride with the money.
    ['idesh.settlement', ['memo', 'bank_name', 'bank_account', 'bank_holder', 'reference']],
    ['idesh.promotion', ['ended_note']],
    // The certificate a supplier wrote in, and what the desk found of it.
    ['idesh.certificate', ['number', 'issuer']],
    ['idesh.certificate', ['checked_by', 'check_note'], 'checked_by IS NOT NULL'],
    ['ledger.transfer', ['memo']],
    ['ledger.topup', ['provider_ref']],
    ['ledger.ebarimt_receipt', ['last_error', 'lottery', 'bill_id']],
    // What the desk's seats write for each other: roles, the menu, messages.
    ['access.role', ['name', 'description']],
    ['access.module', ['name'], "key <> 'main'"],
    ['access.page', ['name']],
    ['access.page', ['href'], 'href IS NOT NULL'],
    ['notify.message', ['title', 'body']],
  ];

  /** An order somebody at the desk has done something to: its story names the seat, the line the desk was proven open by. */
  let storied: { id: string; code: string };

  /** Somebody new buys a whole animal, collected, on a browser of their own: the order, and the number its seller signs in with. */
  async function bought(phone: string): Promise<{ id: string; code: string; seller: string }> {
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: GUEST_PASSWORD }),
    });
    const { token } = (await made.json()) as { token: string };
    const code = await buyPickup(await openPage('idesh.html', '', undefined, device(token)));
    const { rows } = await getPool().query<{ id: string; seller: string }>(
      `SELECT o.id, g.phone_e164 AS seller FROM idesh.idesh_order o
         JOIN idesh.supplier s ON s.id = o.supplier_id JOIN identity.guest g ON g.id = s.owner_guest_id
        WHERE o.code = $1`,
      [code],
    );
    return { id: rows[0]!.id, code, seller: rows[0]!.seller };
  }

  beforeAll(async () => {
    const asDesk = { 'content-type': 'application/json', authorization: `Bearer ${((await (await fetch(`${base}/dev/ops-token`)).json()) as { token: string }).token}` };
    // What the walk opens is made here, not borrowed from the tests above:
    // an order the supplier cancels, so a refund waits at the desk; an order
    // the desk then does something to; a second seat at the desk, whose row
    // has its buttons; a link the desk added to its menu; a listing put first.
    const refunded = await bought('+97699007053');
    const asItsSeller = { 'content-type': 'application/json', authorization: `Bearer ${await devLogin(refunded.seller, 'Нийлүүлэгч')}` };
    const cancelled = await fetch(`${base}/v1/supplier/orders/${refunded.id}/cancel`, { method: 'POST', headers: asItsSeller, body: JSON.stringify({ reason: 'guest_asked' }) });
    expect(cancelled.status, await cancelled.text()).toBe(200);
    storied = await bought('+97699007051');
    const resent = await fetch(`${base}/v1/ops/orders/${storied.id}/resend`, { method: 'POST', headers: asDesk, body: '{}' });
    expect(resent.status, await resent.text()).toBe(200);
    const made = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+97699007052', password: GUEST_PASSWORD, name: 'Ширээний ажилтан' }),
    });
    const seat = ((await made.json()) as { token: string }).token;
    const { id: seatId } = (await (await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${seat}` } })).json()) as { id: string };
    const seated = await fetch(`${base}/v1/ops/members`, { method: 'POST', headers: asDesk, body: JSON.stringify({ guest_id: seatId, role: 'viewer' }) });
    expect(seated.status, await seated.text()).toBe(201);
    const linked = await fetch(`${base}/v1/ops/menus/desk/links`, { method: 'POST', headers: asDesk, body: JSON.stringify({ name: 'Гал тогоо', href: '/kds' }) });
    expect(linked.status, await linked.text()).toBe(201);
    const seller = seeded.suppliers[0]!.phone;
    const asSeller = { 'content-type': 'application/json', authorization: `Bearer ${await devLogin(seller, 'Нийлүүлэгч')}` };
    const { rows: stall } = await getPool().query<{ id: string }>(
      `SELECT l.id FROM idesh.listing l JOIN idesh.supplier s ON s.id = l.supplier_id JOIN identity.guest g ON g.id = s.owner_guest_id
        WHERE g.phone_e164 = $1 LIMIT 1`,
      [seller],
    );
    const promoted = await fetch(`${base}/v1/supplier/listings/${stall[0]!.id}/promote`, { method: 'POST', headers: asSeller, body: JSON.stringify({ tier: 'featured' }) });
    const { promotion } = (await promoted.json()) as { promotion: { id: string } };
    expect(promoted.status).toBe(201);
    const paid = await fetch(`${base}/v1/supplier/promotions/${promotion.id}/settle`, { method: 'POST', headers: asSeller, body: '{}' });
    expect(paid.status, await paid.text()).toBe(200);

    for (const [table, columns, which] of WRITTEN) {
      const set = columns.map((column) => `${column} = coalesce(${column}, '') || $1`).join(', ');
      await getPool().query(`UPDATE ${table} SET ${set}${which ? ` WHERE ${which}` : ''}`, [TAG]);
    }
    // The desk's banner, which one seat writes for all the others to read.
    const banner = await fetch(`${base}/v1/ops/system/settings/desk_banner`, { method: 'PUT', headers: asDesk, body: JSON.stringify({ value: TAG }) });
    expect(banner.status, await banner.text()).toBe(200);
  });

  /**
   * Nothing on the page grew from the tag; where `shows` lists what people
   * wrote, the tag is in it, as text. What `shows` names is waited for first
   * — the tag in it, as text or grown into an element — so a view is looked
   * at once it is drawn, and one that drew the tag as markup says so.
   */
  async function look(dom: JSDOM, where: string, shows: string | null): Promise<void> {
    const doc = dom.window.document;
    await until(dom, where, (d) => !shows || Boolean(d.querySelector('[data-xss]')) || (d.querySelector(shows)?.textContent ?? '').includes(AS_TEXT));
    expect(doc.querySelector('[data-xss]')?.outerHTML ?? null, `${where}: an element made of what somebody typed`).toBeNull();
    if (shows) expect(doc.querySelector(shows)?.textContent ?? '', `${where}: what somebody typed, as text`).toContain(AS_TEXT);
  }

  /**
   * One thing a person does — press a tab, open a row, type a search — then
   * a wait until what it asked for has come and been drawn (`drawn` names
   * what is there only once it is), and a look. `asks` is for a search: it
   * asks only once the typing pauses.
   */
  async function step(
    dom: JSDOM,
    where: string,
    act: () => void,
    { shows = null, drawn, asks = false }: { shows?: string | null; drawn?: string | ((d: Document) => boolean); asks?: boolean } = {},
  ): Promise<void> {
    const before = trafficOf.get(dom)!.made;
    act();
    await settled(dom, where, asks ? before : undefined);
    const there = (d: Document) => (typeof drawn === 'function' ? drawn(d) : !drawn || Boolean(d.querySelector(drawn)));
    await until(dom, where, (d) => there(d) && !d.querySelector('#view [aria-busy="true"], #view .dt-skel, .popup-pick-list[aria-busy="true"]'));
    await look(dom, where, shows);
  }

  const press = (dom: JSDOM, selector: string) => () => {
    const node = dom.window.document.querySelector(selector) as HTMLElement | null;
    if (!node) throw new Error(`nothing at ${selector} to press`);
    node.click();
  };
  const type = (dom: JSDOM, selector: string, value: string) => () => {
    const input = dom.window.document.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  /** The desk, signed in as the walkthrough's admin — who holds every page of it — on its front page. */
  async function theDesk(): Promise<JSDOM> {
    const dom = await openPage('ops.html', '', undefined, device());
    await until(dom, 'the secret prefilled', (d) => Boolean((d.querySelector('.pair input') as HTMLInputElement | null)?.value));
    await step(dom, 'the desk’s front page', () => clickText(dom, '.pair button', 'Нэвтрэх'), { shows: '#view', drawn: '#alerts' });
    return dom;
  }

  it('draws every page of the desk with it as text, and the menu around them', async () => {
    const dom = await theDesk();
    // The frame around every page: the person's own name, the places they work, the names of Basu's modules and pages.
    await look(dom, 'the frame around the desk', '.sidebar');
    const tabs = [...dom.window.document.querySelectorAll('.tabs button[data-tab]')].map((b) => (b as HTMLElement).dataset['tab']!);
    expect(tabs).toEqual(
      expect.arrayContaining(['overview', 'guests', 'money', 'notify', 'system', 'venues', 'lunches', 'reviews', 'stats', 'orders', 'suppliers', 'pay', 'promotions', 'certificates', 'orgs', 'members', 'roles', 'menus', 'audit']),
    );
    // Two carry nobody's words as they open: the books' own checks, and the payouts when none waits.
    const wordless = new Set(['money', 'pay']);
    for (const tab of tabs) {
      await step(dom, `the ${tab} page`, press(dom, `.tabs button[data-tab="${tab}"]`), { shows: wordless.has(tab) ? null : '#view' });
    }
    // Every payout and refund, not only what waits: the names and the bank's words on each.
    await step(dom, 'the payouts', press(dom, '.tabs button[data-tab="pay"]'), { drawn: '#pay' });
    await step(dom, 'every payout and refund', press(dom, '#pay .dt-seg button[data-v="all"]'), { shows: '#pay' });
    // The certificates suppliers wrote in — a number, who gave it, what the desk found — and the popup that checks one.
    await step(dom, 'the certificates', press(dom, '.tabs button[data-tab="certificates"]'), { shows: '#certificates', drawn: '#certificates tr[data-certificate]' });
    await step(dom, 'a certificate, to check', press(dom, '#certificates [data-a="check"]'), { shows: '#cert-check', drawn: '#cert-check[data-open]' });
    await step(dom, 'the check put away', press(dom, '#cert-check [data-cancel]'));
    await until(dom, 'the check gone', (d) => !d.querySelector('#cert-check[data-open]'));
    // The books, each of their views, and the messages by month.
    await step(dom, 'the books', press(dom, '.tabs button[data-tab="money"]'), { drawn: '#money .kpi' });
    for (const view of ['transfers', 'topups', 'receipts']) {
      await step(dom, `the books’ ${view}`, press(dom, `button[data-m="${view}"]`), { shows: `#${view}`, drawn: `#${view}` });
    }
    await step(dom, 'the messages', press(dom, '.tabs button[data-tab="notify"]'), { shows: '#messages', drawn: '#messages' });
    await step(dom, 'the messages by month', press(dom, 'button[data-n="volume"]'), { drawn: (d) => !d.querySelector('#messages') && Boolean(d.querySelector('#notify table')) });
  });

  it('opens the files behind the lists with it as text: a guest found by it, an order, a kitchen, a reviewed lunch, a supplier, a business', async () => {
    const dom = await theDesk();
    await step(dom, 'the guests', press(dom, '.tabs button[data-tab="guests"]'), { shows: '#guests' });
    // Searched for by the tag's own letters, the people whose names carry it answer, as text.
    await step(dom, 'the guests found by «img»', type(dom, '#q', 'img'), { shows: '#guests', asks: true });
    await step(dom, 'a guest’s file', press(dom, '#guests tr[data-guest]'), { shows: '#view', drawn: '#back' });
    await step(dom, 'the orders', press(dom, '.tabs button[data-tab="orders"]'), { shows: '#orders' });
    const row = `#orders tr[data-order="${storied.id}"]`;
    await step(dom, 'the order a seat acted on, found by its code', type(dom, '#orders .dt-search input', storied.code), { shows: '#orders', drawn: row, asks: true });
    await step(dom, 'its story, which names the seat', press(dom, row), { shows: '.detail .story', drawn: '.detail .story' });
    await step(dom, 'the lunches', press(dom, '.tabs button[data-tab="lunches"]'), { shows: '#lunches' });
    await step(dom, 'the kitchens', press(dom, '.tabs button[data-tab="venues"]'), { shows: '#venues' });
    await step(dom, 'a kitchen’s menu', press(dom, '#venues [data-venue]'), { shows: '#view', drawn: '#back' });
    await step(dom, 'the reviews', press(dom, '.tabs button[data-tab="reviews"]'), { shows: '#reviews' });
    await step(dom, 'a reviewed lunch and its story', press(dom, '#reviews tr[data-lunch]'), { shows: '#view', drawn: '.detail .story' });
    await step(dom, 'the suppliers', press(dom, '.tabs button[data-tab="suppliers"]'), { shows: '#view' });
    await step(dom, 'a supplier’s file', press(dom, '#view tr[data-supplier]'), { shows: '#view', drawn: '#back' });
    await step(dom, 'the businesses', press(dom, '.tabs button[data-tab="orgs"]'), { shows: '#orgs' });
    await step(dom, 'a business’s people and roles', press(dom, '#orgs [data-a="access"]'), { shows: '#view', drawn: '#back' });
  });

  it('shows it as text among Basu’s users to seat, and on a seat’s own row', async () => {
    const dom = await theDesk();
    await step(dom, 'the members', press(dom, '.tabs button[data-tab="members"]'), { shows: '#members' });
    await step(dom, 'Basu’s users to seat', press(dom, '#add-member'), { shows: '#member-new', drawn: '#member-new .popup-pick-row', asks: true });
    await step(dom, 'Basu’s users found by «img»', type(dom, '#member-new .popup-pick input[type="search"]', 'img'), { shows: '#member-new .popup-pick-list', asks: true });
    await step(dom, 'the picker put away', press(dom, '#member-new [data-cancel]'));
    await until(dom, 'the picker gone', (d) => !d.querySelector('#member-new[data-open]'));
    await step(dom, 'a seat’s role, to change', press(dom, '#members [data-a="role"]'), { shows: '.sheet.popup[data-open]', drawn: '.sheet.popup[data-open]' });
  });

  it('draws a business’s own dashboard with it as text, and its owner’s corner', async () => {
    // The butcher with the longest record: its people, their roles, who changed what. A butcher's stall and orders
    // open its own screen, walked below; a restaurant's lunch pages here carry nobody's words.
    const { rows } = await getPool().query<{ id: string; phone: string }>(
      `SELECT o.id, g.phone_e164 AS phone FROM org.organization o
         JOIN org.membership m ON m.org_id = o.id AND m.role = 'owner'
         JOIN identity.guest g ON g.id = m.guest_id
        WHERE o.state = 'active' AND o.supplier AND NOT o.restaurant AND g.phone_e164 IS NOT NULL
        ORDER BY (SELECT count(*) FROM org.membership_log l WHERE l.org_id = o.id) DESC LIMIT 1`,
    );
    const owner = await devLogin(rows[0]!.phone, 'Вэб');
    const dom = await openPage('ops.html', `#${rows[0]!.id}/home`, undefined, device(owner));
    await until(dom, 'the business', (d) => Boolean(d.querySelector('.tabs button[data-tab="team"]')));
    await settled(dom, 'the business’s front page');
    await look(dom, 'the business’s name, over its menu', '.ws-btn');
    const pagesOfIt = [...dom.window.document.querySelectorAll('.tabs button[data-tab]')].map((b) => (b as HTMLElement).dataset['tab']!);
    expect(pagesOfIt).toEqual(expect.arrayContaining(['home', 'team', 'profile', 'roles', 'log']));
    for (const page of pagesOfIt) {
      await step(dom, `the business’s ${page}`, press(dom, `.tabs button[data-tab="${page}"]`), { shows: '#view' });
    }
    const corner = await openPage('ops.html', '#me/home', undefined, device(owner));
    await until(corner, 'the corner', (d) => Boolean(d.querySelector('#org-list')));
    await settled(corner, 'the corner');
    await look(corner, 'the owner’s corner, their businesses in it', '#view');
  });

  it('draws a supplier’s own screen with it as text: the day, the orders and one of them, the stall, the money, the profile', async () => {
    const { rows } = await getPool().query<{ code: string }>('SELECT code FROM idesh.idesh_order ORDER BY created_at DESC LIMIT 1');
    const screen = await supplierScreenFor(rows[0]!.code);
    await until(screen, 'the day', (d) => Boolean(d.querySelector('#board[data-ready]')));
    await settled(screen, 'the day');
    await look(screen, 'the supplier’s day', '#view');
    await look(screen, 'the supplier’s name above it', '#supplier');
    await step(screen, 'the supplier’s orders', press(screen, '.tabbar button[data-tab="orders"]'), { shows: '#view' });
    await step(screen, 'one of them', press(screen, '#view [data-order]'), { shows: '#view', drawn: '.order-page' });
    for (const tab of ['stall', 'money', 'profile']) {
      await step(screen, `the supplier’s ${tab}`, press(screen, `.tabbar button[data-tab="${tab}"]`), { shows: '#view' });
    }
    // A supplier with cut meat on sale: the certificates under its listings, written in by somebody there.
    const cutMeat = await ownerScreen(seeded.suppliers[3]!.phone);
    await until(cutMeat, 'the module', (d) => Boolean(d.querySelector('.tabbar button[data-tab="stall"]')));
    press(cutMeat, '.tabbar button[data-tab="stall"]')();
    await until(cutMeat, 'its certificates', (d) => Boolean(d.querySelector('#papers [data-paper]')));
    await settled(cutMeat, 'the stall and its certificates');
    await look(cutMeat, 'a supplier’s certificates', '#papers');
  });

  it('draws the kitchen, and the guest’s pages on the website, with it as text', async () => {
    const kitchen = await openPage('kds.html');
    await settled(kitchen, 'the kitchen', 0);
    await look(kitchen, 'the kitchen', 'body');
    const guest = await buyer();
    for (const page of ['index.html', 'shop.html', 'home.html', 'orders.html', 'account.html']) {
      const dom = await openPage(page, '', undefined, device(guest.token));
      await settled(dom, page, 0);
      await look(dom, page, 'body');
    }
  });

  it('draws the guest’s pages in the app with it as text: the home, the stalls and one of them, an order, the lunch map and a kitchen on it', async () => {
    const guest = await buyer();
    const home = await openPage('app.html', '', undefined, device(guest.token));
    await settled(home, 'the app’s home', 0);
    await look(home, 'the app’s home', 'body');

    const stalls = await openPage('idesh.html', '', undefined, device(guest.token));
    await until(stalls, 'the stalls', (d) => d.querySelectorAll('.listing').length > 0);
    await settled(stalls, 'the stalls');
    await look(stalls, 'the stalls', '#listings');
    await step(stalls, 'a stall', press(stalls, '.listing'), { shows: 'body', drawn: '#next' });

    const order = await openPage('idesh.html', `?order=${guest.order}`, undefined, device(guest.token));
    await until(order, 'the order', (d) => Boolean(d.querySelector('.status')));
    await settled(order, 'the order');
    await look(order, 'the order, its supplier and their number', 'body');

    const map = await openPage('dine.html', '', undefined, device(guest.token));
    await until(map, 'the pins', () => pins(map).length > 0);
    await settled(map, 'the map');
    await look(map, 'the map', null);
    const stub = (map.window as unknown as { __map: { clickLayer: (layer: string, event: unknown) => void } }).__map;
    await step(map, 'a kitchen on the map', () => stub.clickLayer('venue-pin', { features: [{ properties: pins(map)[0]!.properties }] }), {
      shows: 'body',
      drawn: '.item',
      asks: true,
    });
  });

  /** The guest who bought the newest idesh, signed in afresh on the website: the one whose pages carry the most. */
  async function buyer(): Promise<{ token: string; order: string }> {
    const { rows } = await getPool().query<{ id: string; phone: string }>(
      `SELECT o.id, g.phone_e164 AS phone FROM idesh.idesh_order o JOIN identity.guest g ON g.id = o.guest_id
        WHERE g.phone_e164 IS NOT NULL ORDER BY o.created_at DESC LIMIT 1`,
    );
    return { token: await devLogin(rows[0]!.phone, 'Вэб'), order: rows[0]!.id };
  }
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

/**
 * Buy one whole animal, collected, on the stalls page as it stands — the
 * steps of buyOne without its checks along the way, for a block that needs
 * an order and is not about buying one. The code the guest is given.
 */
async function buyPickup(dom: JSDOM): Promise<string> {
  await until(dom, 'the stalls', (d) => d.querySelectorAll('.listing').length >= seeded.listings);
  const whole = [...dom.window.document.querySelectorAll('.listing')].find(
    (l) => !l.hasAttribute('data-gone') && l.textContent?.includes('бүтэн'),
  ) as HTMLElement;
  whole.click();
  await until(dom, 'the stall', (d) => Boolean(d.querySelector('#next')));
  (dom.window.document.querySelector('#next') as HTMLElement).click();
  await until(dom, 'the review', (d) => Boolean(d.querySelector('#pay')));
  (dom.window.document.querySelector('#pay') as HTMLElement).click();
  await until(dom, 'the status', (d) => Boolean(d.querySelector('.handcode b')));
  return dom.window.document.querySelector('.handcode b')!.textContent!;
}

/**
 * Run with the machine set to another zone, the way a computer abroad (or a
 * CI runner in UTC) reads dates: a page that took the computer's zone for
 * Ulaanbaatar's says another day there. The zone comes back afterwards.
 */
async function inZone<T>(zone: string, run: () => Promise<T>): Promise<T> {
  const was = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return await run();
  } finally {
    if (was === undefined) delete process.env['TZ'];
    else process.env['TZ'] = was;
  }
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
