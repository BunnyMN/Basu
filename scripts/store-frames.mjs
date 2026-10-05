#!/usr/bin/env node
/**
 * The App Store's pictures: a headline, a line under it, and the app's own
 * screen in a phone, on the brand's ground — 1320 × 2868, the 6.9" size the
 * store scales down for every smaller iPhone.
 *
 *   node scripts/store-frames.mjs <raw-dir> <out-dir> [design/store/shots.json]
 *
 * <raw-dir> holds the screens as the simulator saw them (the StoreShots UI
 * test writes them there); shots.json says which screen goes with which
 * words, in the order the store shows them. Rendered by the Chrome already on
 * the machine, through puppeteer-core — nothing is downloaded.
 *
 * Every screen shows the app as it is on the real server, or the developer's
 * own with nobody else's business in it: no invented restaurant, supplier or
 * price is ever photographed for the store.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [rawDir, outDir, plan = join(root, 'design', 'store', 'shots.json')] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error('node scripts/store-frames.mjs <raw-dir> <out-dir> [shots.json]');
  process.exit(1);
}
const { brand, shots } = JSON.parse(readFileSync(plan, 'utf8'));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1320;
const H = 2868;

const font = (file) => `data:font/ttf;base64,${readFileSync(join(root, 'ios', 'Fonts', file)).toString('base64')}`;
const png = (file) => `data:image/png;base64,${readFileSync(resolve(rawDir, file)).toString('base64')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Escaped, with a dash held to the word before it: no line starts with «—». */
const words = (s) => esc(s).replace(/ ([—–])/g, '\u00a0$1');

/**
 * «Тансаг хар» (2026-10-05): one ground, the app's warm charcoal; the eyebrow
 * in gold; the headline in Noto Sans Display Condensed at 800 and the line
 * under it in Manrope — the app's own two faces, read from ios/Fonts.
 *
 * The phone sits at the same height in every picture, and the words stand on
 * it: their last line is always the same distance above the phone, so a short
 * headline leaves air at the top rather than a gap over the screen. A headline
 * is two lines at most (see `fit`).
 */
function page(shot) {
  const phoneTop = shot.eyebrow ? 640 : 580;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Manrope;font-weight:500;src:url(${font('Manrope-Medium.ttf')})}
@font-face{font-family:Manrope;font-weight:700;src:url(${font('Manrope-Bold.ttf')})}
@font-face{font-family:Display;font-weight:800;src:url(${font('NotoSansDisplay-CondensedExtraBold.ttf')})}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:Manrope,sans-serif;background:${brand.ground};color:${brand.ink};position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(1100px 900px at 50% 16%, ${brand.glow}, transparent 70%)}
.words{position:absolute;bottom:${H - phoneTop + 72}px;left:96px;right:96px;text-align:center}
.eyebrow{display:inline-block;font-size:34px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${brand.gold};margin-bottom:34px}
h1{font-family:Display,sans-serif;font-size:140px;font-weight:800;line-height:.92;text-wrap:balance}
p{margin-top:34px;font-size:44px;font-weight:500;line-height:1.35;color:${brand.ink2};text-wrap:balance}
.phone{position:absolute;left:50%;top:${phoneTop}px;width:1010px;transform:translateX(-50%);
  border-radius:150px;background:#0B0B0A;padding:22px;
  box-shadow:0 60px 120px -30px rgba(0,0,0,.8),0 0 0 3px rgba(255,244,236,.10)}
.phone img{display:block;width:100%;border-radius:128px}
.island{position:absolute;top:50px;left:50%;transform:translateX(-50%);width:250px;height:72px;border-radius:40px;background:#000}
</style></head><body>
<div class="glow"></div>
<div class="words">
  ${shot.eyebrow ? `<div class="eyebrow">${esc(shot.eyebrow)}</div>` : ''}
  <h1>${words(shot.headline)}</h1>
  ${shot.sub ? `<p>${words(shot.sub)}</p>` : ''}
</div>
<div class="phone"><img src="${png(shot.screen)}"><div class="island"></div></div>
</body></html>`;
}

/**
 * Two lines of headline at most, and the words never up into the top margin:
 * a long headline is set smaller, measured in the page with the real faces,
 * rather than allowed to run into the line under it or behind the phone.
 */
function fit() {
  const h1 = document.querySelector('h1');
  const block = document.querySelector('.words');
  let size = parseFloat(getComputedStyle(h1).fontSize);
  const lines = () => Math.round(h1.getBoundingClientRect().height / (size * 0.92));
  while ((lines() > 2 || block.getBoundingClientRect().top < 120) && size > 96) {
    size -= 2;
    h1.style.fontSize = `${size}px`;
  }
  return { size, lines: lines() };
}

mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  const tab = await browser.newPage();
  await tab.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  for (const [i, shot] of shots.entries()) {
    if (!existsSync(resolve(rawDir, shot.screen))) {
      console.error(`missing ${shot.screen}`);
      process.exitCode = 1;
      continue;
    }
    await tab.setContent(page(shot), { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    const set = await tab.evaluate(fit);
    const file = join(outDir, `${String(i + 1).padStart(2, '0')}-${shot.name}.png`);
    await tab.screenshot({ path: file, type: 'png' });
    console.log(`${file}  (headline ${set.size}px, ${set.lines} line${set.lines > 1 ? 's' : ''})`);
  }
} finally {
  await browser.close();
}
