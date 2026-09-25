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
  return { start: to, setCookie, state, cookie, callback, path, outcome: new URLSearchParams(fragment) };
}

describe('the list of open doors', () => {
  it('shows only what this server can actually do', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/auth/methods' })).json()).toEqual({
      password: true,
      email: true,
      google: true,
      apple: true,
    });
    delete process.env['GOOGLE_CLIENT_SECRET'];
    expect((await app.inject({ method: 'GET', url: '/v1/auth/methods' })).json()).toMatchObject({ google: false });
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
  const post = (url: string, payload: Record<string, unknown>, token?: string) =>
    app.inject({ method: 'POST', url, payload, headers: token ? bearer(token) : {} });

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

  it('comes back to the page it started from, signed in, and the verifier matches the challenge', async () => {
    const { start, path, outcome } = await throughGoogle({ return: '/supplier' });
    expect(path).toBe('/supplier');
    const token = outcome.get('auth')!;
    expect(token).toBeTruthy();
    const me = await whoIs(token);
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
    const first = await throughGoogle();
    const again = await throughGoogle();
    const id = (await whoIs(byCode.json().token)).id;
    expect((await whoIs(first.outcome.get('auth')!)).id).toBe(id);
    expect((await whoIs(again.outcome.get('auth')!)).id).toBe(id);
  });

  it('does not join an address Google has not verified to the account that owns it', async () => {
    await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'bat@gmail.com' } });
    const byCode = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { email: 'bat@gmail.com', code: mailer.codeFor('bat@gmail.com') },
    });
    nextPerson = { sub: 'google-2', email: 'bat@gmail.com', email_verified: false };
    const { outcome } = await throughGoogle();
    const me = await whoIs(outcome.get('auth')!);
    expect(me.id).not.toBe((await whoIs(byCode.json().token)).id);
    expect(me.email).toBeNull();
  });

  it('refuses a second Google account claiming an address already tied to the first', async () => {
    await throughGoogle();
    nextPerson = { sub: 'google-other', email: 'bat@gmail.com', email_verified: true };
    const { outcome, path } = await throughGoogle();
    expect(path).toBe('/idesh');
    expect(outcome.get('auth')).toBeNull();
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
