import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { createListing, createSupplierCode, registerSupplier, type Listing } from '../idesh/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';

/**
 * Өвлийн идэш over HTTP, driven the way the page and the supplier's screen
 * drive it.
 *
 * The isolation tests matter most, as with the kitchen: a guest reading
 * another guest's address, or one supplier moving another's order along, is
 * invisible with one of each and catastrophic with two.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let supplierId: string;
let rivalId: string;
let sheep: Listing;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone = '+97699001122'): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function topUp(token: string, amountMnt: number): Promise<void> {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/wallet/topup',
    headers: auth(token),
    payload: { amount_mnt: amountMnt },
  });
  expect(started.statusCode, started.body).toBe(200);
  const settled = await app.inject({
    method: 'POST',
    url: `/v1/wallet/topup/${started.json().topup_id}/settle`,
    headers: auth(token),
  });
  expect(settled.statusCode, settled.body).toBe(200);
}

async function pairScreen(supplier: string): Promise<string> {
  const code = await createSupplierCode(ctx, supplier, 'Дэлгэц');
  const paired = await app.inject({ method: 'POST', url: '/v1/supplier/pair', payload: { pairing_code: code } });
  expect(paired.statusCode, paired.body).toBe(200);
  return paired.json().token as string;
}

async function placeAndPay(
  token: string,
  body: Record<string, unknown> = {},
  key?: string,
): Promise<{ id: string; code: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/idesh',
    headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) },
    payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12', ...body },
  });
  expect(created.statusCode, created.body).toBe(201);
  const order = created.json();
  const paid = await app.inject({ method: 'POST', url: `/v1/idesh/${order.id}/pay`, headers: auth(token) });
  expect(paid.statusCode, paid.body).toBe(200);
  return { id: order.id, code: order.code };
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  app = await buildServer(ctx, { dev: true });

  supplierId = await registerSupplier({
    name: 'Архангай · Дорж',
    phone: '+97688010001',
    merchantTin: '6501234567',
    pickupAddress: 'Нарантуул, хойд хаалга',
  });
  rivalId = await registerSupplier({
    name: 'Хэнтий · Хэрлэн',
    phone: '+97688010002',
    pickupAddress: 'Эмээлт',
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
      delivers: true,
      deliveryFeeMnt: 25_000,
    },
    clock.now(),
  );
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('browsing', () => {
  it('shows every listing to anybody, with the supplier and the day it is ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/idesh/listings' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.today).toBe('2026-09-02');
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]).toMatchObject({
      title: 'Хонь, залуу ирэг',
      kind: 'sheep',
      unit: 'whole',
      price_mnt: 460_000,
      approx_kg: 38,
      remaining: 5,
      ready_from: '2026-09-10',
      delivers: true,
      delivery_fee_mnt: 25_000,
      supplier: { name: 'Архангай · Дорж', contracted: true, pickup_address: 'Нарантуул, хойд хаалга' },
    });
    // A listing is not a phone book.
    expect(JSON.stringify(body)).not.toContain('+97688010001');
  });
});

describe('ordering', () => {
  it('takes an order, pays it, and shows it on the guest’s list', async () => {
    const token = await signIn();
    await topUp(token, 500_000);

    const { id, code } = await placeAndPay(token);
    expect(code).toMatch(/^70\d\d$/);

    const live = await app.inject({ method: 'GET', url: '/v1/idesh', headers: auth(token) });
    expect(live.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);

    const detail = await app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(token) });
    expect(detail.json()).toMatchObject({
      state: 'PAID',
      total_mnt: 460_000,
      supplier_phone: '+97688010001',
      pickup_address: 'Нарантуул, хойд хаалга',
    });

    const wallet = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    expect(wallet.json().balance_mnt).toBe(40_000);
    expect(wallet.json().lines[0]).toMatchObject({ subject: 'idesh', amount_mnt: -460_000 });
    expect(wallet.json().lines[0].memo).toContain('Идэш');
  });

  it('answers a retried request with the same order, not a second one', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const payload = { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: { ...auth(token), 'idempotency-key': 'tap-1' },
      payload,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: { ...auth(token), 'idempotency-key': 'tap-1' },
      payload,
    });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json().id).toBe(first.json().id);

    const listing = await app.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` });
    expect(listing.json().listing.sold).toBe(1);
  });

  it('explains a refusal in Mongolian', async () => {
    const token = await signIn();
    const early = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: auth(token),
      payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-05' },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toMatchObject({ code: 'BAD_DATE' });
    expect(early.json().error.message_mn).toMatch(/өдөр/);

    const noAddress = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: auth(token),
      payload: { listing_id: sheep.id, qty: 1, receive: 'delivery', receive_on: '2026-09-12' },
    });
    expect(noAddress.json().error.code).toBe('NO_ADDRESS');
  });

  it('keeps one guest out of another guest’s order', async () => {
    const mine = await signIn('+97699001122');
    await topUp(mine, 500_000);
    const { id } = await placeAndPay(mine);

    const theirs = await signIn('+97699002233');
    const peek = await app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(theirs) });
    expect(peek.statusCode).toBe(404);
    const meddle = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay`, headers: auth(theirs) });
    expect(meddle.statusCode).toBe(403);

    const noToken = await app.inject({ method: 'GET', url: `/v1/idesh/${id}` });
    expect(noToken.statusCode).toBe(401);
  });

  it('refunds the guest in full when the supplier cancels — the guest has no cancel of their own', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const { id } = await placeAndPay(token);

    // The guest rang, they talked: the supplier cancels from their screen.
    const screen = await pairScreen(supplierId);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/supplier/orders/${id}/cancel`,
      headers: auth(screen),
      payload: { reason: 'зочин утсаар хүссэн' },
    });
    expect(cancelled.json()).toEqual({ state: 'REFUNDED', refunded: true });
    const wallet = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    expect(wallet.json().balance_mnt).toBe(500_000);
  });
});

describe('the supplier’s screen', () => {
  it('shows the paid order to its supplier and to nobody else', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const { id, code } = await placeAndPay(token, {
      receive: 'delivery',
      address: 'Баянзүрх, 13-р хороолол',
      address_phone: '+97699112233',
    });

    const screen = await pairScreen(supplierId);
    const board = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth(screen) });
    expect(board.statusCode).toBe(200);
    expect(board.json().supplier.name).toBe('Архангай · Дорж');
    expect(board.json().lanes.paid).toHaveLength(1);
    expect(board.json().lanes.paid[0]).toMatchObject({
      id,
      code,
      receive: 'delivery',
      address: 'Баянзүрх, 13-р хороолол',
      address_phone: '+97699112233',
    });
    expect(board.json().listings).toHaveLength(1);

    const rival = await pairScreen(rivalId);
    const rivalBoard = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth(rival) });
    const lanes = rivalBoard.json().lanes;
    expect(lanes.paid.length + lanes.preparing.length + lanes.ready.length + lanes.dispatched.length).toBe(0);

    const meddle = await app.inject({
      method: 'POST',
      url: `/v1/supplier/orders/${id}/prepare`,
      headers: auth(rival),
      payload: {},
    });
    expect(meddle.statusCode).toBe(403);
  });

  it('walks the order through, and gives the guest nothing to cancel with', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const { id } = await placeAndPay(token);
    const screen = await pairScreen(supplierId);

    const act = (action: string) =>
      app.inject({ method: 'POST', url: `/v1/supplier/orders/${id}/${action}`, headers: auth(screen), payload: {} });

    expect((await act('prepare')).json()).toEqual({ state: 'PREPARING' });
    // No guest-side cancel exists — not a refusal, not a route. The guest
    // rings the supplier, whose number the detail carries.
    const noSuchThing = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/cancel`, headers: auth(token) });
    expect(noSuchThing.statusCode).toBe(404);

    expect((await act('ready')).json()).toEqual({ state: 'READY' });
    // A pickup is handed over, not dispatched.
    expect((await act('dispatch')).statusCode).toBe(409);
    expect((await act('hand')).json()).toEqual({ state: 'HANDED' });

    const detail = await app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(token) });
    expect(detail.json()).toMatchObject({ state: 'HANDED' });
    expect(detail.json().handed_at).toBeTruthy();
  });

  it('lets the supplier run their own stall', async () => {
    const screen = await pairScreen(supplierId);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/supplier/listings',
      headers: auth(screen),
      payload: {
        kind: 'beef',
        unit: 'kg',
        title: 'Үхрийн мах, кг-аар',
        price_mnt: 13_500,
        min_qty: 20,
        quantity: 600,
        origin: 'Хэнтий, Хэрлэн',
        ready_from: '2026-09-20',
        delivers: false,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const listingId = created.json().listing.id as string;

    // Twenty sheep became fifteen, and the price went up.
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/supplier/listings/${sheep.id}`,
      headers: auth(screen),
      payload: { quantity: 3, price_mnt: 480_000 },
    });
    expect(updated.json().listing).toMatchObject({ quantity: 3, price_mnt: 480_000 });

    // …but not below what is already sold.
    const token = await signIn();
    await topUp(token, 1_000_000);
    await placeAndPay(token);
    await placeAndPay(token);
    const tooLow = await app.inject({
      method: 'PATCH',
      url: `/v1/supplier/listings/${sheep.id}`,
      headers: auth(screen),
      payload: { quantity: 1 },
    });
    expect(tooLow.statusCode).toBe(409);

    // Pausing a listing hides it from guests without losing its orders.
    await app.inject({
      method: 'PATCH',
      url: `/v1/supplier/listings/${listingId}`,
      headers: auth(screen),
      payload: { active: false },
    });
    const open = await app.inject({ method: 'GET', url: '/v1/idesh/listings' });
    expect(open.json().listings.map((l: { id: string }) => l.id)).toEqual([sheep.id]);

    // The rival cannot touch it.
    const rival = await pairScreen(rivalId);
    const meddle = await app.inject({
      method: 'PATCH',
      url: `/v1/supplier/listings/${sheep.id}`,
      headers: auth(rival),
      payload: { quantity: 0 },
    });
    expect(meddle.statusCode).toBe(404);

    // Bad input is refused before it reaches the database.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/supplier/listings',
      headers: auth(screen),
      payload: { kind: 'camel', unit: 'whole', title: 'x', origin: 'y', price_mnt: 1, quantity: 1, ready_from: '2026-09-20' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('turns a stale screen away', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth('nope') });
    expect(response.statusCode).toBe(401);
  });
});

describe('the demo surface', () => {
  it('hands the walkthrough a screen without a code, and every board at once', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    await placeAndPay(token);

    const suppliers = await app.inject({ method: 'GET', url: '/dev/suppliers' });
    expect(suppliers.json().suppliers.map((s: { name: string }) => s.name)).toEqual([
      'Архангай · Дорж',
      'Хэнтий · Хэрлэн',
    ]);

    const handed = await app.inject({
      method: 'POST',
      url: '/dev/supplier-token',
      payload: { supplier_id: supplierId },
    });
    expect(handed.statusCode).toBe(200);
    const board = await app.inject({
      method: 'GET',
      url: '/v1/supplier/board',
      headers: auth(handed.json().token),
    });
    expect(board.json().lanes.paid).toHaveLength(1);

    const all = await app.inject({ method: 'GET', url: '/dev/supplier/board' });
    expect(all.json().supplier).toBeNull();
    expect(all.json().lanes.paid).toHaveLength(1);
  });
});
