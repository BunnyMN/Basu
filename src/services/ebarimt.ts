import { getPool } from '../db/pool.js';
import type { Ctx } from '../ports.js';

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

export async function queueReceipt(orderId: string, kind: 'SALE' | 'RETURN'): Promise<void> {
  await getPool().query(
    `INSERT INTO ebarimt_receipt (payment_id, kind, state)
     SELECT id, $2, 'queued' FROM payment
      WHERE order_id = $1 AND state IN ('captured','refunded')`,
    [orderId, kind],
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
    `SELECT e.id, e.kind, p.amount_mnt, e.attempts, o.code, r.ebarimt_merchant_tin AS tin
       FROM ebarimt_receipt e
       JOIN payment p ON p.id = e.payment_id
       JOIN dining_order o ON o.id = p.order_id
       JOIN restaurant r ON r.id = o.restaurant_id
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
        `UPDATE ebarimt_receipt
            SET state = 'issued', bill_id = $2, lottery = $3, ddtd = $4,
                qr_payload = $5, issued_at = $6, attempts = attempts + 1
          WHERE id = $1`,
        [row.id, receipt.billId, receipt.lottery, receipt.ddtd, receipt.qrPayload, ctx.clock.now()],
      );
      issued++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await getPool().query(
        `UPDATE ebarimt_receipt
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
 * The 23:30 reconciliation from the technical spec: every captured payment
 * must have a receipt. A non-zero gap is a morning ops task, not a silent hole.
 */
export async function reconcile(): Promise<{ captured: number; issued: number; gap: number }> {
  const { rows } = await getPool().query<{ captured: number; issued: number }>(
    `SELECT
       (SELECT count(*)::int FROM payment WHERE state = 'captured') AS captured,
       (SELECT count(*)::int FROM ebarimt_receipt WHERE kind = 'SALE' AND state = 'issued') AS issued`,
  );
  const captured = rows[0]?.captured ?? 0;
  const issued = rows[0]?.issued ?? 0;
  return { captured, issued, gap: captured - issued };
}
