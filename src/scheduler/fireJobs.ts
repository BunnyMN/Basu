import type { Db } from '../db/pool.js';
import { tx } from '../db/pool.js';
import { appendEvent } from '../db/events.js';
import { FIREABLE_STATES } from '../domain/states.js';
import type { FirePlan } from '../domain/types.js';
import { fromEpochMinute } from '../domain/time.js';

/**
 * The scheduler is the one component whose failure is silent: an API outage
 * shows the guest an error, a scheduler outage just means nothing happens and
 * a table sits waiting. Everything here is written for that asymmetry.
 */

export interface FireJobRow {
  id: string;
  order_id: string;
  run_at: Date;
  state: 'pending' | 'done' | 'cancelled' | 'failed';
  attempt: number;
  plan: unknown;
}

export type FireOutcome =
  | { result: 'fired'; orderId: string; jobId: string; lateSeconds: number }
  | { result: 'superseded'; orderId: string; jobId: string }
  | { result: 'failed'; orderId: string; jobId: string; error: string };

/**
 * Schedule (or move) the single pending fire for an order.
 *
 * Re-planning updates the existing row instead of cancelling and inserting:
 * the partial unique index would reject a second pending job anyway, and doing
 * it in one statement removes the window where an order has none.
 */
export async function scheduleFire(
  db: Db,
  orderId: string,
  runAt: Date,
  plan?: FirePlan,
): Promise<string> {
  const planJson = plan ? JSON.stringify(serialisePlan(plan)) : null;

  const updated = await db.query<{ id: string }>(
    `UPDATE fire_job
        SET run_at = $2, plan = COALESCE($3::jsonb, plan), updated_at = now()
      WHERE order_id = $1 AND state = 'pending'
      RETURNING id`,
    [orderId, runAt, planJson],
  );
  if (updated.rows[0]) return updated.rows[0].id;

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO fire_job (order_id, run_at, plan) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [orderId, runAt, planJson],
  );
  return inserted.rows[0]!.id;
}

export async function cancelFire(db: Db, orderId: string): Promise<void> {
  await db.query(
    `UPDATE fire_job SET state = 'cancelled', updated_at = now()
      WHERE order_id = $1 AND state = 'pending'`,
    [orderId],
  );
}

/**
 * Take ownership of the jobs that are due.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets more than one worker run without them
 * fighting over the same rows, and the lease (`locked_until`) is what lets a
 * worker that dies mid-batch have its jobs picked up without a reaper process.
 */
export async function claimDueJobs(
  db: Db,
  opts: { workerId: string; now: Date; batch?: number; leaseSeconds?: number },
): Promise<FireJobRow[]> {
  const { workerId, now, batch = 50, leaseSeconds = 30 } = opts;
  const { rows } = await db.query<FireJobRow>(
    `UPDATE fire_job
        SET locked_by = $1,
            locked_until = $2::timestamptz + make_interval(secs => $3),
            attempt = attempt + 1,
            updated_at = now()
      WHERE id IN (
        SELECT id FROM fire_job
         WHERE state = 'pending'
           AND run_at <= $2::timestamptz
           AND (locked_until IS NULL OR locked_until < $2::timestamptz)
         ORDER BY run_at
         LIMIT $4
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, order_id, run_at, state, attempt, plan`,
    [workerId, now, leaseSeconds, batch],
  );
  return rows;
}

/**
 * Fire exactly one ticket.
 *
 * The conditional UPDATE is the whole safety story. If a chef already hit
 * «Одоо тавь», or the guest cancelled, the order is no longer in a fireable
 * state and the update touches zero rows — so we stand down instead of
 * cooking the ticket twice. That zero-row count is a metric, not a shrug:
 * if it is ever non-trivial, something upstream is racing.
 */
export async function fireOne(
  job: FireJobRow,
  opts: { now: Date; actor?: string },
): Promise<FireOutcome> {
  const { now, actor = 'system:scheduler' } = opts;

  try {
    return await tx(async (client) => {
      const claimed = await client.query(
        `UPDATE dining_order
            SET state = 'FIRED', fired_at = $2, fired_by = $3,
                version = version + 1, updated_at = $2
          WHERE id = $1 AND state = ANY($4::text[])
          RETURNING id, ready_at`,
        [job.order_id, now, actor, [...FIREABLE_STATES]],
      );

      if (claimed.rowCount === 0) {
        await client.query(
          `UPDATE fire_job SET state = 'cancelled', updated_at = now() WHERE id = $1`,
          [job.id],
        );
        return { result: 'superseded', orderId: job.order_id, jobId: job.id } as const;
      }

      await client.query(`UPDATE fire_job SET state = 'done', updated_at = now() WHERE id = $1`, [
        job.id,
      ]);

      const lateSeconds = Math.max(0, (now.getTime() - job.run_at.getTime()) / 1000);

      await appendEvent(client, job.order_id, 'FIRED', actor, {
        scheduledFor: job.run_at.toISOString(),
        lateSeconds,
        plan: job.plan ?? null,
      });

      // Written in the same transaction as the state change, relayed after.
      // A fire the kitchen never hears about is the same as no fire at all.
      await client.query(
        `INSERT INTO outbox (topic, payload) VALUES
           ('kds.ticket.fire', $1::jsonb),
           ('guest.notify.cooking', $2::jsonb)`,
        [
          JSON.stringify({ orderId: job.order_id, firedAt: now.toISOString(), plan: job.plan }),
          JSON.stringify({ orderId: job.order_id, template: 'order.cooking' }),
        ],
      );

      return { result: 'fired', orderId: job.order_id, jobId: job.id, lateSeconds } as const;
    });
  } catch (error) {
    const message = (error as Error).message;
    await recordFailure(job.id, message);
    return { result: 'failed', orderId: job.order_id, jobId: job.id, error: message };
  }
}

async function recordFailure(jobId: string, message: string): Promise<void> {
  const { getPool } = await import('../db/pool.js');
  await getPool()
    .query(
      `UPDATE fire_job
          SET last_error = $2, locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, message.slice(0, 2000)],
    )
    .catch(() => {});
}

/**
 * Jobs whose minute passed while the worker was down.
 *
 * They still fire — a late ticket beats a lost one — but they are counted, and
 * a large backlog is a page, not a log line: it means guests are sitting down
 * to kitchens that were never told.
 */
export async function findOverdue(
  db: Db,
  opts: { now: Date; graceSeconds?: number },
): Promise<FireJobRow[]> {
  const { now, graceSeconds = 30 } = opts;
  const { rows } = await db.query<FireJobRow>(
    `SELECT id, order_id, run_at, state, attempt, plan
       FROM fire_job
      WHERE state = 'pending'
        AND run_at < $1::timestamptz - make_interval(secs => $2)
      ORDER BY run_at`,
    [now, graceSeconds],
  );
  return rows;
}

function serialisePlan(plan: FirePlan) {
  return {
    fireAt: fromEpochMinute(plan.fireAt).toISOString(),
    readyAt: fromEpochMinute(plan.readyAt).toISOString(),
    orderPrepMinutes: plan.orderPrepMinutes,
    shiftMinutes: plan.shiftMinutes,
    ttfbMinutes: plan.ttfbMinutes,
    lines: plan.lines.map((s) => ({
      name: s.line.name,
      station: s.station,
      lane: s.lane,
      startAt: fromEpochMinute(s.startAt).toISOString(),
      waitMinutes: s.waitMinutes,
    })),
    violations: plan.violations.map((v) => ({
      name: v.line.name,
      waitMinutes: v.waitMinutes,
      toleranceMinutes: v.toleranceMinutes,
    })),
  };
}
