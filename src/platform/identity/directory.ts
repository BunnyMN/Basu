import { getPool } from '../../db/pool.js';
import { phoneE164 } from './register.js';

/**
 * Finding a person, for the desk.
 *
 * By phone, email or name, because that is what a caller gives the desk. Closed
 * accounts are found too — "I closed my account, where did my refund go" is a
 * real call — but they come back without a name or a phone, as the closure
 * left them.
 */
export interface GuestCard {
  id: string;
  /** Null once the account is closed, or for an account made without one. */
  phone: string | null;
  email: string | null;
  /** How the person gets in: 'phone', 'email', 'google', 'apple' — any of them. */
  ways: string[];
  name: string | null;
  joinedAt: Date;
  closedAt: Date | null;
}

type Row = {
  id: string;
  phone_e164: string | null;
  email: string | null;
  google_sub: string | null;
  apple_sub: string | null;
  name: string | null;
  created_at: Date;
  closed_at: Date | null;
};

const COLUMNS = 'id, phone_e164, email, google_sub, apple_sub, name, created_at, closed_at';

const card = (r: Row): GuestCard => ({
  id: r.id,
  phone: r.closed_at ? null : r.phone_e164,
  email: r.closed_at ? null : r.email,
  ways: r.closed_at
    ? []
    : [r.phone_e164 && 'phone', r.email && 'email', r.google_sub && 'google', r.apple_sub && 'apple'].filter(
        (w): w is string => Boolean(w),
      ),
  name: r.closed_at ? null : r.name,
  joinedAt: r.created_at,
  closedAt: r.closed_at,
});

export async function findGuests(q: string, limit = 50): Promise<GuestCard[]> {
  const text = q.trim();
  const digits = text.replace(/\D/g, '');
  const { rows } = await getPool().query<Row>(
    `SELECT ${COLUMNS}
       FROM identity.guest
      WHERE ($1 = '' AND $2 = '')
         OR ($2 <> '' AND length($2) >= 4 AND phone_e164 LIKE '%' || $2 || '%')
         OR ($1 <> '' AND name ILIKE '%' || $1 || '%')
         OR ($1 <> '' AND position('@' in $1) > 0 AND lower(email) LIKE '%' || lower($1) || '%')
         OR ($1 <> '' AND length($1) >= 3 AND lower(email) LIKE lower($1) || '%')
      ORDER BY created_at DESC
      LIMIT $3`,
    [text, digits, limit],
  );
  return rows.map(card);
}

export async function guestCard(guestId: string): Promise<GuestCard | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM identity.guest WHERE id = $1`,
    [guestId],
  );
  return rows[0] ? card(rows[0]) : null;
}

/**
 * The account behind a phone number or an email address, exactly — for a
 * manager adding somebody they work with, who says «I signed in with this».
 * Only open accounts; nothing for a partial match, so it cannot be used to
 * browse who is on Basu.
 */
export async function accountByContact(
  raw: string,
): Promise<{ guestId: string; name: string | null; phone: string | null; email: string | null } | null> {
  const typed = raw.trim();
  if (!typed) return null;
  const byEmail = typed.includes('@');
  const value = byEmail ? typed.toLowerCase() : phoneE164(typed);
  const { rows } = await getPool().query<{ id: string; name: string | null; phone_e164: string | null; email: string | null }>(
    `SELECT g.id, COALESCE(p.display_name, g.name) AS name, g.phone_e164, g.email
       FROM identity.guest g
       LEFT JOIN identity.profile p ON p.guest_id = g.id
      WHERE g.closed_at IS NULL AND ${byEmail ? 'lower(g.email) = $1' : 'g.phone_e164 = $1'}`,
    [value],
  );
  const r = rows[0];
  return r ? { guestId: r.id, name: r.name, phone: r.phone_e164, email: r.email } : null;
}
