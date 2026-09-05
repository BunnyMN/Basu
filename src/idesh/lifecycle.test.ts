import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import {
  balance,
  processReceipts,
  reconcileLedger,
  settleTopup,
  startTopup,
  wallet,
} from '../platform/ledger/index.js';
import { inbox, relay } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedGuest, truncateAll } from '../test/seed.js';
import { tick } from '../scheduler/runner.js';
import {
  cancelIdesh,
  createIdesh,
  createListing,
  detailFor,
  housekeeping,
  listingById,
  liveFor,
  markDispatched,
  markHanded,
  markReady,
  payIdesh,
  registerSupplier,
  startPreparing,
  type Listing,
} from './index.js';

/**
 * The whole journey, against a real database.
 *
 * Money moves out of the wallet once, the animal is spoken for, the supplier
 * walks it through to the handover, the guest is told at each step, and the
 * tax receipt names the supplier. And the two things that only go wrong under
 * pressure: two guests reaching for the last sheep, and a cancel racing the
 * supplier's «бэлтгэж эхлэх».
 */

let clock: VirtualClock;
let payments: FakePaymentProvider;
let tax: FakeTaxProvider;
let notifier: FakeNotifier;
let ctx: Ctx;
let supplierId: string;
let sheep: Listing;
let guestId: string;

const TIN = '6501234567';

async function eventTypes(orderId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ type: string }>(
    'SELECT type FROM idesh.order_event WHERE order_id = $1 ORDER BY seq',
    [orderId],
  );
  return rows.map((r) => r.type);
}

async function stateOf(orderId: string): Promise<string> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM idesh.idesh_order WHERE id = $1',
    [orderId],
  );
  return rows[0]!.state;
}

/** Money in, the way the phone does it. */
async function fund(guest: string, amountMnt: number): Promise<void> {
  const topup = await startTopup(ctx, { guestId: guest, amountMnt });
  await settleTopup(ctx, topup.topupId);
}

async function book(overrides: Partial<Parameters<typeof createIdesh>[1]> = {}) {
  return createIdesh(ctx, {
    listingId: sheep.id,
    guestId,
    qty: 1,
    receive: 'pickup',
    receiveOn: '2026-09-12',
    ...overrides,
  });
}

/** What the guest has been told, by template. */
async function told(guest: string): Promise<string[]> {
  return (await inbox(guest)).map((m) => m.template);
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  payments = new FakePaymentProvider();
  tax = new FakeTaxProvider();
  notifier = new FakeNotifier();
  ctx = { clock, payments, tax, notifier };

  supplierId = await registerSupplier({
    name: 'Архангай · Дорж',
    phone: '+97688010001',
    merchantTin: TIN,
    pickupAddress: 'Нарантуул, хойд хаалга',
    lat: 47.9178,
    lon: 106.9702,
  });
  sheep = await createListing(
    supplierId,
    {
      kind: 'sheep',
      unit: 'whole',
      title: 'Хонь, залуу ирэг',
      priceMnt: 460_000,
      approxKg: 38,
      quantity: 3,
      origin: 'Архангай, Их тамир',
      readyFrom: '2026-09-10',
      delivers: true,
      deliveryFeeMnt: 25_000,
    },
    clock.now(),
  );
  guestId = await seedGuest();
  await fund(guestId, 1_000_000);
});

afterAll(async () => {
  await closePool();
});

describe('paying for an идэш', () => {
  it('takes the whole price once, out of the wallet, and the ledger still balances', async () => {
    const { orderId, code, totalMnt } = await book();
    expect(totalMnt).toBe(460_000);
    expect(code).toMatch(/^70\d\d$/);
    expect(await stateOf(orderId)).toBe('DRAFT');

    await payIdesh(ctx, orderId);
    expect(await stateOf(orderId)).toBe('PAID');
    expect(await balance(guestId)).toBe(1_000_000 - 460_000);
    expect((await reconcileLedger()).drift).toBe(0);

    // Paying again is the same payment, not a second one.
    await expect(payIdesh(ctx, orderId)).rejects.toMatchObject({ code: 'WRONG_STATE' });
    expect(await balance(guestId)).toBe(540_000);

    expect(await eventTypes(orderId)).toEqual(['CREATED', 'PAID']);
    expect(await told(guestId)).toContain('idesh.paid');
  });

  it('pulls the shortfall from the provider when the wallet is light', async () => {
    const poorer = await seedGuest();
    await fund(poorer, 100_000);
    const { orderId } = await book({ guestId: poorer });

    await payIdesh(ctx, orderId);
    expect(await stateOf(orderId)).toBe('PAID');
    // 100 000 from the balance, 360 000 topped up on the spot — and the
    // provider was asked for exactly that, not for the whole price.
    expect(await balance(poorer)).toBe(0);
    const topups = (await wallet(poorer)).lines.filter((l) => l.kind === 'topup').map((l) => l.amountMnt);
    expect(topups).toEqual([360_000, 100_000]);
    expect((await reconcileLedger()).drift).toBe(0);
  });

  it('puts the receipt on the supplier’s TIN, never the platform’s', async () => {
    const { orderId, code } = await book();
    await payIdesh(ctx, orderId);
    await processReceipts(ctx);

    const sale = tax.issued.find((r) => r.kind === 'SALE');
    expect(sale).toMatchObject({ orderCode: code, amountMnt: 460_000, merchantTin: TIN });
  });

  it('speaks for the animal from the draft, and gives it back if nobody pays', async () => {
    const { orderId } = await book();
    expect((await listingById(sheep.id))!.sold).toBe(1);

    // Half an hour goes by; the draft is still unpaid.
    clock.advanceMinutes(31);
    const swept = await housekeeping(ctx);
    expect(swept.expired).toBe(1);
    expect(await stateOf(orderId)).toBe('CLOSED');
    expect((await listingById(sheep.id))!.sold).toBe(0);
    // Nothing was paid, so nothing is refunded and the guest is not told.
    expect(await told(guestId)).toEqual([]);
  });

  it('settles two guests reaching for the last sheep in the database', async () => {
    const other = await seedGuest();
    await fund(other, 1_000_000);
    // Two already sold; one left.
    await book();
    await book();

    const results = await Promise.allSettled([book(), book({ guestId: other })]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'SOLD_OUT' });
    expect((await listingById(sheep.id))!.sold).toBe(3);
  });

  it('refuses what the page should have stopped', async () => {
    await expect(book({ receive: 'delivery' })).rejects.toMatchObject({ code: 'NO_ADDRESS' });
    await expect(book({ receiveOn: '2026-09-05' })).rejects.toMatchObject({ code: 'BAD_DATE' });
    await expect(book({ qty: 0 })).rejects.toMatchObject({ code: 'TOO_FEW' });

    const noDelivery = await createListing(
      supplierId,
      {
        kind: 'beef',
        unit: 'kg',
        title: 'Үхрийн мах',
        priceMnt: 13_500,
        minQty: 20,
        quantity: 100,
        origin: 'Хэнтий',
        readyFrom: '2026-09-10',
        delivers: false,
      },
      clock.now(),
    );
    await expect(
      book({ listingId: noDelivery.id, qty: 20, receive: 'delivery', address: 'x', addressPhone: '+97699001122' }),
    ).rejects.toMatchObject({ code: 'NO_DELIVERY' });
    await expect(book({ listingId: noDelivery.id, qty: 10 })).rejects.toMatchObject({
      code: 'TOO_FEW',
    });
  });
});

/**
 * Cancelling is the supplier's act. A guest has no cancel of their own — money
 * that has moved does not come back at the press of a button — so a guest who
 * chose wrongly rings the supplier, and the supplier undoes it from their
 * screen. The guest is refunded in full whenever that happens.
 */
describe('cancelling', () => {
  it('refunds in full and gives the animal back while the supplier has not started', async () => {
    const { orderId, code } = await book();
    await payIdesh(ctx, orderId);

    // The guest rang, they talked, the supplier cancels.
    const { refunded } = await cancelIdesh(ctx, orderId, { actor: 'supplier:d1', role: 'supplier' });
    expect(refunded).toBe(true);
    expect(await stateOf(orderId)).toBe('REFUNDED');
    expect(await balance(guestId)).toBe(1_000_000);
    expect((await listingById(sheep.id))!.sold).toBe(0);
    expect((await reconcileLedger()).drift).toBe(0);

    await processReceipts(ctx);
    expect(tax.issued.map((r) => r.kind)).toEqual(['SALE', 'RETURN']);
    expect(tax.issued[1]).toMatchObject({ orderCode: code, merchantTin: TIN });
    expect(await told(guestId)).toContain('idesh.refunded');
  });

  it('still refunds in full once the supplier has started, but the animal stays sold', async () => {
    const { orderId } = await book();
    await payIdesh(ctx, orderId);
    await startPreparing(ctx, orderId, 'supplier:d1');
    expect(await told(guestId)).toContain('idesh.preparing');

    // A carcass that failed the vet: the supplier cancels, the guest is made
    // whole, and the sheep is not put back on offer.
    const { refunded } = await cancelIdesh(
      ctx,
      orderId,
      { actor: 'supplier:d1', role: 'supplier' },
      'мал эмнэлгийн шалгалт',
    );
    expect(refunded).toBe(true);
    expect(await stateOf(orderId)).toBe('REFUNDED');
    expect(await balance(guestId)).toBe(1_000_000);
    expect((await listingById(sheep.id))!.sold).toBe(1);
  });

  it('closes an unpaid draft without any money moving', async () => {
    const { orderId } = await book();
    const { refunded } = await cancelIdesh(ctx, orderId, { actor: 'scheduler', role: 'system' });
    expect(refunded).toBe(false);
    expect(await stateOf(orderId)).toBe('CLOSED');
    expect(await balance(guestId)).toBe(1_000_000);
    expect((await listingById(sheep.id))!.sold).toBe(0);
  });
});

describe('the supplier walks it through', () => {
  it('pickup: paid → preparing → ready → handed, and a day later it closes', async () => {
    const { orderId, code } = await book();
    await payIdesh(ctx, orderId);

    await startPreparing(ctx, orderId, 'supplier:d1');
    await markReady(ctx, orderId, 'supplier:d1');
    expect(await stateOf(orderId)).toBe('READY');

    // The one message that matters goes by SMS and says where and which code.
    await relay(ctx);
    const ready = notifier.of('idesh.ready').at(-1);
    expect(ready?.channel).toBe('sms');
    expect(ready?.body).toContain('Нарантуул');
    expect(ready?.body).toContain(`№${code}`);

    // A pickup is handed over, never dispatched.
    await expect(markDispatched(ctx, orderId, 'supplier:d1')).rejects.toMatchObject({
      code: 'WRONG_STATE',
    });

    await markHanded(ctx, orderId, 'supplier:d1');
    expect(await stateOf(orderId)).toBe('HANDED');
    expect((await liveFor(guestId)).map((o) => o.state)).toEqual(['HANDED']);

    clock.advanceMinutes(24 * 60 + 1);
    const swept = await tick(ctx, { spacingMs: 0 });
    expect(swept.ideshClosed).toBe(1);
    expect(await stateOf(orderId)).toBe('CLOSED');
    expect(await liveFor(guestId)).toEqual([]);

    expect(await eventTypes(orderId)).toEqual([
      'CREATED', 'PAID', 'PREPARING', 'READY', 'HANDED', 'CLOSED',
    ]);
  });

  it('delivery: the fee is charged, the courier is told whom to call, and it goes out', async () => {
    const { orderId, totalMnt } = await book({
      receive: 'delivery',
      address: 'Баянзүрх, 13-р хороолол, 45-12',
      addressPhone: '+97699112233',
      addressLat: 47.92,
      addressLon: 106.95,
    });
    expect(totalMnt).toBe(460_000 + 25_000);
    await payIdesh(ctx, orderId);
    await startPreparing(ctx, orderId, 'supplier:d1');
    await markReady(ctx, orderId, 'supplier:d1');
    await markDispatched(ctx, orderId, 'supplier:d1');
    expect(await stateOf(orderId)).toBe('DISPATCHED');

    await relay(ctx);
    expect(notifier.of('idesh.dispatched').at(-1)?.body).toContain('+97699112233');

    await markHanded(ctx, orderId, 'supplier:d1');
    expect(await stateOf(orderId)).toBe('HANDED');
    expect(await told(guestId)).toEqual(
      expect.arrayContaining(['idesh.paid', 'idesh.preparing', 'idesh.ready', 'idesh.dispatched', 'idesh.handed']),
    );
  });

  it('will not skip a step', async () => {
    const { orderId } = await book();
    await expect(startPreparing(ctx, orderId, 'supplier:d1')).rejects.toMatchObject({
      code: 'WRONG_STATE',
    });
    await payIdesh(ctx, orderId);
    await expect(markReady(ctx, orderId, 'supplier:d1')).rejects.toMatchObject({ code: 'WRONG_STATE' });
    await expect(markHanded(ctx, orderId, 'supplier:d1')).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });
});

describe('what the guest sees', () => {
  it('shows the supplier’s phone only once there is money down', async () => {
    const { orderId } = await book();
    const before = await detailFor(guestId, orderId);
    expect(before?.supplierPhone).toBeNull();
    expect(before?.pickupAddress).toBe('Нарантуул, хойд хаалга');

    await payIdesh(ctx, orderId);
    const after = await detailFor(guestId, orderId);
    expect(after?.supplierPhone).toBe('+97688010001');
    expect(after?.state).toBe('PAID');

    // Somebody else's order is nobody's business.
    const stranger = await seedGuest();
    expect(await detailFor(stranger, orderId)).toBeNull();
  });

  it('lists only what is still going on, soonest first', async () => {
    const soon = await book({ receiveOn: '2026-09-11' });
    const later = await book({ receiveOn: '2026-09-20' });
    const draft = await book({ receiveOn: '2026-09-15' });
    await payIdesh(ctx, later.orderId);
    await payIdesh(ctx, soon.orderId);
    void draft;

    const live = await liveFor(guestId);
    expect(live.map((o) => o.receiveOn)).toEqual(['2026-09-11', '2026-09-20']);
  });
});
