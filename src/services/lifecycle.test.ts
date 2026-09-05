import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at, PILOT_MENU } from '../domain/fixtures.js';
import { VirtualClock, addMinutes, hhmm } from '../domain/time.js';
import { occupancyAt } from '../db/stationLoad.js';
import { balance, reconcile, reconcileLedger } from '../platform/ledger/index.js';
import {
  acceptOrder,
  cancelOrder,
  checkIn,
  closeOrder,
  createOrder,
  fireNow,
  holdFor,
  markReady,
  markServed,
  OrderError,
  payOrder,
  recordSignal,
  rejectOrder,
} from './orders.js';
import { runMinutes, tick } from '../scheduler/runner.js';
import {
  FakeNotifier,
  FakePaymentProvider,
  FakeTaxProvider,
  type Ctx,
} from '../ports.js';
import { seedGuest, seedRestaurant, truncateAll, type SeededRestaurant } from '../test/seed.js';

/**
 * The full journey, against a real database and the real scheduler.
 *
 * Unit tests prove the arithmetic and the simulator proves it holds under load.
 * This is the one that proves the pieces are actually wired to each other:
 * money moves, a table is held, a timer is set, the timer fires exactly once,
 * the tax receipt is issued, and the guest is told at each step.
 */

let clock: VirtualClock;
let payments: FakePaymentProvider;
let tax: FakeTaxProvider;
let notifier: FakeNotifier;
let ctx: Ctx;
let venue: SeededRestaurant;
let guestId: string;

const pool = () => getPool();

async function readOrder(orderId: string) {
  const { rows } = await pool().query(
    `SELECT state, fire_at, ready_at, fired_at, fired_by, seated_at, served_at,
            closed_at, eta_confidence, fire_mode, order_prep_minutes, total_mnt
       FROM dine.dining_order WHERE id = $1`,
    [orderId],
  );
  return rows[0] as Record<string, never> & {
    state: string;
    fire_at: Date | null;
    ready_at: Date | null;
    fired_at: Date | null;
    fired_by: string | null;
    seated_at: Date | null;
    served_at: Date | null;
    closed_at: Date | null;
    eta_confidence: number | null;
    fire_mode: string | null;
    order_prep_minutes: number | null;
    total_mnt: number;
  };
}

async function eventTypes(orderId: string): Promise<string[]> {
  const { rows } = await pool().query<{ type: string }>(
    'SELECT type FROM dine.order_event WHERE order_id = $1 ORDER BY seq',
    [orderId],
  );
  return rows.map((r) => r.type);
}

/**
 * The journey, with consecutive repeats collapsed. Re-planning is supposed to
 * happen whenever the guest tells us something new, so asserting on how many
 * times it did would be freezing an implementation detail rather than the
 * shape of the order's life.
 */
async function journey(orderId: string): Promise<string[]> {
  const types = await eventTypes(orderId);
  return types.filter((t, i) => t !== types[i - 1]);
}

async function book(overrides: { slot?: string; items?: Array<[string, number]> } = {}) {
  const items = (overrides.items ?? [['tsuivan', 2]]).map(([menuId, qty]) => ({
    menuItemId: venue.menuIds[menuId as keyof typeof PILOT_MENU]!,
    qty,
  }));
  return createOrder(ctx, {
    restaurantId: venue.restaurantId,
    guestId,
    slotStartsAt: at(overrides.slot ?? '12:30'),
    partySize: 2,
    items,
  });
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  payments = new FakePaymentProvider();
  tax = new FakeTaxProvider();
  notifier = new FakeNotifier();
  ctx = { clock, payments, tax, notifier };
  venue = await seedRestaurant();
  await pool().query(`UPDATE dine.restaurant SET ebarimt_merchant_tin = '1234567' WHERE id = $1`, [
    venue.restaurantId,
  ]);
  guestId = await seedGuest(pool(), 'AUTO');
});

afterAll(async () => {
  await closePool();
});

describe('the whole journey', () => {
  it('carries one order from booking to a closed tax receipt', async () => {
    /* 11:40 — the guest books, pays, the restaurant accepts. */
    const { orderId, code, totalMnt } = await book({ items: [['tsuivan', 2], ['salad', 1]] });
    expect(code).toMatch(/^\d{4}$/);
    expect(totalMnt).toBe(PILOT_MENU.tsuivan!.priceMnt * 2 + PILOT_MENU.salad!.priceMnt);

    await payOrder(ctx, orderId);
    expect(payments.captured).toHaveLength(1);
    expect((await readOrder(orderId)).state).toBe('PLACED');

    await acceptOrder(ctx, orderId);

    // Цуйван is 9 minutes on the wok, салат 3 on the cold station; they run in
    // parallel, so the ticket takes 9 and lands at 12:31.
    const scheduled = await readOrder(orderId);
    expect(scheduled.state).toBe('SCHEDULED');
    expect(scheduled.order_prep_minutes).toBe(9);
    expect(hhmm(scheduled.ready_at!)).toBe('12:31');
    expect(hhmm(scheduled.fire_at!)).toBe('12:22');

    // The kitchen is booked for those exact minutes, and not before.
    expect(await occupancyAt(pool(), venue.restaurantId, 'wok', minute('12:22'))).toBe(1);
    expect(await occupancyAt(pool(), venue.restaurantId, 'wok', minute('12:21'))).toBe(0);

    /* 12:15 — T−15. The scheduler arms the order and texts the guest. */
    clock.set(at('12:15'));
    const armTick = await tick(ctx, { spacingMs: 0 });
    expect(armTick.armed).toBe(1);
    expect((await readOrder(orderId)).state).toBe('ARMED');
    expect(notifier.of('arrival.arm')).toHaveLength(1);
    expect(notifier.of('arrival.arm')[0]!.channel).toBe('sms');

    /* 12:16 — the guest answers, which is what makes an automatic fire safe. */
    clock.set(at('12:16'));
    await recordSignal(ctx, orderId, 'on_my_way');
    await tick(ctx, { spacingMs: 0 });

    const armed = await readOrder(orderId);
    expect(armed.fire_mode).toBe('AUTO');
    expect(Number(armed.eta_confidence)).toBeGreaterThanOrEqual(0.85);
    // Seven minutes on foot puts them there before the slot, so the plan moves
    // earlier — clamped to 12:27, since the table is not held before that.
    expect(hhmm(armed.ready_at!)).toBe('12:28');
    expect(hhmm(armed.fire_at!)).toBe('12:19');
    const plannedFireAt = hhmm(armed.fire_at!);

    /* The scheduler runs every minute; the ticket fires on its planned one. */
    clock.set(at('12:17'));
    const rush = await runMinutes(ctx, 4, (m) => clock.advanceMinutes(m)); // 12:17–12:20
    expect(rush.fired).toBe(1);

    const fired = await readOrder(orderId);
    expect(fired.state).toBe('COOKING');
    expect(fired.fired_by).toBe('system:scheduler');
    expect(hhmm(fired.fired_at!)).toBe(plannedFireAt);

    // And no amount of further ticking fires it again.
    const again = await runMinutes(ctx, 2, (m) => clock.advanceMinutes(m)); // 12:21–12:22
    expect(again.fired).toBe(0);

    /* 12:27 — the guest sits down; the food follows a minute later. */
    clock.set(at('12:27'));
    await checkIn(ctx, orderId);
    clock.set(at('12:28'));
    await markReady(ctx, orderId);
    expect((await readOrder(orderId)).state).toBe('READY');
    // Lanes are given back the moment the food is plated.
    expect(await occupancyAt(pool(), venue.restaurantId, 'wok', minute('12:22'))).toBe(0);

    await markServed(ctx, orderId);
    const served = await readOrder(orderId);
    expect(served.state).toBe('SERVED');
    // Time to first bite: the product's whole promise.
    const ttfb = (served.served_at!.getTime() - served.seated_at!.getTime()) / 60_000;
    expect(ttfb).toBeLessThanOrEqual(3);

    /* 12:55 — the guest leaves, the receipt is issued. */
    clock.set(at('12:55'));
    await closeOrder(ctx, orderId);
    await tick(ctx, { spacingMs: 0 });

    expect((await readOrder(orderId)).state).toBe('CLOSED');
    expect(tax.issued).toMatchObject([{ orderCode: code, kind: 'SALE', amountMnt: totalMnt }]);
    expect((await reconcile()).gap).toBe(0);

    expect(await journey(orderId)).toEqual([
      'CREATED',
      'PAID',
      'ACCEPTED',
      'PLANNED',
      'ARMED',
      'PLANNED', // the guest said they were on their way, so we replanned
      'FIRED',
      'SEATED',
      'READY',
      'SERVED',
      'CLOSED',
    ]);

    // The table is handed back and nothing is left holding kitchen capacity.
    const holds = await pool().query(
      `SELECT release_reason FROM dine.table_hold WHERE order_id = $1 AND released_at IS NOT NULL`,
      [orderId],
    );
    expect(holds.rows[0]).toEqual({ release_reason: 'closed' });
    const reservations = await pool().query(
      'SELECT count(*)::int AS n FROM dine.station_reservation WHERE order_id = $1',
      [orderId],
    );
    expect(reservations.rows[0]).toEqual({ n: 0 });
  });
});

describe('the ways it goes wrong', () => {
  it('refunds a guest who cancels before the kitchen commits', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    clock.set(at('12:10'));
    const result = await cancelOrder(ctx, orderId);
    expect(result.refunded).toBe(true);

    const order = await readOrder(orderId);
    expect(order.state).toBe('REFUNDED');
    // The money comes back to the wallet, not to the card: instant instead of
    // three days, and the guest can spend it on lunch somewhere else today.
    expect(await balance(guestId)).toBe(order.total_mnt);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });

    // The slot, the table and the kitchen minutes all come back.
    const slot = await pool().query<{ taken_orders: number }>(
      'SELECT taken_orders FROM dine.slot WHERE restaurant_id = $1',
      [venue.restaurantId],
    );
    expect(slot.rows[0]!.taken_orders).toBe(0);
    expect(await occupancyAt(pool(), venue.restaurantId, 'wok', minute('12:22'))).toBe(0);

    // And no fire job is left waiting to cook for someone who left.
    clock.set(at('12:22'));
    expect((await tick(ctx, { spacingMs: 0 })).fired).toBe(0);
  });

  it('refuses to cancel once the ticket has fired', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });
    expect((await readOrder(orderId)).fired_at).not.toBeNull();

    await expect(cancelOrder(ctx, orderId)).rejects.toThrow(OrderError);
    await expect(cancelOrder(ctx, orderId)).rejects.toThrow(/already started/);
    expect(payments.refunded).toHaveLength(0);
  });

  it('lets the chef fire by hand and stands the scheduler down', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    clock.set(at('12:18')); // four minutes before the timer
    await fireNow(ctx, orderId, 'kds:tablet-1');

    clock.set(at('12:22'));
    const report = await tick(ctx, { spacingMs: 0 });
    expect(report.fired).toBe(0);

    const order = await readOrder(orderId);
    expect(order.fired_by).toBe('kds:tablet-1');
    expect(hhmm(order.fired_at!)).toBe('12:18');
    expect((await eventTypes(orderId)).filter((t) => t === 'FIRED')).toHaveLength(1);
  });

  it('pushes the timer back when the kitchen asks for five more minutes', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    clock.set(at('12:20'));
    await holdFor(ctx, orderId, 5);
    expect(hhmm((await readOrder(orderId)).fire_at!)).toBe('12:27');

    clock.set(at('12:22'));
    expect((await tick(ctx, { spacingMs: 0 })).fired).toBe(0);
  });

  it('refunds and frees everything when the restaurant rejects', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await rejectOrder(ctx, orderId, 'станц ажиллахгүй байна');

    const rejected = await readOrder(orderId);
    expect(rejected.state).toBe('REFUNDED');
    expect(await balance(guestId)).toBe(rejected.total_mnt);
    expect(await eventTypes(orderId)).toContain('REJECTED');
  });

  it('marks a guest who never arrives as a no-show and tightens their tier', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });

    clock.set(at('13:05')); // 35 minutes past the slot, still nobody
    const report = await tick(ctx, { spacingMs: 0 });
    expect(report.abandoned).toBe(1);

    expect((await readOrder(orderId)).state).toBe('NO_SHOW');
    const trust = await pool().query<{ tier: string; no_shows: number }>(
      'SELECT tier, no_shows FROM dine.trust_profile WHERE guest_id = $1',
      [guestId],
    );
    expect(trust.rows[0]).toEqual({ tier: 'CONFIRM', no_shows: 1 });
    expect(payments.refunded).toHaveLength(0); // fired food is not refunded
  });

  it('will not take a booking once the slot is full', async () => {
    for (let i = 0; i < 3; i++) await book();
    await expect(book()).rejects.toThrow(/no capacity/);
  });

  it('keeps cooking when the tax authority is down, and catches up after', async () => {
    const { orderId, code } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);
    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });
    clock.set(at('12:31'));
    await checkIn(ctx, orderId);
    await markReady(ctx, orderId);
    await markServed(ctx, orderId);

    tax.down = true;
    await closeOrder(ctx, orderId);
    await tick(ctx, { spacingMs: 0 });

    // The order closed regardless; only the receipt is outstanding.
    expect((await readOrder(orderId)).state).toBe('CLOSED');
    expect(tax.issued).toHaveLength(0);
    expect((await reconcile()).gap).toBe(1);

    tax.down = false;
    const recovered = await tick(ctx, { spacingMs: 0 });
    expect(recovered.receipts).toBe(1);
    expect(tax.issued[0]?.orderCode).toBe(code);
    expect((await reconcile()).gap).toBe(0);
  });

  it('falls back to SMS when push is unavailable', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);
    await acceptOrder(ctx, orderId);

    notifier.failChannel = 'push';
    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });

    const cooking = notifier.of('order.cooking');
    expect(cooking).toHaveLength(1);
    expect(cooking[0]!.channel).toBe('sms');
    void orderId;
  });

  it('does not arm, plan or fire an order the restaurant never accepted', async () => {
    const { orderId } = await book();
    await payOrder(ctx, orderId);

    clock.set(at('12:30'));
    const report = await runMinutes(ctx, 3, (m) => clock.advanceMinutes(m));
    expect(report.armed).toBe(0);
    expect(report.fired).toBe(0);
    expect((await readOrder(orderId)).state).toBe('PLACED');
  });
});

describe('a lunch rush through the real stack', () => {
  it('serves a full slot without double-firing or overrunning the grill', async () => {
    // Three tickets in one slot, all leaning on the two-lane grill.
    const booked = [
      await book({ slot: '12:30', items: [['khuushuur', 6]] }),
      await book({ slot: '12:30', items: [['steak', 1], ['salad', 1]] }),
      await book({ slot: '12:30', items: [['fries', 2], ['soup_guril', 1]] }),
    ];

    for (const { orderId } of booked) {
      await payOrder(ctx, orderId);
      await acceptOrder(ctx, orderId);
      await recordSignal(ctx, orderId, 'on_my_way', at('12:16'));
    }

    clock.set(at('12:10'));
    await runMinutes(ctx, 30, (m) => clock.advanceMinutes(m));

    for (const { orderId } of booked) {
      const order = await readOrder(orderId);
      expect(['COOKING', 'READY', 'FIRED'], `${orderId} ended in ${order.state}`).toContain(
        order.state,
      );
      const fires = (await eventTypes(orderId)).filter((t) => t === 'FIRED');
      expect(fires, `${orderId} fired ${fires.length} times`).toHaveLength(1);
    }

    // The grill never ran more lanes than it has, at any minute of the rush.
    for (let m = minute('12:00'); m <= minute('12:45'); m++) {
      expect(await occupancyAt(pool(), venue.restaurantId, 'grill', m)).toBeLessThanOrEqual(2);
    }
  });
});

function minute(hhmmValue: string): number {
  return Math.round(at(hhmmValue).getTime() / 60_000);
}

void addMinutes;
