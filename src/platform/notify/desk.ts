import { getPool } from '../../db/pool.js';

/**
 * What we told people, as the desk reads it: the log, the pulse of each
 * channel, and the month's volume for the bill.
 */

export interface DeskMessage {
  id: string;
  guestId: string;
  channel: 'push' | 'sms';
  template: string;
  title: string | null;
  body: string;
  subject: string | null;
  subjectId: string | null;
  state: string;
  createdAt: Date;
  sentAt: Date | null;
  readAt: Date | null;
  providerRef: string | null;
}

export interface MessageFilter {
  state?: string | undefined;
  channel?: string | undefined;
  template?: string | undefined;
  guestIds?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export async function messagesForDesk(filter: MessageFilter = {}): Promise<DeskMessage[]> {
  const { rows } = await getPool().query<{
    id: string;
    guest_id: string;
    channel: 'push' | 'sms';
    template: string;
    title: string | null;
    body: string;
    subject: string | null;
    subject_id: string | null;
    state: string;
    created_at: Date;
    sent_at: Date | null;
    read_at: Date | null;
    provider_ref: string | null;
  }>(
    `SELECT id, guest_id, channel, template, title, body, subject, subject_id, state, created_at, sent_at, read_at, provider_ref
       FROM notify.message
      WHERE ($1::text IS NULL OR state = $1)
        AND ($2::text IS NULL OR channel = $2)
        AND ($3::text IS NULL OR template = $3)
        AND ($4::uuid[] IS NULL OR guest_id = ANY($4::uuid[]))
        AND ($5::date IS NULL OR (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date >= $5::date)
        AND ($6::date IS NULL OR (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date <= $6::date)
      ORDER BY created_at DESC
      LIMIT $7`,
    [filter.state ?? null, filter.channel ?? null, filter.template ?? null, filter.guestIds ?? null, filter.from ?? null, filter.to ?? null, Math.min(filter.limit ?? 200, 2000)],
  );
  return rows.map((r) => ({
    id: r.id,
    guestId: r.guest_id,
    channel: r.channel,
    template: r.template,
    title: r.title,
    body: r.body,
    subject: r.subject,
    subjectId: r.subject_id,
    state: r.state,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    readAt: r.read_at,
    providerRef: r.provider_ref,
  }));
}

/** A failed message, back in the queue: the relay tries the channels again on its next pass. */
export async function retryMessage(messageId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`UPDATE notify.message SET state = 'queued' WHERE id = $1 AND state = 'failed'`, [messageId]);
  return (rowCount ?? 0) > 0;
}

export interface ChannelPulse {
  channel: 'push' | 'sms';
  lastSentAt: Date | null;
  sentDay: number;
  failedDay: number;
  queued: number;
}

export async function channelPulse(now: Date): Promise<ChannelPulse[]> {
  const { rows } = await getPool().query<{ channel: 'push' | 'sms'; last_sent_at: Date | null; sent_day: number; failed_day: number; queued: number }>(
    `SELECT c.channel,
            (SELECT max(sent_at) FROM notify.message m WHERE m.channel = c.channel AND m.state IN ('sent', 'acked')) AS last_sent_at,
            (SELECT count(*)::int FROM notify.message m WHERE m.channel = c.channel AND m.state IN ('sent', 'acked') AND m.sent_at > $1::timestamptz - interval '24 hours') AS sent_day,
            (SELECT count(*)::int FROM notify.message m WHERE m.channel = c.channel AND m.state = 'failed' AND m.created_at > $1::timestamptz - interval '24 hours') AS failed_day,
            (SELECT count(*)::int FROM notify.message m WHERE m.channel = c.channel AND m.state = 'queued') AS queued
       FROM (VALUES ('push'), ('sms')) AS c(channel)`,
    [now],
  );
  return rows.map((r) => ({ channel: r.channel, lastSentAt: r.last_sent_at, sentDay: r.sent_day, failedDay: r.failed_day, queued: r.queued }));
}

export interface MonthVolume {
  /** `YYYY-MM` in Ulaanbaatar. */
  month: string;
  sms: { sent: number; failed: number };
  push: { sent: number; failed: number };
}

export async function monthlyVolume(months = 6): Promise<MonthVolume[]> {
  const { rows } = await getPool().query<{ month: string; sms_sent: number; sms_failed: number; push_sent: number; push_failed: number }>(
    `SELECT to_char(created_at AT TIME ZONE 'Asia/Ulaanbaatar', 'YYYY-MM') AS month,
            count(*) FILTER (WHERE channel = 'sms' AND state IN ('sent', 'acked'))::int AS sms_sent,
            count(*) FILTER (WHERE channel = 'sms' AND state = 'failed')::int AS sms_failed,
            count(*) FILTER (WHERE channel = 'push' AND state IN ('sent', 'acked'))::int AS push_sent,
            count(*) FILTER (WHERE channel = 'push' AND state = 'failed')::int AS push_failed
       FROM notify.message
      GROUP BY 1 ORDER BY 1 DESC LIMIT $1`,
    [months],
  );
  return rows.map((r) => ({ month: r.month, sms: { sent: r.sms_sent, failed: r.sms_failed }, push: { sent: r.push_sent, failed: r.push_failed } }));
}
