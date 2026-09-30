import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { buildServer } from './server.js';

/**
 * The doors that need no phone: a code by email, Google, Apple.
 *
 * Google and Apple are stood in for by a small server that signs ID tokens
 * with a key made here and publishes it the way they do. Everything past the
 * network — the redirect, the state and its cookie, PKCE, the signature, the
 * account found or made — is the code that runs in production.
 */

const CLIENT_ID = 'basu-web.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'test-key', alg: 'RS256', use: 'sig' };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = b64(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

/** What the stand-in Google will say about the person behind the next code. */
let nextPerson: Record<string, unknown> = {};
/** What our server sent to the token endpoint. */
let traded: URLSearchParams | null = null;
let provider: Server;
let base = '';

let app: FastifyInstance;
let clock: VirtualClock;
let mailer: FakeMailer;

const seconds = () => Math.floor(clock.now().getTime() / 1000);
const googlePerson = (claims: Record<string, unknown>) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  iat: seconds(),
  exp: seconds() + 3600,
  ...claims,
});
const applePerson = (claims: Record<string, unknown>) => ({
  iss: 'https://appleid.apple.com',
  aud: 'mn.basu.app',
  iat: seconds(),
  exp: seconds() + 600,
  ...claims,
});

beforeAll(async () => {
  provider = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        traded = new URLSearchParams(body);
        response.setHeader('content-type', 'application/json');
        if (traded.get('code') !== 'good-code') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        response.end(JSON.stringify({ access_token: 'unused', id_token: idToken(googlePerson(nextPerson)) }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => provider.close(resolve));
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  mailer = new FakeMailer();
  const ctx: Ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier(), mailer };
  process.env['GOOGLE_CLIENT_ID'] = CLIENT_ID;
  process.env['GOOGLE_CLIENT_SECRET'] = 'google-secret-for-the-test';
  process.env['GOOGLE_TOKEN_URL'] = `${base}/token`;
  process.env['GOOGLE_JWKS_URI'] = `${base}/jwks`;
  process.env['APPLE_JWKS_URI'] = `${base}/jwks`;
  nextPerson = { sub: 'google-1', email: 'bat@gmail.com', email_verified: true, name: 'Бат' };
  traded = null;
  app = await buildServer(ctx, { dev: true });
});

afterEach(async () => {
  await app?.close();
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URI', 'APPLE_JWKS_URI']) {
    delete process.env[name];
  }
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const whoIs = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).json();
const post = (url: string, payload: Record<string, unknown>, token?: string) =>
  app.inject({ method: 'POST', url, payload, headers: token ? bearer(token) : {} });
/** Whether this session still opens the account. */
const stillIn = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode === 200;

/** Press «Google», and come back from Google with `code` — or with nothing, if `code` is null. */
async function throughGoogle(
  options: { return?: string; code?: string | null; error?: string; cookie?: 'same' | 'none' | 'other' } = {},
) {
  const start = await app.inject({ method: 'GET', url: `/v1/auth/google/start?return=${encodeURIComponent(options.return ?? '/idesh')}` });
  expect(start.statusCode, start.body).toBe(302);
  const to = new URL(start.headers.location as string);
  const state = to.searchParams.get('state')!;
  const setCookie = String(start.headers['set-cookie']);
  const cookie = options.cookie === 'none' ? undefined : options.cookie === 'other' ? 'basu_oauth=someone-elses' : setCookie.split(';')[0]!;

  const query = new URLSearchParams({ state });
  if (options.code !== null) query.set('code', options.code ?? 'good-code');
  if (options.error) query.set('error', options.error);
  const callback = await app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?${query.toString()}`,
    headers: cookie ? { cookie } : {},
  });
  expect(callback.statusCode, callback.body).toBe(302);
  const location = callback.headers.location as string;
  const [path, fragment = ''] = location.split('#');
  // What this browser now holds for the page to claim with: `basu_handoff=…`, or nothing.
  const handoff = [callback.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('basu_handoff='));
  return {
    start: to,
    setCookie,
    state,
    cookie,
    callback,
    path,
    outcome: new URLSearchParams(fragment),
    handoffCookie: handoff,
    handoff: handoff?.split(';')[0],
  };
}

/** What the page does with the code it came back with: trade it, with whatever cookie its browser holds. */
const claim = (code: string | null | undefined, cookie?: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/handoff', payload: { code }, headers: cookie ? { cookie } : {} });

/** Press «Google», come back to a page, and claim there as the page does: the session's token. */
async function signInWithGoogle(options: Parameters<typeof throughGoogle>[0] = {}): Promise<string> {
  const back = await throughGoogle(options);
  const claimed = await claim(back.outcome.get('auth_code'), back.handoff);
  expect(claimed.statusCode, claimed.body).toBe(200);
  return claimed.json().token;
}

describe('the list of open doors', () => {
  it('shows only what this server can actually do', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/auth/methods' })).json()).toEqual({
      password: true,
      email: true,
      google: true,
      apple: true,
      sms: true,
    });
    delete process.env['GOOGLE_CLIENT_SECRET'];
    expect((await app.inject({ method: 'GET', url: '/v1/auth/methods' })).json()).toMatchObject({ google: false });
  });

  it('says the SMS code door is shut in production while no gateway sends one', async () => {
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/auth/methods' })).json()).toMatchObject({ sms: false });
    } finally {
      if (before === undefined) delete process.env['BASU_MODE'];
      else process.env['BASU_MODE'] = before;
    }
  });
});

describe('a code by email', () => {
  it('goes by letter, never in the response, and signs the person in', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'Bat@Example.mn' } });
    expect(start.statusCode, start.body).toBe(202);
    const code = mailer.codeFor('bat@example.mn')!;
    expect(start.body).not.toContain(code);

    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { email: 'bat@example.mn', code: ` ${code} `, device: 'Chrome' },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ token: expect.any(String), guest_id: expect.any(String) });
    expect((await whoIs(verified.json().token)).email).toBe('bat@example.mn');
  });

  it('answers in Mongolian when the address or the code is wrong', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'bat' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_EMAIL');

    await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'bat@example.mn' } });
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/email/verify', payload: { email: 'bat@example.mn', code: '000000' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_CODE');
    expect(wrong.json().error.message_mn).toBe('Код буруу байна.');
  });
});

describe('a password, by way of the inbox', () => {
  it('signs up by an address, signs in by it, and gets a forgotten password back', async () => {
    const asked = await post('/v1/auth/password/code', { login: 'saraa@example.mn', purpose: 'sign_up' });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json()).toEqual({ sent: true, to: 'saraa@example.mn' });
    expect(asked.body).not.toContain(mailer.codeFor('saraa@example.mn')!);

    const made = await post('/v1/auth/password', {
      login: 'saraa@example.mn',
      code: mailer.codeFor('saraa@example.mn'),
      password: 'сайн нууц үг',
      name: 'Сараа',
      device: 'Chrome',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ token: expect.any(String), created: true });
    expect(await whoIs(made.json().token)).toMatchObject({ email: 'saraa@example.mn', display_name: 'Сараа', has_password: true });

    const signedIn = await post('/v1/auth/login', { login: 'saraa@example.mn', password: 'сайн нууц үг' });
    expect(signedIn.statusCode, signedIn.body).toBe(200);

    await post('/v1/auth/password/code', { login: 'saraa@example.mn' });
    const reset = await post('/v1/auth/password', {
      login: 'saraa@example.mn',
      code: mailer.codeFor('saraa@example.mn'),
      password: 'шинэ нууц үг',
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().created).toBe(false);
    // Signed out wherever the old password had signed in.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(signedIn.json().token) })).statusCode).toBe(401);
  });

  it('still takes `phone` on the login, for the app builds already out', async () => {
    await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' });
    const old = await post('/v1/auth/login', { phone: '+97699001122', password: 'сайн нууц үг' });
    expect(old.statusCode, old.body).toBe(200);
    const wrong = await post('/v1/auth/login', { login: '99001122', password: 'буруу нууц үг' });
    expect(wrong.json().error.message_mn).toBe('Имэйл/утас эсвэл нууц үг буруу байна.');
  });

  it('tells a number with no address where it stands, in Mongolian', async () => {
    const refused = await post('/v1/auth/password/code', { login: '99001122' });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('NO_EMAIL');
    expect(refused.json().error.message_mn).toContain('имэйл холбогдоогүй');
  });

  it('lets a phone account add an address, change its password, and end its other sessions', async () => {
    const first = (await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' })).json().token;
    const second = (await post('/v1/auth/login', { login: '99001122', password: 'сайн нууц үг' })).json().token;
    expect(await whoIs(first)).toMatchObject({ email: null, has_password: true });

    const noPassword = await post('/v1/me/email/code', { email: 'bat@example.mn' }, first);
    expect(noPassword.json().error.code).toBe('WRONG_PASSWORD');
    expect((await post('/v1/me/email/code', { email: 'bat@example.mn', password: 'сайн нууц үг' }, first)).statusCode).toBe(202);
    const attached = await post('/v1/me/email', { email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn') }, first);
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json().email).toBe('bat@example.mn');

    const wrong = await post('/v1/me/password', { current: 'таамаг', next: 'шинэ нууц үг' }, first);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.message_mn).toBe('Одоогийн нууц үг буруу байна.');
    const changed = await post('/v1/me/password', { current: 'сайн нууц үг', next: 'шинэ нууц үг' }, first);
    expect(changed.json()).toEqual({ changed: true, revoked: 1 });
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(second) })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { login: 'bat@example.mn', password: 'шинэ нууц үг' })).statusCode).toBe(200);
  });
});

describe('a session somebody else holds', () => {
  /*
   * A session proves only that somebody holds it: a borrowed browser, a tab
   * left open, the dashboard that opened the admin's desk for whoever signed
   * in next. What would outlive it — a password, an address to reset one
   * through — asks for a proof its holder does not have.
   */

  it('gives an account made by Google no password on the session’s word', async () => {
    const owner = await signInWithGoogle();
    // The same account, signed in once more, in a browser somebody else now has.
    const left = await signInWithGoogle();

    const bare = await post('/v1/me/password', { next: 'булаах нууц үг' }, left);
    expect(bare.statusCode, bare.body).toBe(403);
    expect(bare.json().error.code).toBe('PROOF_REQUIRED');
    expect(bare.json().error.message_mn).toContain('имэйл рүү очих код хэрэгтэй');
    // What the app from before the code (iOS 1.0.3) sends, and what it shows:
    // the code it cannot ask for, and the two ways that can.
    const old = await post('/v1/me/password', { current: '', next: 'булаах нууц үг' }, left);
    expect(old.statusCode, old.body).toBe(403);
    expect(old.json().error.code).toBe('PROOF_REQUIRED');
    const said = old.json().error.message_mn;
    expect(said).toContain('бүртгэлийн тань имэйл рүү очих код хэрэгтэй');
    expect(said).toContain('аппын энэ хувилбар кодыг асуудаггүй');
    expect(said).toContain('Аппаа App Store-оос шинэчлээд');
    expect(said).toContain('вэб сайтын «Бүртгэл» хуудаснаас');
    // A code that is not text is no code, and no crash either.
    const numeric = await post('/v1/me/password', { next: 'булаах нууц үг', code: 123456 }, left);
    expect(numeric.statusCode, numeric.body).toBe(403);
    expect(numeric.json().error.code).toBe('PROOF_REQUIRED');
    expect((await post('/v1/me/password', { next: 12345678 }, left)).json().error.code).toBe('BAD_REQUEST');
    expect(mailer.sent).toHaveLength(0);

    // The door sends a code to any inbox for the asking — the holder's own — and that is no proof.
    await post('/v1/auth/email/start', { email: 'thief@example.mn' });
    const borrowed = await post('/v1/me/password', { next: 'булаах нууц үг', code: mailer.codeFor('thief@example.mn') }, left);
    expect(borrowed.json().error.code).toBe('INVALID_CODE');

    expect((await whoIs(owner)).has_password).toBe(false);
    expect((await post('/v1/auth/login', { login: 'bat@gmail.com', password: 'булаах нууц үг' })).statusCode).toBe(401);
    // And nobody was signed out by it.
    expect(await stillIn(owner)).toBe(true);
    expect(await stillIn(left)).toBe(true);
  });

  it('sets the first with the code a letter to the account’s own address carries, and tells that address', async () => {
    const here = await signInWithGoogle();
    const elsewhere = await signInWithGoogle();

    // Whatever the request names, the letter goes to the address on the account.
    const asked = await post('/v1/me/password/code', { email: 'thief@example.mn' }, here);
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json()).toEqual({ sent: true, to: 'bat@gmail.com' });
    expect(mailer.to('thief@example.mn')).toBeUndefined();
    const letter = mailer.to('bat@gmail.com')!;
    expect(letter.subject).toContain('нууц үг тохируулах код');
    // Somebody who did not ask learns what it means: somebody is signed in as them.
    expect(letter.text).toContain('хэн нэгэн таны бүртгэлээр нэвтэрсэн');
    expect(letter.text).toContain('Бусад бүх төхөөрөмжөөс гарах');
    const code = mailer.codeFor('bat@gmail.com')!;
    expect(asked.body).not.toContain(code);

    // Too short is a typing mistake, and does not spend the code.
    expect((await post('/v1/me/password', { next: 'богино', code }, here)).json().error.code).toBe('TOO_SHORT');
    const set = await post('/v1/me/password', { next: 'шинэ нууц үг', code }, here);
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ changed: true, revoked: 1 });
    expect(await whoIs(here)).toMatchObject({ has_password: true });
    expect(await stillIn(elsewhere)).toBe(false);
    expect((await post('/v1/auth/login', { login: 'bat@gmail.com', password: 'шинэ нууц үг' })).statusCode).toBe(200);

    const notice = mailer.to('bat@gmail.com')!;
    expect(notice.subject).toBe('Basu · Нууц үг тохирууллаа');
    expect(notice.text).toContain('Та өөрөө хийгээгүй бол');
    expect(notice.html).toContain('https://basu.burzai.cloud/login?forgot');

    // Now it has one: it is changed knowing that one, and no letter is sent for it.
    const again = await post('/v1/me/password/code', {}, here);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('PASSWORD_SET');
    expect((await post('/v1/me/password', { next: 'гурав дахь нууц үг', code }, here)).json().error.code).toBe('WRONG_PASSWORD');
  });

  it('counts wrong codes the way every code door does', async () => {
    const here = await signInWithGoogle();
    await post('/v1/me/password/code', {}, here);
    const code = mailer.codeFor('bat@gmail.com')!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      expect((await post('/v1/me/password', { next: 'шинэ нууц үг', code: wrong }, here)).json().error.code).toBe('INVALID_CODE');
    }
    const late = await post('/v1/me/password', { next: 'шинэ нууц үг', code }, here);
    expect(late.statusCode).toBe(429);
    expect(late.json().error.code).toBe('RATE_LIMITED');
    expect((await whoIs(here)).has_password).toBe(false);

    // A new letter, a new code, three more tries — and a handful of letters an hour, no more.
    clock.advanceMinutes(1);
    await post('/v1/me/password/code', {}, here);
    expect((await post('/v1/me/password', { next: 'шинэ нууц үг', code: mailer.codeFor('bat@gmail.com') }, here)).statusCode).toBe(200);
  });

  it('tells an account with no address to add one first, and sends nothing', async () => {
    // Google did not vouch for the address, so the account has none.
    nextPerson = { sub: 'google-2', email: 'dorj@gmail.com', email_verified: false };
    const token = await signInWithGoogle();
    expect(await whoIs(token)).toMatchObject({ email: null, has_password: false });

    const asked = await post('/v1/me/password/code', {}, token);
    expect(asked.statusCode).toBe(404);
    expect(asked.json().error.code).toBe('NO_EMAIL');
    // Inside the account nobody typed a number: it is told what to do first, not what the door says.
    expect(asked.json().error.message_mn).toBe('Эхлээд имэйлээ холбоно уу — нууц үг тохируулах код тэр хаяг руу очно.');
    const set = await post('/v1/me/password', { next: 'шинэ нууц үг', code: '123456' }, token);
    expect(set.json().error.code).toBe('NO_EMAIL');
    expect(set.json().error.message_mn).toContain('Эхлээд имэйлээ холбоно уу');
    expect(mailer.sent).toHaveLength(0);
    expect((await whoIs(token)).has_password).toBe(false);
  });

  it('signs whoever else holds a session out when the owner takes the account back through its inbox, password or none', async () => {
    // Made by Google, with no password; somebody else has a session on it.
    const owner = await signInWithGoogle();
    const intruder = await signInWithGoogle();

    // The owner does what the letters say: «Нууц үгээ мартсан?», a code to the inbox, a password.
    expect((await post('/v1/auth/password/code', { login: 'bat@gmail.com' })).statusCode).toBe(202);
    const back = await post('/v1/auth/password', { login: 'bat@gmail.com', code: mailer.codeFor('bat@gmail.com'), password: 'эзний нууц үг' });
    expect(back.statusCode, back.body).toBe(200);
    expect(await stillIn(intruder)).toBe(false);
    expect(await stillIn(owner)).toBe(false);
    expect(await stillIn(back.json().token)).toBe(true);
  });

  it('lets a session guess the password no more than the door lets anybody', async () => {
    const owner = (await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' })).json().token;
    const left = (await post('/v1/auth/login', { login: '99001122', password: 'сайн нууц үг' })).json().token;

    // Five wrong from a session somebody else holds rest the account, as five at the door do…
    for (let i = 0; i < 5; i++) {
      const wrong = await post('/v1/me/password', { current: `таамаг ${i}`, next: 'булаах нууц үг' }, left);
      expect(wrong.json().error.code).toBe('WRONG_PASSWORD');
    }
    const right = await post('/v1/me/password', { current: 'сайн нууц үг', next: 'булаах нууц үг' }, left);
    expect(right.statusCode, right.body).toBe(429);
    expect(right.json().error.code).toBe('LOCKED');
    // …at the door too, and nobody has been signed out by any of it.
    expect((await post('/v1/auth/login', { login: '99001122', password: 'сайн нууц үг' })).json().error.code).toBe('LOCKED');
    expect(await stillIn(owner)).toBe(true);

    // And wrong guesses at the door rest it here: the session gets no fresh count of its own.
    clock.advanceMinutes(16);
    expect((await post('/v1/auth/login', { login: '99001122', password: 'сайн нууц үг' })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await post('/v1/auth/login', { login: '99001122', password: `таамаг ${i}` })).statusCode).toBe(401);
    }
    expect((await post('/v1/me/password', { current: 'сайн нууц үг', next: 'булаах нууц үг' }, left)).json().error.code).toBe('LOCKED');
    // An address — the way to reset a password — asks for it the same way.
    expect((await post('/v1/me/email/code', { email: 'thief@example.mn', password: 'сайн нууц үг' }, left)).json().error.code).toBe('LOCKED');
    expect(mailer.sent).toHaveLength(0);

    // Rested, it opens to the password again, and the owner changes it.
    clock.advanceMinutes(16);
    const changed = await post('/v1/me/password', { current: 'сайн нууц үг', next: 'эзний шинэ нууц үг' }, owner);
    expect(changed.json()).toEqual({ changed: true, revoked: 2 });
    expect(await stillIn(left)).toBe(false);
  });

  it('tells the account’s inbox when its password is changed or replaced — and a letter that fails undoes nothing', async () => {
    const first = (await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' })).json().token;
    await post('/v1/me/email/code', { email: 'bat@example.mn', password: 'сайн нууц үг' }, first);
    await post('/v1/me/email', { email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn') }, first);

    expect((await post('/v1/me/password', { current: 'сайн нууц үг', next: 'шинэ нууц үг' }, first)).statusCode).toBe(200);
    const changed = mailer.to('bat@example.mn')!;
    expect(changed.subject).toBe('Basu · Нууц үг солигдлоо');
    expect(changed.text).toContain('Та өөрөө хийгээгүй бол');

    // Replaced through the inbox, an hour on (an address hears once an hour
    // at most, see below): the same letter after it.
    clock.advanceMinutes(61);
    await post('/v1/auth/password/code', { login: 'bat@example.mn' });
    const reset = await post('/v1/auth/password', { login: 'bat@example.mn', code: mailer.codeFor('bat@example.mn'), password: 'гурав дахь нууц үг' });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(mailer.to('bat@example.mn')!.subject).toBe('Basu · Нууц үг солигдлоо');

    // An account made just now by its address hears only the code it asked for.
    await post('/v1/auth/password/code', { login: 'saraa@example.mn', purpose: 'sign_up' });
    const made = await post('/v1/auth/password', { login: 'saraa@example.mn', code: mailer.codeFor('saraa@example.mn'), password: 'сайн нууц үг' });
    expect(made.statusCode).toBe(201);
    expect(mailer.sent.filter((m) => m.to === 'saraa@example.mn')).toHaveLength(1);

    clock.advanceMinutes(61);
    mailer.failNext = true;
    const quiet = await post('/v1/me/password', { current: 'гурав дахь нууц үг', next: 'дөрөв дэх нууц үг' }, reset.json().token);
    expect(quiet.statusCode, quiet.body).toBe(200);
    // The letter was tried, and refused.
    expect(mailer.failNext).toBe(false);
    expect((await post('/v1/auth/login', { login: 'bat@example.mn', password: 'дөрөв дэх нууц үг' })).statusCode).toBe(200);
  });

  it('sends an address one letter an hour however often its password changes, and changes it every time', async () => {
    const first = (await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' })).json().token;
    await post('/v1/me/email/code', { email: 'bat@example.mn', password: 'сайн нууц үг' }, first);
    await post('/v1/me/email', { email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn') }, first);
    const before = mailer.sent.length;

    // Changing it knowing the old one takes no code: switched back and forth,
    // a letter a switch would spend the Gmail account's day — and every code
    // with it, for everybody.
    const words = ['нэгдүгээр нууц үг', 'хоёрдугаар нууц үг'];
    let current = 'сайн нууц үг';
    for (let i = 0; i < 20; i++) {
      const next = words[i % 2]!;
      const switched = await post('/v1/me/password', { current, next }, first);
      expect(switched.statusCode, switched.body).toBe(200);
      current = next;
      clock.advanceMinutes(2);
    }
    const letters = mailer.sent.slice(before);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ to: 'bat@example.mn', subject: 'Basu · Нууц үг солигдлоо' });
    expect((await post('/v1/auth/login', { login: 'bat@example.mn', password: current })).statusCode).toBe(200);

    // An hour after the letter, the next change is told again.
    clock.advanceMinutes(21);
    expect((await post('/v1/me/password', { current, next: 'гурав дахь нууц үг' }, first)).statusCode).toBe(200);
    expect(mailer.sent.slice(before)).toHaveLength(2);
  });

  it('ties an address to the account only on the code that account asked for', async () => {
    const left = (await post('/v1/auth/register', { phone: '+97699001122', password: 'сайн нууц үг' })).json().token;

    // The door sends a code to the holder's own inbox, no password asked…
    await post('/v1/auth/email/start', { email: 'thief@example.mn' });
    const byDoor = await post('/v1/me/email', { email: 'thief@example.mn', code: mailer.codeFor('thief@example.mn') }, left);
    expect(byDoor.statusCode).toBe(400);
    expect(byDoor.json().error.code).toBe('INVALID_CODE');

    // …and so does another account's own «Имэйл холбох», past that account's password.
    const theirs = (await post('/v1/auth/register', { phone: '+97699003344', password: 'өөр нууц үг' })).json().token;
    expect((await post('/v1/me/email/code', { email: 'thief@example.mn', password: 'өөр нууц үг' }, theirs)).statusCode).toBe(202);
    const byOther = await post('/v1/me/email', { email: 'thief@example.mn', code: mailer.codeFor('thief@example.mn') }, left);
    expect(byOther.json().error.code).toBe('INVALID_CODE');

    expect((await whoIs(left)).email).toBeNull();
    // So no address stands behind the number to reset its password through.
    expect((await post('/v1/auth/password/code', { login: '99001122' })).json().error.code).toBe('NO_EMAIL');
  });

  it('lets an account with neither a password nor an address add one only just after signing in', async () => {
    nextPerson = { sub: 'google-2', email: 'dorj@gmail.com', email_verified: false };
    const left = await signInWithGoogle();
    clock.advanceMinutes(11);

    const refused = await post('/v1/me/email/code', { email: 'thief@example.mn' }, left);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('SIGN_IN_AGAIN');
    expect(refused.json().error.message_mn).toContain('дахин нэвтэрнэ');
    expect(mailer.sent).toHaveLength(0);

    // Through Google again, a moment ago: that is the person, and the address is theirs to add.
    const fresh = await signInWithGoogle();
    expect((await post('/v1/me/email/code', { email: 'dorj@example.mn' }, fresh)).statusCode).toBe(202);
    const attached = await post('/v1/me/email', { email: 'dorj@example.mn', code: mailer.codeFor('dorj@example.mn') }, fresh);
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json().email).toBe('dorj@example.mn');
  });
});

describe('signing out', () => {
  const signOut = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/v1/auth/sign-out', headers });

  it('ends the session that asks, on the server, and no other', async () => {
    const register = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97699001133', password: 'сайн нууц үг' } });
    const here = register.json().token;
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { login: '99001133', password: 'сайн нууц үг' } });
    const elsewhere = login.json().token;

    expect((await signOut(bearer(here))).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(here) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(elsewhere) })).statusCode).toBe(200);

    // The same answer for a session already ended, one never made, and none at all: it tells nobody anything.
    for (const headers of [bearer(here), bearer('nobody-ever-had-this'), {}]) {
      expect((await signOut(headers)).statusCode).toBe(204);
    }
  });
});

describe('Google', () => {
  it('sends the person to Google with a state, a PKCE challenge and our own return address', async () => {
    const start = await app.inject({ method: 'GET', url: '/v1/auth/google/start?return=/supplier' });
    expect(start.statusCode).toBe(302);
    const to = new URL(start.headers.location as string);
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(to.searchParams.get('redirect_uri')).toBe('https://basu.burzai.cloud/v1/auth/google/callback');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('scope')).toBe('openid email profile');
    // The state rides in a cookie only this browser holds, scoped to these two addresses.
    expect(String(start.headers['set-cookie'])).toMatch(/^basu_oauth=[\w-]+; Path=\/v1\/auth\/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('comes back to the page it started from, signed in there, and the verifier matches the challenge', async () => {
    const { start, path, outcome, handoff } = await throughGoogle({ return: '/supplier' });
    expect(path).toBe('/supplier');
    const claimed = await claim(outcome.get('auth_code'), handoff);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const me = await whoIs(claimed.json().token);
    expect(me).toMatchObject({ email: 'bat@gmail.com', phone: null });

    // PKCE: what went to Google's token endpoint hashes to what went through the browser.
    const verifier = traded!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(start.searchParams.get('code_challenge'));
    expect(traded!.get('client_secret')).toBe('google-secret-for-the-test');
  });

  it('is the same account the next time, and the same as the email-code one for a verified address', async () => {
    await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'bat@gmail.com' } });
    const byCode = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { email: 'bat@gmail.com', code: mailer.codeFor('bat@gmail.com') },
    });
    const first = await signInWithGoogle();
    const again = await signInWithGoogle();
    const id = (await whoIs(byCode.json().token)).id;
    expect((await whoIs(first)).id).toBe(id);
    expect((await whoIs(again)).id).toBe(id);
  });

  it('does not join an address Google has not verified to the account that owns it', async () => {
    await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'bat@gmail.com' } });
    const byCode = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { email: 'bat@gmail.com', code: mailer.codeFor('bat@gmail.com') },
    });
    nextPerson = { sub: 'google-2', email: 'bat@gmail.com', email_verified: false };
    const me = await whoIs(await signInWithGoogle());
    expect(me.id).not.toBe((await whoIs(byCode.json().token)).id);
    expect(me.email).toBeNull();
  });

  it('refuses a second Google account claiming an address already tied to the first', async () => {
    await signInWithGoogle();
    nextPerson = { sub: 'google-other', email: 'bat@gmail.com', email_verified: true };
    const { outcome, path, handoff } = await throughGoogle();
    expect(path).toBe('/idesh');
    expect(outcome.get('auth')).toBeNull();
    expect(outcome.get('auth_code')).toBeNull();
    expect(handoff).toBeUndefined();
    expect(outcome.get('auth_error')).toBe('SOCIAL_REFUSED');
  });

  it('refuses a callback that did not start in this browser — and spends the state anyway', async () => {
    const stranger = await throughGoogle({ cookie: 'other' });
    expect(stranger.outcome.get('auth_error')).toBe('SOCIAL_REFUSED');
    const none = await throughGoogle({ cookie: 'none' });
    expect(none.outcome.get('auth_error')).toBe('SOCIAL_REFUSED');

    // The same state, now with the right cookie, is no good a second time.
    const replay = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?state=${none.state}&code=good-code`,
      headers: { cookie: none.setCookie.split(';')[0]! },
    });
    expect(replay.headers.location).toBe('/#auth_error=SOCIAL_REFUSED');
  });

  it('refuses a state it never issued, and one that is too old', async () => {
    const made_up = await app.inject({ method: 'GET', url: '/v1/auth/google/callback?state=made-up&code=good-code' });
    expect(made_up.headers.location).toBe('/#auth_error=SOCIAL_REFUSED');

    const start = await app.inject({ method: 'GET', url: '/v1/auth/google/start?return=/idesh' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    clock.advanceMinutes(11);
    const late = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?state=${state}&code=good-code`,
      headers: { cookie: String(start.headers['set-cookie']).split(';')[0]! },
    });
    expect(late.headers.location).toBe('/#auth_error=SOCIAL_REFUSED');
  });

  it('says «cancelled» when the person backs out at Google, and refuses a code Google will not trade', async () => {
    expect((await throughGoogle({ code: null, error: 'access_denied' })).outcome.get('auth_error')).toBe('CANCELLED');
    expect((await throughGoogle({ code: 'forged' })).outcome.get('auth_error')).toBe('SOCIAL_REFUSED');
  });

  it('never sends anybody anywhere but our own pages and the app', async () => {
    for (const elsewhere of ['https://evil.example/steal', '//evil.example', '/v1/me', 'javascript:alert(1)']) {
      expect((await throughGoogle({ return: elsewhere })).path).toBe('/');
    }
    const app_ = await throughGoogle({ return: 'basu://auth' });
    expect(app_.path).toBe('basu://auth');
    expect(app_.outcome.get('auth')).toBeTruthy();
  });

  it('says the door is closed when Google is not set up', async () => {
    delete process.env['GOOGLE_CLIENT_ID'];
    const start = await app.inject({ method: 'GET', url: '/v1/auth/google/start?return=/dine' });
    expect(start.headers.location).toBe('/dine#auth_error=SOCIAL_CLOSED');
  });
});

describe('Google, back on a page', () => {
  /*
   * The page's address is kept by the browser's history as it was visited,
   * fragment and all, and Chrome syncs that history. So the address carries
   * a code, not the session; the code is good once, for a minute, and only
   * with the cookie the callback set in the browser that went to Google.
   */
  const REFUSED = { code: 'HANDOFF_REFUSED', message_mn: 'Google-ээр нэвтрэлт хүчингүй болсон байна. Дахин нэвтэрнэ үү.' };

  it('carries no session in the address, only a code that is no way in by itself', async () => {
    const back = await throughGoogle({ return: '/login' });
    expect(back.path).toBe('/login');
    expect([...back.outcome.keys()]).toEqual(['auth_code']);
    const code = back.outcome.get('auth_code')!;
    expect(code).toMatch(/^[\w-]{43}$/);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(code) })).statusCode).toBe(401);

    // The cookie it is good with: this browser's only, sent only to the one address that claims it.
    expect(back.handoffCookie).toMatch(/^basu_handoff=[\w-]{43}; Path=\/v1\/auth\/handoff; Max-Age=120; HttpOnly; Secure; SameSite=Lax$/);
    expect(back.handoff!.slice('basu_handoff='.length)).not.toBe(code);
  });

  it('trades the code for a session once, with the cookie, and the cookie goes', async () => {
    const back = await throughGoogle({ return: '/dashboard' });
    const code = back.outcome.get('auth_code')!;
    const claimed = await claim(code, back.handoff);
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json()).toMatchObject({ token: expect.any(String), guest_id: expect.any(String), expires_at: expect.any(String) });
    expect(claimed.json().token).not.toBe(code);
    expect(await whoIs(claimed.json().token)).toMatchObject({ id: claimed.json().guest_id, email: 'bat@gmail.com' });
    expect(String(claimed.headers['set-cookie'])).toBe('basu_handoff=; Path=/v1/auth/handoff; Max-Age=0; HttpOnly; Secure; SameSite=Lax');

    // A code read out of a history later, cookie and all, is spent.
    const again = await claim(code, back.handoff);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatchObject(REFUSED);
  });

  it('opens nothing for a code brought without its own cookie, and the try spends it', async () => {
    // What a link to somebody else carries: the code, and none of the cookie.
    const linked = await throughGoogle({ return: '/login' });
    const bare = await claim(linked.outcome.get('auth_code'));
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toMatchObject(REFUSED);
    expect((await claim(linked.outcome.get('auth_code'), linked.handoff)).statusCode).toBe(400);

    // A browser with a cookie of its own, from its own round trip to Google.
    const mine = await throughGoogle({ return: '/login' });
    const theirs = await throughGoogle({ return: '/login' });
    expect((await claim(mine.outcome.get('auth_code'), theirs.handoff)).json().error).toMatchObject(REFUSED);
    expect((await claim(mine.outcome.get('auth_code'), mine.handoff)).statusCode).toBe(400);
    // Theirs is still theirs.
    expect((await claim(theirs.outcome.get('auth_code'), theirs.handoff)).statusCode).toBe(200);
  });

  it('opens nothing a minute on, nor for a code it never made', async () => {
    const back = await throughGoogle({ return: '/login' });
    clock.advanceSeconds(61);
    expect((await claim(back.outcome.get('auth_code'), back.handoff)).json().error).toMatchObject(REFUSED);

    for (const code of ['made-up', '', null, 42]) {
      const refused = await app.inject({ method: 'POST', url: '/v1/auth/handoff', payload: { code }, headers: { cookie: 'basu_handoff=made-up' } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatchObject(REFUSED);
    }
    const nothing = await app.inject({ method: 'POST', url: '/v1/auth/handoff', headers: { cookie: 'basu_handoff=%E0%A4%A' } });
    expect(nothing.statusCode).toBe(400);
  });

  it('still gives the iPhone app the session itself, at basu://auth, and no code or cookie', async () => {
    const back = await throughGoogle({ return: 'basu://auth' });
    expect(back.callback.headers.location).toMatch(/^basu:\/\/auth#auth=[\w-]{43}$/);
    expect(back.outcome.get('auth_code')).toBeNull();
    expect(back.handoff).toBeUndefined();
    expect(await whoIs(back.outcome.get('auth')!)).toMatchObject({ email: 'bat@gmail.com' });
  });
});

describe('Apple, from the iPhone', () => {
  /** What the app does: a random nonce, its hash to Apple, the nonce itself to us. */
  const NONCE = 'a-random-nonce-from-the-app';
  const hashed = createHash('sha256').update(NONCE).digest('hex');
  const signIn = (token: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v1/auth/apple', payload: { identity_token: token, nonce: NONCE, ...extra } });

  it('signs in with the token Apple gave the app, and keeps the name Apple sends only once', async () => {
    const first = await signIn(
      idToken(applePerson({ sub: 'apple-1', nonce: hashed, email: 'x1@privaterelay.appleid.com', email_verified: 'true' })),
      { name: 'Дорж' },
    );
    expect(first.statusCode, first.body).toBe(200);
    const again = await signIn(idToken(applePerson({ sub: 'apple-1', nonce: hashed })));
    expect(again.json().guest_id).toBe(first.json().guest_id);
    expect(await whoIs(again.json().token)).toMatchObject({ display_name: 'Дорж', email: 'x1@privaterelay.appleid.com' });
  });

  it('refuses a token made for another app, or one that is not Apple’s', async () => {
    const other = await signIn(idToken(applePerson({ sub: 'apple-1', nonce: hashed, aud: 'com.someone.else' })));
    expect(other.statusCode).toBe(401);
    expect(other.json().error.code).toBe('SOCIAL_REFUSED');
    const google = await signIn(idToken(googlePerson({ sub: 'apple-1', nonce: hashed })));
    expect(google.json().error.code).toBe('SOCIAL_REFUSED');
  });

  it('refuses a token this sign-in did not ask for', async () => {
    const elsewhere = await signIn(idToken(applePerson({ sub: 'apple-1', nonce: 'somebody-elses-hash' })));
    expect(elsewhere.json().error.code).toBe('SOCIAL_REFUSED');
    const none = await signIn(idToken(applePerson({ sub: 'apple-1' })));
    expect(none.json().error.code).toBe('SOCIAL_REFUSED');
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/auth/apple',
      payload: { identity_token: idToken(applePerson({ sub: 'apple-1', nonce: hashed })) },
    });
    expect(missing.statusCode).toBe(400);
  });
});
