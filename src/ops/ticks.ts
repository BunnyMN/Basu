import { getPool, type Db } from '../db/pool.js';

/**
 * The scheduler's pulse.
 *
 * Every tick writes one line; the desk reads the last of them to say whether
 * the machine is running, and the last hour's worth to say how hard.
 */
export interface Tick {
  at: Date;
  tookMs: number;
  report: Record<string, number>;
}

export async function recordTick(at: Date, report: Record<string, number>, tookMs: number, db: Db = getPool()): Promise<void> {
  await db.query(
    `WITH gone AS (DELETE FROM ops.tick WHERE at < $1::timestamptz - interval '7 days')
     INSERT INTO ops.tick (at, took_ms, report) VALUES ($1, $2, $3)`,
    [at, Math.max(0, Math.round(tookMs)), JSON.stringify(report)],
  );
}

export async function lastTicks(limit = 50, db: Db = getPool()): Promise<Tick[]> {
  const { rows } = await db.query<{ at: Date; took_ms: number; report: Record<string, number> }>(
    'SELECT at, took_ms, report FROM ops.tick ORDER BY at DESC LIMIT $1',
    [limit],
  );
  return rows.map((r) => ({ at: r.at, tookMs: r.took_ms, report: r.report }));
}

export interface Pulse {
  lastAt: Date | null;
  lastTookMs: number | null;
  lastReport: Record<string, number> | null;
  /** Ticks inside the last hour before `now`. */
  lastHour: number;
  /** Summed over the last 24 hours before `now`. */
  day: { fired: number; lateFires: number; held: number; notified: number; receipts: number };
}

export async function pulse(now: Date, db: Db = getPool()): Promise<Pulse> {
  const [{ rows: last }, { rows: sums }] = await Promise.all([
    db.query<{ at: Date; took_ms: number; report: Record<string, number> }>('SELECT at, took_ms, report FROM ops.tick ORDER BY at DESC LIMIT 1'),
    db.query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE at > $1::timestamptz - interval '1 hour')::int AS last_hour,
              COALESCE(sum((report->>'fired')::int), 0)::int AS fired,
              COALESCE(sum((report->>'lateFires')::int), 0)::int AS late,
              COALESCE(sum((report->>'held')::int), 0)::int AS held,
              COALESCE(sum((report->>'notified')::int), 0)::int AS notified,
              COALESCE(sum((report->>'receipts')::int), 0)::int AS receipts
         FROM ops.tick WHERE at > $1::timestamptz - interval '24 hours' AND at <= $1`,
      [now],
    ),
  ]);
  const s = sums[0]!;
  return {
    lastAt: last[0]?.at ?? null,
    lastTookMs: last[0]?.took_ms ?? null,
    lastReport: last[0]?.report ?? null,
    lastHour: s['last_hour']!,
    day: { fired: s['fired']!, lateFires: s['late']!, held: s['held']!, notified: s['notified']!, receipts: s['receipts']! },
  };
}
