#!/usr/bin/env node
/**
 * The picture a shared link carries: what Facebook, Messenger and Viber show
 * under somebody's message when they paste basu.burzai.cloud — 1200 × 630.
 *
 *   node scripts/og-image.mjs [out.jpg]
 *
 * The front page's own photograph and headline in «Тансаг хар»: the wordmark,
 * a gold eyebrow, the headline in Noto Sans Display Condensed at 800, one line
 * under it. Rendered by the Chrome already on the machine, through
 * puppeteer-core, from the files the site serves — nothing is downloaded.
 *
 * Sites keep a shared picture by its address, so a new look goes out under a
 * new name (og-dark.jpg after og.jpg) and the pages' `og:image` follows it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'src', 'web');
const [out = join(web, 'brand', 'og-dark.jpg')] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const data = (file, type) => `data:${type};base64,${readFileSync(join(web, file)).toString('base64')}`;

const html = `<!doctype html><html lang="mn"><head><meta charset="utf-8"><style>
@font-face{font-family:"Noto Sans Display Condensed";font-weight:800;src:url("${data('fonts/NotoSansDisplay-CondensedExtraBold.v3.woff2', 'font/woff2')}") format("woff2")}
@font-face{font-family:"Manrope";font-weight:500;src:url("${data('fonts/Manrope-Medium.v3.woff2', 'font/woff2')}") format("woff2")}
@font-face{font-family:"Manrope";font-weight:700;src:url("${data('fonts/Manrope-Bold.v3.woff2', 'font/woff2')}") format("woff2")}
html,body{margin:0;width:1200px;height:630px;background:#100D0C;overflow:hidden}
.ph{position:absolute;left:530px;right:-190px;top:-20px;bottom:-50px}
.ph img{width:100%;height:100%;object-fit:cover;object-position:30% 50%;filter:sepia(.14) saturate(1.25) contrast(1.14) brightness(1.03)}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,#100D0C 0%,#100D0C 45%,rgba(16,13,12,.8) 54%,rgba(16,13,12,.2) 69%,rgba(16,13,12,0) 80%),linear-gradient(0deg,rgba(16,13,12,.6) 0%,rgba(16,13,12,0) 32%)}
.copy{position:absolute;left:72px;top:60px;bottom:62px;width:720px;display:flex;flex-direction:column}
.word{font-family:"Noto Sans Display Condensed";font-weight:800;font-size:46px;line-height:1;color:#F6F0E8;letter-spacing:.01em}
.lab{margin-top:auto;display:flex;align-items:center;gap:14px;font-family:"Manrope";font-weight:700;font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#C9A96E}
.lab i{display:block;width:36px;height:1px;background:rgba(201,169,110,.7)}
h1{margin:20px 0 0;font-family:"Noto Sans Display Condensed";font-weight:800;font-size:100px;line-height:.9;color:#F6F0E8;white-space:nowrap}
p{margin:26px 0 0;font-family:"Manrope";font-weight:500;font-size:24px;line-height:1.35;color:#C4BAB0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#D21F3C;box-shadow:0 0 18px rgba(210,31,60,.8);margin-right:14px;vertical-align:middle;position:relative;top:-2px}
</style></head><body>
<div class="ph"><img src="${data('brand/meat/hero.webp', 'image/webp')}" alt=""></div>
<div class="shade"></div>
<div class="copy">
  <div class="word">Basu</div>
  <div class="lab"><i></i>Шинэ мах · Эцсийн үнэ</div>
  <h1>Өвлийн идэшээ<br>эртхэн захиал.</h1>
  <p><span class="dot"></span>Бүтэн мал эсвэл кг-аар. QPay-ээр төлнө.</p>
</div>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
  console.log(`✓ ${out}`);
} finally {
  await browser.close();
}
