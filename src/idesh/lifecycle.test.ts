import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import {
  balance,
  owed,
  processReceipts,
  reconcileLedger,
  settleTopup,
  startTopup,
  wallet,
} from '../platform/ledger/index.js';
import { guestForPhone } from '../platform/identity/index.js';
import { inbox, relay } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedGuest, truncateAll } from '../test/seed.js';
import { tick } from '../scheduler/runner.js';
import {
  FORFEIT_PCT,
  cancelIdesh,
  createIdesh,
  createListing,
  detailFor,
  housekeeping,
  listSettlements,
  listingById,
  liveFor,
  markDispatched,
  markHanded,
  markReady,
  markSettled,
  payIdesh,
  refundOf,
  registerSupplier,
  setRefundAccount,
  settlementsOf,
  startPreparing,
  updateSupplierProfile,
  verifySupplierBank,
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
  it('tells the supplier both ways the moment the money is down', async () => {
    const { orderId, code } = await book();
    await payIdesh(ctx, orderId);
    // The supplier was written in by ops with a phone; that phone is who hears.
    const owner = await guestForPhone('+97688010001');
    const heard = (await inbox(owner)).filter((m) => m.template === 'supplier.order');
    expect(heard.map((m) => m.channel).sort()).toEqual(['push', 'sms']);
    expect(heard[0]?.body).toContain(`№${code}`);
    expect(heard[0]?.body).toContain('өөрөө авна');
  });

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
 * Cancelling is the supplier's act, for a reason, and the reason decides the
 * money. A guest has no cancel of their own — money that has moved does not
 * come back at the press of a button — so a guest who chose wrongly rings
 * the supplier, and the supplier undoes it from their screen. The refund
 * then goes to a bank account the guest names, by a transfer ops makes; it
 * never lands in the wallet.
 */
describe('cancelling', () => {
  const by = { actor: 'supplier:d1', role: 'supplier' as const };
  const BANK = { bankName: 'Хаан банк', bankAccount: '5012345678', bankHolder: 'Бат Дорж' };

  it('before the supplier starts: everything back, the animal on offer again, the guest asked for an account', async () => {
    const { orderId, code, totalMnt } = await book();
    await payIdesh(ctx, orderId);

    // The guest rang, they talked, the supplier cancels.
    const split = await cancelIdesh(ctx, orderId, by, 'guest_asked');
    expect(split).toEqual({ refundMnt: totalMnt, forfeitMnt: 0 });
    expect(await stateOf(orderId)).toBe('CANCELLED');
    expect((await listingById(sheep.id))!.sold).toBe(0);

    // Not in the wallet: set aside, owed to the guest's bank.
    expect(await balance(guestId)).toBe(1_000_000 - totalMnt);
    expect(await owed(`guest:${guestId}`)).toBe(totalMnt);
    expect((await reconcileLedger()).drift).toBe(0);
    expect(await told(guestId)).toContain('idesh.cancelled');

    await processReceipts(ctx);
    expect(tax.issued.map((r) => r.kind)).toEqual(['SALE', 'RETURN']);
    expect(tax.issued[1]).toMatchObject({ orderCode: code, merchantTin: TIN, amountMnt: totalMnt });

    // Still the guest's to act on: the order stays in view until the money has gone.
    expect((await liveFor(guestId)).map((o) => o.id)).toEqual([orderId]);
    expect((await refundOf(orderId))?.state).toBe('needs_account');
    expect((await detailFor(guestId, orderId))?.refund?.state).toBe('needs_account');

    await setRefundAccount(orderId, guestId, BANK);
    const due = await refundOf(orderId);
    expect(due).toMatchObject({ state: 'due', amountMnt: totalMnt, bank: BANK });

    // Ops pays it by bank and says so: the books close, the order is REFUNDED.
    const paid = await markSettled(ctx, due!.id, 'ops:test', 'KB-2026-0912-001');
    expect(paid.state).toBe('paid');
    expect(await stateOf(orderId)).toBe('REFUNDED');
    expect(await owed(`guest:${guestId}`)).toBe(0);
    expect((await reconcileLedger()).drift).toBe(0);
    expect(await told(guestId)).toContain('idesh.refunded');
    expect(await liveFor(guestId)).toEqual([]);
    await expect(markSettled(ctx, due!.id, 'ops:test', 'again')).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });

  it('after slaughter on the guest’s own word: a tenth of the meat stays with the supplier', async () => {
    const { orderId, totalMnt } = await book();
    await payIdesh(ctx, orderId);
    await startPreparing(ctx, orderId, 'supplier:d1');

    const forfeit = Math.round((sheep.priceMnt * FORFEIT_PCT) / 100);
    const split = await cancelIdesh(ctx, orderId, by, 'guest_asked');
    expect(split).toEqual({ refundMnt: totalMnt - forfeit, forfeitMnt: forfeit });
    // The sheep is not put back on offer: it is a carcass now.
    expect((await listingById(sheep.id))!.sold).toBe(1);

    expect(await owed(`guest:${guestId}`)).toBe(totalMnt - forfeit);
    expect(await owed(`supplier:${supplierId}`)).toBe(forfeit);
    expect((await reconcileLedger()).drift).toBe(0);

    // Two lines for ops: the guest's refund (waiting on an account) and the
    // supplier's forfeit (due on the contract account).
    const open = await listSettlements();
    expect(open.map((t) => [t.kind, t.state, t.memo, t.amountMnt])).toEqual([
      ['refund', 'needs_account', 'Буцаалт', totalMnt - forfeit],
      ['payout', 'due', 'Суутгал', forfeit],
    ]);
    // The supplier has no account on file yet, so even a due line cannot be paid.
    await expect(markSettled(ctx, open[1]!.id, 'ops:test', 'x')).rejects.toMatchObject({ code: 'NEEDS_ACCOUNT' });
  });

  it('the vet: everything back even after slaughter, and the animal stays sold', async () => {
    const { orderId, totalMnt } = await book();
    await payIdesh(ctx, orderId);
    await startPreparing(ctx, orderId, 'supplier:d1');

    const split = await cancelIdesh(ctx, orderId, by, 'vet');
    expect(split).toEqual({ refundMnt: totalMnt, forfeitMnt: 0 });
    expect((await listingById(sheep.id))!.sold).toBe(1);
    expect(await owed(`supplier:${supplierId}`)).toBe(0);
  });

  it('«зочин ирээгүй» needs a ready pickup and three days past the guest’s day', async () => {
    const { orderId, totalMnt } = await book({ receiveOn: '2026-09-12' });
    await payIdesh(ctx, orderId);
    await expect(cancelIdesh(ctx, orderId, by, 'no_show')).rejects.toMatchObject({ code: 'BAD_REASON' });

    await startPreparing(ctx, orderId, 'supplier:d1');
    await markReady(ctx, orderId, 'supplier:d1');
    // Ready on the 2nd, the guest's day is the 12th: not absent until the 15th.
    clock.advanceMinutes(12 * 24 * 60);
    await expect(cancelIdesh(ctx, orderId, by, 'no_show')).rejects.toMatchObject({ code: 'BAD_REASON' });
    clock.advanceMinutes(24 * 60);
    const split = await cancelIdesh(ctx, orderId, by, 'no_show');
    expect(split.forfeitMnt).toBe(Math.round((sheep.priceMnt * FORFEIT_PCT) / 100));
    expect(split.refundMnt).toBe(totalMnt - split.forfeitMnt);
  });

  it('refuses a reason that does not fit, and any reason from the scheduler but its own', async () => {
    const { orderId } = await book();
    await payIdesh(ctx, orderId);
    await expect(cancelIdesh(ctx, orderId, by, 'unreachable')).rejects.toMatchObject({ code: 'BAD_REASON' });
    await expect(cancelIdesh(ctx, orderId, by, 'draft_expired')).rejects.toMatchObject({ code: 'BAD_REASON' });
    await expect(
      cancelIdesh(ctx, orderId, { actor: 'system:scheduler', role: 'system' }, 'guest_asked'),
    ).rejects.toMatchObject({ code: 'BAD_REASON' });
    expect(await stateOf(orderId)).toBe('PAID');
  });

  it('closes an unpaid draft without any money moving', async () => {
    const { orderId } = await book();
    const split = await cancelIdesh(ctx, orderId, { actor: 'scheduler', role: 'system' }, 'draft_expired');
    expect(split).toEqual({ refundMnt: 0, forfeitMnt: 0 });
    expect(await stateOf(orderId)).toBe('CLOSED');
    expect(await balance(guestId)).toBe(1_000_000);
    expect((await listingById(sheep.id))!.sold).toBe(0);
    expect(await listSettlements()).toEqual([]);
  });
});

/**
 * The supplier's share: fixed at the handover at their rate, set aside a day
 * later when the order closes, paid by ops against the account on the
 * contract. The delivery fee is theirs in full; Basu's cut is of the meat.
 */
describe('the supplier’s share', () => {
  it('is set aside when the order closes and paid out against the contract account', async () => {
    const { orderId, totalMnt } = await book({
      receive: 'delivery',
      address: 'Баянзүрх, 13-р хороолол',
      addressPhone: '+97699112233',
    });
    await payIdesh(ctx, orderId);
    await startPreparing(ctx, orderId, 'supplier:d1');
    await markReady(ctx, orderId, 'supplier:d1');
    await markDispatched(ctx, orderId, 'supplier:d1');
    await markHanded(ctx, orderId, 'supplier:d1');

    // 2% of 460 000 is 9 200; the 25 000 delivery fee passes through whole.
    const commission = Math.round(sheep.priceMnt * 0.02);
    expect(totalMnt).toBe(sheep.priceMnt + 25_000);
    expect(await settlementsOf(supplierId)).toEqual([]);
    expect(await owed(`supplier:${supplierId}`)).toBe(0);

    clock.advanceMinutes(25 * 60);
    expect((await housekeeping(ctx)).closed).toBe(1);
    const [payout] = await settlementsOf(supplierId);
    expect(payout).toMatchObject({ kind: 'payout', state: 'due', memo: 'Олголт', amountMnt: totalMnt - commission });
    expect(await owed(`supplier:${supplierId}`)).toBe(totalMnt - commission);
    // Closing twice opens nothing twice.
    expect((await housekeeping(ctx)).closed).toBe(0);
    expect(await settlementsOf(supplierId)).toHaveLength(1);

    // No account on the contract yet: ops writes it in, then pays.
    await expect(markSettled(ctx, payout!.id, 'ops:test', 'GB-1')).rejects.toMatchObject({ code: 'NEEDS_ACCOUNT' });
    // The supplier types one in from their phone: on file, not yet trusted.
    await updateSupplierProfile(supplierId, { bankName: 'Голомт', bankAccount: '1105012345', bankHolder: 'Дорж' });
    await expect(markSettled(ctx, payout!.id, 'ops:test', 'GB-1')).rejects.toMatchObject({ code: 'BANK_UNVERIFIED' });
    // Finance holds it up against the contract, and only then it pays.
    await verifySupplierBank(supplierId);
    const paid = await markSettled(ctx, payout!.id, 'ops:test', 'GB-1');
    expect(paid.state).toBe('paid');
    expect(paid.bank?.bankName).toBe('Голомт');
    expect(await owed(`supplier:${supplierId}`)).toBe(0);
    expect((await reconcileLedger()).drift).toBe(0);
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
