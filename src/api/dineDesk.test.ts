import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { opsToken } from './ops.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedGuest, seedOrder, seedRestaurant, truncateAll, type SeededRestaurant } from '../test/seed.js';

/**
 * The lunch side of the desk, over HTTP: the restaurants and their tablets,
 * the day's orders and what can be done to one, the menu, and what people said.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let seeded: SeededRestaurant;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = (name?: string) => ({ ...auth(opsToken()!), ...(name ? { 'x-ops-name': name } : {}) });

async function signIn(phone = '+97699001122'): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function topUp(token: string, amountMnt: number): Promise<void> {
  const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: amountMnt } });
  expect(started.statusCode, started.body).toBe(200);
  const settled = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${started.json().topup_id}/settle`, headers: auth(token) });
  expect(settled.statusCode, settled.body).toBe(200);
}

/** A guest with money, and a paid lunch at 12:30. */
async function aPaidLunch(): Promise<{ id: string; code: string; guest: string }> {
  const guest = await signIn();
  await topUp(guest, 200_000);
  const menuId = Object.values(seeded.menuIds)[0]!;
  const created = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(guest),
    payload: { restaurant_id: seeded.restaurantId, slot_starts_at: at('12:30').toISOString(), party_size: 2, items: [{ menu_item_id: menuId, qty: 2 }] },
  });
  expect(created.statusCode, created.body).toBe(201);
  const paid = await app.inject({ method: 'POST', url: `/v1/orders/${created.json().id}/pay`, headers: auth(guest) });
  expect(paid.statusCode, paid.body).toBe(200);
  return { id: created.json().id, code: created.json().code, guest };
}

beforeEach(async () => {
  await truncateAll();
  seeded = await seedRestaurant();
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

describe('the restaurants at the desk', () => {
  it('lists each kitchen with its tablets, its day, and a code for a new tablet', async () => {
    await aPaidLunch();
    const before = (await app.inject({ method: 'GET', url: '/v1/ops/dine/restaurants', headers: desk() })).json().restaurants;
    expect(before).toEqual([
      expect.objectContaining({ id: seeded.restaurantId, active: true, online: false, devices: [], today: expect.objectContaining({ placed: 1, live: 1, held: 0 }) }),
    ]);
    expect(before[0].menu.total).toBeGreaterThan(0);

    const code = await app.inject({ method: 'POST', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/devices`, headers: desk(), payload: { label: 'Хойд гал тогоо' } });
    expect(code.statusCode).toBe(201);
    expect(code.json().pairing_code).toMatch(/^\d{8}$/);
    const waiting = (await app.inject({ method: 'GET', url: '/v1/ops/dine/restaurants', headers: desk() })).json().restaurants[0];
    expect(waiting.devices).toEqual([expect.objectContaining({ label: 'Хойд гал тогоо', paired_at: null, pairing_code: code.json().pairing_code })]);

    const paired = await app.inject({ method: 'POST', url: '/v1/kds/pair', payload: { pairing_code: code.json().pairing_code } });
    expect(paired.statusCode).toBe(200);
    const withTablet = (await app.inject({ method: 'GET', url: '/v1/ops/dine/restaurants', headers: desk() })).json().restaurants[0];
    expect(withTablet.devices[0]).toMatchObject({ label: 'Хойд гал тогоо', pairing_code: null });
    expect(withTablet.devices[0].paired_at).not.toBeNull();

    const gone = await app.inject({ method: 'POST', url: `/v1/ops/dine/devices/${withTablet.devices[0].id}/revoke`, headers: desk(), payload: { note: 'таблет солигдсон' } });
    expect(gone.json()).toEqual({ id: withTablet.devices[0].id, revoked: true });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/restaurants', headers: desk() })).json().restaurants[0].devices).toEqual([]);
    // The tablet's token no longer opens the kitchen display.
    expect((await app.inject({ method: 'GET', url: '/v1/kds/tickets', headers: auth(paired.json().token) })).statusCode).toBe(401);

    // Nobody without a seat at the desk hands out codes.
    expect((await app.inject({ method: 'POST', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/devices`, payload: {} })).statusCode).toBe(401);
  });

  it('takes a kitchen off the app and a dish off the menu, with the reason kept', async () => {
    const menu = (await app.inject({ method: 'GET', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/menu`, headers: desk() })).json().items;
    expect(menu.length).toBeGreaterThan(0);
    const dish = menu[0];
    const hidden = await app.inject({ method: 'POST', url: `/v1/ops/dine/menu/${dish.id}/active`, headers: desk(), payload: { active: false, note: 'түүхий эд дууссан' } });
    expect(hidden.json()).toEqual({ id: dish.id, active: false });
    const publicMenu = (await app.inject({ method: 'GET', url: `/v1/restaurants/${seeded.restaurantId}/menu` })).json().items;
    expect(publicMenu.map((m: { id: string }) => m.id)).not.toContain(dish.id);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/menu`, headers: desk() })).json().items.find((m: { id: string }) => m.id === dish.id)).toMatchObject({ active: false });

    const off = await app.inject({ method: 'POST', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/active`, headers: desk('Bayaraa'), payload: { active: false, note: 'засвартай' } });
    expect(off.json()).toEqual({ id: seeded.restaurantId, active: false });
    expect((await app.inject({ method: 'GET', url: '/v1/restaurants' })).json().restaurants).toEqual([]);
    await app.inject({ method: 'POST', url: `/v1/ops/dine/restaurants/${seeded.restaurantId}/active`, headers: desk(), payload: { active: true } });
    expect((await app.inject({ method: 'GET', url: '/v1/restaurants' })).json().restaurants).toHaveLength(1);

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['restaurant.activate', 'restaurant.suspend', 'menu.hide']);
    expect(audit[1]).toMatchObject({ who: 'ops:Демо', target_kind: 'restaurant', note: 'засвартай' });
  });
});

describe('the lunches at the desk', () => {
  it('finds the day’s orders by anything, and reads one order’s story', async () => {
    const { id, code } = await aPaidLunch();
    const live = (await app.inject({ method: 'GET', url: '/v1/ops/dine/orders', headers: desk() })).json().orders;
    expect(live).toEqual([expect.objectContaining({ id, code, state: expect.any(String), guest_phone: '+97699001122', party_size: 2, late: false })]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders?scope=done', headers: desk() })).json().orders).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders?q=9900 1122', headers: desk() })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/dine/orders?q=${code}`, headers: desk() })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders?q=nobody', headers: desk() })).json().orders).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders?day=2026-09-02', headers: desk() })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders?day=2026-09-03', headers: desk() })).json().orders).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/dine/orders?restaurant=${seeded.restaurantId}`, headers: desk() })).json().orders).toHaveLength(1);

    const file = (await app.inject({ method: 'GET', url: `/v1/ops/dine/orders/${id}`, headers: desk() })).json();
    expect(file.order).toMatchObject({ id, code, guest_phone: '+97699001122', restaurant: { id: seeded.restaurantId } });
    expect(file.lines).toEqual([expect.objectContaining({ qty: 2, cancelled: false })]);
    expect(file.events.map((e: { type: string }) => e.type).slice(0, 2)).toEqual(['CREATED', 'PAID']);
    expect(file.review).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/ops/dine/orders/00000000-0000-0000-0000-000000000000', headers: desk() })).statusCode).toBe(404);
  });

  it('cancels for a guest who rang while it is still free, refunds, and refuses after', async () => {
    const { id, guest } = await aPaidLunch();
    const unsaid = await app.inject({ method: 'POST', url: `/v1/ops/dine/orders/${id}/cancel`, headers: desk(), payload: {} });
    expect(unsaid.statusCode).toBe(400);
    const cancelled = await app.inject({ method: 'POST', url: `/v1/ops/dine/orders/${id}/cancel`, headers: desk('Bayaraa'), payload: { note: 'зочин утсаар хүссэн' } });
    expect(cancelled.json()).toEqual({ state: 'CANCELLED', refunded: true });
    expect((await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(guest) })).json().balance_mnt).toBe(200_000);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/dine/orders/${id}/cancel`, headers: desk(), payload: { note: 'дахин' } })).statusCode).toBe(409);
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ who: 'ops:Демо', action: 'order.cancel', target_kind: 'order', target_id: id, note: 'зочин утсаар хүссэн' });
    const file = (await app.inject({ method: 'GET', url: `/v1/ops/dine/orders/${id}`, headers: desk() })).json();
    expect(file.events.at(-1)).toMatchObject({ type: 'REFUNDED' });
  });

  it('marks a held table nobody came to, and reads what people said', async () => {
    const guestId = await seedGuest();
    const { orderId, code } = await seedOrder({ restaurantId: seeded.restaurantId, guestId, state: 'ARMED', slotStartsAt: at('12:30') });
    const gone = await app.inject({ method: 'POST', url: `/v1/ops/dine/orders/${orderId}/no-show`, headers: desk(), payload: { note: 'гал тогоо залгасан' } });
    expect(gone.json()).toEqual({ state: 'NO_SHOW' });

    await getPool().query(
      `INSERT INTO dine.order_review (order_id, guest_id, restaurant_id, stars, on_time, comment) VALUES ($1, $2, $3, 4, true, 'Сайхан байсан')`,
      [orderId, guestId, seeded.restaurantId],
    );
    const reviews = (await app.inject({ method: 'GET', url: '/v1/ops/dine/reviews', headers: desk() })).json().reviews;
    expect(reviews).toEqual([expect.objectContaining({ order_code: code, stars: 4, on_time: true, comment: 'Сайхан байсан', guest: 'Тест' })]);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/dine/reviews?restaurant=${seeded.restaurantId}`, headers: desk() })).json().reviews).toHaveLength(1);
    const file = (await app.inject({ method: 'GET', url: `/v1/ops/dine/orders/${orderId}`, headers: desk() })).json();
    expect(file.review).toMatchObject({ stars: 4 });
  });
});
