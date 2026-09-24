import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { startSession } from '../platform/identity/index.js';
import { relay } from '../platform/notify/index.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedPerson, truncateAll } from '../test/seed.js';
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
  supplierOf,
} from './index.js';
import { guestForPhone } from '../platform/identity/index.js';

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

describe('an account made without a phone', () => {
  const input = () => ({ name: 'Говь-Алтай · Дорж', pickupAddress: 'Нарантуул, 3-р хаалга' });

  it('applies with the number it types, and is told when it types none or a wrong one', async () => {
    const byEmail = await seedPerson({ email: 'dorj@example.mn' });
    await expect(applySupplier(ctx, { guestId: byEmail, ...input() })).rejects.toMatchObject({ code: 'NEEDS_PHONE' });
    await expect(applySupplier(ctx, { guestId: byEmail, ...input(), phone: '12345' })).rejects.toMatchObject({ code: 'BAD_PHONE' });
    const id = await applySupplier(ctx, { guestId: byEmail, ...input(), phone: '9911 2233' });
    expect((await listSuppliers()).find((s) => s.id === id)).toMatchObject({ phone: '+97699112233', state: 'applied' });
  });

  it('never lets a typed number stand in for the one an account already has', async () => {
    const id = await applySupplier(ctx, { guestId, ...input(), phone: '+97699999999' });
    expect((await listSuppliers()).find((s) => s.id === id)).toMatchObject({ phone: PHONE });
  });

  it('hears the yes by email, code and all', async () => {
    const mailer = new FakeMailer();
    const withMail: Ctx = { ...ctx, mailer };
    const byEmail = await seedPerson({ email: 'dorj@example.mn' });
    const id = await applySupplier(withMail, { guestId: byEmail, ...input(), phone: '99112233' });
    const { pairingCode } = await approveSupplier(withMail, id);
    await relay(withMail);
    expect(mailer.to('dorj@example.mn')?.text).toContain(pairingCode);
    expect(notifier.of('supplier.approved')).toEqual([]);
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

describe('who a supplier answers to', () => {
  it('is the phone on the row — claimed at sign-in when the row predates owners', async () => {
    const id = await registerSupplier({ name: 'Хэрлэн хоршоо', phone: '+97688010002', pickupAddress: 'x' });
    const owner = await guestForPhone('+97688010002');
    expect((await supplierOf(owner))?.id).toBe(id);

    // Written in before there were owners: the column is empty, the phone is not.
    await getPool().query('UPDATE idesh.supplier SET owner_guest_id = NULL WHERE id = $1', [id]);
    expect((await supplierOf(owner))?.id).toBe(id);
    expect((await supplierOf(owner))?.id).toBe(id);
    // Somebody else's phone claims nothing.
    expect(await supplierOf(await guestForPhone('+97699000099'))).toBeNull();
  });
});
