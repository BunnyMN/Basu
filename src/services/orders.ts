import { getPool, tx, type Db } from '../db/pool.js';
import { appendEvent } from '../db/events.js';
import { releaseReservation } from '../db/stationLoad.js';
import { addMinutes } from '../domain/time.js';
import { isFreeToCancel, LIVE_STATES } from '../domain/states.js';
import type { OrderState } from '../domain/types.js';
import type { SignalType } from '../domain/eta.js';
import { cancelFire } from '../scheduler/fireJobs.js';
import { planAndSchedule } from './planning.js';
import { enqueue } from '../platform/notify/index.js';
import { collect, queueReceipt, refund as refundToWallet } from '../platform/ledger/index.js';
import type { Ctx } from '../ports.js';

/**
 * The order lifecycle, one function per thing a person can actually do.
 *
 * Every state change goes through `transition`, which is a conditional UPDATE:
 * the caller says which states the move is legal from, and zero affected rows
 * means somebody got there first. That is the same protection the scheduler
 * uses, applied everywhere, so a guest cancelling at the exact moment a chef
 * fires resolves to one winner rather than to two half-applied changes.
 */

/** Codes match the API error envelope in the technical spec (§07). */
export type OrderErrorCode =
  | 'SLOT_FULL'
  | 'NO_TABLE'
  | 'ITEM_SOLD_OUT'
  | 'TOO_LATE_TO_CANCEL'
  | 'TRUST_BLOCKED'
  | 'WRONG_STATE'
  | 'NOT_FOUND'
  | 'PAYMENT_FAILED';

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

/** Table is held from three minutes before the slot to twelve minutes after. */
const TABLE_HOLD_BEFORE = 3;
const TABLE_HOLD_AFTER = 12;
/** T−15 is when we ask the guest where they are. */
export const ARM_LEAD_MINUTES = 15;

async function transition(
  db: Db,
  orderId: string,
  from: OrderState[],
  to: OrderState,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  const { rowCount } = await db.query(
    `UPDATE dine.dining_order
        SET state = $2, version = version + 1, updated_at = now()
            ${sets.length ? `, ${sets.join(', ')}` : ''}
      WHERE id = $1 AND state = ANY($3::text[])`,
    [orderId, to, from, ...keys.map((k) => patch[k])],
  );
  return (rowCount ?? 0) > 0;
}

async function requireState(db: Db, orderId: string): Promise<{ state: OrderState; code: string }> {
  const { rows } = await db.query<{ state: OrderState; code: string }>(
    'SELECT state, code FROM dine.dining_order WHERE id = $1',
    [orderId],
  );
  const row = rows[0];
  if (!row) throw new OrderError('NOT_FOUND', `order ${orderId} does not exist`);
  return row;
}

/* ── booking ───────────────────────────────────────────────────────── */

export interface CreateOrderInput {
  restaurantId: string;
  guestId: string;
  slotStartsAt: Date;
  partySize: number;
  items: Array<{ menuItemId: string; qty: number; notes?: string }>;
  /** Per-slot ceiling; the ops playbook starts restaurants at a low number. */
  maxOrdersPerSlot?: number;
}

export interface CreatedOrder {
  orderId: string;
  code: string;
  totalMnt: number;
  tableId: string;
}

export async function createOrder(ctx: Ctx, input: CreateOrderInput): Promise<CreatedOrder> {
  const now = ctx.clock.now();

  return tx(async (client) => {
    // Identity creates the person; the dining record of how they behave is
    // ours, and starts the first time they order something.
    await client.query(
      `INSERT INTO dine.trust_profile (guest_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [input.guestId],
    );
    const trust = await client.query<{ tier: string }>(
      'SELECT tier FROM dine.trust_profile WHERE guest_id = $1',
      [input.guestId],
    );
    if (trust.rows[0]?.tier === 'BLOCKED') {
      throw new OrderError('TRUST_BLOCKED', 'pre-ordering is paused for this guest');
    }

    const slotId = await reserveSlot(client, input, now);
    const code = await nextOrderCode(client);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO dine.dining_order
         (code, restaurant_id, guest_id, slot_id, state, party_size, slot_starts_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $7)
       RETURNING id`,
      [code, input.restaurantId, input.guestId, slotId, input.partySize, input.slotStartsAt, now],
    );
    const orderId = rows[0]!.id;

    const totalMnt = await addLines(client, orderId, input);
    await client.query('UPDATE dine.dining_order SET total_mnt = $2 WHERE id = $1', [orderId, totalMnt]);

    const tableId = await holdTable(client, {
      orderId,
      restaurantId: input.restaurantId,
      partySize: input.partySize,
      slotStartsAt: input.slotStartsAt,
    });

    await appendEvent(client, orderId, 'CREATED', `guest:${input.guestId}`, {
      slotStartsAt: input.slotStartsAt.toISOString(),
      partySize: input.partySize,
      totalMnt,
    });

    return { orderId, code, totalMnt, tableId };
  });
}

async function nextOrderCode(db: Db): Promise<string> {
  const { rows } = await db.query<{ code: string }>(
    `SELECT lpad(((COALESCE(max(code::int), 1041) + 1))::text, 4, '0') AS code
       FROM dine.dining_order WHERE code ~ '^[0-9]+$'`,
  );
  return rows[0]!.code;
}

async function reserveSlot(db: Db, input: CreateOrderInput, now: Date): Promise<string> {
  const cap = input.maxOrdersPerSlot ?? 3;
  const endsAt = addMinutes(input.slotStartsAt, 15);

  await db.query(
    `INSERT INTO dine.slot (restaurant_id, starts_at, ends_at, max_orders, max_covers)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (restaurant_id, starts_at) DO NOTHING`,
    [input.restaurantId, input.slotStartsAt, endsAt, cap, cap * 4],
  );

  // The CHECK on the table does the enforcing; we just read the outcome.
  const { rows } = await db.query<{ id: string }>(
    `UPDATE dine.slot
        SET taken_orders = taken_orders + 1, taken_covers = taken_covers + $3
      WHERE restaurant_id = $1 AND starts_at = $2
        AND NOT closed
        AND taken_orders < max_orders
      RETURNING id`,
    [input.restaurantId, input.slotStartsAt, input.partySize],
  );
  const slot = rows[0];
  if (!slot) {
    throw new OrderError('SLOT_FULL', `no capacity at ${input.slotStartsAt.toISOString()}`);
  }
  void now;
  return slot.id;
}

async function addLines(db: Db, orderId: string, input: CreateOrderInput): Promise<number> {
  let total = 0;
  for (const item of input.items) {
    const { rows } = await db.query<{
      id: string;
      name: string;
      price_mnt: number;
      prep_minutes: number;
      hold_tolerance_minutes: number;
      code: string;
      sold_out_until: Date | null;
      preorder_enabled: boolean;
    }>(
      `SELECT m.id, m.name, m.price_mnt, m.prep_minutes, m.hold_tolerance_minutes,
              s.code, m.sold_out_until, m.preorder_enabled
         FROM dine.menu_item m JOIN dine.station s ON s.id = m.station_id
        WHERE m.id = $1 AND m.active`,
      [item.menuItemId],
    );
    const menu = rows[0];
    if (!menu || !menu.preorder_enabled) {
      throw new OrderError('ITEM_SOLD_OUT', `menu item ${item.menuItemId} is not available`);
    }
    if (menu.sold_out_until) {
      throw new OrderError('ITEM_SOLD_OUT', `${menu.name} is 86'd`);
    }

    // Copied, not joined: tomorrow's price change must not rewrite this ticket.
    await db.query(
      `INSERT INTO dine.order_line
         (order_id, menu_item_id, qty, name, unit_price_mnt, prep_minutes,
          hold_tolerance_minutes, station_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        orderId,
        menu.id,
        item.qty,
        menu.name,
        menu.price_mnt,
        menu.prep_minutes,
        menu.hold_tolerance_minutes,
        menu.code,
        item.notes ?? null,
      ],
    );
    total += menu.price_mnt * item.qty;
  }
  if (total === 0) throw new OrderError('ITEM_SOLD_OUT', 'an order needs at least one line');
  return total;
}

/**
 * Grab the smallest table that fits. The exclusion constraint decides whether
 * a table is really free, so we let it reject and move on rather than asking
 * first and racing between the answer and the insert.
 */
async function holdTable(
  db: Db,
  input: { orderId: string; restaurantId: string; partySize: number; slotStartsAt: Date },
): Promise<string> {
  const from = addMinutes(input.slotStartsAt, -TABLE_HOLD_BEFORE);
  const until = addMinutes(input.slotStartsAt, TABLE_HOLD_AFTER);

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM dine.dining_table
      WHERE restaurant_id = $1 AND seats >= $2
      ORDER BY seats, code`,
    [input.restaurantId, input.partySize],
  );

  for (const table of rows) {
    try {
      await db.query('SAVEPOINT try_table');
      await db.query(
        `INSERT INTO dine.table_hold (order_id, table_id, hold_from, hold_until)
         VALUES ($1, $2, $3, $4)`,
        [input.orderId, table.id, from, until],
      );
      await db.query('RELEASE SAVEPOINT try_table');
      return table.id;
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT try_table');
      const code = (error as { code?: string }).code;
      if (code !== '23P01') throw error; // not an exclusion violation — real problem
    }
  }
  throw new OrderError('NO_TABLE', 'every table is held for that window');
}

/* ── money in ──────────────────────────────────────────────────────── */

/**
 * Full amount up front, out of the guest's wallet.
 *
 * Dine no longer talks to QPay. It says "collect 18 500 ₮ from this guest for
 * this order" and the ledger decides whether that comes out of a balance they
 * already have or has to be pulled from a card first — which is the difference
 * between a guest with money in Basu tapping once and being sent to a payment
 * app they have to come back from.
 *
 * The idempotency key is the order, so the double-tapped Pay button, the retry
 * after a timeout and the redelivered callback all buy exactly one lunch.
 */
export async function payOrder(ctx: Ctx, orderId: string): Promise<void> {
  const billed = await billingFacts(orderId);
  const { rows } = await getPool().query<{ total_mnt: number; state: string; guest_id: string }>(
    'SELECT total_mnt, state, guest_id FROM dine.dining_order WHERE id = $1',
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new OrderError('NOT_FOUND', 'no such order');
  if (order.state !== 'DRAFT') throw new OrderError('WRONG_STATE', `cannot pay in ${order.state}`);

  let collected;
  try {
    collected = await collect(ctx, {
      guestId: order.guest_id,
      amountMnt: order.total_mnt,
      subject: 'order',
      subjectId: orderId,
      // The memo is what the guest reads in their statement, so the vertical
      // names itself here — the ledger must never learn that an order is lunch.
      memo: billed ? `Хоол · ${billed.restaurant} №${billed.code}` : 'Хоол',
      idempotencyKey: `order:${orderId}:purchase`,
    });
  } catch (error) {
    throw new OrderError('PAYMENT_FAILED', (error as Error).message);
  }

  await tx(async (client) => {
    await client.query('UPDATE dine.dining_order SET ledger_transfer_id = $2 WHERE id = $1', [
      orderId,
      collected.transferId,
    ]);
    const moved = await transition(client, orderId, ['DRAFT'], 'PLACED');
    if (!moved) throw new OrderError('WRONG_STATE', 'order left DRAFT while paying');
    await appendEvent(client, orderId, 'PAID', `guest:${orderId}`, {
      amountMnt: order.total_mnt,
      fromWalletMnt: collected.fromWalletMnt,
      toppedUpMnt: collected.toppedUpMnt,
    });
  });
}

/* ── the restaurant answers ────────────────────────────────────────── */

export async function acceptOrder(ctx: Ctx, orderId: string, actor = 'kds:tablet'): Promise<void> {
  const moved = await tx(async (client) => {
    const ok = await transition(client, orderId, ['PLACED'], 'ACCEPTED');
    if (ok) await appendEvent(client, orderId, 'ACCEPTED', actor);
    return ok;
  });
  if (!moved) {
    const { state } = await requireState(getPool(), orderId);
    throw new OrderError('WRONG_STATE', `cannot accept in ${state}`);
  }

  await tx(async (client) => {
    await transition(client, orderId, ['ACCEPTED'], 'SCHEDULED');
  });
  await planAndSchedule(ctx, orderId);
}

export async function rejectOrder(ctx: Ctx, orderId: string, reason: string): Promise<void> {
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['PLACED', 'ACCEPTED'], 'REJECTED');
    if (!ok) throw new OrderError('WRONG_STATE', 'order is no longer rejectable');
    await appendEvent(client, orderId, 'REJECTED', 'kds:tablet', { reason });
  });
  await refund(ctx, orderId, 'restaurant rejected');
}

/* ── arrival ───────────────────────────────────────────────────────── */

export async function recordSignal(
  ctx: Ctx,
  orderId: string,
  type: SignalType,
  at?: Date,
): Promise<void> {
  const when = at ?? ctx.clock.now();
  await getPool().query(
    'INSERT INTO dine.arrival_signal (order_id, type, at) VALUES ($1, $2, $3)',
    [orderId, type, when],
  );
}

/** T−15. The message this sends is what most fire decisions rest on. */
export async function armOrder(ctx: Ctx, orderId: string): Promise<boolean> {
  const now = ctx.clock.now();
  const armed = await tx(async (client) => {
    const ok = await transition(client, orderId, ['SCHEDULED'], 'ARMED', { armed_at: now });
    if (ok) await appendEvent(client, orderId, 'ARMED', 'system:scheduler');
    return ok;
  });
  if (!armed) return false;

  const { rows } = await getPool().query<{ guest_id: string }>(
    'SELECT guest_id FROM dine.dining_order WHERE id = $1',
    [orderId],
  );
  const guestId = rows[0]?.guest_id;
  if (!guestId) return true;

  await enqueue(ctx, {
    guestId,
    subject: 'order',
    subjectId: orderId,
    template: 'arrival.arm',
    title: 'Та замд гарсан уу?',
    body: 'Та замд гарсан уу? 1 = Тийм · 2 = 10 минут хойшлуул',
    // SMS first: iOS web push only reaches guests who added us to the home
    // screen, and the whole fire decision hangs off this reply.
    channel: 'sms',
  });
  return true;
}

export async function checkIn(ctx: Ctx, orderId: string): Promise<void> {
  const now = ctx.clock.now();
  await recordSignal(ctx, orderId, 'checkin', now);
  await getPool().query(
    'UPDATE dine.dining_order SET seated_at = COALESCE(seated_at, $2), updated_at = $2 WHERE id = $1',
    [orderId, now],
  );
  await appendEvent(getPool(), orderId, 'SEATED', `guest:${orderId}`);
}

/* ── the kitchen ───────────────────────────────────────────────────── */

/** «Одоо тавь». Always available — the chef knows things the model does not. */
export async function fireNow(ctx: Ctx, orderId: string, actor = 'kds:tablet'): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(
      client,
      orderId,
      ['SCHEDULED', 'ARMED', 'HELD'],
      'FIRED',
      { fired_at: now, fired_by: actor },
    );
    if (!ok) throw new OrderError('WRONG_STATE', 'this ticket cannot be fired now');
    await cancelFire(client, orderId);
    await appendEvent(client, orderId, 'FIRED', actor, { manual: true });
    await client.query(
      `INSERT INTO outbox (topic, payload) VALUES ('guest.notify.cooking', $1::jsonb)`,
      [JSON.stringify({ orderId, template: 'order.cooking' })],
    );
  });
}

/** «+5 минут» — the kitchen is buried and wants the ticket to wait. */
export async function holdFor(ctx: Ctx, orderId: string, minutes = 5): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const { rows } = await client.query<{ fire_at: Date | null }>(
      'SELECT fire_at FROM dine.dining_order WHERE id = $1',
      [orderId],
    );
    const fireAt = rows[0]?.fire_at;
    if (!fireAt) throw new OrderError('WRONG_STATE', 'nothing scheduled to postpone');
    const next = addMinutes(fireAt, minutes);
    // Recorded as a floor, not just a new time: the planner re-runs every tick
    // and would otherwise recompute the ideal minute and undo the chef.
    await client.query(
      `UPDATE dine.dining_order SET fire_at = $2, fire_not_before = $2, updated_at = $3 WHERE id = $1`,
      [orderId, next, now],
    );
    await client.query(
      `UPDATE dine.fire_job SET run_at = $2, updated_at = now()
        WHERE order_id = $1 AND state = 'pending'`,
      [orderId, next],
    );
    await appendEvent(client, orderId, 'HELD_BY_KITCHEN', 'kds:tablet', { minutes });
  });
}

export async function markReady(ctx: Ctx, orderId: string, actor = 'kds:tablet'): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['FIRED', 'COOKING'], 'READY', {
      cooked_ready_at: now,
    });
    if (!ok) throw new OrderError('WRONG_STATE', 'this ticket is not cooking');
    // The lanes are free the moment the food is plated, not when it is eaten.
    await releaseReservation(client, orderId);
    await appendEvent(client, orderId, 'READY', actor);
  });
}

export async function markServed(ctx: Ctx, orderId: string, actor = 'kds:tablet'): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['READY'], 'SERVED', { served_at: now });
    if (!ok) throw new OrderError('WRONG_STATE', 'this ticket is not ready');
    await appendEvent(client, orderId, 'SERVED', actor);
  });
}

/* ── closing out ───────────────────────────────────────────────────── */

export async function closeOrder(ctx: Ctx, orderId: string): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['SERVED', 'NO_SHOW', 'REFUNDED'], 'CLOSED', {
      closed_at: now,
    });
    if (!ok) throw new OrderError('WRONG_STATE', 'this order cannot be closed yet');
    await releaseReservation(client, orderId);
    await client.query(
      `UPDATE dine.table_hold SET released_at = $2, release_reason = 'closed'
        WHERE order_id = $1 AND released_at IS NULL`,
      [orderId, now],
    );
    await appendEvent(client, orderId, 'CLOSED', 'system:ops');
  });

  const billed = await billingFacts(orderId);
  if (billed?.transferId) {
    await queueReceipt({
      transferId: billed.transferId,
      kind: 'SALE',
      merchantTin: billed.merchantTin,
      orderCode: billed.code,
      amountMnt: billed.amountMnt,
    });
  }
}

export async function cancelOrder(
  ctx: Ctx,
  orderId: string,
  actor = 'guest',
): Promise<{ refunded: boolean }> {
  const now = ctx.clock.now();
  const { state } = await requireState(getPool(), orderId);
  if (!isFreeToCancel(state)) {
    throw new OrderError('TOO_LATE_TO_CANCEL', 'the kitchen has already started this order');
  }

  const cancelled = await tx(async (client) => {
    const ok = await transition(
      client,
      orderId,
      ['DRAFT', 'PLACED', 'ACCEPTED', 'SCHEDULED', 'ARMED', 'HELD', 'RESLOTTED'],
      'CANCELLED',
    );
    if (!ok) return false;
    await cancelFire(client, orderId);
    await releaseReservation(client, orderId);
    await client.query(
      `UPDATE dine.table_hold SET released_at = $2, release_reason = 'cancelled'
        WHERE order_id = $1 AND released_at IS NULL`,
      [orderId, now],
    );
    await client.query(
      `UPDATE dine.slot SET taken_orders = greatest(taken_orders - 1, 0)
        WHERE id = (SELECT slot_id FROM dine.dining_order WHERE id = $1)`,
      [orderId],
    );
    await appendEvent(client, orderId, 'CANCELLED', actor);
    return true;
  });

  // Lost the race: the scheduler fired in between. The guest is told plainly.
  if (!cancelled) throw new OrderError('TOO_LATE_TO_CANCEL', 'the ticket fired first');

  await refund(ctx, orderId, 'cancelled before firing');
  return { refunded: true };
}

export async function markNoShow(ctx: Ctx, orderId: string): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(
      client,
      orderId,
      ['ARMED', 'HELD', 'FIRED', 'COOKING', 'READY'],
      'NO_SHOW',
    );
    if (!ok) return;
    await releaseReservation(client, orderId);
    await client.query(
      `UPDATE dine.table_hold SET released_at = $2, release_reason = 'no_show'
        WHERE order_id = $1 AND released_at IS NULL`,
      [orderId, now],
    );
    await appendEvent(client, orderId, 'NO_SHOW', 'system:scheduler');
    await client.query(
      `UPDATE dine.trust_profile
          SET no_shows = no_shows + 1,
              consecutive_no_shows = consecutive_no_shows + 1,
              last_no_show_at = $2::timestamptz,
              tier = CASE WHEN consecutive_no_shows + 1 >= 2 THEN 'BLOCKED' ELSE 'CONFIRM' END,
              tier_until = $2::timestamptz + interval '60 days'
        WHERE guest_id = (SELECT guest_id FROM dine.dining_order WHERE id = $1)`,
      [orderId, now],
    );
  });
}

/**
 * Money goes back to the wallet, not to the card.
 *
 * Instant instead of the three to five days a QPay reversal takes, and it is
 * the same two accounts the purchase used, so the pair nets to zero and reads
 * as one line of story rather than two unrelated events.
 */
const REFUND_MEMO: Record<string, string> = {
  'cancelled before firing': 'цуцалсан',
  'restaurant rejected': 'ресторан татгалзсан',
};

async function refund(ctx: Ctx, orderId: string, reason: string): Promise<void> {
  const billed = await billingFacts(orderId);
  if (!billed?.transferId) return; // never paid — nothing to give back

  const transferId = await refundToWallet({
    guestId: billed.guestId,
    amountMnt: billed.amountMnt,
    subject: 'order',
    subjectId: orderId,
    // The memo is what the statement prints under «Буцаалт». The reason is
    // the event log's, in English; the guest reads Mongolian.
    memo: `Хоол · ${REFUND_MEMO[reason] ?? 'буцаалт'}`,
    idempotencyKey: `order:${orderId}:refund`,
  });

  await tx(async (client) => {
    await transition(client, orderId, ['CANCELLED', 'REJECTED'], 'REFUNDED');
    await appendEvent(client, orderId, 'REFUNDED', 'system:payments', {
      amountMnt: billed.amountMnt,
      reason,
    });
  });
  await queueReceipt({
    transferId,
    kind: 'RETURN',
    merchantTin: billed.merchantTin,
    orderCode: billed.code,
    amountMnt: billed.amountMnt,
  });
  void ctx;
}

/**
 * The four facts a receipt needs, plus who to give money back to.
 *
 * All of it lives in dine's own tables — the transfer id included, because the
 * ledger handed it back when it took the money. Nothing here reads a ledger
 * table, which is what lets the ledger move house later.
 */
async function billingFacts(orderId: string): Promise<
  | {
      guestId: string;
      code: string;
      restaurant: string;
      amountMnt: number;
      merchantTin: string;
      transferId: string | null;
    }
  | null
> {
  const { rows } = await getPool().query<{
    guest_id: string;
    code: string;
    restaurant: string;
    total_mnt: number;
    tin: string | null;
    ledger_transfer_id: string | null;
  }>(
    `SELECT o.guest_id, o.code, o.total_mnt, o.ledger_transfer_id,
            r.name AS restaurant, r.ebarimt_merchant_tin AS tin
       FROM dine.dining_order o
       JOIN dine.restaurant r ON r.id = o.restaurant_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    guestId: row.guest_id,
    code: row.code,
    restaurant: row.restaurant,
    amountMnt: row.total_mnt,
    merchantTin: row.tin ?? 'UNSET',
    transferId: row.ledger_transfer_id,
  };
}

/**
 * How much of this guest's is still running.
 *
 * Dine answers this because identity cannot ask it — closing an account has to
 * know whether somebody has lunch on the fire, and «what counts as running» is
 * a question only the vertical can answer. The second vertical will add its own
 * count beside this one.
 */
export async function liveOrderCount(guestId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dine.dining_order
      WHERE guest_id = $1 AND state = ANY($2)`,
    [guestId, LIVE_STATES],
  );
  return rows[0]?.n ?? 0;
}

/** Guests who never appeared and whose table has long since been let go. */
export async function findAbandoned(db: Db, now: Date, afterMinutes = 30): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM dine.dining_order
      WHERE state IN ('ARMED','HELD','FIRED','COOKING','READY')
        AND seated_at IS NULL
        AND slot_starts_at < $1::timestamptz - make_interval(mins => $2)`,
    [now, afterMinutes],
  );
  return rows.map((r) => r.id);
}
