import { getPool } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { ARM_LEAD_MINUTES, armOrder, findAbandoned, markNoShow } from '../services/orders.js';
import { findPlannable, planAndSchedule } from '../services/planning.js';
import { relay as relayNotifications } from '../platform/notify/index.js';
import { processReceipts } from '../platform/ledger/index.js';
import { housekeeping as ideshHousekeeping } from '../idesh/index.js';
import { claimDueJobs, findOverdue, fireOne } from './fireJobs.js';
import type { Ctx } from '../ports.js';

/**
 * One pass of the scheduler.
 *
 * Order matters here. Arming happens before planning because a guest's reply
 * is the strongest input the plan has; planning happens before firing so a
 * ticket fires against a fresh decision; the outbox is relayed last so nothing
 * leaves the building until the state change that justified it has committed.
 */

export interface TickReport {
  armed: number;
  planned: number;
  held: number;
  fired: number;
  superseded: number;
  lateFires: number;
  relayed: number;
  notified: number;
  receipts: number;
  abandoned: number;
  /** Idesh drafts that gave their animal back, and handovers that closed. */
  ideshExpired: number;
  ideshClosed: number;
}

const EMPTY: TickReport = {
  armed: 0,
  planned: 0,
  held: 0,
  fired: 0,
  superseded: 0,
  lateFires: 0,
  relayed: 0,
  notified: 0,
  receipts: 0,
  abandoned: 0,
  ideshExpired: 0,
  ideshClosed: 0,
};

/** Fire tickets are spaced so a 12:00 crush does not flood the tablet at once. */
const FIRE_SPACING_MS = Number(process.env['SCHEDULER_SPACING_MS'] ?? 250);

export interface TickOptions {
  workerId?: string;
  batch?: number;
  /** Tests drive time by hand and do not want to wait between fires. */
  spacingMs?: number;
}

export async function tick(ctx: Ctx, opts: TickOptions = {}): Promise<TickReport> {
  const { workerId = `worker-${process.pid}`, batch = 50, spacingMs = FIRE_SPACING_MS } = opts;
  const now = ctx.clock.now();
  const report: TickReport = { ...EMPTY };
  const db = getPool();

  /* 1. Arm everything inside its last fifteen minutes. */
  const { rows: armable } = await db.query<{ id: string }>(
    `SELECT id FROM dine.dining_order
      WHERE state = 'SCHEDULED'
        AND slot_starts_at <= $1::timestamptz + make_interval(mins => $2)`,
    [now, ARM_LEAD_MINUTES],
  );
  for (const row of armable) {
    if (await armOrder(ctx, row.id)) report.armed++;
  }

  /* 2. Re-plan what may have drifted. */
  for (const orderId of await findPlannable(db)) {
    const outcome = await planAndSchedule(ctx, orderId);
    if (outcome.kind === 'planned') report.planned++;
    else if (outcome.kind === 'held') report.held++;
  }

  /* 3. Fire what is due. */
  const jobs = await claimDueJobs(db, { workerId, now, batch });
  for (const job of jobs) {
    const outcome = await fireOne(job, { now });
    if (outcome.result === 'fired') {
      report.fired++;
      if (outcome.lateSeconds > 120) report.lateFires++;
    } else if (outcome.result === 'superseded') {
      report.superseded++;
    }
    if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
  }

  /* 4. Cooking finishes on its own clock. */
  await db.query(
    `UPDATE dine.dining_order SET state = 'COOKING', updated_at = $1
      WHERE state = 'FIRED'`,
    [now],
  );

  /* 5. Let go of guests who are not coming. */
  for (const orderId of await findAbandoned(db, now)) {
    await markNoShow(ctx, orderId);
    report.abandoned++;
  }

  /* 6. The other vertical's housekeeping. Before the outbox, for the same
   *    reason everything else is: a refund it posts wants relaying now. */
  const idesh = await ideshHousekeeping(ctx);
  report.ideshExpired = idesh.expired;
  report.ideshClosed = idesh.closed;

  /* 7. Anything the state changes promised the outside world. */
  report.relayed = await relayOutbox(ctx);
  report.notified = await relayNotifications(ctx);
  report.receipts = (await processReceipts(ctx)).issued;

  return report;
}

/**
 * Drain the outbox.
 *
 * Rows were written inside the same transaction as the state change that
 * caused them, so this is at-least-once delivery of things that definitely
 * happened — the opposite of the usual failure, where a message goes out for a
 * change that then rolls back.
 */
export async function relayOutbox(ctx: Ctx, limit = 200): Promise<number> {
  const db = getPool();
  const { rows } = await db.query<{ id: number; topic: string; payload: Record<string, unknown> }>(
    `SELECT id, topic, payload FROM outbox
      WHERE published_at IS NULL ORDER BY id LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    switch (row.topic) {
      case 'guest.notify.cooking': {
        const orderId = String(row.payload['orderId']);
        const guestId = row.payload['guestId'];
        if (typeof guestId !== 'string') break;
        const { enqueue } = await import('../platform/notify/index.js');
        await enqueue(ctx, {
          guestId,
          subject: 'order',
          subjectId: orderId,
          template: 'order.cooking',
          channel: 'push',
          title: 'Гал дээр гарлаа',
          body: 'Таны хоол гал дээр гарлаа. Цуцлах боломжгүй боллоо.',
        });
        break;
      }
      case 'kds.ticket.fire':
        // The websocket gateway subscribes here. Until it exists the KDS reads
        // its tickets over HTTP, so there is nothing to push.
        break;
      default:
        break;
    }
    await db.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
  }
  return rows.length;
}

/**
 * Boot recovery. Jobs whose minute passed while nobody was running still fire —
 * a late ticket beats a lost one — but a large backlog is a page, because it
 * means guests are sitting down to kitchens that were never told.
 */
export async function recoverOnBoot(
  ctx: Ctx,
  opts: { alertThreshold?: number } = {},
): Promise<{ recovered: number; backlog: number }> {
  const { alertThreshold = 20 } = opts;
  const now = ctx.clock.now();
  const overdue = await findOverdue(getPool(), { now });

  if (overdue.length > alertThreshold) {
    console.error(
      `[scheduler] FIRE_BACKLOG ${overdue.length} overdue jobs at boot — kitchens were not told`,
    );
  }

  let recovered = 0;
  for (const job of overdue) {
    const outcome = await fireOne(job, { now });
    if (outcome.result === 'fired') recovered++;
  }
  return { recovered, backlog: overdue.length };
}

/** Long-running entrypoint. `tick` is what the tests drive directly. */
export async function run(ctx: Ctx, intervalMs = 1000): Promise<() => void> {
  await recoverOnBoot(ctx);
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await tick(ctx);
      } catch (error) {
        console.error('[scheduler] tick failed', error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}

/** Convenience for tests: advance a virtual clock and tick each minute. */
export async function runMinutes(
  ctx: Ctx,
  minutes: number,
  advance: (m: number) => void,
  opts: TickOptions = {},
): Promise<TickReport> {
  const total: TickReport = { ...EMPTY };
  for (let i = 0; i < minutes; i++) {
    const report = await tick(ctx, { spacingMs: 0, ...opts });
    for (const key of Object.keys(total) as Array<keyof TickReport>) {
      total[key] += report[key];
    }
    advance(1);
  }
  return total;
}

export { addMinutes };
