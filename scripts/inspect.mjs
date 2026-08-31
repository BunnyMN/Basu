#!/usr/bin/env node
/**
 * Open a page in a real browser and report what it actually did.
 *
 * The map failing taught the lesson: a tile can be byte-perfect at the proxy
 * and still never be asked for, and no amount of curl reveals that. This drives
 * Chrome, so console errors, failed requests and WebGL are the real ones.
 *
 *   npm run inspect                       # the guest page, locally
 *   npm run inspect -- https://host/kds   # anywhere
 */
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { launch } from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] ?? 'http://localhost:3000/';
const seconds = Number(process.argv[3] ?? 8);
const shot = process.argv.find((a) => a.endsWith('.png'));

const browser = await launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });

const console_ = [];
const failed = [];
const requests = new Map();

page.on('console', async (message) => {
  const type = message.type();
  if (type !== 'error' && type !== 'warning') return;
  // message.text() renders an Error as "[object Error]", which is the one
  // thing it must not do here. Pull the arguments out properly.
  try {
    const parts = await Promise.all(
      message.args().map((arg) =>
        arg.evaluate((value) =>
          value instanceof Error ? `${value.name}: ${value.message}` : String(value),
        ),
      ),
    );
    const line = parts.join(' ').trim();
    if (line) console_.push(`${type}: ${line}`);
  } catch {
    console_.push(`${type}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => console_.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) =>
  failed.push(`${request.url()} — ${request.failure()?.errorText}`),
);
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  // Tiles and glyphs are counted by family, not one line each.
  const key = path.startsWith('/tiles/')
    ? '/tiles/*'
    : path.startsWith('/fonts/')
      ? '/fonts/*'
      : path;
  const entry = requests.get(key) ?? { n: 0, statuses: new Set() };
  entry.n++;
  entry.statuses.add(response.status());
  requests.set(key, entry);
});

console.log(`\n${url}\n`);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, seconds * 1000));

console.log('Хүсэлт');
for (const [path, { n, statuses }] of [...requests].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(n).padStart(3)}×  ${[...statuses].join(',')}  ${path}`);
}

if (failed.length) {
  console.log('\nБүтэлгүй');
  for (const line of failed.slice(0, 10)) console.log(`  ${line}`);
}

if (console_.length) {
  console.log('\nКонсол');
  for (const line of [...new Set(console_)].slice(0, 15)) console.log(`  ${line}`);
}

// What the page believes about itself, asked directly.
const state = await page
  .evaluate(() => {
    // `window.map` is the <div id="map"> — named access on Window, not our map.
    const map = window.__map;
    const out = { hasMap: typeof map?.getStyle === 'function' };
    if (!out.hasMap) return out;
    try {
      out.sources = Object.keys(map.style.sourceCaches ?? map.getStyle().sources ?? {});
      out.layers = (map.getStyle().layers ?? []).length;
      out.zoom = Number(map.getZoom().toFixed(2));
      out.loaded = map.loaded?.();
      // Source caches move between MapLibre versions; report what we find.
      const caches = map.style?.sourceCaches ?? map.style?._sourceCaches ?? {};
      const counts = Object.entries(caches).map(
        ([id, cache]) => `${id}:${Object.keys(cache._tiles ?? {}).length}`,
      );
      if (counts.length) out.tiles = counts.join(' · ');
    } catch (error) {
      out.error = String(error);
    }
    return out;
  })
  .catch((error) => ({ error: String(error) }));

console.log('\nГазрын зураг');
for (const [key, value] of Object.entries(state)) {
  console.log(`  ${key}: ${Array.isArray(value) ? value.join(' · ') : value}`);
}

/**
 * A picture, because "the tiles were requested" is not the same claim as "the
 * map drew".
 *
 * The sample is taken from a screenshot rather than from the canvas: a WebGL
 * context without preserveDrawingBuffer reads back blank, so drawImage on it
 * reports one flat colour for a map that is drawing perfectly. That misread
 * cost a round of debugging on a bug that was already fixed.
 */
const png = await page.screenshot({ type: 'png' });
const colours = countColours(png);
console.log(`\nЗураас  ${colours > 200 ? '✓ зурагдсан' : '✗ хоосон'}  (${colours} өнгө)`);

if (shot) {
  await writeFile(shot, png);
  console.log(`  ${shot}`);
}

console.log('');
await browser.close();

/** Distinct colours in a PNG, quantised. A blank map has a handful. */
function countColours(buffer) {
  const png = PNG.sync.read(buffer);
  const seen = new Set();
  for (let y = 0; y < png.height; y += 3) {
    for (let x = 0; x < png.width; x += 3) {
      const i = (png.width * y + x) << 2;
      seen.add((png.data[i] >> 3) * 1024 + (png.data[i + 1] >> 3) * 32 + (png.data[i + 2] >> 3));
    }
  }
  return seen.size;
}
