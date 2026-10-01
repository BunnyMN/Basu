import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { createListing, housekeeping, registerSupplier, supplierById, type Listing } from '../idesh/index.js';
import { ClosedPaymentProvider, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { setSetting } from '../ops/index.js';

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

/** What every test account is opened with, the way a person's would be. */
const PASSWORD = 'туршилтын нууц үг';

async function signIn(phone = '+97699001122'): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  if (made.statusCode === 201) return made.json().token as string;
  const back = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone, password: PASSWORD } });
  expect(back.statusCode, back.body).toBe(200);
  return back.json().token as string;
}

/** A supplier's owner: a person who signed up first, as every owner is. */
async function ownerAccount(phone: string): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().guest_id as string;
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

/** Whoever is at the supplier's counter: its owner, signed in as themselves. */
async function atCounter(supplier: string): Promise<string> {
  return signIn(supplier === supplierId ? '+97688010001' : '+97688010002');
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
    ownerId: await ownerAccount('+97688010001'),
    name: 'Архангай · Дорж',
    phone: '+97688010001',
    merchantTin: '6501234567',
    pickupAddress: 'Нарантуул, хойд хаалга',
  });
  rivalId = await registerSupplier({
    ownerId: await ownerAccount('+97688010002'),
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
  it('lets anybody browse — App Review asks for no account before products — but not order', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/idesh/listings' });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Хонь, залуу ирэг');
    const one = await app.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` });
    expect(one.statusCode).toBe(200);
    // Nothing of the owner rides along with a stall.
    expect(one.body).not.toMatch(/\+976\d{8}/);
    // Ordering is the account's: a stranger is refused.
    const order = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
    });
    expect(order.statusCode).toBe(401);
  });

  it('shows every listing to a signed-in guest, with the supplier and the day it is ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/idesh/listings', headers: auth(await signIn()) });
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

describe('putting a listing first', () => {
  const stalls = async () =>
    (await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings as Array<{ id: string; tier: string | null; tier_until: string | null }>;

  it('raises an invoice at the desk’s price, starts only once paid, and puts the listing first', async () => {
    // Another supplier's listing, ready sooner: on its own it would come first.
    const beef = await createListing(
      rivalId,
      { kind: 'beef', unit: 'kg', title: 'Үхрийн мах', priceMnt: 14_000, minQty: 10, quantity: 300, origin: 'Хэнтий', readyFrom: '2026-09-05' },
      clock.now(),
    );
    expect((await stalls()).map((l) => l.id)).toEqual([beef.id, sheep.id]);

    const owner = await atCounter(supplierId);
    const offer = (await app.inject({ method: 'GET', url: '/v1/supplier/promotions', headers: auth(owner) })).json();
    expect(offer.may_buy).toBe(true);
    expect(offer.plans).toEqual([
      { tier: 'featured', name: 'Онцгой', days: 7, price_mnt: 20_000 },
      { tier: 'vip', name: 'VIP', days: 7, price_mnt: 50_000 },
    ]);

    const asked = await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'vip' } });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json().invoice).toMatchObject({ amount_mnt: 50_000 });
    expect(asked.json().promotion).toMatchObject({ tier: 'vip', state: 'pending', starts_at: null });
    // Not before the money: an unpaid invoice puts nothing first.
    expect((await stalls())[0]!.id).toBe(beef.id);

    const paid = await app.inject({ method: 'POST', url: `/v1/supplier/promotions/${asked.json().promotion.id}/settle`, headers: auth(owner) });
    expect(paid.statusCode, paid.body).toBe(200);
    const promotion = paid.json().promotion;
    expect(promotion.state).toBe('active');
    expect(new Date(promotion.ends_at).getTime() - new Date(promotion.starts_at).getTime()).toBe(7 * 86_400_000);
    // Asked again, it answers with what holds rather than charging twice.
    expect((await app.inject({ method: 'POST', url: `/v1/supplier/promotions/${promotion.id}/settle`, headers: auth(owner) })).json().promotion.id).toBe(promotion.id);

    const now = await stalls();
    expect(now.map((l) => [l.id, l.tier])).toEqual([[sheep.id, 'vip'], [beef.id, null]]);
    expect(now[0]!.tier_until).toBe(promotion.ends_at);
    // The money went to Basu, from the person who bought it.
    const wallet = (await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(owner) })).json();
    expect(wallet.lines[0]).toMatchObject({ subject: 'idesh_promo', amount_mnt: -50_000 });
    expect(wallet.lines[0].memo).toContain('VIP');

    // Its days run out, and the listing takes its ordinary place again.
    clock.advanceMinutes(7 * 24 * 60 + 1);
    expect((await stalls()).map((l) => [l.id, l.tier])).toEqual([[beef.id, null], [sheep.id, null]]);
  });

  it('adds the days on when the same tier is bought again, at whatever price the desk has set', async () => {
    const owner = await atCounter(supplierId);
    // The desk gives the featured tier away this week: no invoice, it starts at once.
    await setSetting('promo_featured_mnt', 0, 'test');
    await setSetting('promo_featured_days', 3, 'test');

    const first = (await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'featured' } })).json();
    expect(first.invoice).toBeNull();
    expect(first.promotion.state).toBe('active');
    const second = (await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'featured' } })).json();
    expect(new Date(second.promotion.ends_at).getTime() - new Date(first.promotion.starts_at).getTime()).toBe(6 * 86_400_000);
    expect((await stalls())[0]).toMatchObject({ id: sheep.id, tier: 'featured', tier_until: second.promotion.ends_at });
    // A featured listing may go VIP; a VIP one is not sold the lesser tier.
    await setSetting('promo_vip_mnt', 0, 'test');
    expect((await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'vip' } })).statusCode).toBe(201);
    const lesser = await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'featured' } });
    expect(lesser.json().error.code).toBe('NOT_PROMOTABLE');
  });

  it('refuses another supplier’s listing, a paused one, and a tier that does not exist', async () => {
    const rival = await atCounter(rivalId);
    expect((await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(rival), payload: { tier: 'vip' } })).statusCode).toBe(404);
    const owner = await atCounter(supplierId);
    expect((await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'gold' } })).statusCode).toBe(400);
    await app.inject({ method: 'PATCH', url: `/v1/supplier/listings/${sheep.id}`, headers: auth(owner), payload: { active: false } });
    const paused = await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner), payload: { tier: 'vip' } });
    expect(paused.json().error.code).toBe('NOT_PROMOTABLE');
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

  it('files what the guest and the supplier are told under the order, so the app opens it from the inbox', async () => {
    type Message = { template: string; subject: string | null; subject_id: string | null };
    const inbox = async (token: string) =>
      (await app.inject({ method: 'GET', url: '/v1/notifications', headers: auth(token) })).json().messages as Message[];
    const token = await signIn();
    await topUp(token, 500_000);
    const { id } = await placeAndPay(token);

    expect((await inbox(token)).find((m) => m.template === 'idesh.paid')).toMatchObject({ subject: 'idesh', subject_id: id });
    // The supplier hears of the same order, by the same id.
    const owner = await signIn('+97688010001');
    expect((await inbox(owner)).find((m) => m.template === 'supplier.order')).toMatchObject({ subject: 'idesh', subject_id: id });

    // What is about the supplier itself is filed under the supplier, so
    // nothing under «idesh» carries an id that is not an order's.
    const moved = await app.inject({
      method: 'PATCH',
      url: '/v1/supplier/profile',
      headers: auth(owner),
      payload: { bank_name: 'Хаан банк', bank_account: '5012345678', bank_holder: 'Дорж', password: PASSWORD },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const told = await inbox(owner);
    expect(told.find((m) => m.template === 'supplier.bank')).toMatchObject({ subject: 'supplier', subject_id: supplierId });
    const filed = told.filter((m) => m.subject === 'idesh');
    expect(filed.length).toBeGreaterThan(0);
    expect(new Set(filed.map((m) => m.subject_id))).toEqual(new Set([id]));
  });

  it('keeps every paid order in the history, finished ones too, and never a draft', async () => {
    const token = await signIn('+97699001133');
    await topUp(token, 1_000_000);
    const { id } = await placeAndPay(token);
    // Made but never paid: not an order anybody placed.
    const draft = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: { ...auth(token), 'idempotency-key': 'draft-only' },
      payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
    });
    expect(draft.statusCode, draft.body).toBe(201);

    const all = await app.inject({ method: 'GET', url: '/v1/idesh?scope=all', headers: auth(token) });
    expect(all.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);
    // Half an hour on, the scheduler gives the draft's animal back. Closed, it
    // is still not an order anybody placed, and not «Дууслаа» among theirs.
    clock.advanceMinutes(31);
    expect((await housekeeping(ctx)).expired).toBe(1);
    const lapsed = await app.inject({ method: 'GET', url: '/v1/idesh?scope=all', headers: auth(token) });
    expect(lapsed.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);
    // Somebody else's history is theirs.
    const other = await app.inject({ method: 'GET', url: '/v1/idesh?scope=all', headers: auth(await signIn('+97699001144')) });
    expect(other.json().orders).toEqual([]);
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

    const listing = await app.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}`, headers: auth(token) });
    expect(listing.json().listing.sold).toBe(1);
  });

  it('says payments are closed in their own words, not «try again», on a server with no provider — and holds nothing', async () => {
    const closed = await buildServer({ ...ctx, payments: new ClosedPaymentProvider() }, { dev: true });
    try {
      const token = await signIn();
      // Pressed by as many curious visitors as the stall has sheep, and once
      // more: each refused before anything is set aside. A draft made anyway
      // held its sheep for half an hour, and five of them read «Энэ зар
      // дууссан» on a stall nobody had bought from.
      for (let press = 0; press <= sheep.quantity; press++) {
        const created = await closed.inject({
          method: 'POST',
          url: '/v1/idesh',
          headers: auth(press % 2 ? await signIn(`+9769900120${press}`) : token),
          payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
        });
        expect(created.statusCode, created.body).toBe(503);
        expect(created.json().error).toMatchObject({ code: 'PAYMENTS_CLOSED', message_mn: 'Онлайн төлбөр одоогоор хаалттай байна.' });
      }
      const stall = await closed.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` });
      expect(stall.json().listing).toMatchObject({ sold: 0, remaining: 5 });
      // Nothing was taken and nothing was ordered.
      const all = await closed.inject({ method: 'GET', url: '/v1/idesh?scope=all', headers: auth(token) });
      expect(all.json().orders).toEqual([]);
      const wallet = await closed.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
      expect(wallet.json().balance_mnt).toBe(0);
      // Half an hour on there is no draft to give back: none was ever made.
      clock.advanceMinutes(31);
      expect((await housekeeping(ctx)).expired).toBe(0);
    } finally {
      await closed.close();
    }
  });

  it('still sells from a wallet that covers the whole order when there is no provider, and only then', async () => {
    const token = await signIn();
    // Money the guest already holds in Basu, put there while payments were open.
    await topUp(token, 470_000);
    const closed = await buildServer({ ...ctx, payments: new ClosedPaymentProvider() }, { dev: true });
    try {
      const order = (receive: 'pickup' | 'delivery') =>
        closed.inject({
          method: 'POST',
          url: '/v1/idesh',
          headers: auth(token),
          payload: {
            listing_id: sheep.id,
            qty: 1,
            receive,
            receive_on: '2026-09-12',
            ...(receive === 'delivery' ? { address: 'Баянзүрх, 26-р хороо, 12-р байр', address_phone: '+97699112233' } : {}),
          },
        });
      // Brought to the door it is 485 000 ₮, more than the wallet holds: refused, and nothing held for it.
      const delivered = await order('delivery');
      expect(delivered.statusCode, delivered.body).toBe(503);
      expect(delivered.json().error.code).toBe('PAYMENTS_CLOSED');
      expect((await closed.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` })).json().listing.sold).toBe(0);

      // Collected it is 460 000 ₮, which the wallet covers: ordered, and paid from the wallet alone.
      const collected = await order('pickup');
      expect(collected.statusCode, collected.body).toBe(201);
      const paid = await closed.inject({ method: 'POST', url: `/v1/idesh/${collected.json().id}/pay`, headers: auth(token) });
      expect(paid.statusCode, paid.body).toBe(200);
      const wallet = await closed.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
      expect(wallet.json().balance_mnt).toBe(10_000);
      expect((await closed.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` })).json().listing).toMatchObject({ sold: 1, remaining: 4 });
    } finally {
      await closed.close();
    }
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

  it('refunds the guest in full when the supplier cancels — to a bank account the guest names', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const { id } = await placeAndPay(token);

    // The guest rang, they talked: the supplier cancels from their screen —
    // and must say why, because the reason decides the money.
    const screen = await atCounter(supplierId);
    const unsaid = await app.inject({
      method: 'POST',
      url: `/v1/supplier/orders/${id}/cancel`,
      headers: auth(screen),
      payload: {},
    });
    expect(unsaid.statusCode).toBe(409);
    expect(unsaid.json().error.code).toBe('BAD_REASON');

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/supplier/orders/${id}/cancel`,
      headers: auth(screen),
      payload: { reason: 'guest_asked' },
    });
    expect(cancelled.json()).toEqual({ state: 'CANCELLED', refund_mnt: 460_000, forfeit_mnt: 0 });

    // Not back in the wallet: owed to the guest's bank, once they say which.
    const wallet = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    expect(wallet.json().balance_mnt).toBe(40_000);
    const before = await app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(token) });
    expect(before.json()).toMatchObject({ state: 'CANCELLED', cancel_reason: 'guest_asked', refund: { state: 'needs_account' } });
    // …and still on the list, because there is something left to do.
    const live = await app.inject({ method: 'GET', url: '/v1/idesh', headers: auth(token) });
    expect(live.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);

    // Naming an account takes the password again: a stolen session may
    // look, not redirect money.
    const account = { bank_name: 'Хаан банк', bank_account: '5012 3456 78', bank_holder: 'Бат' };
    const asked = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/refund-account`, headers: auth(token), payload: account });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().error.code).toBe('PASSWORD_REQUIRED');
    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/idesh/${id}/refund-account`,
      headers: auth(token),
      payload: { ...account, password: 'өөр хүний таамаг' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('BAD_PASSWORD');
    const named = await app.inject({
      method: 'POST',
      url: `/v1/idesh/${id}/refund-account`,
      headers: auth(token),
      payload: { ...account, password: PASSWORD },
    });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().refund).toMatchObject({ state: 'due', bank_account: '5012345678', amount_mnt: 460_000 });
  });

  it('takes a refund’s account in the forms a supplier’s account takes: the number, or the IBAN with MN', async () => {
    const token = await signIn();
    await topUp(token, 500_000);
    const { id } = await placeAndPay(token);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/supplier/orders/${id}/cancel`,
      headers: auth(await atCounter(supplierId)),
      payload: { reason: 'guest_asked' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const name = (bank_account: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/idesh/${id}/refund-account`,
        headers: auth(token),
        payload: { bank_name: 'Хаан банк', bank_account, bank_holder: 'Бат', password: PASSWORD },
      });
    // An IBAN is MN and eighteen digits, twenty in all; anything shorter or longer is not one.
    for (const wrong of ['MN12 0005 0050 1234', 'MN12 0005 0050 1234 5678 9', 'MNXX12345678', 'GB12345678', '12345', 'дансны дугаар']) {
      const refused = await name(wrong);
      expect(refused.statusCode, wrong).toBe(409);
      expect(refused.json().error.code, wrong).toBe('WRONG_STATE');
    }
    // Read aloud in groups, in either case: the spaces go, the MN stays.
    const iban = await name('mn12 0005 0050 1234 5678');
    expect(iban.statusCode, iban.body).toBe(200);
    expect(iban.json().refund).toMatchObject({ state: 'due', bank_account: 'MN120005005012345678' });
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

    const screen = await atCounter(supplierId);
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

    const rival = await atCounter(rivalId);
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
    const screen = await atCounter(supplierId);

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
    const screen = await atCounter(supplierId);

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
    const open = await app.inject({ method: 'GET', url: '/v1/idesh/listings', headers: auth(await signIn()) });
    expect(open.json().listings.map((l: { id: string }) => l.id)).toEqual([sheep.id]);

    // The rival cannot touch it.
    const rival = await atCounter(rivalId);
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

  it('turns away a session that is no longer anybody', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth('nope') });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * The supplier as a person: signed in with the phone the contract names,
 * they see their own numbers, their own orders, one order's whole story,
 * and may change how they are found. A guest who owns nothing sees none of it.
 */
describe('the supplier’s own module', () => {
  it('opens to the owner’s phone and to nobody else', async () => {
    const owner = await signIn('+97688010001');
    const me = await app.inject({ method: 'GET', url: '/v1/supplier/me', headers: auth(owner) });
    expect(me.json().supplier).toMatchObject({ id: supplierId, state: 'contracted' });

    const nobody = await signIn('+97699007777');
    expect((await app.inject({ method: 'GET', url: '/v1/supplier/me', headers: auth(nobody) })).json()).toEqual({ supplier: null });
    expect((await app.inject({ method: 'GET', url: '/v1/supplier/home', headers: auth(nobody) })).statusCode).toBe(401);
  });

  it('shows today, the season, the list, and one order with its story', async () => {
    const guest = await signIn('+97699004004');
    await topUp(guest, 500_000);
    const { id, code } = await placeAndPay(guest);
    const owner = await signIn('+97688010001');

    const home = await app.inject({ method: 'GET', url: '/v1/supplier/home', headers: auth(owner) });
    expect(home.json()).toMatchObject({ lanes: { paid: 1, preparing: 0 }, season: { handed: 0, revenue_mnt: 0 } });

    const live = await app.inject({ method: 'GET', url: '/v1/supplier/orders?scope=live', headers: auth(owner) });
    expect(live.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(live.json().orders[0]).toMatchObject({ code, guest_phone: '+97699004004', payout_mnt: 460_000 - 9_200 });
    // Searched by the guest's number, with the spaces a person types.
    const byPhone = await app.inject({ method: 'GET', url: '/v1/supplier/orders?q=9900%204004', headers: auth(owner) });
    expect(byPhone.json().orders).toHaveLength(1);
    const miss = await app.inject({ method: 'GET', url: '/v1/supplier/orders?q=0000', headers: auth(owner) });
    expect(miss.json().orders).toHaveLength(0);

    // The owner walks it through from their phone, and the story says who.
    await app.inject({ method: 'POST', url: `/v1/supplier/orders/${id}/prepare`, headers: auth(owner), payload: {} });
    await app.inject({ method: 'POST', url: `/v1/supplier/orders/${id}/ready`, headers: auth(owner), payload: {} });
    await app.inject({ method: 'POST', url: `/v1/supplier/orders/${id}/hand`, headers: auth(owner), payload: {} });
    const one = await app.inject({ method: 'GET', url: `/v1/supplier/orders/${id}`, headers: auth(owner) });
    expect(one.json().order).toMatchObject({ state: 'HANDED', payout_mnt: 450_800 });
    expect(one.json().events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'PAID', 'PREPARING', 'READY', 'HANDED']);
    expect(one.json().events.at(-1).actor).toMatch(/^supplier:owner:/);

    const after = await app.inject({ method: 'GET', url: '/v1/supplier/home', headers: auth(owner) });
    expect(after.json().season).toMatchObject({ handed: 1, revenue_mnt: 460_000, payout_mnt: 450_800 });
    expect(after.json().season.by_kind).toEqual([{ kind: 'sheep', unit: 'whole', qty: 1, orders: 1 }]);

    // Another supplier's owner sees none of it.
    const rival = await signIn('+97688010002');
    expect((await app.inject({ method: 'GET', url: `/v1/supplier/orders/${id}`, headers: auth(rival) })).statusCode).toBe(404);
  });

  it('lets the owner change how they are found and where the money goes', async () => {
    const owner = await signIn('+97688010001');
    const edit = { address: 'Нарантуул, урд хаалга', about: 'Архангайн хонь', bank_name: 'Хаан банк', bank_account: '5012 3456 78', bank_holder: 'Дорж' };
    // Moving the money somewhere new takes the owner's password…
    const asked = await app.inject({ method: 'PATCH', url: '/v1/supplier/profile', headers: auth(owner), payload: edit });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().error.code).toBe('PASSWORD_REQUIRED');
    const wrong = await app.inject({ method: 'PATCH', url: '/v1/supplier/profile', headers: auth(owner), payload: { ...edit, password: 'таамаг' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('BAD_PASSWORD');
    const changed = await app.inject({ method: 'PATCH', url: '/v1/supplier/profile', headers: auth(owner), payload: { ...edit, password: PASSWORD } });
    expect(changed.statusCode, changed.body).toBe(200);
    // …and the new account is on file but not yet trusted.
    expect(changed.json()).toMatchObject({ pickup_address: 'Нарантуул, урд хаалга', bank_account: '5012345678', commission_pct: 2, bank_verified: false });
    // A name change alone asks for nothing.
    const quiet = await app.inject({ method: 'PATCH', url: '/v1/supplier/profile', headers: auth(owner), payload: { about: 'Архангайн хонь, ямаа' } });
    expect(quiet.statusCode).toBe(200);
    const short = await app.inject({ method: 'PATCH', url: '/v1/supplier/profile', headers: auth(owner), payload: { name: 'X' } });
    expect(short.statusCode).toBe(409);
  });

  it('takes an account in every form the application takes: the number, or the IBAN with MN', async () => {
    const owner = await signIn('+97688010001');
    const change = (bank_account: string) =>
      app.inject({
        method: 'PATCH',
        url: '/v1/supplier/profile',
        headers: auth(owner),
        payload: { bank_name: 'Хаан банк', bank_account, bank_holder: 'Дорж', password: PASSWORD },
      });
    // Read aloud in groups, in either case: the spaces go, the MN stays.
    const iban = await change('mn12 0005 0050 1234 5678');
    expect(iban.statusCode, iban.body).toBe(200);
    expect(iban.json()).toMatchObject({ bank_account: 'MN120005005012345678', bank_verified: false });
    const plain = await change('5012 3456 78');
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json().bank_account).toBe('5012345678');
    // Anything else is still refused, and nothing is changed by it — an IBAN
    // is twenty characters, MN and eighteen digits, never fewer or more.
    for (const wrong of ['MN12 345', 'MN12 0005 0050 1234', 'MN12 0005 0050 1234 5678 9', 'MNXX12345678', 'GB12345678', '12345', 'дансны дугаар']) {
      const refused = await change(wrong);
      expect(refused.statusCode, wrong).toBe(409);
      expect(refused.json().error.code, wrong).toBe('WRONG_STATE');
    }
    const kept = await app.inject({ method: 'GET', url: '/v1/supplier/money', headers: auth(owner) });
    expect(kept.json().bank_account).toBe('5012345678');
  });
});

describe('an account on an application', () => {
  it('is taken the way the supplier’s own change takes it: the spaces gone, the MN kept, the rest refused', async () => {
    const applicant = await signIn('+97699001177');
    const apply = (bank_account: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/supplier/apply',
        headers: auth(applicant),
        payload: { name: 'Завхан · Бат', address: 'Хархорин зах', bank_name: 'Хаан банк', bank_account, bank_holder: 'Бат' },
      });
    // Refused before anything is written: the person may correct it and ask again.
    for (const wrong of ['MN12 345', 'MN12 0005 0050 1234', 'MNXX12345678', 'GB12345678', '12345', 'дансны дугаар']) {
      const refused = await apply(wrong);
      expect(refused.statusCode, wrong).toBe(409);
      expect(refused.json().error.code, wrong).toBe('WRONG_STATE');
    }
    const asked = await apply('mn12 0005 0050 1234 5678');
    expect(asked.statusCode, asked.body).toBe(201);
    // What finance holds up against the contract is the account as the supplier's own page would save it.
    expect((await supplierById(asked.json().id))?.bankAccount).toBe('MN120005005012345678');
  });
});

describe('an id that is not one', () => {
  it('is nothing of anybody’s: 404 at every идэш address that takes one, never a 500', async () => {
    const guest = await signIn();
    const owner = await atCounter(supplierId);
    for (const id of ['not-an-id', '------------------------------------', '7001']) {
      const asked = [
        ['a listing', app.inject({ method: 'GET', url: `/v1/idesh/listings/${id}` })],
        ['an order', app.inject({ method: 'GET', url: `/v1/idesh/${id}`, headers: auth(guest) })],
        ['paying', app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay`, headers: auth(guest) })],
        [
          'a refund’s account',
          app.inject({
            method: 'POST',
            url: `/v1/idesh/${id}/refund-account`,
            headers: auth(guest),
            payload: { bank_name: 'Хаан банк', bank_account: '5012345678', bank_holder: 'Бат', password: PASSWORD },
          }),
        ],
        ['the supplier’s order', app.inject({ method: 'GET', url: `/v1/supplier/orders/${id}`, headers: auth(owner) })],
        ['moving it along', app.inject({ method: 'POST', url: `/v1/supplier/orders/${id}/prepare`, headers: auth(owner), payload: {} })],
        ['the supplier’s listing', app.inject({ method: 'PATCH', url: `/v1/supplier/listings/${id}`, headers: auth(owner), payload: { price_mnt: 470_000 } })],
        ['putting it first', app.inject({ method: 'POST', url: `/v1/supplier/listings/${id}/promote`, headers: auth(owner), payload: { tier: 'vip' } })],
        ['paying for that', app.inject({ method: 'POST', url: `/v1/supplier/promotions/${id}/settle`, headers: auth(owner) })],
      ] as const;
      for (const [what, answer] of asked) {
        const response = await answer;
        expect(response.statusCode, `${what} at «${id}»: ${response.body}`).toBe(404);
        expect(response.json().error.code, what).toBe('NOT_FOUND');
      }
    }
    // A stranger is still asked who they are before anything else.
    expect((await app.inject({ method: 'GET', url: '/v1/idesh/not-an-id' })).statusCode).toBe(401);
  });
});
