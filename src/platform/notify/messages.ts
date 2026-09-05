import { getPool } from '../../db/pool.js';
import { contactsFor } from '../identity/index.js';
import type { Ctx } from '../../ports.js';
import { pushTokensFor } from './devices.js';

/**
 * Messages are written to a table first and sent afterwards.
 *
 * The dedupe key is the point: a retried relay, a re-planned order or a second
 * scheduler all collapse onto the same row, so a guest never gets the same
 * question twice. Four messages per order is the budget the unit economics
 * assume (§02 of the ops playbook).
 *
 * A message belongs to a *person*, not to an order. `subject`/`subject_id` say
 * what it was about in whatever language the sending module speaks; notify
 * stores those two strings and never interprets them, which is what lets a
 * second vertical send through here without touching this file.
 */

export interface OutgoingRequest {
  guestId: string;
  template: string;
  /** Shown as the heading in the in-app inbox; the SMS only carries the body. */
  title?: string;
  body: string;
  channel: 'push' | 'sms';
  /** What this is about, in the caller's own vocabulary — e.g. `order`. */
  subject?: string;
  subjectId?: string;
  /** Defaults to one message per template per subject. */
  dedupeKey?: string;
}

export async function enqueue(ctx: Ctx, req: OutgoingRequest): Promise<void> {
  void ctx;
  const key = req.dedupeKey ?? `${req.subjectId ?? req.guestId}:${req.template}`;
  await getPool().query(
    `INSERT INTO notify.message
       (guest_id, order_id, subject, subject_id, channel, template, dedupe_key, title, body, state)
     VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8, 'queued')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      req.guestId,
      req.subject === 'order' ? (req.subjectId ?? null) : null,
      req.subject ?? null,
      req.channel,
      req.template,
      key,
      req.title ?? null,
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
 *
 * Note what this no longer does — join its way to `dining_order` and `guest`
 * for a phone number. It asks identity for the contacts in one call, which is
 * the same shape the call will have when identity answers over HTTP.
 */
export async function relay(ctx: Ctx, limit = 100): Promise<number> {
  const { rows } = await getPool().query<{
    id: string;
    guest_id: string;
    channel: 'push' | 'sms';
    template: string;
    body: string;
  }>(
    `SELECT id, guest_id, channel, template, body
       FROM notify.message
      WHERE state = 'queued'
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return 0;

  const contacts = await contactsFor(rows.map((r) => r.guest_id));
  const prefs = await preferencesFor(rows.map((r) => r.guest_id));
  const pushable = await pushTokensFor(rows.map((r) => r.guest_id));

  let sent = 0;
  for (const row of rows) {
    const contact = contacts.get(row.guest_id);
    if (!contact) {
      // The person is gone. Nothing to retry, and a queued row that can never
      // drain is worse than one marked for what it is.
      await getPool().query(`UPDATE notify.message SET state = 'failed' WHERE id = $1`, [row.id]);
      continue;
    }

    const pref = prefs.get(row.guest_id) ?? { push: true, sms: true };
    const wanted: Array<'push' | 'sms'> = row.channel === 'sms' ? ['sms'] : ['push', 'sms'];
    const ladder = wanted.filter((c) =>
      c === 'push' ? pref.push && pushable.has(row.guest_id) : pref.sms,
    );

    const body = row.body || row.template;
    let ref: string | null = null;
    let channel: 'push' | 'sms' = row.channel;

    for (const attempt of ladder) {
      try {
        const result = await ctx.notifier.send({
          channel: attempt,
          to: attempt === 'push' ? (pushable.get(row.guest_id) ?? contact.phone) : contact.phone,
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
        `UPDATE notify.message SET state = 'sent', sent_at = $2, provider_ref = $3, channel = $4
          WHERE id = $1`,
        [row.id, ctx.clock.now(), ref, channel],
      );
    } else {
      await getPool().query(`UPDATE notify.message SET state = 'failed' WHERE id = $1`, [row.id]);
    }
  }
  return sent;
}

/** The guest replied to the T−15 message. */
export async function ack(subjectId: string, template: string, at: Date): Promise<void> {
  await getPool().query(
    `UPDATE notify.message SET state = 'acked', acked_at = $3
      WHERE subject_id = $1 AND template = $2`,
    [subjectId, template, at],
  );
}

/* ── the inbox ─────────────────────────────────────────────────────── */

export interface InboxItem {
  id: string;
  title: string | null;
  body: string;
  template: string;
  subject: string | null;
  subjectId: string | null;
  channel: 'push' | 'sms';
  state: string;
  createdAt: Date;
  readAt: Date | null;
}

/**
 * What the phone shows. Queued rows are included on purpose: from the guest's
 * side a message that exists is a message, and hiding it until an SMS gateway
 * has acknowledged it only makes the app look slower than it is.
 */
export async function inbox(guestId: string, limit = 50): Promise<InboxItem[]> {
  const { rows } = await getPool().query<{
    id: string;
    title: string | null;
    body: string;
    template: string;
    subject: string | null;
    subject_id: string | null;
    channel: 'push' | 'sms';
    state: string;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT id, title, body, template, subject, subject_id, channel, state, created_at, read_at
       FROM notify.message
      WHERE guest_id = $1 AND state <> 'failed' AND dismissed_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [guestId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    template: r.template,
    subject: r.subject,
    subjectId: r.subject_id,
    channel: r.channel,
    state: r.state,
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
}

export async function unreadCount(guestId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notify.message
      WHERE guest_id = $1 AND read_at IS NULL AND state <> 'failed' AND dismissed_at IS NULL`,
    [guestId],
  );
  return rows[0]?.n ?? 0;
}

/** `null` marks the whole inbox read — what tapping into the list means. */
export async function markRead(guestId: string, messageId: string | null, at: Date): Promise<void> {
  await getPool().query(
    `UPDATE notify.message SET read_at = $3
      WHERE guest_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)`,
    [guestId, messageId, at],
  );
}

/**
 * The swipe. The row leaves the inbox and stops counting as unread; the
 * message itself stays, because "we told you" has to remain true afterwards.
 * Returns whether there was anything of this guest's to dismiss.
 */
export async function dismiss(guestId: string, messageId: string, at: Date): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE notify.message SET dismissed_at = $3
      WHERE guest_id = $1 AND id = $2::uuid AND dismissed_at IS NULL`,
    [guestId, messageId, at],
  );
  return (rowCount ?? 0) > 0;
}

/* ── preferences ───────────────────────────────────────────────────── */

export interface Preferences {
  push: boolean;
  sms: boolean;
  marketing: boolean;
}

const DEFAULT_PREFERENCES: Preferences = { push: true, sms: true, marketing: false };

export async function preferences(guestId: string): Promise<Preferences> {
  const map = await preferencesFor([guestId]);
  return { ...DEFAULT_PREFERENCES, ...map.get(guestId) };
}

export async function setPreferences(
  guestId: string,
  edit: Partial<Preferences>,
  at: Date,
): Promise<Preferences> {
  await getPool().query(
    `INSERT INTO notify.preference (guest_id, push, sms, marketing, updated_at)
     VALUES ($1, COALESCE($2, true), COALESCE($3, true), COALESCE($4, false), $5)
     ON CONFLICT (guest_id) DO UPDATE
        SET push       = COALESCE($2, notify.preference.push),
            sms        = COALESCE($3, notify.preference.sms),
            marketing  = COALESCE($4, notify.preference.marketing),
            updated_at = $5`,
    [guestId, edit.push ?? null, edit.sms ?? null, edit.marketing ?? null, at],
  );
  return preferences(guestId);
}

async function preferencesFor(guestIds: readonly string[]): Promise<Map<string, Preferences>> {
  if (guestIds.length === 0) return new Map();
  const { rows } = await getPool().query<{
    guest_id: string;
    push: boolean;
    sms: boolean;
    marketing: boolean;
  }>(
    'SELECT guest_id, push, sms, marketing FROM notify.preference WHERE guest_id = ANY($1::uuid[])',
    [[...new Set(guestIds)]],
  );
  return new Map(rows.map((r) => [r.guest_id, { push: r.push, sms: r.sms, marketing: r.marketing }]));
}
