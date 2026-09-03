import { tx, type Db } from '../db/pool.js';
import { appendEvent } from '../db/events.js';
import { lockKitchen, persistReservation, readLedger, releaseReservation } from '../db/stationLoad.js';
import { computeFirePlan } from '../domain/firePlan.js';
import { decideFireMode, predictSeatTime, type ArrivalSignal, type SignalType } from '../domain/eta.js';
import { fromEpochMinute, toEpochMinute } from '../domain/time.js';
import type { KitchenConfig, OrderLine, TrustTier } from '../domain/types.js';
import type { LaneInterval } from '../domain/load.js';
import { cancelFire, scheduleFire } from '../scheduler/fireJobs.js';
import type { Ctx } from '../ports.js';

/**
 * Where the pure engine meets the database.
 *
 * Everything decided here is decided by `src/domain` — this module's whole job
 * is to gather the inputs, hold the right lock while it does, and write the
 * answer down. Keeping the arithmetic out of SQL is what lets the simulator
 * replay a whole service in milliseconds.
 */

export type PlanOutcome =
  | { kind: 'planned'; fireAt: Date; readyAt: Date; mode: string; shiftMinutes: number }
  | { kind: 'held'; reason: string }
  | { kind: 'skipped'; reason: string };

interface OrderRow {
  id: string;
  code: string;
  restaurant_id: string;
  state: string;
  slot_starts_at: Date;
  fire_at: Date | null;
  fire_not_before: Date | null;
  plating_buffer_min: number;
  travel_minutes: number;
  tier: TrustTier | null;
}

const PLANNABLE = ['SCHEDULED', 'ARMED', 'HELD'];

async function loadKitchen(db: Db, restaurantId: string, platingBuffer: number): Promise<KitchenConfig> {
  const { rows } = await db.query<{ code: string; display_name: string; parallel_lanes: number }>(
    'SELECT code, display_name, parallel_lanes FROM dine.station WHERE restaurant_id = $1',
    [restaurantId],
  );
  const stations: KitchenConfig['stations'] = {};
  for (const row of rows) {
    stations[row.code] = {
      code: row.code,
      displayName: row.display_name,
      parallelLanes: row.parallel_lanes,
    };
  }
  return { stations, platingBufferMinutes: platingBuffer };
}

async function loadLines(db: Db, orderId: string): Promise<OrderLine[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    qty: number;
    prep_minutes: number;
    hold_tolerance_minutes: number;
    station_code: string;
  }>(
    `SELECT id, name, qty, prep_minutes, hold_tolerance_minutes, station_code
       FROM dine.order_line WHERE order_id = $1 AND cancelled_at IS NULL`,
    [orderId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    qty: r.qty,
    prepMinutes: Number(r.prep_minutes),
    holdToleranceMinutes: Number(r.hold_tolerance_minutes),
    station: r.station_code,
  }));
}

async function loadSignals(db: Db, orderId: string): Promise<ArrivalSignal[]> {
  const { rows } = await db.query<{ type: SignalType; at: Date }>(
    'SELECT type, at FROM dine.arrival_signal WHERE order_id = $1 ORDER BY at',
    [orderId],
  );
  return rows.map((r) => ({ type: r.type, at: r.at }));
}

/**
 * Recompute the fire plan for one order and write it down.
 *
 * Runs inside a transaction holding the restaurant's advisory lock, so the read
 * of the station ledger and the reservation written against it cannot be
 * interleaved by a second planner. Different restaurants never wait on each
 * other, which is what keeps this cheap at fifteen venues and beyond.
 */
export async function planAndSchedule(ctx: Ctx, orderId: string): Promise<PlanOutcome> {
  const now = ctx.clock.now();

  return tx(async (client) => {
    const { rows } = await client.query<OrderRow>(
      `SELECT o.id, o.code, o.restaurant_id, o.state, o.slot_starts_at, o.fire_at,
              o.fire_not_before, r.plating_buffer_min, r.travel_minutes, t.tier
         FROM dine.dining_order o
         JOIN dine.restaurant r ON r.id = o.restaurant_id
         LEFT JOIN dine.trust_profile t ON t.guest_id = o.guest_id
        WHERE o.id = $1`,
      [orderId],
    );
    const order = rows[0];
    if (!order) return { kind: 'skipped', reason: 'no such order' } as const;
    if (!PLANNABLE.includes(order.state)) {
      return { kind: 'skipped', reason: `state ${order.state}` } as const;
    }

    await lockKitchen(client, order.restaurant_id);

    // Sequential on purpose: a pg client runs one query at a time, so
    // Promise.all over the same client is a race, not a speed-up.
    const kitchen = await loadKitchen(client, order.restaurant_id, order.plating_buffer_min);
    const lines = await loadLines(client, orderId);
    const signals = await loadSignals(client, orderId);

    const prediction = predictSeatTime({
      signals,
      slotStartsAt: order.slot_starts_at,
      now,
      travelMinutes: order.travel_minutes,
    });
    const mode = decideFireMode(prediction.confidence, order.tier ?? 'NEW');

    // Read the kitchen without this order's own current reservation, otherwise
    // a re-plan would find itself in the way.
    const windowFrom = toEpochMinute(now) - 5;
    const windowTo = toEpochMinute(prediction.seatAt) + 120;
    const ledger = await readLedger(client, order.restaurant_id, windowFrom, windowTo, orderId);

    // The kitchen's «+5 минут» is an earliest-start the planner may not undo,
    // so it is fed in as `now`: the engine already refuses to fire in the past.
    const floor =
      order.fire_not_before && order.fire_not_before > now ? order.fire_not_before : now;

    const decision = computeFirePlan({
      lines,
      seatAt: prediction.seatAt,
      now: floor,
      kitchen,
      ledger,
      orderId,
    });

    await client.query(
      `UPDATE dine.dining_order
          SET eta_at = $2, eta_confidence = $3, eta_basis = $4, fire_mode = $5,
              version = version + 1, updated_at = $6
        WHERE id = $1`,
      [orderId, prediction.seatAt, prediction.confidence, prediction.basis, mode, now],
    );

    if (decision.kind === 'held') {
      await releaseReservation(client, orderId);
      await cancelFire(client, orderId);
      if (order.state !== 'HELD') {
        await client.query(
          `UPDATE dine.dining_order SET state = 'HELD', fire_at = NULL, updated_at = $2 WHERE id = $1`,
          [orderId, now],
        );
        await appendEvent(client, orderId, 'HELD', 'system:planner', { reason: decision.reason });
      }
      return { kind: 'held', reason: decision.reason } as const;
    }

    const intervals: Array<{ station: string; interval: LaneInterval }> = decision.lines.map((s) => ({
      station: s.station,
      interval: { from: s.startAt, to: s.endAt },
    }));
    await persistReservation(client, {
      orderId,
      restaurantId: order.restaurant_id,
      intervals,
    });

    const fireAt = fromEpochMinute(decision.fireAt);
    const readyAt = fromEpochMinute(decision.readyAt);

    await client.query(
      `UPDATE dine.dining_order
          SET fire_at = $2, ready_at = $3, order_prep_minutes = $4,
              version = version + 1, updated_at = $5
        WHERE id = $1`,
      [orderId, fireAt, readyAt, decision.orderPrepMinutes, now],
    );

    // A held ticket that found room is fireable again straight from HELD.
    await scheduleFire(client, orderId, fireAt, decision);

    if (order.fire_at === null || order.fire_at.getTime() !== fireAt.getTime()) {
      await appendEvent(client, orderId, 'PLANNED', 'system:planner', {
        fireAt: fireAt.toISOString(),
        readyAt: readyAt.toISOString(),
        shiftMinutes: decision.shiftMinutes,
        mode,
        confidence: prediction.confidence,
        violations: decision.violations.length,
      });
    }

    return {
      kind: 'planned',
      fireAt,
      readyAt,
      mode,
      shiftMinutes: decision.shiftMinutes,
    } as const;
  });
}

/**
 * Orders whose plan may have gone stale: anything armed or held, plus anything
 * scheduled that has no plan yet. Armed orders are inside their last fifteen
 * minutes, so this set stays small even at scale.
 */
export async function findPlannable(db: Db, restaurantId?: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM dine.dining_order
      WHERE state IN ('ARMED','HELD')
         OR (state = 'SCHEDULED' AND fire_at IS NULL)
        ${restaurantId ? 'AND restaurant_id = $1' : ''}
      ORDER BY slot_starts_at`,
    restaurantId ? [restaurantId] : [],
  );
  return rows.map((r) => r.id);
}
