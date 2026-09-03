import { getPool } from '../../db/pool.js';
import type { Ctx } from '../../ports.js';

/**
 * Мongolian tax receipts, queued rather than inline.
 *
 * Issuing a receipt is a legal obligation, but it is not on the critical path
 * of feeding anyone. If the tax API is down the ticket still cooks and the
 * receipt catches up; what must never happen is an order blocked, or a
 * captured payment with no receipt and nobody noticing. Hence the queue, the
 * bounded retries, and the end-of-day reconciliation below.
 */

const MAX_ATTEMPTS = 12;

export interface ReceiptRequest {
  /** The movement this receipt is for, from `collect` or `refund`. */
  transferId: string;
  kind: 'SALE' | 'RETURN';
  /** The seller of record. The restaurant's TIN, never the platform's. */
  merchantTin: string;
  /** What the customer will look for on the receipt — the order's code. */
  orderCode: string;
  amountMnt: number;
}

/**
 * Queue one receipt per movement.
 *
 * The caller supplies the four facts rather than this module joining its way
 * to them: a receipt is a record of a moment, and it has to keep saying what
 * was true then even after the restaurant changes its name or its TIN.
 */
export async function queueReceipt(req: ReceiptRequest): Promise<void> {
  await getPool().query(
    `INSERT INTO ledger.ebarimt_receipt
       (transfer_id, kind, merchant_tin, order_code, amount_mnt, state)
     VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [req.transferId, req.kind, req.merchantTin, req.orderCode, req.amountMnt],
  );
}

export async function processReceipts(ctx: Ctx, limit = 50): Promise<{ issued: number; failed: number }> {
  const { rows } = await getPool().query<{
    id: string;
    kind: 'SALE' | 'RETURN';
    amount_mnt: number;
    attempts: number;
    code: string;
    tin: string | null;
  }>(
    `SELECT e.id, e.kind, e.amount_mnt, e.attempts, e.order_code AS code, e.merchant_tin AS tin
       FROM ledger.ebarimt_receipt e
      WHERE e.state = 'queued' AND e.attempts < $2
      ORDER BY e.created_at
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  );

  let issued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const receipt = await ctx.tax.issue({
        // The restaurant is the seller of record, not the platform.
        merchantTin: row.tin ?? 'UNSET',
        orderCode: row.code,
        amountMnt: row.amount_mnt,
        kind: row.kind,
      });
      await getPool().query(
        `UPDATE ledger.ebarimt_receipt
            SET state = 'issued', bill_id = $2, lottery = $3, ddtd = $4,
                qr_payload = $5, issued_at = $6, attempts = attempts + 1
          WHERE id = $1`,
        [row.id, receipt.billId, receipt.lottery, receipt.ddtd, receipt.qrPayload, ctx.clock.now()],
      );
      issued++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await getPool().query(
        `UPDATE ledger.ebarimt_receipt
            SET attempts = $2::int, last_error = $3,
                state = CASE WHEN $2::int >= $4::int THEN 'failed' ELSE 'queued' END
          WHERE id = $1`,
        [row.id, attempts, (error as Error).message.slice(0, 500), MAX_ATTEMPTS],
      );
      failed++;
    }
  }
  return { issued, failed };
}

/**
 * The 23:30 reconciliation from the technical spec: every purchase must have a
 * receipt. A non-zero gap is a morning ops task, not a silent hole.
 */
export async function reconcile(): Promise<{ captured: number; issued: number; gap: number }> {
  const { rows } = await getPool().query<{ captured: number; issued: number }>(
    `SELECT
       (SELECT count(*)::int FROM ledger.transfer WHERE kind = 'purchase') AS captured,
       (SELECT count(*)::int FROM ledger.ebarimt_receipt WHERE kind = 'SALE' AND state = 'issued') AS issued`,
  );
  const captured = rows[0]?.captured ?? 0;
  const issued = rows[0]?.issued ?? 0;
  return { captured, issued, gap: captured - issued };
}

export interface IssuedReceipt {
  lottery: string | null;
  qrPayload: string | null;
}

/**
 * The receipt for one movement, if the tax authority has issued it yet.
 *
 * Callers hold a transfer id and nothing else — they cannot see a payment, a
 * receipt row or the queue behind it, which is what lets all three change
 * shape without a single vertical noticing.
 */
export async function receiptsFor(
  transferIds: readonly string[],
): Promise<Map<string, IssuedReceipt>> {
  if (transferIds.length === 0) return new Map();
  const { rows } = await getPool().query<{
    transfer_id: string;
    lottery: string | null;
    qr_payload: string | null;
  }>(
    `SELECT transfer_id, lottery, qr_payload
       FROM ledger.ebarimt_receipt
      WHERE transfer_id = ANY($1::uuid[]) AND kind = 'SALE' AND state = 'issued'`,
    [[...new Set(transferIds)]],
  );
  return new Map(
    rows.map((r) => [r.transfer_id, { lottery: r.lottery, qrPayload: r.qr_payload }]),
  );
}
