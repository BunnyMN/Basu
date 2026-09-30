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
  const csp = h.get('content-security-policy') ?? '';
  check('Content-Security-Policy толгой', csp.includes("default-src 'self'"));
  // A CDN named whole lets any library it serves run here; the policy names the one file a page loads.
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
  check('CSP: CDN бүхэлдээ биш, зөвхөн тухайн скрипт', !/https:\/\/[^\s/]+(\/)?(\s|$)/.test(scriptSrc), scriptSrc.trim().slice(0, 120));
  check('Strict-Transport-Security толгой', (h.get('strict-transport-security') ?? '').includes('max-age='));
  check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options: DENY', h.get('x-frame-options') === 'DENY');
  check('Referrer-Policy', Boolean(h.get('referrer-policy')));

  for (const path of ['/dev/ops-token', '/dev/clock', '/dev/suppliers', '/dev/kitchens']) {
    const r = await head(path);
    check(`демо зам хаалттай ${path}`, r.status === 404, `HTTP ${r.status}`);
  }
  const login = await fetch(`${base}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+97699000000"}' });
  check('демо нэвтрэлт хаалттай /dev/login', login.status === 404, `HTTP ${login.status}`);

  const desk = await head('/v1/ops/suppliers');
  check('ops хаалга сессгүй хаалттай', desk.status === 401, `HTTP ${desk.status}`);

  // Every per-address limit counts the address nginx saw, whatever the caller
  // wrote in X-Forwarded-For: two knocks under two made-up addresses are one
  // caller, so the second finds the count the first left. Asked twice, in
  // case a window closed between the two.
  const left = async (as) =>
    Number((await fetch(`${base}/health`, { headers: { 'x-forwarded-for': as } })).headers.get('x-ratelimit-remaining'));
  let counted = false;
  let counts = '';
  for (let i = 0; i < 2 && !counted; i++) {
    const first = await left('203.0.113.7');
    const second = await left('198.51.100.7');
    counted = second < first;
    counts = `${first} → ${second}`;
  }
  check('хуурамч X-Forwarded-For хязгаарыг тойрохгүй', counted, counts);

  const foreign = await fetch(`${base}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+15550001111"}' });
  check('гадаад дугаарт код илгээхгүй', foreign.status === 400, `HTTP ${foreign.status}`);

  // Google comes back to a page with a code, never a session; one nobody was given opens nothing.
  const handoff = await fetch(`${base}/v1/auth/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"made-up"}' });
  check('Google-ээс буцсан код: зохиомол кодоор нэвтрэхгүй', handoff.status === 400, `HTTP ${handoff.status}`);

  // Which ways in are open: Google and email need keys only the server holds.
  const methods = await head('/v1/auth/methods');
  const open = methods.status === 200 ? JSON.parse(methods.text) : null;
  check('нэвтрэх хаалга бүртгэлтэй', Boolean(open), `HTTP ${methods.status}`);
  if (open) {
    check('имэйл код нээлттэй (SMTP_URL, MAIL_FROM)', open.email === true);
    check('Google нээлттэй (GOOGLE_CLIENT_ID, _SECRET)', open.google === true);
    // Without an SMS gateway nobody receives a code, so the door must not
    // take guesses at one either.
    if (open.sms !== true) {
      const guess = await fetch(`${base}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+97699000000","code":"000000"}' });
      check('SMS код хаалттай (gateway алга)', guess.status === 503, `HTTP ${guess.status}`);
    }
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
