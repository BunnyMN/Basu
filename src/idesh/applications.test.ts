import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { startSession } from '../platform/identity/index.js';
import { relay } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import {
  applicationOf,
  applySupplier,
  approveSupplier,
  createListing,
  declineSupplier,
  listSuppliers,
  openListings,
  pairSupplier,
  registerSupplier,
} from './index.js';

/**
 * Becoming a supplier, against a real database.
 *
 * The line this guards: nothing an unapproved applicant lists reaches a
 * guest, and no code opens a screen for them, until ops has said yes. And the
 * yes arrives the way a person will actually receive it — as an SMS with the
 * code in it.
 */

let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let guestId: string;

const PHONE = '+97688010009';

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  ({ guestId } = await startSession(ctx, PHONE));
});

afterAll(async () => {
  await closePool();
});

async function apply(name = 'Завхан · Бат-Эрдэнэ') {
  return applySupplier(ctx, {
    guestId,
    name,
    merchantTin: '6505678901',
    pickupAddress: 'Хархорин зах, урд хаалга',
    about: 'Завханы хонь',
  });
}

describe('asking to become a supplier', () => {
  it('records the application on the phone the guest proved, not one they typed', async () => {
    const id = await apply();
    const mine = await applicationOf(ctx, guestId);
    expect(mine).toMatchObject({ id, state: 'applied', pairingCode: null, paired: false });

    const [row] = await listSuppliers();
    expect(row).toMatchObject({ id, state: 'applied', phone: PHONE, merchantTin: '6505678901' });
    // Applications sort first: ops sees what is waiting before what is done.
    await registerSupplier({ name: 'Aa contracted', phone: '+97688010001', pickupAddress: 'x' });
    expect((await listSuppliers())[0]!.id).toBe(id);
  });

  it('allows one open application per person', async () => {
    await apply();
    await expect(apply('Өөр нэр')).rejects.toMatchObject({ code: 'ALREADY_APPLIED' });
  });

  it('shows a guest nothing an applicant lists, and sells none of it', async () => {
    const id = await apply();
    await createListing(
      id,
      {
        kind: 'sheep',
        unit: 'whole',
        title: 'Хонь',
        priceMnt: 400_000,
        approxKg: 35,
        quantity: 5,
        origin: 'Завхан',
        readyFrom: '2026-09-10',
      },
      clock.now(),
    );
    expect(await openListings()).toEqual([]);
  });

  it('is refused a TIN that is not one', async () => {
    await expect(
      applySupplier(ctx, { guestId, name: 'X', merchantTin: '12', pickupAddress: 'somewhere' }),
    ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });
});

describe('ops decides', () => {
  it('yes: the applicant becomes a supplier, gets a code by SMS, and the code opens a screen', async () => {
    const id = await apply();
    const { pairingCode } = await approveSupplier(ctx, id);
    expect(pairingCode).toMatch(/^\d{8}$/);

    const mine = await applicationOf(ctx, guestId);
    expect(mine).toMatchObject({ state: 'contracted', pairingCode, paired: false });

    await relay(ctx);
    const sms = notifier.of('supplier.approved').at(-1);
    expect(sms?.channel).toBe('sms');
    expect(sms?.to).toBe(PHONE);
    expect(sms?.body).toContain(pairingCode);

    // The code good for a day, not ten minutes: it went out by SMS.
    clock.advanceMinutes(20 * 60);
    const session = await pairSupplier(ctx, pairingCode);
    expect(session.supplierId).toBe(id);
    expect((await applicationOf(ctx, guestId))?.paired).toBe(true);

    // Now what they list is on offer.
    await createListing(
      id,
      {
        kind: 'sheep',
        unit: 'whole',
        title: 'Хонь',
        priceMnt: 400_000,
        approxKg: 35,
        quantity: 5,
        origin: 'Завхан',
        readyFrom: '2026-09-10',
      },
      clock.now(),
    );
    expect((await openListings()).map((l) => l.supplier.contracted)).toEqual([true]);

    // Approving twice is not a thing.
    await expect(approveSupplier(ctx, id)).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it('no: the reason is kept and sent, and the person may ask again', async () => {
    const id = await apply();
    await declineSupplier(ctx, id, 'ТТД баталгаажаагүй');

    const mine = await applicationOf(ctx, guestId);
    expect(mine).toMatchObject({ state: 'declined', declineReason: 'ТТД баталгаажаагүй' });

    await relay(ctx);
    expect(notifier.of('supplier.declined').at(-1)?.body).toContain('ТТД баталгаажаагүй');

    // The declined row stays as the record; a new application is a new row.
    const again = await apply('Завхан · Бат-Эрдэнэ, засварласан');
    expect(again).not.toBe(id);
    expect((await applicationOf(ctx, guestId))?.state).toBe('applied');
    expect((await listSuppliers()).map((s) => s.state).sort()).toEqual(['applied', 'declined']);
  });

  it('cannot decide what is not waiting', async () => {
    const contracted = await registerSupplier({ name: 'X', phone: '+97688010001', pickupAddress: 'x' });
    await expect(approveSupplier(ctx, contracted)).rejects.toMatchObject({ code: 'NOT_PENDING' });
    await expect(declineSupplier(ctx, contracted, 'y')).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });
});
