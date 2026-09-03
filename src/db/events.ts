import type { Db } from './pool.js';

/**
 * The order's append-only stream. `UNIQUE (order_id, seq)` means a racing
 * writer gets a constraint violation rather than a silently reordered history,
 * which is the behaviour you want when the stream is your only evidence in a
 * dispute.
 */
export async function appendEvent(
  db: Db,
  orderId: string,
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO dine.order_event (order_id, seq, type, payload, actor)
     SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3::jsonb, $4
       FROM dine.order_event WHERE order_id = $1`,
    [orderId, type, JSON.stringify(payload), actor],
  );
}
