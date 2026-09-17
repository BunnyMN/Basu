import { getPool } from '../../db/pool.js';
import { periodParams, periodsOf, type PerPeriod } from '../../domain/time.js';

/**
 * How many people there are, for the desk's front page.
 *
 * Counts only: no phone, no name leaves this module through here. "Active"
 * means a session was used inside the window, which is the nearest thing the
 * platform has to "opened the app".
 */
export interface GuestCensus {
  /** Everyone who ever verified a phone and has not closed the account. */
  total: number;
  closed: number;
  /** First sign-in fell inside the window. */
  joined: PerPeriod;
  /** A session of theirs was seen inside the window. */
  active: PerPeriod;
  /** Sessions still open right now. */
  sessionsOpen: number;
}

export async function guestCensus(now: Date): Promise<GuestCensus> {
  const [today, week, end] = periodParams(periodsOf(now));
  const { rows } = await getPool().query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM identity.guest WHERE closed_at IS NULL) AS total,
       (SELECT count(*)::int FROM identity.guest WHERE closed_at IS NOT NULL) AS closed,
       (SELECT count(*)::int FROM identity.guest WHERE created_at >= $1 AND created_at < $3) AS joined_today,
       (SELECT count(*)::int FROM identity.guest WHERE created_at >= $2 AND created_at < $3) AS joined_week,
       (SELECT count(*)::int FROM identity.guest) AS joined_season,
       (SELECT count(DISTINCT guest_id)::int FROM identity.guest_session
         WHERE COALESCE(last_seen_at, created_at) >= $1 AND COALESCE(last_seen_at, created_at) < $3) AS active_today,
       (SELECT count(DISTINCT guest_id)::int FROM identity.guest_session
         WHERE COALESCE(last_seen_at, created_at) >= $2 AND COALESCE(last_seen_at, created_at) < $3) AS active_week,
       (SELECT count(DISTINCT guest_id)::int FROM identity.guest_session) AS active_season,
       (SELECT count(*)::int FROM identity.guest_session WHERE revoked_at IS NULL AND expires_at > $4) AS sessions_open`,
    [today, week, end, now],
  );
  const r = rows[0]!;
  return {
    total: r['total']!,
    closed: r['closed']!,
    joined: { today: r['joined_today']!, week: r['joined_week']!, season: r['joined_season']! },
    active: { today: r['active_today']!, week: r['active_week']!, season: r['active_season']! },
    sessionsOpen: r['sessions_open']!,
  };
}
