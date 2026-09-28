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

function page(shot) {
  const dark = shot.theme === 'dark';
  const ground = dark ? brand.darkGround : brand.lightGround;
  const ink = dark ? '#F3F2EF' : '#161514';
  const ink2 = dark ? 'rgba(243,242,239,.72)' : 'rgba(22,21,20,.66)';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Golos;font-weight:400;src:url(${font('GolosText-Regular.ttf')})}
@font-face{font-family:Golos;font-weight:600;src:url(${font('GolosText-SemiBold.ttf')})}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:Golos,sans-serif;background:${ground};color:${ink};position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(1100px 900px at 50% 16%, ${brand.glow}, transparent 70%)}
.words{position:absolute;top:150px;left:96px;right:96px;text-align:center}
.eyebrow{display:inline-block;font-size:34px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${dark ? brand.accentDark ?? brand.accent : brand.accent};margin-bottom:34px}
h1{font-size:${shot.headline.length > 34 ? 92 : 104}px;font-weight:600;line-height:1.07;letter-spacing:-.025em}
p{margin-top:30px;font-size:44px;line-height:1.35;color:${ink2}}
.phone{position:absolute;left:50%;top:${shot.eyebrow ? 640 : 580}px;width:1010px;transform:translateX(-50%);
  border-radius:150px;background:#0B0B0A;padding:22px;
  box-shadow:0 60px 120px -30px rgba(0,0,0,${dark ? '.7' : '.32'}),0 0 0 3px rgba(255,255,255,${dark ? '.10' : '.0'})}
.phone img{display:block;width:100%;border-radius:128px}
.island{position:absolute;top:50px;left:50%;transform:translateX(-50%);width:250px;height:72px;border-radius:40px;background:#000}
</style></head><body>
<div class="glow"></div>
<div class="words">
  ${shot.eyebrow ? `<div class="eyebrow">${esc(shot.eyebrow)}</div>` : ''}
  <h1>${esc(shot.headline)}</h1>
  ${shot.sub ? `<p>${esc(shot.sub)}</p>` : ''}
</div>
<div class="phone"><img src="${png(shot.screen)}"><div class="island"></div></div>
</body></html>`;
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
    const file = join(outDir, `${String(i + 1).padStart(2, '0')}-${shot.name}.png`);
    await tab.screenshot({ path: file, type: 'png' });
    console.log(file);
  }
} finally {
  await browser.close();
}
