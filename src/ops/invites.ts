import { createHash, randomInt } from 'node:crypto';
import { getPool, tx, type Db } from '../db/pool.js';
import type { Role } from './members.js';

/**
 * Invites onto the desk.
 *
 * A code is ten digits — long enough that guessing one inside its day
 * through a rate-limited door is hopeless, short enough to read out over a
 * phone. It is shown once, to the admin who made it, and stored only as a
 * hash. Redeeming one is a single act: it is taken inside a transaction, so
 * two people cannot both use it, and handed back if the account step after
 * it fails.
 */

const TTL_HOURS = 24;

export class InviteError extends Error {
  constructor(readonly code: 'INVITE_INVALID', message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

export interface Invite {
  id: string;
  phone: string | null;
  role: Role | null;
  name: string | null;
  createdBy: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const hash = (code: string) => createHash('sha256').update(code.replace(/\D/g, '')).digest('hex');

/** Ten digits, grouped as the desk will read them out: «12345 67890». */
function freshCode(): string {
  const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join('');
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export async function createInvite(
  input: { phone?: string | null; role?: Role | null; name?: string | null; by: string; now: Date },
  db: Db = getPool(),
): Promise<{ invite: Invite; code: string }> {
  const phone = input.phone?.replace(/\s+/g, '') || null;
  if (phone && !/^\+976\d{8}$/.test(phone)) throw new Error('an invite’s phone is +976 and eight digits');
  const code = freshCode();
  const { rows } = await db.query<Row>(
    `INSERT INTO ops.invite (code_hash, phone, role, name, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, phone, role, name, created_by, expires_at, used_at`,
    [hash(code), phone, input.role ?? null, input.name?.trim() || null, input.by, input.now, new Date(input.now.getTime() + TTL_HOURS * 3600_000)],
  );
  return { invite: shape(rows[0]!), code };
}

/**
 * Take an invite for this phone, or refuse.
 *
 * Unknown, used, expired and bound-to-another-phone all answer the same, so
 * the door cannot be used to learn which codes exist.
 */
export async function takeInvite(code: string, phone: string, now: Date): Promise<Invite> {
  return tx(async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT id, phone, role, name, created_by, expires_at, used_at
         FROM ops.invite WHERE code_hash = $1 FOR UPDATE`,
      [hash(code)],
    );
    const found = rows[0];
    if (!found || found.used_at || found.expires_at <= now || (found.phone && found.phone !== phone)) {
      throw new InviteError('INVITE_INVALID', 'the invite is not valid');
    }
    await client.query('UPDATE ops.invite SET used_at = $2, used_by_phone = $3 WHERE id = $1', [found.id, now, phone]);
    return shape({ ...found, used_at: now });
  });
}

/** The account step after taking failed: the invite is still theirs to use. */
export async function releaseInvite(id: string): Promise<void> {
  await getPool().query('UPDATE ops.invite SET used_at = NULL, used_by_phone = NULL WHERE id = $1', [id]);
}

/** Open invites, newest first, for the members page. */
export async function openInvites(now: Date, db: Db = getPool()): Promise<Invite[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, phone, role, name, created_by, expires_at, used_at FROM ops.invite
      WHERE used_at IS NULL AND expires_at > $1 ORDER BY created_at DESC`,
    [now],
  );
  return rows.map(shape);
}

interface Row {
  id: string;
  phone: string | null;
  role: Role | null;
  name: string | null;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
}

const shape = (r: Row): Invite => ({
  id: r.id,
  phone: r.phone,
  role: r.role,
  name: r.name,
  createdBy: r.created_by,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
});
