#!/usr/bin/env node
/**
 * Walk the guest flow in a real browser with a real position, and report
 * whether the route was asked for and drawn.
 *
 * The map failing twice taught this: what the page believes and what it does
 * are separate claims, and only the browser can settle either.
 */
import { launch } from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.argv[2] ?? 'http://localhost:3000';

const browser = await launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const context = browser.defaultBrowserContext();
await context.overridePermissions(BASE, ['geolocation']);

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 780 });
// A few hundred metres from the cluster: a real walk, not a teleport — and at
// the precision a phone actually reports. Four tidy decimals passed a check
// that every real fix failed.
await page.setGeolocation({ latitude: 47.92051234567, longitude: 106.91052341234 });

const calls = [];
const errors = [];
page.on('request', (r) => {
  const p = new URL(r.url()).pathname;
  if (p.startsWith('/v1/route') || p.startsWith('/v1/orders')) calls.push(`${r.method()} ${p}`);
});
page.on('console', async (m) => {
  if (m.type() !== 'error') return;
  try {
    const parts = await Promise.all(
      m.args().map((a) => a.evaluate((v) => (v instanceof Error ? v.message : String(v)))),
    );
    const line = parts.join(' ').trim();
    if (line) errors.push(line);
  } catch {
    errors.push(m.text());
  }
});

const step = (label, ok, extra) =>
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`);

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__map?.getSource?.('venues'), { timeout: 20_000 });

const venue = await page.evaluate(async () => {
  const list = await (await fetch('/v1/restaurants')).json();
  const open = list.restaurants.find((r) => r.accepting_orders && r.lat);
  return open ? { id: open.id, name: open.name } : null;
});
step('venue chosen', Boolean(venue), venue?.name);

// Tap the pin. MapLibre routes layer clicks itself, so go in the same door:
// fire the delegated event with the feature the layer would have carried.
await page.evaluate((id) => {
  window.__map.fire('click', {
    lngLat: { lng: 0, lat: 0 },
    point: { x: 0, y: 0 },
    features: [{ properties: { id } }],
  });
}, venue.id);

await page.waitForFunction(() => document.querySelectorAll('.item').length > 2, {
  timeout: 15_000,
});
step('menu opened', true);

await page.evaluate(() => {
  document.querySelector('.item button[data-d="1"]').click();
  const slot = [...document.querySelectorAll('.slot')].find((s) => !s.disabled);
  slot.click();
});
await page.waitForFunction(
  () => document.querySelector('.sheet footer button')?.textContent.includes('төлөх'),
  { timeout: 10_000 },
);
await page.evaluate(() => document.querySelector('.sheet footer button').click());

await page.waitForFunction(() => document.querySelector('.status'), { timeout: 20_000 });
const code = await page.evaluate(() => document.querySelector('#sheet-name')?.textContent);
step('order placed', true, code);

// The kitchen takes it, which is when the route is supposed to appear.
const orderId = await page.evaluate(async () => {
  const board = await (await fetch('/dev/kds/tickets')).json();
  const all = [...board.lanes.incoming, ...board.lanes.cooking, ...board.lanes.ready];
  return all[0]?.id ?? null;
});
await page.evaluate(
  (id) => fetch(`/dev/kds/tickets/${id}/accept`, { method: 'POST' }),
  orderId,
);
await new Promise((r) => setTimeout(r, 6000));

const drawn = await page.evaluate(() => {
  // What the map is actually painting, not what a source was handed. The two
  // came apart once already: an invalid paint expression left the source full
  // and the screen empty.
  const map = window.__map;
  const painted = map.queryRenderedFeatures({ layers: ['route-line', 'route-guess'] });
  const source = map.getSource('walk');
  const held = source?.serialize?.().data?.features?.length ?? 0;
  return {
    held,
    painted: painted.length,
    points: painted[0]?.geometry?.coordinates?.length ?? 0,
    label: document.getElementById('sheet-walk')?.textContent ?? '',
    here: Boolean(document.querySelector('.maplibregl-user-location-dot')),
  };
});

step('position known', drawn.here);
step('route requested', calls.some((c) => c.includes('/v1/route')));
step('route in source', drawn.held > 0);
step('route painted', drawn.painted > 0, `${drawn.points} цэг`);
step('distance shown', drawn.label.length > 0, drawn.label.replace(/\s+/g, ' ').trim());

const shot = process.argv.find((v) => v.endsWith('.png'));
if (shot) {
  // Dismiss the sheet so the route is not behind it.
  await page.evaluate(() => document.querySelector('#sheet-close')?.click());
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: shot });
  console.log(`  ${shot}`);
}

console.log('\n  дуудлага:', [...new Set(calls)].join(' · ') || '—');
if (errors.length) console.log('  алдаа:  ', [...new Set(errors)].slice(0, 5).join('\n           '));

await browser.close();
