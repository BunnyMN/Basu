#!/usr/bin/env node
/**
 * Is this server production, seen from outside? Run before and after the
 * switch: `npm run check:prod -- https://basu.burzai.cloud`.
 *
 * Nothing here needs a secret. It asks the questions an attacker would ask
 * first — is the demo door still open, are the headers on, is the desk
 * shut without a session — and prints one line per answer.
 */
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

async function head(path) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

try {
  const home = await head('/');
  check('нүүр хуудас нээгдэнэ', home.status === 200, `HTTP ${home.status}`);
  const h = home.headers;
  check('Content-Security-Policy толгой', (h.get('content-security-policy') ?? '').includes("default-src 'self'"));
  check('Strict-Transport-Security толгой', (h.get('strict-transport-security') ?? '').includes('max-age='));
  check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options: DENY', h.get('x-frame-options') === 'DENY');
  check('Referrer-Policy', Boolean(h.get('referrer-policy')));

  for (const path of ['/dev/ops-token', '/dev/clock', '/dev/suppliers', '/dev/supplier-codes']) {
    const r = await head(path);
    check(`демо зам хаалттай ${path}`, r.status === 404, `HTTP ${r.status}`);
  }
  const login = await fetch(`${base}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+97699000000"}' });
  check('демо нэвтрэлт хаалттай /dev/login', login.status === 404, `HTTP ${login.status}`);

  const desk = await head('/v1/ops/suppliers');
  check('ops хаалга сессгүй хаалттай', desk.status === 401, `HTTP ${desk.status}`);

  const foreign = await fetch(`${base}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+15550001111"}' });
  check('гадаад дугаарт код илгээхгүй', foreign.status === 400, `HTTP ${foreign.status}`);

  // Which ways in are open: Google and email need keys only the server holds.
  const methods = await head('/v1/auth/methods');
  const open = methods.status === 200 ? JSON.parse(methods.text) : null;
  check('нэвтрэх хаалга бүртгэлтэй', Boolean(open), `HTTP ${methods.status}`);
  if (open) {
    check('имэйл код нээлттэй (SMTP_URL, MAIL_FROM)', open.email === true);
    check('Google нээлттэй (GOOGLE_CLIENT_ID, _SECRET)', open.google === true);
    const google = await head('/v1/auth/google/start?return=https://evil.example');
    const to = google.headers.get('location') ?? '';
    check('Google эхлэл Google руу, state cookie-тэй', !open.google || (to.startsWith('https://accounts.google.com/') && (google.headers.get('set-cookie') ?? '').includes('HttpOnly')), `HTTP ${google.status}`);
  }

  const tls = base.startsWith('https://');
  check('HTTPS', tls, tls ? '' : 'http-ээр шалгаж байна');
} catch (error) {
  check('серверт холбогдох', false, String(error).slice(0, 120));
}

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
}
console.log(bad ? `\n✗ ${bad} шалгалт унасан — production биш, эсвэл дутуу.` : '\n✓ Гаднаас харахад production.');
process.exit(bad ? 1 : 0);
