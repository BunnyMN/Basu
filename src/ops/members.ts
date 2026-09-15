import { getPool, type Db } from '../db/pool.js';

/**
 * The people at the desk.
 *
 * A member is a phone number with a name and a role. Signing in is the same
 * OTP everybody uses; what makes the session ops is that its phone is on
 * this list and active. Roles are few and flat: admin does everything,
 * finance moves money, ops runs orders and suppliers, viewer looks.
 */

export type Role = 'admin' | 'finance' | 'ops' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'finance', 'ops', 'viewer'];

export interface Member {
  id: string;
  phone: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: Date;
}

const shape = (r: { id: string; phone: string; name: string; role: Role; active: boolean; created_at: Date }): Member => ({
  id: r.id,
  phone: r.phone,
  name: r.name,
  role: r.role,
  active: r.active,
  createdAt: r.created_at,
});

export async function listMembers(db: Db = getPool()): Promise<Member[]> {
  const { rows } = await db.query<{ id: string; phone: string; name: string; role: Role; active: boolean; created_at: Date }>(
    'SELECT id, phone, name, role, active, created_at FROM ops.member ORDER BY active DESC, name',
  );
  return rows.map(shape);
}

export async function memberByPhone(phone: string, db: Db = getPool()): Promise<Member | null> {
  const { rows } = await db.query<{ id: string; phone: string; name: string; role: Role; active: boolean; created_at: Date }>(
    'SELECT id, phone, name, role, active, created_at FROM ops.member WHERE phone = $1',
    [phone],
  );
  return rows[0] ? shape(rows[0]) : null;
}

/** Add a member, or change the name and role of one already there. */
export async function upsertMember(
  input: { phone: string; name: string; role: Role },
  db: Db = getPool(),
): Promise<Member> {
  const phone = input.phone.replace(/\s+/g, '');
  if (!/^\+976\d{8}$/.test(phone)) throw new Error('a member’s phone is +976 and eight digits');
  if (!ROLES.includes(input.role)) throw new Error(`no such role: ${input.role}`);
  const name = input.name.trim();
  if (name.length < 2) throw new Error('a member needs a name');
  const { rows } = await db.query<{ id: string; phone: string; name: string; role: Role; active: boolean; created_at: Date }>(
    `INSERT INTO ops.member (phone, name, role) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = true, updated_at = now()
     RETURNING id, phone, name, role, active, created_at`,
    [phone, name, input.role],
  );
  return shape(rows[0]!);
}

export async function setMemberActive(id: string, active: boolean, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query('UPDATE ops.member SET active = $2, updated_at = now() WHERE id = $1', [id, active]);
  if (!rowCount) throw new Error('no such member');
}

/**
 * The first members come from the environment, so a fresh server has a
 * desk before anybody can sit at it: `OPS_MEMBERS="+97688102856:Баярцогт:admin,+976…:Нэр:finance"`.
 * Run at boot; a name or role changed there changes here.
 */
export async function syncMembersFromEnv(raw: string | undefined, db: Db = getPool()): Promise<number> {
  if (!raw?.trim()) return 0;
  let n = 0;
  for (const entry of raw.split(',')) {
    const [phone, name, role] = entry.split(':').map((s) => s?.trim());
    if (!phone || !name || !role) continue;
    await upsertMember({ phone, name, role: role as Role }, db);
    n++;
  }
  return n;
}
