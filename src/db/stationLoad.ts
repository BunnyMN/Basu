import { InMemoryStationLoad, type LaneInterval } from '../domain/load.js';
import type { Db } from './pool.js';
import type { EpochMinute } from '../domain/time.js';
import type { StationCode } from '../domain/types.js';

/**
 * The planner works against a synchronous ledger because searching for a
 * feasible minute probes it dozens of times, and doing that over the wire would
 * be absurd. So planning reads the relevant window into memory once, decides,
 * and writes the reservation back.
 *
 * Two planners for the same restaurant would race between the read and the
 * write, so callers take an advisory lock for the restaurant first — see
 * `withKitchenLock`. Different restaurants never block each other.
 */

/** Hold a per-restaurant lock for the rest of the transaction. */
export async function lockKitchen(db: Db, restaurantId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [restaurantId]);
}

/**
 * `excludeOrderId` matters on a re-plan: an order must not find its own
 * previous reservation blocking the minute it is trying to move into.
 */
export async function readLedger(
  db: Db,
  restaurantId: string,
  from: EpochMinute,
  to: EpochMinute,
  excludeOrderId?: string,
): Promise<InMemoryStationLoad> {
  const ledger = new InMemoryStationLoad();
  const { rows } = await db.query<{ order_id: string; station_code: string; minute: number }>(
    `SELECT order_id, station_code, minute
       FROM dine.station_reservation
      WHERE restaurant_id = $1 AND minute >= $2 AND minute < $3
        AND ($4::uuid IS NULL OR order_id <> $4::uuid)`,
    [restaurantId, from, to, excludeOrderId ?? null],
  );

  // Rebuild one-minute intervals; the in-memory ledger only cares about counts.
  for (const row of rows) {
    ledger.occupy(row.order_id, row.station_code, [
      { from: row.minute, to: row.minute + 1 },
    ]);
  }
  return ledger;
}

export async function persistReservation(
  db: Db,
  input: {
    orderId: string;
    restaurantId: string;
    intervals: Array<{ station: StationCode; interval: LaneInterval }>;
  },
): Promise<void> {
  await releaseReservation(db, input.orderId);
  if (input.intervals.length === 0) return;

  const stations: string[] = [];
  const minutes: number[] = [];
  for (const { station, interval } of input.intervals) {
    for (let m = interval.from; m < interval.to; m++) {
      stations.push(station);
      minutes.push(m);
    }
  }

  await db.query(
    `INSERT INTO dine.station_reservation (order_id, restaurant_id, station_code, minute)
     SELECT $1, $2, s, m FROM unnest($3::text[], $4::int[]) AS t(s, m)
     ON CONFLICT DO NOTHING`,
    [input.orderId, input.restaurantId, stations, minutes],
  );
}

/** Called on READY, on cancellation, and before every re-plan. */
export async function releaseReservation(db: Db, orderId: string): Promise<void> {
  await db.query('DELETE FROM dine.station_reservation WHERE order_id = $1', [orderId]);
}

/** Ops view: how many lanes of a station are spoken for in a given minute. */
export async function occupancyAt(
  db: Db,
  restaurantId: string,
  station: StationCode,
  minute: EpochMinute,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dine.station_reservation
      WHERE restaurant_id = $1 AND station_code = $2 AND minute = $3`,
    [restaurantId, station, minute],
  );
  return rows[0]?.n ?? 0;
}
