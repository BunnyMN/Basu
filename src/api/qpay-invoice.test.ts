import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { createListing, housekeeping, registerSupplier, type Listing } from '../idesh/index.js';
import { WirePayments } from '../platform/ledger/index.js';
import { FakeNotifier, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { buildServer } from './server.js';

/**
 * An идэш paid for by QPay, on Wire's own page.
 *
 * What has to hold: a purchase the wallet does not cover is not refused —
 * it waits on one invoice, the same one however often the page asks — and
 * goes through once Wire says the money arrived, whoever asks next: the
 * page, Wire's callback, or the scheduler with nobody on the page at all. A
 * draft somebody is paying right now is not given back at half an hour; an
 * invoice nobody paid is let go.
 */

const SECRET = 'whsec_for_the_test';
let wire: Server;
let wireBase: string;
/** Wire's side: intents by id, the idempotency keys it has seen, and where each page sends people back. */
const intents = new Map<string, { id: string; status: string; amount: number; metadata: Record<string, string> }>();
const byKey = new Map<string, string>();
const returns = new Map<string, string>();

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let sheep: Listing;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'туршилтын нууц үг';

async function signIn(phone = '+97699001122'): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().token as string;
}

async function ownerAccount(phone: string): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().guest_id as string;
}

async function anOrder(token: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/idesh',
    headers: auth(token),
    payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

const pay = (token: string, id: string, key = `pay-${id}`) =>
  app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay`, headers: { ...auth(token), 'idempotency-key': key } });

const stateOf = async (token: string, id: string) =>
  (await app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(token) })).json().state as string;

const balanceOf = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) })).json().balance_mnt as number;

/** Time passing on the demo clock. */
const later = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));

/** The person pays on Wire's page. */
const paidAtWire = (providerRef: string) => {
  const intent = intents.get(providerRef);
  if (!intent) throw new Error(`no intent ${providerRef}`);
  intent.status = 'succeeded';
};

beforeAll(async () => {
  wire = createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => (raw += c));
    request.on('end', () => {
      const path = request.url ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const key = request.headers['idempotency-key'] as string | undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/payment_intents' && request.method === 'POST') {
        const seen = key ? byKey.get(key) : undefined;
        const id = seen ?? `pi_test_${intents.size + 1}`;
        if (!seen) {
          intents.set(id, { id, status: 'requires_payment_method', amount: Number(body['amount']), metadata: body['metadata'] as Record<string, string> });
          if (key) byKey.set(key, id);
        }
        response.end(JSON.stringify(intents.get(id)));
      } else if (path === '/checkout/sessions') {
        const pi = String(body['payment_intent']);
        if (typeof body['success_url'] === 'string') returns.set(pi, body['success_url']);
        response.end(JSON.stringify({ url: `https://pay.wire.test/c/${pi}` }));
      } else if (path.endsWith('/cancel')) {
        const intent = intents.get(decodeURIComponent(path.split('/')[2] ?? ''));
        if (intent && intent.status !== 'succeeded') intent.status = 'canceled';
        response.end(JSON.stringify(intent ?? {}));
      } else {
        const intent = intents.get(decodeURIComponent(path.split('/')[2] ?? ''));
        if (!intent) {
          response.writeHead(404);
          response.end(JSON.stringify({ error: { code: 'not_found' } }));
        } else response.end(JSON.stringify(intent));
      }
    });
  });
  await new Promise<void>((resolve) => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  wireBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

beforeEach(async () => {
  await truncateAll();
  intents.clear();
  byKey.clear();
  returns.clear();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = {
    clock,
    payments: new WirePayments({ secretKey: 'sk_test_for_the_test', webhookSecret: SECRET, apiBase: wireBase }),
    tax: new FakeTaxProvider(),
    notifier,
  };
  // The callback's route is mounted from the environment, as on the server.
  process.env['WIRE_SECRET_KEY'] = 'sk_test_for_the_test';
  process.env['WIRE_WEBHOOK_SECRET'] = SECRET;
  process.env['WIRE_API_BASE'] = wireBase;
  app = await buildServer(ctx, { dev: true });
  delete process.env['WIRE_SECRET_KEY'];
  delete process.env['WIRE_WEBHOOK_SECRET'];
  delete process.env['WIRE_API_BASE'];
  const supplierId = await registerSupplier({
    ownerId: await ownerAccount('+97688010001'),
    name: 'Архангай · Дорж',
    phone: '+97688010001',
    merchantTin: '6501234567',
    pickupAddress: 'Нарантуул, хойд хаалга',
  });
  sheep = await createListing(
    supplierId,
    {
      kind: 'sheep',
      unit: 'whole',
      title: 'Хонь, залуу ирэг',
      priceMnt: 460_000,
      approxKg: 38,
      quantity: 5,
      origin: 'Архангай, Их тамир',
      readyFrom: '2026-09-10',
      delivers: false,
      deliveryFeeMnt: 0,
    },
    clock.now(),
  );
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => wire.close(() => resolve()));
  await closePool();
});

describe('an идэш paid by QPay on Wire’s page', () => {
  it('waits on one invoice, the same however often the page asks, and is bought once it is paid', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);

    const first = await pay(guest, id);
    expect(first.statusCode, first.body).toBe(202);
    const invoice = first.json().invoice;
    expect(first.json().state).toBe('AWAITING_PAYMENT');
    expect(invoice).toMatchObject({ amount_mnt: 460_000 });
    expect(invoice.action_url).toMatch(/^https:\/\/pay\.wire\.test\/c\/pi_test_1$/);
    // Wire sends the person back to the order's own page.
    expect(returns.get('pi_test_1')).toMatch(new RegExp(`/orders/${id}\\?paying=1$`));
    expect(await stateOf(guest, id)).toBe('DRAFT');

    // Asked again — the same key, a new one — it is the same invoice, never a second QR for the same money.
    for (const key of [`pay-${id}`, 'another-press']) {
      const again = await pay(guest, id, key);
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json().invoice.topup_id).toBe(invoice.topup_id);
    }
    expect(intents.size).toBe(1);

    // Paid at Wire: the next ask buys it — under the first key too (a 202 is never kept as its answer).
    paidAtWire('pi_test_1');
    const bought = await pay(guest, id);
    expect(bought.statusCode, bought.body).toBe(200);
    expect(bought.json()).toEqual({ state: 'PAID' });
    expect(await stateOf(guest, id)).toBe('PAID');
    // The money went through the wallet and on to the order: nothing left over, nothing missing.
    expect(await balanceOf(guest)).toBe(0);
  });

  it('is bought by the scheduler when the person paid and never came back to the page', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    paidAtWire('pi_test_1');

    later(3 * 60_000);
    const swept = await housekeeping(ctx);
    expect(swept.bought).toBe(1);
    expect(await stateOf(guest, id)).toBe('PAID');
    expect(await balanceOf(guest)).toBe(0);
  });

  it('is bought by Wire’s callback', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    paidAtWire('pi_test_1');

    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_1' } } });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
    const heard = await app.inject({
      method: 'POST',
      url: '/v1/payments/wire/webhook',
      headers: { 'content-type': 'application/json', 'wirepayment-signature': signature },
      payload: body,
    });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(await stateOf(guest, id)).toBe('PAID');
  });

  it('keeps a draft somebody is paying right now past half an hour, and lets an unpaid invoice go', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    // Thinking it over for 25 minutes, then «Төлөх».
    later(25 * 60_000);
    expect((await pay(guest, id)).statusCode).toBe(202);

    // The draft is 31 minutes old, its invoice 6: still theirs.
    later(6 * 60_000);
    await housekeeping(ctx);
    expect(await stateOf(guest, id)).toBe('DRAFT');

    // Never paid: the invoice is let go at Wire, and the draft gives its animal back.
    later(10 * 60_000);
    await housekeeping(ctx);
    expect(intents.get('pi_test_1')?.status).toBe('canceled');
    // Given back, as any draft nobody paid for is (cancelled and, with no money to return, closed).
    expect(await stateOf(guest, id)).toBe('CLOSED');
    expect(await balanceOf(guest)).toBe(0);
  });

  it('raises a fresh invoice when the last one lapsed unpaid', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    later(13 * 60_000);
    const again = await pay(guest, id, 'later');
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().invoice.action_url).toMatch(/pi_test_2$/);
    expect(intents.get('pi_test_1')?.status).toBe('canceled');
  });

  it('lands a payment made just after its invoice was let go — in the order if it still waits, else in the wallet', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    // Unpaid at twelve minutes: let go (cancelled at Wire)…
    later(13 * 60_000);
    await housekeeping(ctx);
    expect(intents.get('pi_test_1')?.status).toBe('canceled');
    // …and yet paid in the moment after (Wire took it): the next look buys the order.
    intents.get('pi_test_1')!.status = 'succeeded';
    later(60_000);
    const swept = await housekeeping(ctx);
    expect(swept.bought).toBe(1);
    expect(await stateOf(guest, id)).toBe('PAID');
    expect(await balanceOf(guest)).toBe(0);

    // The same, for a draft given back meanwhile: the money waits in the wallet, never stranded at Wire.
    const other = await anOrder(guest);
    expect((await pay(guest, other, 'second')).statusCode).toBe(202);
    later(31 * 60_000);
    await housekeeping(ctx);
    expect(await stateOf(guest, other)).toBe('CLOSED');
    intents.get('pi_test_2')!.status = 'succeeded';
    later(60_000);
    await housekeeping(ctx);
    expect(await balanceOf(guest)).toBe(460_000);
  });

  it('pays from the wallet at once when the wallet covers it', async () => {
    const guest = await signIn();
    // Money already in the wallet (a top-up through Wire, paid).
    const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(guest), payload: { amount_mnt: 500_000 } });
    expect(started.statusCode, started.body).toBe(200);
    paidAtWire('pi_test_1');
    const settled = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${started.json().topup_id}/settle`, headers: auth(guest) });
    expect(settled.statusCode, settled.body).toBe(200);

    const id = await anOrder(guest);
    const paid = await pay(guest, id);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await stateOf(guest, id)).toBe('PAID');
    expect(await balanceOf(guest)).toBe(40_000);
    expect(intents.size).toBe(1);
  });
});
