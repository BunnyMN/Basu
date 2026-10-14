import { getPool, tx, type Db } from '../db/pool.js';
import { payOut } from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { mode } from '../mode.js';
import { unseal } from '../secret.js';
import { IdeshError } from './errors.js';
import { dayOf } from './pricing.js';
import type { BankAccount } from './settlements.js';

/**
 * A supplier is paid once a day, not once an order.
 *
 * Every order's payout is still its own settlement — the ledger owes it on
 * its own key — but nobody transfers them one by one. When a day in
 * Ulaanbaatar is over, the payouts that fell due on it are gathered into a
 * batch per supplier: that day's earnings, one figure, one bank transfer.
 * The batch is what one member approves and another marks sent, with the
 * bank's one reference; marking it sent pays out every order in it.
 *
 * Refunds go to many different people and are not gathered.
 */

export type BatchState = 'due' | 'paid';

/** One order's share in a batch. */
export interface BatchLine {
  settlementId: string;
  orderId: string;
  orderCode: string;
  memo: string;
  amountMnt: number;
}

export interface PayoutBatch {
  id: string;
  supplier: { id: string; name: string };
  /** `YYYY-MM-DD`, the day in Ulaanbaatar the payouts fell due. */
  day: string;
  amountMnt: number;
  orders: number;
  state: BatchState;
  /** The supplier's account now: where the transfer goes. */
  bank: BankAccount | null;
  bankVerified: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  paidBy: string | null;
  paidAt: Date | null;
  reference: string | null;
  createdAt: Date;
  lines: BatchLine[];
}

/** The lock every gathering takes: two at once would gather the same payouts twice. */
const GATHER_LOCK = 'idesh.payout_batch.gather';

/**
 * Gather every payout owed from a day that is over into its supplier's batch
 * for that day. Run on every scheduler tick and before the desk reads the
 * list; cheap when there is nothing to gather, and safe to run at once from
 * two places. Returns how many batches it made.
 */
export async function gatherPayouts(now: Date): Promise<number> {
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [GATHER_LOCK]);
    const { rows } = await client.query<{ id: string }>(
      `WITH owed AS (
         SELECT t.id, t.supplier_id, t.amount_mnt,
                (t.created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date AS day
           FROM idesh.settlement t
          WHERE t.kind = 'payout' AND t.state = 'due' AND t.batch_id IS NULL AND t.supplier_id IS NOT NULL
            AND (t.created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date < $1::date
       ), made AS (
         INSERT INTO idesh.payout_batch (supplier_id, day, amount_mnt, orders, created_at)
         SELECT supplier_id, day, SUM(amount_mnt), COUNT(*), $2 FROM owed GROUP BY supplier_id, day
         RETURNING id, supplier_id, day
       )
       UPDATE idesh.settlement t SET batch_id = made.id
         FROM owed JOIN made ON made.supplier_id = owed.supplier_id AND made.day = owed.day
        WHERE t.id = owed.id
       RETURNING made.id`,
      [dayOf(now), now],
    );
    return new Set(rows.map((r) => r.id)).size;
  });
}

interface Row {
  id: string;
  supplier_id: string;
  supplier_name: string;
  day: string;
  amount_mnt: number;
  orders: number;
  state: BatchState;
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
  bank_verified: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  paid_by: string | null;
  paid_at: Date | null;
  reference: string | null;
  created_at: Date;
}

const SELECT = `
  SELECT b.id, b.supplier_id, s.name AS supplier_name, to_char(b.day, 'YYYY-MM-DD') AS day,
         b.amount_mnt, b.orders, b.state, s.bank_name, s.bank_account, s.bank_holder,
         (s.bank_verified_at IS NOT NULL) AS bank_verified,
         b.approved_by, b.approved_at, b.paid_by, b.paid_at, b.reference, b.created_at
    FROM idesh.payout_batch b
    JOIN idesh.supplier s ON s.id = b.supplier_id`;

async function shape(rows: Row[], db: Db): Promise<PayoutBatch[]> {
  if (!rows.length) return [];
  const { rows: lines } = await db.query<{
    batch_id: string;
    id: string;
    order_id: string;
    code: string;
    memo: string;
    amount_mnt: number;
  }>(
    `SELECT t.batch_id, t.id, t.order_id, o.code, t.memo, t.amount_mnt
       FROM idesh.settlement t JOIN idesh.idesh_order o ON o.id = t.order_id
      WHERE t.batch_id = ANY($1::uuid[])
      ORDER BY t.created_at`,
    [rows.map((r) => r.id)],
  );
  const byBatch = new Map<string, BatchLine[]>();
  for (const l of lines) {
    const list = byBatch.get(l.batch_id) ?? [];
    list.push({ settlementId: l.id, orderId: l.order_id, orderCode: l.code, memo: l.memo, amountMnt: Number(l.amount_mnt) });
    byBatch.set(l.batch_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    supplier: { id: r.supplier_id, name: r.supplier_name },
    day: r.day,
    amountMnt: Number(r.amount_mnt),
    orders: r.orders,
    state: r.state,
    bank:
      r.bank_name && r.bank_account && r.bank_holder
        ? { bankName: r.bank_name, bankAccount: unseal(r.bank_account)!, bankHolder: unseal(r.bank_holder)! }
        : null,
    bankVerified: r.bank_verified,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    paidBy: r.paid_by,
    paidAt: r.paid_at,
    reference: r.reference,
    createdAt: r.created_at,
    lines: byBatch.get(r.id) ?? [],
  }));
}

/** Every batch still to send, the oldest day first, then what was sent in the last 30 days. For the desk. */
export async function listBatches(db: Db = getPool()): Promise<PayoutBatch[]> {
  const { rows } = await db.query<Row>(
    `${SELECT}
      WHERE b.state = 'due' OR b.paid_at > now() - interval '30 days'
      ORDER BY (b.state = 'paid'), b.day, s.name`,
  );
  return shape(rows, db);
}

/** One supplier's batches, the latest day first: what Basu has sent them, a day at a time. */
export async function batchesOf(supplierId: string, db: Db = getPool()): Promise<PayoutBatch[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE b.supplier_id = $1 ORDER BY b.day DESC LIMIT 120`, [supplierId]);
  return shape(rows, db);
}

export async function batchById(id: string, db: Db = getPool()): Promise<PayoutBatch | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE b.id = $1`, [id]);
  return (await shape(rows, db))[0] ?? null;
}

/** What the paper and the money both need before anybody signs: an account, checked against the contract. */
function payable(b: PayoutBatch): void {
  if (b.state === 'paid') throw new IdeshError('WRONG_STATE', 'already paid');
  if (!b.bank) throw new IdeshError('NEEDS_ACCOUNT', 'the supplier has no account to send it to');
  if (!b.bankVerified) throw new IdeshError('BANK_UNVERIFIED', 'the account has not been checked against the contract');
}

/**
 * «Батлах» on a day's batch: this total should go to this account. The
 * person who approves it is not the one who sends it — see `markBatchPaid`.
 */
export async function approveBatch(id: string, by: string, now: Date): Promise<PayoutBatch> {
  const found = await batchById(id);
  if (!found) throw new IdeshError('NOT_FOUND', 'no such batch');
  payable(found);
  // The first approval stands; a second person's part is the transfer.
  if (found.approvedAt && found.approvedBy !== by) throw new IdeshError('WRONG_STATE', `already released by ${found.approvedBy}`);
  await getPool().query(
    `UPDATE idesh.payout_batch SET approved_by = $2, approved_at = $3 WHERE id = $1 AND state = 'due' AND approved_at IS NULL`,
    [id, by, now],
  );
  return (await batchById(id))!;
}

/**
 * «Шилжүүлсэн»: the day's total went out in one bank transfer. Every order
 * in the batch is paid out in the ledger on its own key — the same key a
 * single settlement would have used, so nothing is ever paid twice — the
 * batch and its settlements remember who sent it and the bank's reference,
 * and the supplier is told once, with the day and the total.
 */
export async function markBatchPaid(ctx: Ctx, id: string, by: string, reference: string): Promise<PayoutBatch> {
  const now = ctx.clock.now();
  const found = await batchById(id);
  if (!found) throw new IdeshError('NOT_FOUND', 'no such batch');
  payable(found);
  if (!found.approvedAt) throw new IdeshError('NOT_APPROVED', 'nobody has released this one yet');
  // The demo's desk is one shared identity; production holds the line.
  if (mode() === 'production' && found.approvedBy === by) {
    throw new IdeshError('SAME_PERSON', 'the person who released it cannot also send it');
  }
  const ref = reference.trim() || null;

  const paidOut = new Map<string, string>();
  for (const line of found.lines) {
    paidOut.set(
      line.settlementId,
      await payOut({
        payee: `supplier:${found.supplier.id}`,
        amountMnt: line.amountMnt,
        subject: 'idesh',
        subjectId: line.orderId,
        memo: `Идэш · ${line.memo} №${line.orderCode} · ${found.day} · ${ref ?? 'банк'}`,
        idempotencyKey: `idesh:settlement:${line.settlementId}:payout`,
      }),
    );
  }

  const moved = await tx(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE idesh.payout_batch SET state = 'paid', paid_by = $2, paid_at = $3, reference = $4
        WHERE id = $1 AND state = 'due'`,
      [id, by, now, ref],
    );
    if (!rowCount) return false;
    for (const [settlementId, transferId] of paidOut) {
      await client.query(
        `UPDATE idesh.settlement
            SET state = 'paid', paid_at = $2, paid_by = $3, reference = $4, ledger_payout_id = $5,
                approved_by = COALESCE(approved_by, $6), approved_at = COALESCE(approved_at, $7)
          WHERE id = $1 AND state <> 'paid'`,
        [settlementId, now, by, ref, transferId, found.approvedBy, found.approvedAt],
      );
    }
    return true;
  });
  if (!moved) throw new IdeshError('WRONG_STATE', 'already paid');

  const { rows: who } = await getPool().query<{ owner_guest_id: string | null }>(
    'SELECT owner_guest_id FROM idesh.supplier WHERE id = $1',
    [found.supplier.id],
  );
  const owner = who[0]?.owner_guest_id;
  if (owner) {
    const [, month, date] = found.day.split('-').map(Number);
    await enqueue(ctx, {
      guestId: owner,
      subject: 'payout',
      subjectId: found.id,
      template: 'supplier.paid',
      channel: 'sms',
      dedupeKey: `batch:${found.id}:paid`,
      title: 'Олголт шилжүүллээ',
      body: `Basu: ${month}-р сарын ${date}-ний ${found.orders} захиалгын олголт ${found.amountMnt.toLocaleString('mn-MN')}₮ данс руу тань шилжүүллээ.`,
    });
  }
  return (await batchById(id))!;
}
