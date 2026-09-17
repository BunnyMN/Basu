import { getPool } from '../db/pool.js';
import { periodParams, periodsOf, type PerPeriod } from '../domain/time.js';

/**
 * Lunch, for the desk's front page: what is in flight this minute, and what
 * the window held.
 *
 * The three live numbers are the ones the lunchtime watch already looks at
 * in `/v1/ops/health`; they are repeated here so the front page needs one
 * request, not two.
 */
export interface DineOverview {
  /** Placed and not yet closed, whichever step it is on. */
  live: number;
  held: number;
  /** Fire jobs the scheduler should have run by now. */
  late: number;
  restaurants: { active: number; offline: number };
  /** Orders placed inside the window. Drafts never count. */
  placed: PerPeriod;
  /** Money for those orders, less the ones that came back. */
  salesMnt: PerPeriod;
  closed: PerPeriod;
  /** Rejected by the kitchen, cancelled by the guest, or refunded. */
  cancelled: PerPeriod;
  noShows: PerPeriod;
}

const LIVE = `('PLACED','ACCEPTED','SCHEDULED','ARMED','HELD','FIRED','COOKING','READY','SERVED')`;
const CAME_BACK = `('REJECTED','CANCELLED','REFUNDED')`;

export async function dineOverview(now: Date): Promise<DineOverview> {
  const [today, week, end] = periodParams(periodsOf(now));
  const { rows } = await getPool().query<Record<string, string | number>>(
    `SELECT
       (SELECT count(*)::int FROM dine.dining_order WHERE state IN ${LIVE}) AS live,
       (SELECT count(*)::int FROM dine.dining_order WHERE state = 'HELD') AS held,
       (SELECT count(*)::int FROM dine.fire_job WHERE state = 'pending' AND run_at < $4::timestamptz - interval '2 minutes') AS late,
       (SELECT count(*)::int FROM dine.restaurant WHERE active) AS active,
       (SELECT count(*)::int FROM dine.restaurant r WHERE r.active AND NOT EXISTS (
          SELECT 1 FROM dine.kds_device d
           WHERE d.restaurant_id = r.id AND d.revoked_at IS NULL AND d.last_seen_at > $4::timestamptz - interval '90 seconds')) AS offline,
       count(*) FILTER (WHERE state <> 'DRAFT' AND created_at >= $1 AND created_at < $3)::int AS placed_today,
       count(*) FILTER (WHERE state <> 'DRAFT' AND created_at >= $2 AND created_at < $3)::int AS placed_week,
       count(*) FILTER (WHERE state <> 'DRAFT')::int AS placed_season,
       COALESCE(sum(total_mnt) FILTER (WHERE state <> 'DRAFT' AND state NOT IN ${CAME_BACK} AND created_at >= $1 AND created_at < $3), 0) AS sales_today,
       COALESCE(sum(total_mnt) FILTER (WHERE state <> 'DRAFT' AND state NOT IN ${CAME_BACK} AND created_at >= $2 AND created_at < $3), 0) AS sales_week,
       COALESCE(sum(total_mnt) FILTER (WHERE state <> 'DRAFT' AND state NOT IN ${CAME_BACK}), 0) AS sales_season,
       count(*) FILTER (WHERE state = 'CLOSED' AND COALESCE(closed_at, updated_at) >= $1 AND COALESCE(closed_at, updated_at) < $3)::int AS closed_today,
       count(*) FILTER (WHERE state = 'CLOSED' AND COALESCE(closed_at, updated_at) >= $2 AND COALESCE(closed_at, updated_at) < $3)::int AS closed_week,
       count(*) FILTER (WHERE state = 'CLOSED')::int AS closed_season,
       count(*) FILTER (WHERE state IN ${CAME_BACK} AND created_at >= $1 AND created_at < $3)::int AS cancelled_today,
       count(*) FILTER (WHERE state IN ${CAME_BACK} AND created_at >= $2 AND created_at < $3)::int AS cancelled_week,
       count(*) FILTER (WHERE state IN ${CAME_BACK})::int AS cancelled_season,
       count(*) FILTER (WHERE state = 'NO_SHOW' AND created_at >= $1 AND created_at < $3)::int AS no_show_today,
       count(*) FILTER (WHERE state = 'NO_SHOW' AND created_at >= $2 AND created_at < $3)::int AS no_show_week,
       count(*) FILTER (WHERE state = 'NO_SHOW')::int AS no_show_season
       FROM dine.dining_order`,
    [today, week, end, now],
  );
  const r = rows[0]!;
  const n = (key: string) => Number(r[key]);
  const per = (key: string): PerPeriod => ({ today: n(`${key}_today`), week: n(`${key}_week`), season: n(`${key}_season`) });
  return {
    live: n('live'),
    held: n('held'),
    late: n('late'),
    restaurants: { active: n('active'), offline: n('offline') },
    placed: per('placed'),
    salesMnt: per('sales'),
    closed: per('closed'),
    cancelled: per('cancelled'),
    noShows: per('no_show'),
  };
}
