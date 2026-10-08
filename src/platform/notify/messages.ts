import { getPool } from '../../db/pool.js';
import { contactsFor } from '../identity/index.js';
import type { Ctx } from '../../ports.js';
import { pushTokensFor } from './devices.js';
import { actionFor, renderLetter } from '../../letter.js';
import { mode } from '../../mode.js';

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
  /**
   * What this is about, in the caller's own vocabulary — e.g. `order` — and
   * the id of that one thing: the app opens it from the inbox, the letter
   * links to it. An `idesh` message's id is always the order's.
   */
  subject?: string;
  subjectId?: string;
  /** Defaults to one message per template per subject. */
  dedupeKey?: string;
}

/**
 * A one-time code, once sent, is a secret with nothing to protect: it
 * expires in minutes and the row that carried it should not outlive the
 * day. Everything else in the inbox is the guest's to keep.
 */
export async function purgeCodes(now: Date): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM notify.message WHERE template = 'auth.otp' AND created_at < $1::timestamptz - interval '1 day'`,
    [now],
  );
  return rowCount ?? 0;
}

export async function enqueue(ctx: Ctx, req: OutgoingRequest): Promise<void> {
  void ctx;
  const key = req.dedupeKey ?? `${req.subjectId ?? req.guestId}:${req.template}`;
  await getPool().query(
    `INSERT INTO notify.message
       (guest_id, order_id, subject, subject_id, channel, template, dedupe_key, title, body, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      req.guestId,
      // The deprecated column only ever held a lunch's id; it keeps doing that
      // and no more. The subject's id goes in subject_id whatever the subject
      // is — it once took this lunch-only value too, which left every идэш
      // message with no order the app could open.
      req.subject === 'order' ? (req.subjectId ?? null) : null,
      req.subject ?? null,
      req.subjectId ?? null,
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
    channel: 'push' | 'sms' | 'email';
    template: string;
    title: string | null;
    body: string;
    subject: string | null;
    subject_id: string | null;
  }>(
    `SELECT id, guest_id, channel, template, title, body, subject, subject_id
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
  // The number on the app's icon goes with each push: everything the person has not read, the queued
  // ones of this pass already among them. It stays there until they have seen it.
  const unread = await unreadCounts([...new Set(rows.map((r) => r.guest_id))]);

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
    // Push first where the app can be reached; then email, which reaches
    // anybody who signed up with an address; the phone last, and only where
    // there is one. A message asked for as SMS (the ones that matter most:
    // «бэлэн», «замд», a cancel) goes by SMS first — but only where a real
    // gateway is behind it. Without one it went to the stand-in, which keeps
    // the message to itself: in production «бэлэн» was marked sent and reached
    // nobody, not even by push. So without a gateway it is pushed like the rest,
    // and production never counts the stand-in as a delivery.
    const smsIsReal = Boolean(ctx.smsGateway);
    const wanted: Array<'push' | 'email' | 'sms'> =
      row.channel === 'sms' && smsIsReal ? ['sms', 'push', 'email'] : ['push', 'email', 'sms'];
    const ladder = wanted.filter((c) =>
      c === 'push'
        ? pref.push && pushable.has(row.guest_id)
        : c === 'email'
          ? Boolean(contact.email && ctx.mailer)
          : pref.sms && Boolean(contact.phone) && (smsIsReal || mode() !== 'production'),
    );

    const body = row.body || row.template;
    let ref: string | null = null;
    let channel: 'push' | 'sms' | 'email' = row.channel;

    for (const attempt of ladder) {
      try {
        const result =
          attempt === 'email'
            ? await ctx.mailer!.send({
                to: contact.email!,
                subject: row.title ? `Basu · ${row.title}` : 'Basu',
                text: body,
                html: renderLetter({
                  preheader: body,
                  title: row.title ?? 'Basu',
                  paragraphs: [body],
                  action: actionFor(row.template, row.subject_id),
                }),
              })
            : await ctx.notifier.send({
                channel: attempt,
                to: attempt === 'push' ? (pushable.get(row.guest_id)?.token ?? contact.phone ?? '') : contact.phone!,
                template: row.template,
                body,
                ...(attempt === 'push'
                  ? {
                      badge: unread.get(row.guest_id) ?? 1,
                      // Which phone it is, and what an app that draws its own notification needs (Android).
                      ...(pushable.get(row.guest_id) ? { platform: pushable.get(row.guest_id)!.platform } : {}),
                      ...(row.title ? { title: row.title } : {}),
                      ...(row.subject ? { subject: row.subject } : {}),
                      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
                    }
                  : {}),
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

type InboxRow = {
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
};

const itemOf = (r: InboxRow): InboxItem => ({
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
});

/**
 * What the phone shows. Queued rows are included on purpose: from the guest's
 * side a message that exists is a message, and hiding it until an SMS gateway
 * has acknowledged it only makes the app look slower than it is.
 */
export async function inbox(guestId: string, limit = 50): Promise<InboxItem[]> {
  return (await inboxPage(guestId, { limit })).items;
}

export interface InboxPage {
  items: InboxItem[];
  /** The last message's id, to ask for the page after it; null at the end. */
  next: string | null;
}

/** The most a page holds, whatever is asked for. */
export const INBOX_PAGE_MAX = 100;

/**
 * One page of the inbox, newest first.
 *
 * Keyed on the last message the guest already has rather than an offset: a
 * message that arrives while they scroll lands at the top, and the page they
 * are reading neither shifts nor repeats a row. A cursor that is not one of
 * their messages finds nothing.
 */
export async function inboxPage(
  guestId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<InboxPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), INBOX_PAGE_MAX);
  const { rows } = await getPool().query<InboxRow>(
    `SELECT m.id, m.title, m.body, m.template, m.subject, m.subject_id, m.channel, m.state,
            m.created_at, m.read_at
       FROM notify.message m
      WHERE m.guest_id = $1 AND m.state <> 'failed' AND m.dismissed_at IS NULL
        AND ($3::uuid IS NULL OR (m.created_at, m.id) <
             (SELECT c.created_at, c.id FROM notify.message c WHERE c.id = $3 AND c.guest_id = $1))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    [guestId, limit + 1, opts.before ?? null],
  );
  const items = rows.slice(0, limit).map(itemOf);
  return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
}

export async function unreadCount(guestId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notify.message
      WHERE guest_id = $1 AND read_at IS NULL AND state <> 'failed' AND dismissed_at IS NULL`,
    [guestId],
  );
  return rows[0]?.n ?? 0;
}

/** Unread counts for several people at once, as `unreadCount` counts them. */
async function unreadCounts(guestIds: string[]): Promise<Map<string, number>> {
  if (guestIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ guest_id: string; n: number }>(
    `SELECT guest_id::text AS guest_id, count(*)::int AS n FROM notify.message
      WHERE guest_id::text = ANY($1::text[]) AND read_at IS NULL AND state <> 'failed' AND dismissed_at IS NULL
      GROUP BY guest_id`,
    [guestIds],
  );
  return new Map(rows.map((r) => [r.guest_id, r.n]));
}

/**
 * What a person has not yet seen about each thing of one kind — `idesh`, `order` — by its id: the
 * dot on an order in the app, there until the order is opened.
 */
export async function unreadBySubject(guestId: string, subject: string): Promise<Map<string, number>> {
  const { rows } = await getPool().query<{ subject_id: string; n: number }>(
    `SELECT subject_id::text AS subject_id, count(*)::int AS n FROM notify.message
      WHERE guest_id = $1 AND subject = $2 AND subject_id IS NOT NULL
        AND read_at IS NULL AND state <> 'failed' AND dismissed_at IS NULL
      GROUP BY subject_id`,
    [guestId, subject],
  );
  return new Map(rows.map((r) => [r.subject_id, r.n]));
}

/** The order was opened: everything said about it counts as seen. */
export async function markSubjectRead(guestId: string, subject: string, subjectId: string, at: Date): Promise<void> {
  await getPool().query(
    `UPDATE notify.message SET read_at = $4
      WHERE guest_id = $1 AND subject = $2 AND subject_id::text = $3 AND read_at IS NULL`,
    [guestId, subject, subjectId, at],
  );
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
