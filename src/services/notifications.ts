import { getPool } from '../db/pool.js';
import type { Ctx } from '../ports.js';

/**
 * Messages are written to a table first and sent afterwards.
 *
 * The dedupe key is the point: a retried relay, a re-planned order or a second
 * scheduler all collapse onto the same row, so a guest never gets the same
 * question twice. Four messages per order is the budget the unit economics
 * assume (§02 of the ops playbook).
 */

export interface NotificationRequest {
  orderId: string;
  template: string;
  body: string;
  channel: 'push' | 'sms';
  /** Defaults to one message per template per order. */
  dedupeKey?: string;
}

export async function enqueueNotification(ctx: Ctx, req: NotificationRequest): Promise<void> {
  void ctx;
  await getPool().query(
    `INSERT INTO notification (order_id, channel, template, dedupe_key, body, state)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      req.orderId,
      req.channel,
      req.template,
      req.dedupeKey ?? `${req.orderId}:${req.template}`,
      req.body,
    ],
  );
}

/**
 * Push first where we have it, SMS when push is unavailable or fails.
 *
 * A message that cannot be delivered is not a silent loss: the planner reads
 * `arrival.arm` acknowledgement rates, and an unsent arm means the order falls
 * back to confirm-fire rather than being fired on a guess.
 */
export async function relayNotifications(ctx: Ctx, limit = 100): Promise<number> {
  const { rows } = await getPool().query<{
    id: string;
    order_id: string;
    channel: 'push' | 'sms';
    template: string;
    dedupe_key: string;
    body: string;
    phone: string;
  }>(
    `SELECT n.id, n.order_id, n.channel, n.template, n.dedupe_key, n.body, g.phone_e164 AS phone
       FROM notification n
       JOIN dining_order o ON o.id = n.order_id
       JOIN guest g ON g.id = o.guest_id
      WHERE n.state = 'queued'
      ORDER BY n.created_at
      LIMIT $1`,
    [limit],
  );

  let sent = 0;
  for (const row of rows) {
    const body = row.body || row.template;
    const attempts: Array<'push' | 'sms'> = row.channel === 'sms' ? ['sms'] : ['push', 'sms'];
    let ref: string | null = null;
    let channel: 'push' | 'sms' = row.channel;

    for (const attempt of attempts) {
      try {
        const result = await ctx.notifier.send({
          channel: attempt,
          to: row.phone,
          template: row.template,
          body,
        });
        ref = result.providerRef;
        channel = attempt;
        break;
      } catch {
        // fall through to the next channel
      }
    }

    if (ref) {
      sent++;
      await getPool().query(
        `UPDATE notification SET state = 'sent', sent_at = $2, provider_ref = $3, channel = $4
          WHERE id = $1`,
        [row.id, ctx.clock.now(), ref, channel],
      );
    } else {
      await getPool().query(`UPDATE notification SET state = 'failed' WHERE id = $1`, [row.id]);
    }
  }
  return sent;
}

/** The guest replied to the T−15 message. */
export async function ackNotification(orderId: string, template: string, at: Date): Promise<void> {
  await getPool().query(
    `UPDATE notification SET state = 'acked', acked_at = $3
      WHERE order_id = $1 AND template = $2`,
    [orderId, template, at],
  );
}
