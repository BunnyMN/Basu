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
import { tick } from '../scheduler/runner.js';
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
/** Wire answering the next status lookups with a 503, as a busy day does. */
let failGets = 0;

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
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (path === '/payment_intents' && request.method === 'POST') {
        const seen = key ? byKey.get(key) : undefined;
        const id = seen ?? `pi_test_${intents.size + 1}`;
        if (!seen) {
          intents.set(id, { id, status: 'requires_payment_method', amount: Number(body['amount']), metadata: body['metadata'] as Record<string, string> });
          if (key) byKey.set(key, id);
        }
        send(200, intents.get(id));
      } else if (path === '/checkout/sessions') {
        const pi = String(body['payment_intent']);
        if (typeof body['success_url'] === 'string') returns.set(pi, body['success_url']);
        send(200, { url: `https://pay.wire.test/c/${pi}` });
      } else if (path.endsWith('/cancel')) {
        const intent = intents.get(decodeURIComponent(path.split('/')[2] ?? ''));
        if (intent && intent.status !== 'succeeded') intent.status = 'canceled';
        send(200, intent ?? {});
      } else {
        if (failGets > 0) {
          failGets--;
          return send(503, { error: { code: 'unavailable' } });
        }
        const intent = intents.get(decodeURIComponent(path.split('/')[2] ?? ''));
        if (!intent) send(404, { error: { code: 'not_found' } });
        else send(200, intent);
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
  failGets = 0;
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

  it('never fails a paid invoice on a passing error from Wire, and never shows a second QR for it', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    paidAtWire('pi_test_1');
    failGets = 1;
    const busy = await pay(guest, id);
    expect(busy.statusCode, busy.body).toBe(202);
    expect(busy.json().invoice.action_url).toMatch(/pi_test_1$/);
    const bought = await pay(guest, id);
    expect(bought.statusCode, bought.body).toBe(200);
    expect(intents.size).toBe(1);
    expect(await balanceOf(guest)).toBe(0);
  });

  it('asks only, with check=1: no invoice is raised, and one let go is said as gone', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    const nothing = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay?check=1`, headers: auth(guest) });
    expect(nothing.statusCode, nothing.body).toBe(202);
    expect(nothing.json()).toEqual({ state: 'AWAITING_PAYMENT', invoice: null });
    expect(intents.size).toBe(0);

    expect((await pay(guest, id)).statusCode).toBe(202);
    later(13 * 60_000);
    const gone = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay?check=1`, headers: auth(guest) });
    expect(gone.json()).toEqual({ state: 'AWAITING_PAYMENT', invoice: null });
    expect(intents.size).toBe(1);
    expect(intents.get('pi_test_1')?.status).toBe('canceled');
  });

  it('buys from the wallet, and lets the newer invoice go, when a late payment already covers the order', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    later(13 * 60_000);
    // Let go, a fresh invoice raised on the next press…
    const fresh = await pay(guest, id, 'again');
    expect(fresh.json().invoice.action_url).toMatch(/pi_test_2$/);
    // …and the first one paid after all, found by Basu's own look: the money is in the wallet.
    intents.get('pi_test_1')!.status = 'succeeded';
    later(60_000);
    await housekeeping(ctx);
    expect(await stateOf(guest, id)).toBe('PAID');
    // Never both: the second QR is let go at Wire, and nothing is left over.
    expect(intents.get('pi_test_2')?.status).toBe('canceled');
    expect(await balanceOf(guest)).toBe(0);
  });

  it('answers «paid» to every ask that races to finish one invoice — never «payment failed»', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    paidAtWire('pi_test_1');
    const answers = await Promise.all(
      ['a', 'b', 'c', 'd'].map((key) => app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay?check=1`, headers: { ...auth(guest), 'idempotency-key': key } })),
    );
    for (const answer of answers) {
      // Bought by one of them; the others are told so (PAID), or that it is no longer a draft (WRONG_STATE, read as bought).
      expect([200, 409], answer.body).toContain(answer.statusCode);
      if (answer.statusCode === 409) expect(answer.json().error.code).toBe('WRONG_STATE');
    }
    expect(answers.some((a) => a.statusCode === 200)).toBe(true);
    expect(await stateOf(guest, id)).toBe('PAID');
    expect(await balanceOf(guest)).toBe(0);
  });

  it('lets nothing go, and gives no draft back, while Wire does not answer', async () => {
    const guest = await signIn();
    const id = await anOrder(guest);
    expect((await pay(guest, id)).statusCode).toBe(202);
    paidAtWire('pi_test_1');
    // Past both the invoice's twelve minutes and the draft's thirty — and Wire down.
    later(31 * 60_000);
    failGets = 100;
    await housekeeping(ctx);
    expect(await stateOf(guest, id)).toBe('DRAFT');
    expect(intents.get('pi_test_1')?.status).toBe('succeeded');
    // Back: the payment Wire took buys the order.
    failGets = 0;
    later(60_000);
    expect((await housekeeping(ctx)).bought).toBe(1);
    expect(await stateOf(guest, id)).toBe('PAID');
    expect(await balanceOf(guest)).toBe(0);
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

describe('a wallet top-up paid on Wire’s page', () => {
  const topUp = async (token: string, amount = 1_000) => {
    const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: amount } });
    expect(started.statusCode, started.body).toBe(200);
    return started.json().topup_id as string;
  };
  const toldOf = async (token: string) =>
    ((await app.inject({ method: 'GET', url: '/v1/notifications', headers: auth(token) })).json().messages as Array<{ template: string; body: string }>)
      .filter((m) => m.template === 'wallet.topup');

  it('lands in the wallet on the scheduler’s look when the app asked before the person paid, and says so once', async () => {
    const guest = await signIn();
    const id = await topUp(guest);
    // The app asks the moment QPay opens: nobody has paid yet, and it does not ask again.
    const early = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${id}/settle`, headers: auth(guest) });
    expect(early.statusCode).toBe(409);
    paidAtWire('pi_test_1');

    later(2 * 60_000);
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(1);
    expect(await balanceOf(guest)).toBe(1_000);
    const told = await toldOf(guest);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatch(/^1[,.\s ]?000₮ /);

    // Asked again: nothing more lands, nobody is told twice.
    later(60_000);
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(0);
    expect(await balanceOf(guest)).toBe(1_000);
    expect(await toldOf(guest)).toHaveLength(1);
  });

  it('lands the moment its owner opens the wallet, whether or not the scheduler has looked', async () => {
    const guest = await signIn();
    await topUp(guest, 20_000);
    const other = await signIn('+97699002233');
    paidAtWire('pi_test_1');
    // Somebody else's wallet does not ask about it.
    expect(await balanceOf(other)).toBe(0);
    expect(await balanceOf(guest)).toBe(20_000);
    expect(await balanceOf(guest)).toBe(20_000);
  });

  it('still lands when the person took an hour in their bank app — asked now and then for a week', async () => {
    const guest = await signIn();
    await topUp(guest, 50_000);
    later(60 * 60_000);
    paidAtWire('pi_test_1');
    // The quarter-hour look is for the young ones; the day's look finds it.
    expect((await tick(ctx, { spacingMs: 0, invoices: true, lapsed: false })).topups).toBe(0);
    expect((await tick(ctx, { spacingMs: 0, invoices: false, lapsed: true })).topups).toBe(1);
    expect(await balanceOf(guest)).toBe(50_000);
  });

  it('credits nothing unpaid or while Wire does not answer, and lets one older than a week be', async () => {
    const guest = await signIn();
    await topUp(guest);
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(0);

    paidAtWire('pi_test_1');
    // Wire busy for the tick's look and for the wallet's own.
    failGets = 2;
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(0);
    expect(await balanceOf(guest)).toBe(0);
    // Wire answers again: the same top-up, still pending, lands.
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(1);
    expect(await balanceOf(guest)).toBe(1_000);

    // Three days on, a paid one still lands; one raised more than a week ago is not asked about any more.
    await topUp(guest);
    later(3 * 24 * 60 * 60_000);
    paidAtWire('pi_test_2');
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(1);
    expect(await balanceOf(guest)).toBe(2_000);
    await topUp(guest);
    later(8 * 24 * 60 * 60_000);
    paidAtWire('pi_test_3');
    expect((await tick(ctx, { spacingMs: 0 })).topups).toBe(0);
    expect(await balanceOf(guest)).toBe(2_000);
  });
});
