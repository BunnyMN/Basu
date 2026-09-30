import type { PoolClient } from 'pg';
import { getPool, tx, type Db } from '../db/pool.js';
import { ensureRoles, linksOf, mayHandOutDesk, roleOf, type Grants } from '../platform/access/index.js';

/**
 * The people at the desk.
 *
 * A member is a name and a role, named by a phone number, an email address,
 * or both. What makes a session ops is that its account is linked to an
 * active member — and an account is linked only by proof: an admin choosing
 * that very account from Basu's users, a phone number an SMS code reached,
 * or an address Google, Apple or a code in the inbox vouched for. Knowing
 * the number an admin typed is not enough; with passwords, anybody can type
 * anybody's. Nobody asks for a seat: the desk is Basu's staff, and an admin
 * seats them.
 *
 * One person may come in through a few accounts — the number they signed up
 * with, the Google account they use at work — and each is the same seat.
 *
 * A role is the key of one of the desk's roles in `platform/access` —
 * admin, ops, finance and viewer to begin with, and whatever else Basu
 * makes there. What each may open and press lives there; this module keeps
 * who sits in which, and that nobody moves a seat past what they hold.
 */

export type Role = string;

/** The desk's locked role: it opens everything, and the desk always keeps somebody active in it. */
const ADMIN: Role = 'admin';

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

async function memberById(id: string, db: Db = getPool()): Promise<Member> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM ops.member m WHERE m.id = $1`, [id]);
  return shape(rows[0]!);
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

/** The seat each of these accounts sits in, if any — to mark, in a list of people, who is at the desk already. */
export async function seatsOfAccounts(guestIds: readonly string[], db: Db = getPool()): Promise<Map<string, Member>> {
  if (!guestIds.length) return new Map();
  const { rows } = await db.query<Row & { guest_id: string }>(
    `SELECT link.guest_id, ${COLUMNS} FROM ops.member m JOIN ops.member_account link ON link.member_id = m.id WHERE link.guest_id = ANY($1)`,
    [guestIds],
  );
  return new Map(rows.map((r) => [r.guest_id, shape(r)]));
}

/* ── changing a seat ─────────────────────────────────────────────── */

export class MemberError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'LAST_ADMIN' | 'ALREADY_SEATED' | 'OWN_SEAT' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'MemberError';
  }
}

/**
 * Whoever is changing a seat: what their own seat opens, whether that is the
 * locked admin role, which seat is theirs and which account they are signed
 * in as — both `null` for the demo's shared secret, which is nobody.
 */
export interface DeskActor {
  grants: Grants;
  locked: boolean;
  seatId: string | null;
  account: string | null;
}

/**
 * Whether this actor may put a seat into the desk role `key`, or take one
 * out of it: the role opens nothing they do not hold, and only the admin
 * role hands out the admin role. A role that is gone — a seat switched off
 * keeps its role, and a role no active seat holds may be deleted — is the
 * admin's alone to judge.
 */
export async function mayHandle(actor: DeskActor, key: Role, db: Db = getPool()): Promise<boolean> {
  const role = await roleOf('desk', key, db);
  if (!role) return actor.locked;
  return mayHandOutDesk(actor.grants, role, await linksOf('desk', db), actor.locked);
}

/**
 * Every change that could leave the desk without an admin — switching a
 * seat off, giving it another role, seating an account in a seat already
 * there — waits for the one before it to finish. Locking the rows is not
 * enough: two admins taking each other out at the same moment each lock
 * their own row, and each counts the other as still there.
 */
async function oneAtATime(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('ops.member'))`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A seat as it is, locked for the change. An id that is not one names nobody, the same as one nobody has. */
async function heldSeat(client: PoolClient, id: string): Promise<{ id: string; role: Role; active: boolean; accounts: number }> {
  if (!UUID.test(id)) throw new MemberError('NOT_FOUND', 'no such member');
  const { rows } = await client.query<{ role: Role; active: boolean }>('SELECT role, active FROM ops.member WHERE id = $1 FOR UPDATE', [id]);
  const seat = rows[0];
  if (!seat) throw new MemberError('NOT_FOUND', 'no such member');
  const { rows: linked } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM ops.member_account WHERE member_id = $1', [id]);
  return { id, role: seat.role, active: seat.active, accounts: linked[0]?.n ?? 0 };
}

/**
 * The actor may take a seat out of the role it holds, `from`, and put it in
 * `into` — the same role, for a seat switched off or on — or the change is
 * refused.
 */
async function mayMove(client: PoolClient, actor: DeskActor, from: Role, into: Role): Promise<void> {
  if (!(await mayHandle(actor, from, client)) || (into !== from && !(await mayHandle(actor, into, client)))) {
    throw new MemberError('FORBIDDEN', `cannot move a seat from ${from} to ${into}`);
  }
}

/**
 * The seat leaving the admin role, or going off, must not be the last active
 * admin: without one, nobody could say yes to the next seat. Asked inside
 * the change, after `oneAtATime`.
 */
async function keepAnAdmin(client: PoolClient, leaving: string): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM ops.member WHERE role = $1 AND active AND id <> $2',
    [ADMIN, leaving],
  );
  if (!rows[0]?.n) throw new MemberError('LAST_ADMIN', 'the desk keeps one active admin');
}

/**
 * A seat for an account an admin chose from Basu's users, with the role
 * given. The choice is the proof, so the account sits at once.
 *
 * Which seat: the one the account sat in before, when it was switched off;
 * else a member the desk named by an address this account has proved — its
 * email, which somebody always vouched for, or a number an SMS code
 * reached — the way the environment names the first members; else a new
 * one. `email` and `phone` must be those proved addresses and nothing else.
 * A number merely typed at sign-up names nobody: with passwords anybody can
 * type anybody's, and whoever typed an admin's number would be handed the
 * admin's chair the day somebody chose them for anything. A new seat is
 * named by the proved addresses alone, for the same reason: a typed number
 * kept on it would hand it to whoever proves that number one day.
 *
 * Refused: the actor's own account or own seat; an account whose seat is on
 * already — a role is changed in the table, where the checks for that are;
 * a seat taken out of a role, or put in one, beyond the actor — switching a
 * seat back on, or taking over one the desk named, takes it out of the role
 * it held; and the last active admin taken out of the admin role.
 */
export async function seatAccount(
  input: { guestId: string; name: string; email: string | null; phone: string | null; role: Role },
  actor: DeskActor,
  db: Db = getPool(),
): Promise<Member> {
  if (!(await deskRoleExists(input.role, db))) throw new Error(`no such role: ${input.role}`);
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone || null;
  await tx(async (client) => {
    await oneAtATime(client);
    if (input.guestId === actor.account) throw new MemberError('OWN_SEAT', 'not your own account');
    const linked = await client.query<{ member_id: string }>('SELECT member_id FROM ops.member_account WHERE guest_id = $1', [input.guestId]);
    const named = linked.rows[0]
      ? linked.rows
      : (
          await client.query<{ member_id: string }>(
            `SELECT id AS member_id FROM ops.member
              WHERE ($1::text IS NOT NULL AND lower(email) = $1) OR ($2::text IS NOT NULL AND phone = $2)
              ORDER BY (lower(email) = $1) DESC NULLS LAST, created_at
              LIMIT 1`,
            [email, phone],
          )
        ).rows;
    let memberId = named[0]?.member_id;
    if (memberId) {
      const seat = await heldSeat(client, memberId);
      if (seat.id === actor.seatId) throw new MemberError('OWN_SEAT', 'not your own seat');
      // On, and somebody sits in it — this account, or another of the same person's: it is at the desk.
      if (seat.active && (linked.rows[0] || seat.accounts > 0)) throw new MemberError('ALREADY_SEATED', 'that account sits at the desk already');
      await mayMove(client, actor, seat.role, input.role);
      if (seat.active && seat.role === ADMIN && input.role !== ADMIN) await keepAnAdmin(client, seat.id);
      await client.query('UPDATE ops.member SET role = $2, active = true, updated_at = now() WHERE id = $1', [memberId, input.role]);
    } else {
      await mayMove(client, actor, input.role, input.role);
      const made = await client.query<{ id: string }>(
        'INSERT INTO ops.member (name, role, email, phone) VALUES ($1, $2, $3, $4) RETURNING id',
        [input.name.trim() || email || phone || 'Нэргүй', input.role, email, phone],
      );
      memberId = made.rows[0]!.id;
    }
    await client.query(
      `INSERT INTO ops.member_account (guest_id, member_id, how) VALUES ($1, $2, 'chosen') ON CONFLICT (guest_id) DO NOTHING`,
      [input.guestId, memberId],
    );
  });
  return (await memberForAccount(input.guestId, db))!;
}

const PHONE = /^\+976\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add a member, or change one already there — found by the phone or the
 * address given. A person named by both keeps one seat; two different
 * members named by the two is a mistake, and refused. For scripts and
 * tests that set a desk up; the desk's own pages change seats through
 * `seatAccount`, `setMemberRole` and `setMemberActive`, which hold the
 * rules.
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
  return memberById(id, db);
}

/**
 * Switch a seat off, or back on. Off is at once — the desk asks after the
 * seat on every request, so a dashboard left open loses the desk at its
 * next step — and it is only the desk: the person's own sign-ins are
 * theirs, and stay open for the website and the app. Either way it is for
 * somebody who may hand out the seat's role, and the last active admin
 * stays on.
 */
export async function setMemberActive(id: string, active: boolean, actor: DeskActor): Promise<void> {
  await tx(async (client) => {
    await oneAtATime(client);
    const seat = await heldSeat(client, id);
    await mayMove(client, actor, seat.role, seat.role);
    if (!active && seat.active && seat.role === ADMIN) await keepAnAdmin(client, id);
    await client.query('UPDATE ops.member SET active = $2, updated_at = now() WHERE id = $1', [id, active]);
  });
}

/**
 * Another role for a member already at the desk: for somebody who may take
 * the seat out of the role it holds and hand out the one it gets. The desk
 * always keeps one active admin.
 */
export async function setMemberRole(id: string, role: Role, actor: DeskActor): Promise<Member> {
  if (!(await deskRoleExists(role))) throw new Error(`no such role: ${role}`);
  await tx(async (client) => {
    await oneAtATime(client);
    const seat = await heldSeat(client, id);
    await mayMove(client, actor, seat.role, role);
    if (seat.active && seat.role === ADMIN && role !== ADMIN) await keepAnAdmin(client, id);
    await client.query('UPDATE ops.member SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
  });
  return memberById(id);
}

/* ── the first members, from the environment ─────────────────────── */

type Seed = { phone: string | null; email: string | null; name: string; role: Role };

/** One entry of the list, read — or why it cannot be, in words that repeat nothing it holds. */
async function seedOf(entry: string, db: Db): Promise<Seed | string> {
  const parts = entry.split(':');
  if (parts.length < 3) return 'it is not address:name:role';
  const address = parts[0]!.trim();
  const name = parts.slice(1, -1).join(':').trim();
  const role = parts.at(-1)!.trim().toLowerCase();
  const email = address.includes('@') ? address.toLowerCase() : null;
  const phone = email ? null : address.replace(/\s+/g, '');
  if (email ? email.length > 254 || !EMAIL.test(email) : !PHONE.test(phone ?? '')) return 'the address is neither an email nor a +976 number';
  if (name.length < 2) return 'the name is missing';
  if (!(await deskRoleExists(role, db))) return 'the desk has no such role';
  return { phone, email, name, role };
}

/**
 * The first members come from the environment, so a fresh server has a desk
 * before anybody can sit at it. Each entry is `address:name:role`, the
 * address an email or a phone, entries apart by commas:
 * `OPS_MEMBERS="owner@gmail.com:Эзэн:admin,bat@gmail.com:Бат:finance"`.
 * The address is what comes before the first colon and the role what comes
 * after the last; a name may hold a colon of its own.
 *
 * The environment only seeds. A member it names is made when the desk has
 * nobody by that address, and never touched after: the role, the name and
 * whether the seat is on are the desk's, on «Гишүүд». A seat an admin
 * switched off is not switched back on by the next deploy, nor a role taken
 * away given back; and taking an entry out of the list takes nobody off the
 * desk. Naming somebody gives nobody a seat by itself: the account still has
 * to prove the address — and in production, with no SMS, only an email can
 * be proved.
 *
 * An entry that is not an address, a name and a desk role is skipped and
 * said so by its place in the list and why, never by what it holds: boot
 * logs are public. Run at boot; returns how many members it made.
 */
export async function syncMembersFromEnv(
  raw: string | undefined,
  log: (line: string) => void = (line) => console.log(line),
  db: Db = getPool(),
): Promise<number> {
  if (!raw?.trim()) return 0;
  // Boot runs this before the server writes its roles: the roles named here must exist first.
  await ensureRoles(db);
  let made = 0;
  for (const [i, entry] of raw.split(',').entries()) {
    if (!entry.trim()) continue;
    const seed = await seedOf(entry, db);
    if (typeof seed === 'string') {
      log(`OPS_MEMBERS entry ${i + 1} skipped: ${seed}`);
      continue;
    }
    // Somebody the desk already names by this address stays exactly as the desk left them.
    const { rowCount } = await db.query(
      'INSERT INTO ops.member (phone, email, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [seed.phone, seed.email, seed.name, seed.role],
    );
    made += rowCount ?? 0;
  }
  return made;
}
