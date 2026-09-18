import { getPool } from '../../db/pool.js';

/**
 * Finding a person, for the desk.
 *
 * By phone or by name, because that is what a caller gives the desk. Closed
 * accounts are found too — "I closed my account, where did my refund go" is a
 * real call — but they come back without a name or a phone, as the closure
 * left them.
 */
export interface GuestCard {
  id: string;
  /** Null once the account is closed. */
  phone: string | null;
  name: string | null;
  joinedAt: Date;
  closedAt: Date | null;
}

type Row = { id: string; phone_e164: string; name: string | null; created_at: Date; closed_at: Date | null };

const card = (r: Row): GuestCard => ({
  id: r.id,
  phone: r.closed_at ? null : r.phone_e164,
  name: r.closed_at ? null : r.name,
  joinedAt: r.created_at,
  closedAt: r.closed_at,
});

export async function findGuests(q: string, limit = 50): Promise<GuestCard[]> {
  const text = q.trim();
  const digits = text.replace(/\D/g, '');
  const { rows } = await getPool().query<Row>(
    `SELECT id, phone_e164, name, created_at, closed_at
       FROM identity.guest
      WHERE ($1 = '' AND $2 = '')
         OR ($2 <> '' AND length($2) >= 4 AND phone_e164 LIKE '%' || $2 || '%')
         OR ($1 <> '' AND name ILIKE '%' || $1 || '%')
      ORDER BY created_at DESC
      LIMIT $3`,
    [text, digits, limit],
  );
  return rows.map(card);
}

export async function guestCard(guestId: string): Promise<GuestCard | null> {
  const { rows } = await getPool().query<Row>(
    'SELECT id, phone_e164, name, created_at, closed_at FROM identity.guest WHERE id = $1',
    [guestId],
  );
  return rows[0] ? card(rows[0]) : null;
}
