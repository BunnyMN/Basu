import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at, PILOT_MENU } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import {
  createIdesh,
  createListing,
  markHanded,
  markReady as markIdeshReady,
  payIdesh,
  registerSupplier,
  startPreparing,
} from '../idesh/index.js';
import { settleTopup, startTopup } from '../platform/ledger/index.js';
import { startSession } from '../platform/identity/index.js';
import { activityTokensFor, registerActivityToken } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedGuest, seedRestaurant, truncateAll, type SeededRestaurant } from '../test/seed.js';
import { relayActivities } from './activities.js';
import { acceptOrder, cancelOrder, createOrder, fireNow, markReady, markServed, payOrder } from './orders.js';

/**
 * The lock screen, moved from the server.
 *
 * The card is not the app: once the phone has registered its token, every
 * change it shows has to arrive by push, and a change that does not arrive
 * is a guest walking to a table that is not ready. So what is tested is the
 * contract with the scheduler — a change pushes, no change does not, a
 * failed push is retried, an ended order ends the card, a dead token stops.
 */

let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let venue: SeededRestaurant;
let guestId: string;

async function book(): Promise<string> {
  const created = await createOrder(ctx, {
    restaurantId: venue.restaurantId,
    guestId,
    slotStartsAt: at('12:30'),
    partySize: 2,
    items: [{ menuItemId: venue.menuIds['tsuivan' as keyof typeof PILOT_MENU]!, qty: 1 }],
  });
  await payOrder(ctx, created.orderId);
  return created.orderId;
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  venue = await seedRestaurant();
  guestId = await seedGuest(getPool(), 'AUTO');
});

afterAll(async () => {
  await closePool();
});

describe('a card that follows the order', () => {
  it('is pushed on change and left alone otherwise, per token', async () => {
    const orderId = await book();
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-a', at: clock.now() });

    // The first pass tells the card where the order stands.
    let report = await relayActivities(ctx);
    expect(report).toEqual({ updated: 1, ended: 0, forgotten: 0, failed: 0 });
    expect(notifier.activities).toHaveLength(1);
    const first = notifier.activities[0]!;
    expect(first.token).toBe('phone-a');
    expect(first.event).toBe('update');
    expect(first.contentState).toEqual({
      stage: 'waiting',
      stageLabel: 'Хүлээгдэж байна',
      seatingTime: at('12:30').toISOString(),
      fireTime: null,
    });
    expect(first.alert).toBeUndefined();
    // Stale half an hour after seating: by then the lunch is a memory.
    expect(first.staleAt).toEqual(new Date(at('12:30').getTime() + 30 * 60_000));

    // Nothing happened. Nothing is sent.
    report = await relayActivities(ctx);
    expect(report.updated).toBe(0);
    expect(notifier.activities).toHaveLength(1);

    // The kitchen accepts and the planner picks a fire time: that is news,
    // even though the stage on the card is still "waiting".
    await acceptOrder(ctx, orderId);
    report = await relayActivities(ctx);
    expect(report.updated).toBe(1);
    const second = notifier.activities[1]!;
    expect(second.contentState['stage']).toBe('waiting');
    expect(second.contentState['fireTime']).not.toBeNull();

    // A second phone registering late gets caught up on its own, without
    // the first being told again.
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-b', at: clock.now() });
    report = await relayActivities(ctx);
    expect(report.updated).toBe(1);
    expect(notifier.activities[2]!.token).toBe('phone-b');
  });

  it('interrupts for the fire and the food, and ends when the order is over', async () => {
    const orderId = await book();
    await acceptOrder(ctx, orderId);
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-a', at: clock.now() });
    await relayActivities(ctx);
    notifier.activities.length = 0;

    await fireNow(ctx, orderId);
    await relayActivities(ctx);
    expect(notifier.activities[0]!.contentState['stage']).toBe('cooking');
    expect(notifier.activities[0]!.alert?.title).toBe('Гал дээр гарлаа');

    await markReady(ctx, orderId);
    await relayActivities(ctx);
    expect(notifier.activities[1]!.contentState['stage']).toBe('ready');
    expect(notifier.activities[1]!.alert?.title).toBe('Ширээ бэлэн');

    await markServed(ctx, orderId);
    const report = await relayActivities(ctx);
    expect(report.ended).toBe(1);
    const end = notifier.activities[2]!;
    expect(end.event).toBe('end');
    expect(end.dismissAt).toBeInstanceOf(Date);
    // Ended is ended: the token is forgotten, and the next pass is silent.
    expect(await activityTokensFor('order', orderId)).toEqual([]);
    expect((await relayActivities(ctx)).ended).toBe(0);
  });

  it('ends a cancelled order the same way', async () => {
    const orderId = await book();
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-a', at: clock.now() });
    await relayActivities(ctx);
    await cancelOrder(ctx, orderId, 'guest');
    const report = await relayActivities(ctx);
    expect(report.ended).toBe(1);
    expect(notifier.activities.at(-1)!.event).toBe('end');
  });

  it('retries a push that failed, and stops on a token Apple has declared dead', async () => {
    const orderId = await book();
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-a', at: clock.now() });
    await registerActivityToken({ guestId, subject: 'order', subjectId: orderId, pushToken: 'phone-dead', at: clock.now() });
    notifier.deadTokens.add('phone-dead');

    notifier.failChannel = 'push';
    let report = await relayActivities(ctx);
    // Apple down: nothing landed, nothing is marked as landed. The token
    // Apple had already declared dead is forgotten regardless.
    expect(report.failed).toBe(1);
    expect(report.forgotten).toBe(1);
    expect(notifier.activities).toHaveLength(0);
    expect(await activityTokensFor('order', orderId)).toEqual(['phone-a']);

    notifier.failChannel = null;
    report = await relayActivities(ctx);
    expect(report.updated).toBe(1);
    expect(notifier.activities).toHaveLength(1);
  });

  it('forgets a card whose order no longer exists', async () => {
    await registerActivityToken({
      guestId,
      subject: 'order',
      subjectId: '00000000-0000-0000-0000-000000000000',
      pushToken: 'phone-a',
      at: clock.now(),
    });
    const report = await relayActivities(ctx);
    expect(report.forgotten).toBe(1);
    expect(notifier.activities).toHaveLength(0);
  });
});

describe('an идэш on the lock screen', () => {
  /** A sheep, paid for, to be picked up on the 12th. */
  async function paidSheep(): Promise<string> {
    const ownerId = (await startSession(ctx, '+97688010001')).guestId;
    const supplierId = await registerSupplier({
      ownerId,
      name: 'Архангай · Дорж',
      phone: '+97688010001',
      merchantTin: '6501234567',
      pickupAddress: 'Нарантуул, хойд хаалга',
      lat: 47.9178,
      lon: 106.9702,
    });
    const sheep = await createListing(
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
    const topup = await startTopup(ctx, { guestId, amountMnt: 500_000 });
    await settleTopup(ctx, topup.topupId);
    const { orderId } = await createIdesh(ctx, {
      listingId: sheep.id,
      guestId,
      qty: 1,
      receive: 'pickup',
      receiveOn: '2026-09-12',
    });
    await payIdesh(ctx, orderId);
    return orderId;
  }

  it('follows the order step by step, without an alert, and ends at the handover', async () => {
    const orderId = await paidSheep();
    await registerActivityToken({ guestId, subject: 'idesh', subjectId: orderId, pushToken: 'phone-a', at: clock.now() });

    let report = await relayActivities(ctx);
    expect(report).toEqual({ updated: 1, ended: 0, forgotten: 0, failed: 0 });
    const first = notifier.activities.at(-1)!;
    expect(first.event).toBe('update');
    // What `IdeshActivityAttributes.ContentState` decodes: four plain values.
    expect(first.contentState).toEqual({ state: 'PAID', word: 'Төлсөн', step: 1, receiveOn: '2026-09-12' });
    // The order's own messages say it; the card does not buzz as well.
    expect(first.alert).toBeUndefined();
    // Out of date at the end of the day it was for, in Ulaanbaatar.
    expect(first.staleAt).toEqual(new Date('2026-09-12T15:59:59Z'));

    // Nothing happened: nothing is sent.
    report = await relayActivities(ctx);
    expect(report.updated).toBe(0);

    await startPreparing(ctx, orderId, 'supplier');
    await relayActivities(ctx);
    expect(notifier.activities.at(-1)!.contentState).toMatchObject({ state: 'PREPARING', word: 'Бэлтгэж байна', step: 2 });

    await markIdeshReady(ctx, orderId, 'supplier');
    await relayActivities(ctx);
    expect(notifier.activities.at(-1)!.contentState).toMatchObject({ state: 'READY', word: 'Бэлэн', step: 3 });
    expect(notifier.activities.at(-1)!.alert).toBeUndefined();

    await markHanded(ctx, orderId, 'supplier');
    report = await relayActivities(ctx);
    expect(report.ended).toBe(1);
    const last = notifier.activities.at(-1)!;
    expect(last.event).toBe('end');
    expect(last.contentState).toMatchObject({ state: 'HANDED', word: 'Хүлээлгэн өгсөн', step: 4 });
    // The last word stays a quarter of an hour, then goes.
    expect(last.dismissAt).toEqual(new Date(clock.now().getTime() + 15 * 60_000));
    expect(await activityTokensFor('idesh', orderId)).toEqual([]);
  });

  it('leaves a lunch card and an идэш card each to its own order', async () => {
    const lunch = await book();
    const sheep = await paidSheep();
    await registerActivityToken({ guestId, subject: 'order', subjectId: lunch, pushToken: 'phone-a', at: clock.now() });
    await registerActivityToken({ guestId, subject: 'idesh', subjectId: sheep, pushToken: 'phone-b', at: clock.now() });

    const report = await relayActivities(ctx);
    expect(report.updated).toBe(2);
    const byToken = new Map(notifier.activities.map((a) => [a.token, a.contentState]));
    expect(byToken.get('phone-a')).toMatchObject({ stage: 'waiting' });
    expect(byToken.get('phone-b')).toMatchObject({ state: 'PAID' });
  });
});
