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

export async function sessionsOf(guestId: string, token: string): Promise<DeviceSession[]> {
  const { rows } = await getPool().query<{
    id: string;
    label: string | null;
    created_at: Date;
    last_seen_at: Date | null;
    expires_at: Date;
    current: boolean;
  }>(
    `SELECT id, label, created_at, last_seen_at, expires_at,
            token_hash = $2 AS current
       FROM identity.guest_session
      WHERE guest_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY COALESCE(last_seen_at, created_at) DESC`,
    [guestId, sha256(token)],
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
              phone_e164 = 'closed:' || id::text
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
