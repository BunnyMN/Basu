import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { addMinutes } from '../domain/time.js';
import {
  cancelFire,
  claimDueJobs,
  findOverdue,
  fireOne,
  scheduleFire,
} from './fireJobs.js';
import { seedGuest, seedOrder, seedRestaurant, truncateAll } from '../test/seed.js';
import type { OrderState } from '../domain/types.js';

const pool = () => getPool();

async function anOrder(state: OrderState = 'SCHEDULED') {
  const { restaurantId } = await seedRestaurant();
  const guestId = await seedGuest();
  return seedOrder({ restaurantId, guestId, state, slotStartsAt: at('12:30') });
}

async function orderState(orderId: string): Promise<string> {
  const { rows } = await pool().query<{ state: string }>(
    'SELECT state FROM dine.dining_order WHERE id = $1',
    [orderId],
  );
  return rows[0]!.state;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe('fire job queue', () => {
  it('claims a job only once its minute has come', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));

    const early = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:22') });
    expect(early).toHaveLength(0);

    const due = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });
    expect(due).toHaveLength(1);
    expect(due[0]!.order_id).toBe(orderId);
  });

  it('hands a job to exactly one worker', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));

    // Two workers reaching for the same due job at the same instant.
    const [a, b] = await Promise.all([
      claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') }),
      claimDueJobs(pool(), { workerId: 'w2', now: at('12:23') }),
    ]);

    expect(a.length + b.length).toBe(1);
  });

  it('re-plans in place instead of queueing a second fire', async () => {
    const { orderId } = await anOrder();
    const first = await scheduleFire(pool(), orderId, at('12:23'));
    const second = await scheduleFire(pool(), orderId, at('12:28'));

    expect(second).toBe(first);

    const { rows } = await pool().query<{ count: number; run_at: Date }>(
      `SELECT count(*)::int AS count, min(run_at) AS run_at
         FROM dine.fire_job WHERE order_id = $1 AND state = 'pending'`,
      [orderId],
    );
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.run_at.toISOString()).toBe(at('12:28').toISOString());
  });

  it('refuses a second pending job at the database level', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));

    await expect(
      pool().query(`INSERT INTO dine.fire_job (order_id, run_at) VALUES ($1, $2)`, [
        orderId,
        at('12:25'),
      ]),
    ).rejects.toThrow(/fire_job_one_pending_idx/);
  });
});

describe('firing', () => {
  it('moves the order to FIRED and tells the kitchen in the same transaction', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });

    const outcome = await fireOne(job!, { now: at('12:23') });
    expect(outcome.result).toBe('fired');
    expect(await orderState(orderId)).toBe('FIRED');

    const events = await pool().query(
      `SELECT type, actor FROM dine.order_event WHERE order_id = $1`,
      [orderId],
    );
    expect(events.rows).toEqual([{ type: 'FIRED', actor: 'system:scheduler' }]);

    const outbox = await pool().query<{ topic: string }>(`SELECT topic FROM outbox ORDER BY id`);
    expect(outbox.rows.map((r) => r.topic)).toEqual([
      'kds.ticket.fire',
      'guest.notify.cooking',
    ]);

    const job2 = await pool().query<{ state: string }>(
      `SELECT state FROM dine.fire_job WHERE id = $1`,
      [job!.id],
    );
    expect(job2.rows[0]!.state).toBe('done');
  });

  it('never fires the same ticket twice', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });

    const first = await fireOne(job!, { now: at('12:23') });
    // A duplicate delivery of the very same job — the shape a retry takes.
    const second = await fireOne(job!, { now: at('12:23') });

    expect(first.result).toBe('fired');
    expect(second.result).toBe('superseded');

    const events = await pool().query(
      `SELECT count(*)::int AS n FROM dine.order_event WHERE order_id = $1 AND type = 'FIRED'`,
      [orderId],
    );
    expect(events.rows[0]!.n).toBe(1);
  });

  it('stands down when the chef already fired by hand', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });

    // «Одоо тавь» on the tablet, two seconds before the timer would have run.
    await pool().query(
      `UPDATE dine.dining_order SET state = 'FIRED', fired_at = $2, fired_by = 'kds:tablet-1'
        WHERE id = $1`,
      [orderId, at('12:22')],
    );

    const outcome = await fireOne(job!, { now: at('12:23') });
    expect(outcome.result).toBe('superseded');

    const { rows } = await pool().query<{ fired_by: string }>(
      `SELECT fired_by FROM dine.dining_order WHERE id = $1`,
      [orderId],
    );
    expect(rows[0]!.fired_by).toBe('kds:tablet-1'); // the chef's action survives
  });

  it('does not fire an order the guest cancelled', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });

    await pool().query(`UPDATE dine.dining_order SET state = 'CANCELLED' WHERE id = $1`, [orderId]);
    await cancelFire(pool(), orderId);

    const outcome = await fireOne(job!, { now: at('12:23') });
    expect(outcome.result).toBe('superseded');
    expect(await orderState(orderId)).toBe('CANCELLED');
    expect(
      (await pool().query(`SELECT count(*)::int AS n FROM outbox`)).rows[0]!.n,
    ).toBe(0);
  });

  it('fires a HELD ticket when the kitchen frees up', async () => {
    const { orderId } = await anOrder('HELD');
    await scheduleFire(pool(), orderId, at('12:23'));
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:23') });

    expect((await fireOne(job!, { now: at('12:23') })).result).toBe('fired');
  });

  it('reports how late it was rather than hiding it', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));
    // The worker was down and only came back four minutes later.
    const [job] = await claimDueJobs(pool(), { workerId: 'w1', now: at('12:27') });

    const outcome = await fireOne(job!, { now: at('12:27') });
    expect(outcome.result).toBe('fired');
    if (outcome.result === 'fired') expect(outcome.lateSeconds).toBe(240);
    expect(await orderState(orderId)).toBe('FIRED');
  });
});

describe('recovery', () => {
  it('finds the backlog a crashed worker left behind', async () => {
    const { restaurantId } = await seedRestaurant();
    const guestId = await seedGuest();

    for (const minute of ['12:10', '12:15', '12:40']) {
      const { orderId } = await seedOrder({
        restaurantId,
        guestId,
        slotStartsAt: at('12:30'),
      });
      await scheduleFire(pool(), orderId, at(minute));
    }

    const overdue = await findOverdue(pool(), { now: at('12:20') });
    expect(overdue).toHaveLength(2);
    // Oldest first: the guest who has been sitting longest gets cooked for first.
    expect(overdue[0]!.run_at.getTime()).toBeLessThan(overdue[1]!.run_at.getTime());
  });

  it('lets a lease expire so a dead worker does not strand a ticket', async () => {
    const { orderId } = await anOrder();
    await scheduleFire(pool(), orderId, at('12:23'));

    const claimed = await claimDueJobs(pool(), {
      workerId: 'dead-worker',
      now: at('12:23'),
      leaseSeconds: 30,
    });
    expect(claimed).toHaveLength(1);

    // Still leased — nobody else may touch it.
    expect(await claimDueJobs(pool(), { workerId: 'w2', now: at('12:23') })).toHaveLength(0);

    // Lease expired; the work is up for grabs again.
    const retaken = await claimDueJobs(pool(), {
      workerId: 'w2',
      now: addMinutes(at('12:23'), 1),
    });
    expect(retaken).toHaveLength(1);
    expect(retaken[0]!.attempt).toBe(2);
  });
});
