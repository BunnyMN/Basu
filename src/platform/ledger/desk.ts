import { getPool } from '../../db/pool.js';

/**
 * The books, as the desk reads them.
 *
 * Balances by account, every movement with where it came from and went, the
 * top-ups QPay owes us an answer on, and the receipts the tax authority has
 * or has not issued. Nothing here writes; the two things the desk can do to
 * the ledger — run the checks, retry a receipt — live beside the code that
 * knows how.
 */

export interface DeskAccount {
  id: string;
  kind: string;
  label: string | null;
  balanceMnt: number;
  entries: number;
  lastAt: Date | null;
}

/** Every named account, and the guest wallets folded into one line. */
export async function accountsForDesk(): Promise<{ named: DeskAccount[]; wallets: { count: number; balanceMnt: number; holding: number } }> {
  const db = getPool();
  const [{ rows: named }, { rows: wallets }] = await Promise.all([
    db.query<{ id: string; kind: string; label: string | null; balance: string; entries: number; last_at: Date | null }>(
      `SELECT a.id, a.kind, a.label,
              COALESCE(sum(e.amount_mnt), 0) AS balance, count(e.id)::int AS entries, max(e.created_at) AS last_at
         FROM ledger.account a
         LEFT JOIN ledger.entry e ON e.account_id = a.id
        WHERE a.kind <> 'guest'
        GROUP BY a.id
        ORDER BY a.kind, a.label`,
    ),
    db.query<{ count: number; balance: string; holding: number }>(
      `SELECT count(*)::int AS count, COALESCE(sum(b.balance), 0) AS balance, count(*) FILTER (WHERE b.balance > 0)::int AS holding
         FROM (SELECT a.id, COALESCE(sum(e.amount_mnt), 0) AS balance
                 FROM ledger.account a LEFT JOIN ledger.entry e ON e.account_id = a.id
                WHERE a.kind = 'guest' GROUP BY a.id) b`,
    ),
  ]);
  return {
    named: named.map((r) => ({ id: r.id, kind: r.kind, label: r.label, balanceMnt: Number(r.balance), entries: r.entries, lastAt: r.last_at })),
    wallets: { count: wallets[0]?.count ?? 0, balanceMnt: Number(wallets[0]?.balance ?? 0), holding: wallets[0]?.holding ?? 0 },
  };
}

export interface DeskTransfer {
  id: string;
  kind: string;
  amountMnt: number;
  subject: string | null;
  subjectId: string | null;
  memo: string | null;
  /** The account the money left, and the one it reached: a label, or `guest:<id>` for a wallet. */
  from: string;
  to: string;
  at: Date;
}

export interface TransferFilter {
  kind?: string | undefined;
  /** `YYYY-MM-DD`, inclusive, in Ulaanbaatar. */
  from?: string | undefined;
  to?: string | undefined;
  /** A wallet's owner, to see one person's movements. */
  guestId?: string | undefined;
  limit?: number | undefined;
}

export async function transfersForDesk(filter: TransferFilter = {}): Promise<DeskTransfer[]> {
  const { rows } = await getPool().query<{
    id: string;
    kind: string;
    amount_mnt: string;
    subject: string | null;
    subject_id: string | null;
    memo: string | null;
    created_at: Date;
    from_side: string;
    to_side: string;
  }>(
    `SELECT t.id, t.kind, t.amount_mnt, t.subject, t.subject_id, t.memo, t.created_at,
            (SELECT COALESCE(a.label, 'guest:' || a.owner_id::text) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
              WHERE e.transfer_id = t.id AND e.amount_mnt < 0 ORDER BY e.amount_mnt LIMIT 1) AS from_side,
            (SELECT COALESCE(a.label, 'guest:' || a.owner_id::text) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
              WHERE e.transfer_id = t.id AND e.amount_mnt > 0 ORDER BY e.amount_mnt DESC LIMIT 1) AS to_side
       FROM ledger.transfer t
      WHERE ($1::text IS NULL OR t.kind = $1)
        AND ($2::date IS NULL OR (t.created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date >= $2::date)
        AND ($3::date IS NULL OR (t.created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date <= $3::date)
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id
                                          WHERE e.transfer_id = t.id AND a.owner_id = $4::uuid))
      ORDER BY t.created_at DESC
      LIMIT $5`,
    [filter.kind ?? null, filter.from ?? null, filter.to ?? null, filter.guestId ?? null, Math.min(filter.limit ?? 200, 5000)],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountMnt: Number(r.amount_mnt),
    subject: r.subject,
    subjectId: r.subject_id,
    memo: r.memo,
    from: r.from_side,
    to: r.to_side,
    at: r.created_at,
  }));
}

export interface DeskTopup {
  id: string;
  guestId: string;
  amountMnt: number;
  provider: string;
  providerRef: string | null;
  state: string;
  createdAt: Date;
  settledAt: Date | null;
}

export async function topupsForDesk(filter: { state?: string | undefined; from?: string | undefined; to?: string | undefined; limit?: number | undefined } = {}): Promise<DeskTopup[]> {
  const { rows } = await getPool().query<{
    id: string;
    guest_id: string;
    amount_mnt: string;
    provider: string;
    provider_ref: string | null;
    state: string;
    created_at: Date;
    settled_at: Date | null;
  }>(
    `SELECT id, guest_id, amount_mnt, provider, provider_ref, state, created_at, settled_at
       FROM ledger.topup
      WHERE ($1::text IS NULL OR state = $1)
        AND ($2::date IS NULL OR (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date >= $2::date)
        AND ($3::date IS NULL OR (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date <= $3::date)
      ORDER BY created_at DESC
      LIMIT $4`,
    [filter.state ?? null, filter.from ?? null, filter.to ?? null, Math.min(filter.limit ?? 200, 5000)],
  );
  return rows.map((r) => ({
    id: r.id,
    guestId: r.guest_id,
    amountMnt: Number(r.amount_mnt),
    provider: r.provider,
    providerRef: r.provider_ref,
    state: r.state,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  }));
}

export interface DeskReceipt {
  id: string;
  kind: string;
  state: string;
  orderCode: string | null;
  merchantTin: string | null;
  amountMnt: number;
  attempts: number;
  lastError: string | null;
  billId: string | null;
  lottery: string | null;
  issuedAt: Date | null;
  createdAt: Date;
}

export async function receiptsForDesk(state?: string, limit = 200): Promise<DeskReceipt[]> {
  const { rows } = await getPool().query<{
    id: string;
    kind: string;
    state: string;
    order_code: string | null;
    merchant_tin: string | null;
    amount_mnt: string | null;
    attempts: number;
    last_error: string | null;
    bill_id: string | null;
    lottery: string | null;
    issued_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, kind, state, order_code, merchant_tin, amount_mnt, attempts, last_error, bill_id, lottery, issued_at, created_at
       FROM ledger.ebarimt_receipt
      WHERE $1::text IS NULL OR state = $1
      ORDER BY (state = 'failed') DESC, (state = 'queued') DESC, created_at DESC
      LIMIT $2`,
    [state ?? null, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    orderCode: r.order_code,
    merchantTin: r.merchant_tin,
    amountMnt: Number(r.amount_mnt ?? 0),
    attempts: r.attempts,
    lastError: r.last_error,
    billId: r.bill_id,
    lottery: r.lottery,
    issuedAt: r.issued_at,
    createdAt: r.created_at,
  }));
}

/** A failed receipt, back in the queue with its attempts forgiven. */
export async function retryReceipt(receiptId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE ledger.ebarimt_receipt SET state = 'queued', attempts = 0, last_error = NULL WHERE id = $1 AND state = 'failed'`,
    [receiptId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The three checks finance runs before believing a number.
 *
 * Every tugrik is somewhere (the entries sum to zero); what QPay has sent us
 * is what the clearing account says it did; what left by bank transfer is
 * what the outbound account says left. The two `pending` counts are the
 * money that is neither here nor there yet.
 */
export interface Reconciliation {
  drift: number;
  accounts: number;
  qpay: { settledMnt: number; clearingMnt: number; gapMnt: number; pending: number; stuck: number };
  bank: { outMnt: number };
  wallets: { liabilityMnt: number; payableMnt: number };
  receipts: { queued: number; issued: number; failed: number; purchases: number; gap: number };
}

export async function reconciliationForDesk(now: Date): Promise<Reconciliation> {
  const stuckBefore = new Date(now.getTime() - 30 * 60 * 1000);
  const { rows } = await getPool().query<Record<string, string | number>>(
    `SELECT
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.entry) AS drift,
       (SELECT count(*)::int FROM ledger.account) AS accounts,
       (SELECT COALESCE(sum(amount_mnt), 0) FROM ledger.topup WHERE state = 'settled') AS settled,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.label = 'qpay:clearing') AS clearing,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'pending') AS pending,
       (SELECT count(*)::int FROM ledger.topup WHERE state = 'pending' AND created_at < $1) AS stuck,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.label = 'bank:out') AS bank_out,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.kind = 'guest') AS liability,
       (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e JOIN ledger.account a ON a.id = e.account_id WHERE a.kind = 'payable') AS payable,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE state = 'queued') AS r_queued,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE state = 'issued') AS r_issued,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE state = 'failed') AS r_failed,
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'purchase') AS purchases,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE kind = 'SALE' AND state = 'issued') AS sales_issued`,
    [stuckBefore],
  );
  const r = rows[0]!;
  const n = (k: string) => Number(r[k]);
  // Money QPay sent us lands in the clearing account as a debit (it left QPay's side), so the two agree when they cancel.
  return {
    drift: n('drift'),
    accounts: n('accounts'),
    qpay: { settledMnt: n('settled'), clearingMnt: n('clearing'), gapMnt: n('settled') + n('clearing'), pending: n('pending'), stuck: n('stuck') },
    bank: { outMnt: n('bank_out') },
    wallets: { liabilityMnt: n('liability'), payableMnt: n('payable') },
    receipts: { queued: n('r_queued'), issued: n('r_issued'), failed: n('r_failed'), purchases: n('purchases'), gap: n('purchases') - n('sales_issued') },
  };
}
