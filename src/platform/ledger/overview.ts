import { getPool } from '../../db/pool.js';
import { periodParams, periodsOf, type PerPeriod } from '../../domain/time.js';

/**
 * The money, for the desk's front page.
 *
 * Three balances say what the house is holding for whom; the rest is what
 * moved inside a window. All of it is read straight off the entries, so it
 * agrees with every statement the ledger has ever shown a guest.
 */
export interface LedgerOverview {
  /** Every guest wallet added up: what the house owes its guests. */
  liabilityMnt: number;
  /** Set aside for suppliers and restaurants, not yet sent. */
  payableMnt: number;
  /** The house's own, after what it set aside. */
  revenueMnt: number;
  /** What the house earned inside the window, net of what it passed on. */
  revenue: PerPeriod;
  topups: {
    pending: number;
    /** Pending for more than half an hour: the guest gave up, or QPay never called back. */
    stuck: number;
    settled: PerPeriod;
    settledMnt: PerPeriod;
    failed: PerPeriod;
  };
  purchases: { count: PerPeriod; mnt: PerPeriod };
  refunds: { count: PerPeriod; mnt: PerPeriod };
  receipts: { queued: number; failed: number };
  /** Sum of every entry. Anything but zero means a one-sided write got in. */
  drift: number;
}

export async function ledgerOverview(now: Date): Promise<LedgerOverview> {
  const [today, week, end] = periodParams(periodsOf(now));
  const stuckBefore = new Date(now.getTime() - 30 * 60 * 1000);
  const { rows } = await getPool().query<Record<string, string | number>>(
    `SELECT
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.kind = 'guest') AS liability,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.kind = 'payable') AS payable,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.label = 'house:revenue') AS revenue,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
         WHERE a.label = 'house:revenue' AND e.created_at >= $1 AND e.created_at < $3) AS revenue_today,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
         WHERE a.label = 'house:revenue' AND e.created_at >= $2 AND e.created_at < $3) AS revenue_week,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
         WHERE a.label = 'house:revenue') AS revenue_season,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'pending') AS topup_pending,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'pending' AND created_at < $4) AS topup_stuck,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'settled' AND settled_at >= $1 AND settled_at < $3) AS topup_today,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'settled' AND settled_at >= $2 AND settled_at < $3) AS topup_week,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'settled') AS topup_season,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.topup WHERE state = 'settled' AND settled_at >= $1 AND settled_at < $3) AS topup_mnt_today,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.topup WHERE state = 'settled' AND settled_at >= $2 AND settled_at < $3) AS topup_mnt_week,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.topup WHERE state = 'settled') AS topup_mnt_season,
       (SELECT count(*)::int FROM ledger.topup WHERE state IN ('failed', 'expired') AND created_at >= $1 AND created_at < $3) AS topup_failed_today,
       (SELECT count(*)::int FROM ledger.topup WHERE state IN ('failed', 'expired') AND created_at >= $2 AND created_at < $3) AS topup_failed_week,
       (SELECT count(*)::int FROM ledger.topup WHERE state IN ('failed', 'expired')) AS topup_failed_season,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'purchase' AND created_at >= $1 AND created_at < $3) AS buy_today,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'purchase' AND created_at >= $2 AND created_at < $3) AS buy_week,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'purchase') AS buy_season,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'purchase' AND created_at >= $1 AND created_at < $3) AS buy_mnt_today,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'purchase' AND created_at >= $2 AND created_at < $3) AS buy_mnt_week,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'purchase') AS buy_mnt_season,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'refund' AND created_at >= $1 AND created_at < $3) AS back_today,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'refund' AND created_at >= $2 AND created_at < $3) AS back_week,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'refund') AS back_season,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'refund' AND created_at >= $1 AND created_at < $3) AS back_mnt_today,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'refund' AND created_at >= $2 AND created_at < $3) AS back_mnt_week,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.transfer WHERE kind = 'refund') AS back_mnt_season,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE state = 'queued') AS receipts_queued,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE state = 'failed') AS receipts_failed,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.entry) AS drift`,
    [today, week, end, stuckBefore],
  );
  const r = rows[0]!;
  const n = (key: string) => Number(r[key]);
  const per = (key: string): PerPeriod => ({ today: n(`${key}_today`), week: n(`${key}_week`), season: n(`${key}_season`) });
  return {
    liabilityMnt: n('liability'),
    payableMnt: n('payable'),
    revenueMnt: n('revenue'),
    revenue: per('revenue'),
    topups: { pending: n('topup_pending'), stuck: n('topup_stuck'), settled: per('topup'), settledMnt: per('topup_mnt'), failed: per('topup_failed') },
    purchases: { count: per('buy'), mnt: per('buy_mnt') },
    refunds: { count: per('back'), mnt: per('back_mnt') },
    receipts: { queued: n('receipts_queued'), failed: n('receipts_failed') },
    drift: n('drift'),
  };
}
