import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { guestForPhone } from '../platform/identity/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * Getting onto the desk when a phone number proves nothing.
 *
 * A password can be set by anybody who types a number, so authority on the
 * desk arrives with a one-time code an admin hands to one person. These are
 * the properties that make that safe.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let ctx: Ctx;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => bearer(opsToken()!);

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier() };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });
});

afterEach(async () => {
  await app?.close();
  delete process.env['OPS_TOKEN'];
});

afterAll(async () => {
  await closePool();
});

const claim = (payload: Record<string, string>) => app.inject({ method: 'POST', url: '/v1/auth/claim', payload });

describe('the first admin of an empty desk', () => {
  it('comes in with a code bound to nobody, and then is a member in their own right', async () => {
    const made = await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'admin' } });
    expect(made.statusCode, made.body).toBe(201);
    const { code } = made.json();
    expect(code).toMatch(/^\d{5} \d{5}$/);

    const joined = await claim({ code, phone: '+97699112233', password: 'админы нууц үг', name: 'Ганхүлэг' });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(joined.json().role).toBe('admin');

    // The session it hands back opens the desk, by name and role.
    const me = await app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(joined.json().token) });
    expect(me.json().member).toMatchObject({ name: 'Ганхүлэг', role: 'admin', phone: '+97699112233' });

    // And from now on the ordinary door works.
    const back = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+97699112233', password: 'админы нууц үг' } });
    expect(back.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(back.json().token) })).statusCode).toBe(200);
  });

  it('is used once, and says nothing about why a code does not work', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'admin' } })).json();
    expect((await claim({ code, phone: '+97699112233', password: 'админы нууц үг' })).statusCode).toBe(201);

    const twice = await claim({ code, phone: '+97699445566', password: 'хоёр дахь хүн' });
    const made_up = await claim({ code: '00000 00000', phone: '+97699445566', password: 'хоёр дахь хүн' });
    expect(twice.statusCode).toBe(400);
    expect(made_up.statusCode).toBe(400);
    expect(twice.json().error).toEqual(made_up.json().error);
    expect(twice.json().error.code).toBe('INVITE_INVALID');
  });

  it('expires after a day', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'admin' } })).json();
    clock.advanceMinutes(25 * 60);
    expect((await claim({ code, phone: '+97699112233', password: 'админы нууц үг' })).json().error.code).toBe('INVITE_INVALID');
  });
});

describe('a member added by an admin', () => {
  it('gets a code for their own number only', async () => {
    const added = await app.inject({
      method: 'POST',
      url: '/v1/ops/members',
      headers: desk(),
      payload: { phone: '+97699778899', name: 'Санхүү', role: 'finance' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const code = added.json().invite_code as string;
    expect(code).toMatch(/^\d{5} \d{5}$/);

    // Somebody else holding the code cannot use it with their own number.
    const stranger = await claim({ code, phone: '+97699000000', password: 'булаах гэсэн' });
    expect(stranger.json().error.code).toBe('INVITE_INVALID');

    // The person it was made for can, and the stranger's try did not burn it.
    const joined = await claim({ code, phone: '+97699778899', password: 'санхүүгийн нууц' });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(joined.json().role).toBe('finance');
  });

  it('keeps an existing password, and does not burn the code on a wrong one', async () => {
    // Already a guest with a password of their own.
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97699778899', password: 'миний өөрийн' } });
    const code = (await app.inject({
      method: 'POST',
      url: '/v1/ops/members',
      headers: desk(),
      payload: { phone: '+97699778899', name: 'Санхүү', role: 'finance' },
    })).json().invite_code as string;

    const wrong = await claim({ code, phone: '+97699778899', password: 'таамаглал' });
    expect(wrong.json().error.code).toBe('BAD_CREDENTIALS');
    const right = await claim({ code, phone: '+97699778899', password: 'миний өөрийн' });
    expect(right.statusCode, right.body).toBe(201);
  });

  it('may give the first password to an account the desk made without one', async () => {
    // A supplier's owner, made by the desk from a phone number, never set a
    // password. Registering on that number is refused; an invite is the way.
    await guestForPhone('+97688010001');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97688010001', password: 'булаах гэсэн' } })).json().error.code).toBe('PHONE_TAKEN');

    const { code } = (await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { phone: '+97688010001' } })).json();
    const joined = await claim({ code, phone: '+97688010001', password: 'эзэмшигчийн' });
    expect(joined.statusCode, joined.body).toBe(201);
    // No role on the invite: an account, not a seat at the desk.
    expect(joined.json().role).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(joined.json().token) })).statusCode).toBe(401);
  });
});

describe('who may make invites', () => {
  it('is an admin, and nobody else', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/ops/invites', payload: { role: 'admin' } })).statusCode).toBe(401);
    const { code } = (await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'viewer' } })).json();
    const viewer = (await claim({ code, phone: '+97699112233', password: 'харагчийн нууц' })).json().token as string;
    expect((await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: bearer(viewer), payload: { role: 'admin' } })).statusCode).toBe(403);
  });
});
