import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at, PILOT_MENU } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
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
