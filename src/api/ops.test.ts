import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { opsToken } from './ops.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';

/**
 * Becoming a supplier, over HTTP: the guest's side, the ops desk, and the
 * one secret between them.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone = '+97688010009'): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function applied(token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/supplier/apply',
    headers: auth(token),
    payload: { name: 'Завхан · Бат-Эрдэнэ', tin: '6505678901', address: 'Хархорин зах', about: 'хонь' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });
});

afterEach(() => {
  delete process.env['OPS_TOKEN'];
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('the ops desk', () => {
  it('opens only to the secret', async () => {
    const none = await app.inject({ method: 'GET', url: '/v1/ops/suppliers' });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth('nope') });
    expect(wrong.statusCode).toBe(401);
    const right = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) });
    expect(right.statusCode).toBe(200);
    // The demo hands the secret out; it is the configured one when there is one.
    const handed = await app.inject({ method: 'GET', url: '/dev/ops-token' });
    expect(handed.json().token).toBe('ops-secret-for-the-test');
  });

  it('stays shut in production until somebody sets the secret', async () => {
    delete process.env['OPS_TOKEN'];
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    try {
      expect(opsToken()).toBeNull();
      const response = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth('anything') });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('OPS_CLOSED');
    } finally {
      if (before === undefined) delete process.env['BASU_MODE'];
      else process.env['BASU_MODE'] = before;
    }
  });

  it('walks an application from the form to a paired screen', async () => {
    const guest = await signIn();
    const id = await applied(guest);

    // The applicant sees it waiting; a guest sees nothing of it.
    const waiting = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(waiting.json().application).toMatchObject({ id, state: 'applied', pairing_code: null });
    expect((await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings).toEqual([]);

    // Ops sees it first in the list, with the phone that was proved.
    const desk = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) });
    expect(desk.json().suppliers[0]).toMatchObject({ id, state: 'applied', phone: '+97688010009' });

    const yes = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${id}/approve`,
      headers: auth(opsToken()!),
      payload: {},
    });
    expect(yes.statusCode, yes.body).toBe(200);
    const code = yes.json().pairing_code as string;
    expect(code).toMatch(/^\d{8}$/);

    // The applicant now sees the code — and can pair with it.
    const done = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(done.json().application).toMatchObject({ state: 'contracted', pairing_code: code });
    const paired = await app.inject({ method: 'POST', url: '/v1/supplier/pair', payload: { pairing_code: code } });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json().supplier_id).toBe(id);

    const board = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth(paired.json().token) });
    expect(board.json().supplier.name).toBe('Завхан · Бат-Эрдэнэ');
  });

  it('declines with a reason the applicant reads', async () => {
    const guest = await signIn();
    const id = await applied(guest);
    const no = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${id}/decline`,
      headers: auth(opsToken()!),
      payload: { reason: 'ТТД баталгаажаагүй' },
    });
    expect(no.json()).toEqual({ state: 'declined' });
    const mine = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(mine.json().application).toMatchObject({ state: 'declined', decline_reason: 'ТТД баталгаажаагүй' });
  });

  it('lets ops register a contracted supplier straight in, and mint a fresh code later', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(opsToken()!),
      payload: { name: 'Хэнтий · Хэрлэн', phone: '+97688010002', tin: '6502345678', address: 'Эмээлт' },
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().pairing_code).toMatch(/^\d{8}$/);

    const again = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${made.json().id}/code`,
      headers: auth(opsToken()!),
      payload: {},
    });
    expect(again.json().pairing_code).toMatch(/^\d{8}$/);
    expect(again.json().pairing_code).not.toBe(made.json().pairing_code);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(opsToken()!),
      payload: { name: 'x', phone: '99001122', address: 'y' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a second open application and a form without an address', async () => {
    const guest = await signIn();
    await applied(guest);
    const twice = await app.inject({
      method: 'POST',
      url: '/v1/supplier/apply',
      headers: auth(guest),
      payload: { name: 'Дахиад', address: 'Хархорин зах, урд хаалга' },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('ALREADY_APPLIED');

    const other = await signIn('+97688010010');
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/supplier/apply',
      headers: auth(other),
      payload: { name: 'Нэр л' },
    });
    expect(bare.statusCode).toBe(400);
  });
});
