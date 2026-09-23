import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { WirePayments } from '../platform/ledger/index.js';
import { FakeNotifier, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { buildServer } from './server.js';

/**
 * A top-up with a real payment provider behind it.
 *
 * The property under test is the one that lets `/settle` stay open to the
 * guest: the wallet fills when the provider says the money arrived, and at
 * no other moment — not when the person comes back from the checkout page,
 * not when a forged callback says so.
 */

const SECRET = 'whsec_for_the_test';
let wire: Server;
let wireBase: string;
let intentStatus = 'requires_payment_method';

let app: FastifyInstance;
let notifier: FakeNotifier;
let ctx: Ctx;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone = '+97699003311'): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

const signed = (body: string, at = new Date()) => {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
};

beforeAll(async () => {
  wire = createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => (raw += c));
    request.on('end', () => {
      const path = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/payment_intents') response.end(JSON.stringify({ id: 'pi_live_1', status: 'new', amount: 5_000_000 }));
      else if (path === '/checkout/sessions') response.end(JSON.stringify({ url: 'https://pay.wire.mn/c/zz' }));
      else response.end(JSON.stringify({ id: 'pi_live_1', status: intentStatus, amount: 5_000_000, metadata: { topup_id: 'x' } }));
    });
  });
  await new Promise<void>((resolve) => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  wireBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wire.close(() => resolve()));
  await app?.close();
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  intentStatus = 'requires_payment_method';
  process.env['WIRE_SECRET_KEY'] = 'sk_live_for_the_test';
  process.env['WIRE_WEBHOOK_SECRET'] = SECRET;
  process.env['WIRE_API_BASE'] = wireBase;
  notifier = new FakeNotifier();
  ctx = {
    clock: new VirtualClock(at('11:40')),
    payments: new WirePayments({ secretKey: 'sk_live_for_the_test', apiBase: wireBase }),
    tax: new FakeTaxProvider(),
    notifier,
  };
  app = await buildServer(ctx, { dev: true });
});

afterEach(async () => {
  await app?.close();
  delete process.env['WIRE_SECRET_KEY'];
  delete process.env['WIRE_WEBHOOK_SECRET'];
  delete process.env['WIRE_API_BASE'];
});

describe('a top-up paid through Wire', () => {
  it('hands the phone a checkout page, and fills the wallet only once the money is there', async () => {
    const token = await signIn();
    const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: 50_000 } });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ amount_mnt: 50_000, action_url: 'https://pay.wire.mn/c/zz', state: 'pending' });
    const topupId = started.json().topup_id as string;

    // Coming back from the checkout page proves nothing, and asking early
    // gets the provider's answer, not a credit.
    const early = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${topupId}/settle`, headers: auth(token) });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NOT_PAID_YET');
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt).toBe(0);

    intentStatus = 'succeeded';
    const settled = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${topupId}/settle`, headers: auth(token) });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ balance_mnt: 50_000 });
  });

  it('fills the wallet when Wire calls back, and only for a callback Wire signed', async () => {
    const token = await signIn();
    const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: 50_000 } });
    const topupId = started.json().topup_id as string;
    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_live_1' } } });

    const forged = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': 't=1,v1=deadbeef' },
      payload: body,
    });
    expect(forged.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt).toBe(0);

    // Signed, but the money is not actually there: heard, and still nothing credited.
    const tooEarly = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': signed(body) },
      payload: body,
    });
    expect(tooEarly.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt).toBe(0);

    intentStatus = 'succeeded';
    const real = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': signed(body) },
      payload: body,
    });
    expect(real.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt).toBe(50_000);

    // Wire repeats a callback it is unsure of; the second one must not pay twice.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': signed(body) },
      payload: body,
    });
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt).toBe(50_000);
    expect(topupId).toBeTruthy();
  });

  it('shrugs at a callback about a payment it has never heard of', async () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: { id: 'pi_unknown' } } });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': signed(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, known: false });
  });
});
