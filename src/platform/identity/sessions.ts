import { createHash } from 'node:crypto';
import { getPool, tx } from '../../db/pool.js';

/**
 * Where somebody is signed in, and how they get out.
 *
 * A session list is not a feature until the day a phone is lost, and then it
 * is the only thing that matters. It exists so that day needs nobody's help:
 * no email, no support queue, no waiting for a token to expire sixty days from
 * now.
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface DeviceSession {
  id: string;
  /** What the phone called itself when it signed in. */
  label: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  /** The one asking. A list where you cannot tell is a list you dare not use. */
  current: boolean;
}

/** With no token — the desk looking in — nothing is `current`. */
export async function sessionsOf(guestId: string, token?: string): Promise<DeviceSession[]> {
  const { rows } = await getPool().query<{
    id: string;
    label: string | null;
    created_at: Date;
    last_seen_at: Date | null;
    expires_at: Date;
    current: boolean;
  }>(
    `SELECT id, label, created_at, last_seen_at, expires_at,
            token_hash = COALESCE($2, '') AS current
       FROM identity.guest_session
      WHERE guest_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY COALESCE(last_seen_at, created_at) DESC`,
    [guestId, token ? sha256(token) : null],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    current: r.current,
  }));
}

/** A session as a record names it: which device, and when it was signed in. */
export interface NamedSession {
  id: string;
  guestId: string;
  /** What the device called itself when it signed in. */
  label: string | null;
  signedInAt: Date;
}

/**
 * Sessions by their ids, for a record that names the one somebody acted
 * in — the desk's record of who did what. Ended ones too, signed out or
 * run out: the record outlives them, and a session's row is never deleted.
 */
export async function sessionsById(ids: readonly string[]): Promise<Map<string, NamedSession>> {
  if (ids.length === 0) return new Map();
  const { rows } = await getPool().query<{ id: string; guest_id: string; label: string | null; created_at: Date }>(
    `SELECT id, guest_id, label, created_at FROM identity.guest_session WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, guestId: r.guest_id, label: r.label, signedInAt: r.created_at }]));
}

/**
 * Sign out everywhere else.
 *
 * Everywhere *else* on purpose: somebody reaching for this has just realised a
 * phone is gone, and logging them out of the one in their hand mid-panic is
 * the wrong end of the tool.
 */
export async function revokeOtherSessions(
  guestId: string,
  token: string,
  at: Date,
): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE identity.guest_session SET revoked_at = $3
      WHERE guest_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
    [guestId, sha256(token), at],
  );
  return rowCount ?? 0;
}

export async function revokeSession(guestId: string, sessionId: string, at: Date): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE identity.guest_session SET revoked_at = $3
      WHERE guest_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [guestId, sessionId, at],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * When the session this token is was opened: the last time its person came
 * through a door. Null for a token that is not this account's, or no longer
 * open.
 */
export async function sessionOpenedAt(guestId: string, token: string): Promise<Date | null> {
  const { rows } = await getPool().query<{ created_at: Date }>(
    `SELECT created_at FROM identity.guest_session
      WHERE guest_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
    [guestId, sha256(token)],
  );
  return rows[0]?.created_at ?? null;
}

/**
 * Sign out here: the session this token is, and nothing else. A browser
 * that only forgets its token has not signed anybody out — the server would
 * still take that token from whoever copied it, out of a history, a stale
 * tab, a key the page no longer reads.
 */
export async function endSession(token: string, at: Date): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE identity.guest_session SET revoked_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token), at],
  );
  return (rowCount ?? 0) > 0;
}

/* ── leaving ───────────────────────────────────────────────────────── */

export class ClosureError extends Error {
  constructor(
    readonly code: 'HAS_BALANCE' | 'HAS_LIVE_WORK',
    message: string,
  ) {
    super(message);
    this.name = 'ClosureError';
  }
}

/**
 * Close the account.
 *
 * Erases the person and keeps the accounting, because the two have different
 * owners: the ledger is append-only evidence about money that has already
 * moved, and the tax receipts belong to the restaurant that sold the food as
 * much as to us. Both point at a `guest_id` that still exists and now names
 * nobody.
 *
 * The phone number is replaced rather than nulled — it is UNIQUE, and the same
 * number has to be free to open a new account tomorrow.
 *
 * Callers pass what they know about their own vertical. Identity cannot ask
 * dine whether this person has lunch on the fire, and should not learn how.
 */
export async function closeAccount(input: {
  guestId: string;
  at: Date;
  balanceMnt: number;
  liveWork: number;
}): Promise<void> {
  if (input.balanceMnt > 0) {
    throw new ClosureError('HAS_BALANCE', 'the wallet still holds money');
  }
  if (input.liveWork > 0) {
    throw new ClosureError('HAS_LIVE_WORK', 'something of theirs is still running');
  }

  await tx(async (client) => {
    await client.query(
      `UPDATE identity.guest
          SET closed_at = $2,
              name = NULL,
              phone_e164 = 'closed:' || id::text,
              -- Every way back in goes, so the address and the Google or Apple
              -- account are free to open a new account, and none of them can
              -- reopen this one.
              email = NULL,
              email_verified_at = NULL,
              google_sub = NULL,
              apple_sub = NULL,
              password_hash = NULL
        WHERE id = $1 AND closed_at IS NULL`,
      [input.guestId, input.at],
    );
    await client.query('DELETE FROM identity.profile WHERE guest_id = $1', [input.guestId]);
    await client.query(
      `UPDATE identity.guest_session SET revoked_at = $2
        WHERE guest_id = $1 AND revoked_at IS NULL`,
      [input.guestId, input.at],
    );
  });
}
