import { getPool } from '../../db/pool.js';
import { periodParams, periodsOf, type PerPeriod } from '../../domain/time.js';

/**
 * Whether people are hearing from us, for the desk's front page.
 *
 * A queue that is not draining and a gateway that is failing look the same
 * from a guest's phone — silence — and different from here.
 */
export interface NotifyOverview {
  queued: number;
  /** Queued for more than ten minutes: the relay is not running, or cannot. */
  stuck: number;
  sent: PerPeriod;
  failed: PerPeriod;
  sms: { sent: PerPeriod; failed: PerPeriod };
  push: { sent: PerPeriod; failed: PerPeriod };
  /** Phones that can be pushed to right now. */
  devices: number;
}

export async function notifyOverview(now: Date): Promise<NotifyOverview> {
  const [today, week, end] = periodParams(periodsOf(now));
  const stuckBefore = new Date(now.getTime() - 10 * 60 * 1000);
  const { rows } = await getPool().query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM notify.message WHERE state = 'queued') AS queued,
       (SELECT count(*)::int FROM notify.message WHERE state = 'queued' AND created_at < $4) AS stuck,
       count(*) FILTER (WHERE state IN ('sent', 'acked') AND sent_at >= $1 AND sent_at < $3)::int AS sent_today,
       count(*) FILTER (WHERE state IN ('sent', 'acked') AND sent_at >= $2 AND sent_at < $3)::int AS sent_week,
       count(*) FILTER (WHERE state IN ('sent', 'acked'))::int AS sent_season,
       count(*) FILTER (WHERE state = 'failed' AND created_at >= $1 AND created_at < $3)::int AS failed_today,
       count(*) FILTER (WHERE state = 'failed' AND created_at >= $2 AND created_at < $3)::int AS failed_week,
       count(*) FILTER (WHERE state = 'failed')::int AS failed_season,
       count(*) FILTER (WHERE channel = 'sms' AND state IN ('sent', 'acked') AND sent_at >= $1 AND sent_at < $3)::int AS sms_sent_today,
       count(*) FILTER (WHERE channel = 'sms' AND state IN ('sent', 'acked') AND sent_at >= $2 AND sent_at < $3)::int AS sms_sent_week,
       count(*) FILTER (WHERE channel = 'sms' AND state IN ('sent', 'acked'))::int AS sms_sent_season,
       count(*) FILTER (WHERE channel = 'sms' AND state = 'failed' AND created_at >= $1 AND created_at < $3)::int AS sms_failed_today,
       count(*) FILTER (WHERE channel = 'sms' AND state = 'failed' AND created_at >= $2 AND created_at < $3)::int AS sms_failed_week,
       count(*) FILTER (WHERE channel = 'sms' AND state = 'failed')::int AS sms_failed_season,
       count(*) FILTER (WHERE channel = 'push' AND state IN ('sent', 'acked') AND sent_at >= $1 AND sent_at < $3)::int AS push_sent_today,
       count(*) FILTER (WHERE channel = 'push' AND state IN ('sent', 'acked') AND sent_at >= $2 AND sent_at < $3)::int AS push_sent_week,
       count(*) FILTER (WHERE channel = 'push' AND state IN ('sent', 'acked'))::int AS push_sent_season,
       count(*) FILTER (WHERE channel = 'push' AND state = 'failed' AND created_at >= $1 AND created_at < $3)::int AS push_failed_today,
       count(*) FILTER (WHERE channel = 'push' AND state = 'failed' AND created_at >= $2 AND created_at < $3)::int AS push_failed_week,
       count(*) FILTER (WHERE channel = 'push' AND state = 'failed')::int AS push_failed_season,
       (SELECT count(*)::int FROM notify.device WHERE revoked_at IS NULL) AS devices
       FROM notify.message`,
    [today, week, end, stuckBefore],
  );
  const r = rows[0]!;
  const per = (key: string): PerPeriod => ({ today: r[`${key}_today`]!, week: r[`${key}_week`]!, season: r[`${key}_season`]! });
  return {
    queued: r['queued']!,
    stuck: r['stuck']!,
    sent: per('sent'),
    failed: per('failed'),
    sms: { sent: per('sms_sent'), failed: per('sms_failed') },
    push: { sent: per('push_sent'), failed: per('push_failed') },
    devices: r['devices']!,
  };
}
