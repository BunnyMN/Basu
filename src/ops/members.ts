import { getPool, tx, type Db } from '../db/pool.js';
import { ensureRoles, roleOf } from '../platform/access/index.js';

/**
 * The people at the desk.
 *
 * A member is a name and a role, named by a phone number, an email address,
 * or both. What makes a session ops is that its account is linked to an
 * active member — and an account is linked only by proof: an admin saying
 * yes to the seat that account asked for, a phone number an SMS code
 * reached, or an address Google, Apple or a code in the inbox vouched for.
 * Knowing the number an admin typed is not enough; with passwords, anybody
 * can type anybody's.
 *
 * One person may come in through a few accounts — the number they signed up
 * with, the Google account they use at work — and each is the same seat.
 *
 * A role is the key of one of the desk's roles in `platform/access` —
 * admin, ops, finance and viewer to begin with, and whatever else Basu
 * makes there. What each may open and press lives there; this module keeps
 * who sits in which.
 */

export type Role = string;

/** Whether the desk has a role of that key. */
export async function deskRoleExists(key: string | null | undefined, db: Db = getPool()): Promise<boolean> {
  return Boolean(key && (await roleOf('desk', key, db)));
}

export interface Member {
  id: string;
  phone: string | null;
  email: string | null;
  name: string;
  role: Role;
  active: boolean;
  createdAt: Date;
  /** How many accounts have proved their way to this seat; 0 is somebody who has not come in yet. */
  accounts: number;
}

type Row = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string;
  role: Role;
  active: boolean;
  created_at: Date;
  accounts: number;
};

const COLUMNS = `m.id, m.phone, m.email, m.name, m.role, m.active, m.created_at,
  (SELECT count(*)::int FROM ops.member_account a WHERE a.member_id = m.id) AS accounts`;

const shape = (r: Row): Member => ({
  id: r.id,
  phone: r.phone,
  email: r.email,
  name: r.name,
  role: r.role,
  active: r.active,
  createdAt: r.created_at,
  accounts: r.accounts,
});

export async function listMembers(db: Db = getPool()): Promise<Member[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM ops.member m ORDER BY m.active DESC, m.name`);
  return rows.map(shape);
}

/** The member this account sits as, if it has proved its way to a seat. */
export async function memberForAccount(guestId: string, db: Db = getPool()): Promise<Member | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM ops.member m JOIN ops.member_account link ON link.member_id = m.id WHERE link.guest_id = $1`,
    [guestId],
  );
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * An account that has just proved an address: if the desk named a member by
 * it, the account now sits as that member. `phone` must be a number an SMS
 * code reached and `email` an address somebody vouched for — never merely
 * one that was typed.
 */
export async function linkByProof(
  input: { guestId: string; phone: string | null; email: string | null },
  db: Db = getPool(),
): Promise<Member | null> {
  const email = input.email?.trim().toLowerCase() || null;
  if (!email && !input.phone) return null;
  const { rows } = await db.query<{ id: string; how: string }>(
    `SELECT id, CASE WHEN $1::text IS NOT NULL AND lower(email) = $1 THEN 'email' ELSE 'phone' END AS how
       FROM ops.member
      WHERE ($1::text IS NOT NULL AND lower(email) = $1) OR ($2::text IS NOT NULL AND phone = $2)
      ORDER BY (lower(email) = $1) DESC NULLS LAST, created_at
      LIMIT 1`,
    [email, input.phone],
  );
  const found = rows[0];
  if (!found) return null;
  await db.query(
    `INSERT INTO ops.member_account (guest_id, member_id, how) VALUES ($1, $2, $3) ON CONFLICT (guest_id) DO NOTHING`,
    [input.guestId, found.id, found.how],
  );
  return memberForAccount(input.guestId, db);
}

const PHONE = /^\+976\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add a member, or change one already there — found by the phone or the
 * address given. A person named by both keeps one seat; two different
 * members named by the two is a mistake, and refused.
 */
export async function upsertMember(
  input: { phone?: string | null; email?: string | null; name: string; role: Role },
  db: Db = getPool(),
): Promise<Member> {
  const phone = input.phone?.replace(/\s+/g, '') || null;
  const email = input.email?.trim().toLowerCase() || null;
  if (!phone && !email) throw new Error('a member needs a phone or an email');
  if (phone && !PHONE.test(phone)) throw new Error('a member’s phone is +976 and eight digits');
  if (email && (email.length > 254 || !EMAIL.test(email))) throw new Error('that is not an email address');
  if (!(await deskRoleExists(input.role, db))) throw new Error(`no such role: ${input.role}`);
  const name = input.name.trim();
  if (name.length < 2) throw new Error('a member needs a name');

  const id = await tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ops.member
        WHERE ($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND lower(email) = $2)
        FOR UPDATE`,
      [phone, email],
    );
    if (rows.length > 1) throw new Error('that phone and that email belong to two different members');
    if (rows[0]) {
      await client.query(
        `UPDATE ops.member
            SET phone = COALESCE($2, phone), email = COALESCE($3, email), name = $4, role = $5,
                active = true, updated_at = now()
          WHERE id = $1`,
        [rows[0].id, phone, email, name, input.role],
      );
      return rows[0].id;
    }
    const made = await client.query<{ id: string }>(
      'INSERT INTO ops.member (phone, email, name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [phone, email, name, input.role],
    );
    return made.rows[0]!.id;
  });
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM ops.member m WHERE m.id = $1`, [id]);
  return shape(rows[0]!);
}

export async function setMemberActive(id: string, active: boolean, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query('UPDATE ops.member SET active = $2, updated_at = now() WHERE id = $1', [id, active]);
  if (!rowCount) throw new Error('no such member');
}

export class MemberError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'LAST_ADMIN', message: string) {
    super(message);
    this.name = 'MemberError';
  }
}

/**
 * Another role for a member already at the desk. The desk always keeps one
 * active admin: without one, nobody could say yes to the next seat.
 */
export async function setMemberRole(id: string, role: Role): Promise<Member> {
  if (!(await deskRoleExists(role))) throw new Error(`no such role: ${role}`);
  await tx(async (client) => {
    const { rows } = await client.query<{ role: Role; active: boolean }>(
      'SELECT role, active FROM ops.member WHERE id = $1 FOR UPDATE',
      [id],
    );
    const current = rows[0];
    if (!current) throw new MemberError('NOT_FOUND', 'no such member');
    if (current.role === 'admin' && current.active && role !== 'admin') {
      const { rows: admins } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ops.member WHERE role = 'admin' AND active AND id <> $1`,
        [id],
      );
      if (!admins[0]?.n) throw new MemberError('LAST_ADMIN', 'the desk keeps one active admin');
    }
    await client.query('UPDATE ops.member SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
  });
  const { rows } = await getPool().query<Row>(`SELECT ${COLUMNS} FROM ops.member m WHERE m.id = $1`, [id]);
  return shape(rows[0]!);
}

/**
 * The first members come from the environment, so a fresh server has a
 * desk before anybody can sit at it. Each entry is `address:name:role`, the
 * address a phone or an email:
 * `OPS_MEMBERS="+97688102856:Баярцогт:admin,bat@gmail.com:Бат:finance"`.
 * Run at boot; a name or role changed there changes here. Naming somebody
 * here gives nobody a seat by itself — the account still has to prove the
 * address.
 */
export async function syncMembersFromEnv(raw: string | undefined, db: Db = getPool()): Promise<number> {
  if (!raw?.trim()) return 0;
  // Boot runs this before the server writes its roles: the roles named here must exist first.
  await ensureRoles(db);
  let n = 0;
  for (const entry of raw.split(',')) {
    const [address, name, role] = entry.split(':').map((s) => s?.trim());
    if (!address || !name || !role) continue;
    const byEmail = address.includes('@');
    await upsertMember({ ...(byEmail ? { email: address } : { phone: address }), name, role: role as Role }, db);
    n++;
  }
  return n;
}
