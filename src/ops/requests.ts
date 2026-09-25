import { getPool, tx, type Db } from '../db/pool.js';
import { ROLES, memberForAccount, type Member, type Role } from './members.js';

/**
 * Asking for a seat at the desk.
 *
 * Anybody signed in may ask, from the dashboard, for the role they need; an
 * admin answers. The yes is the proof: the account that asked is the account
 * that sits, so nobody collects addresses to type into a form.
 */

export type RequestState = 'pending' | 'approved' | 'declined';

export interface AccessRequest {
  id: string;
  guestId: string;
  name: string;
  /** The address the account signed in with — how the admin recognises them. */
  contact: string | null;
  role: Role;
  note: string | null;
  state: RequestState;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  declineReason: string | null;
}

export class RequestError extends Error {
  constructor(
    readonly code: 'ALREADY_MEMBER' | 'NOT_PENDING' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

type Row = {
  id: string;
  guest_id: string;
  name: string;
  contact: string | null;
  role: Role;
  note: string | null;
  state: RequestState;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decline_reason: string | null;
};

const COLUMNS = 'id, guest_id, name, contact, role, note, state, created_at, decided_at, decided_by, decline_reason';

const shape = (r: Row): AccessRequest => ({
  id: r.id,
  guestId: r.guest_id,
  name: r.name,
  contact: r.contact,
  role: r.role,
  note: r.note,
  state: r.state,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  declineReason: r.decline_reason,
});

/**
 * Ask, or change what is asked while nobody has answered. An account that
 * already sits at the desk has nothing to ask for.
 */
export async function requestAccess(
  input: { guestId: string; name: string; contact: string | null; role: Role; note?: string | null; now: Date },
  db: Db = getPool(),
): Promise<AccessRequest> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw new RequestError('BAD_REQUEST', 'a request needs a name');
  if (!ROLES.includes(input.role)) throw new RequestError('BAD_REQUEST', `no such role: ${input.role}`);
  const member = await memberForAccount(input.guestId, db);
  if (member?.active) throw new RequestError('ALREADY_MEMBER', 'this account already sits at the desk');
  const note = input.note?.trim().slice(0, 500) || null;
  const { rows } = await db.query<Row>(
    `INSERT INTO ops.access_request (guest_id, name, contact, role, note, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guest_id) WHERE state = 'pending'
     DO UPDATE SET name = EXCLUDED.name, contact = EXCLUDED.contact, role = EXCLUDED.role, note = EXCLUDED.note
     RETURNING ${COLUMNS}`,
    [input.guestId, name, input.contact, input.role, note, input.now],
  );
  return shape(rows[0]!);
}

/** What this account asked last, answered or not. */
export async function requestOf(guestId: string, db: Db = getPool()): Promise<AccessRequest | null> {
  const { rows } = await db.query<Row>(
    // A waiting one first: an answer and a new ask can share an instant.
    `SELECT ${COLUMNS} FROM ops.access_request WHERE guest_id = $1 ORDER BY (state = 'pending') DESC, created_at DESC LIMIT 1`,
    [guestId],
  );
  return rows[0] ? shape(rows[0]) : null;
}

/** Everything waiting for an answer, oldest first. */
export async function pendingRequests(db: Db = getPool()): Promise<AccessRequest[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM ops.access_request WHERE state = 'pending' ORDER BY created_at`,
  );
  return rows.map(shape);
}

/**
 * Yes. The account that asked sits as a member with the role given — the
 * one asked for unless the admin chose another. An account that once sat
 * and was switched off is switched back on rather than seated twice.
 */
export async function approveRequest(
  input: { id: string; role?: Role | null; by: string; now: Date; email?: string | null; phone?: string | null },
  db: Db = getPool(),
): Promise<{ request: AccessRequest; member: Member }> {
  if (input.role && !ROLES.includes(input.role)) throw new RequestError('BAD_REQUEST', `no such role: ${input.role}`);
  const decided = await tx(async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT ${COLUMNS} FROM ops.access_request WHERE id = $1 AND state = 'pending' FOR UPDATE`,
      [input.id],
    );
    const request = rows[0];
    if (!request) throw new RequestError('NOT_PENDING', 'no request is waiting under that id');
    const role = input.role ?? request.role;

    const linked = await client.query<{ member_id: string }>(
      'SELECT member_id FROM ops.member_account WHERE guest_id = $1',
      [request.guest_id],
    );
    if (linked.rows[0]) {
      await client.query('UPDATE ops.member SET role = $2, active = true, updated_at = now() WHERE id = $1', [
        linked.rows[0].member_id,
        role,
      ]);
    } else {
      // Named by the account's own addresses where no other member is — so
      // the members list says who it is — and by nothing where one is.
      const email = input.email?.trim().toLowerCase() || null;
      const phone = input.phone || null;
      const taken = await client.query<{ email: string | null; phone: string | null }>(
        'SELECT email, phone FROM ops.member WHERE ($1::text IS NOT NULL AND lower(email) = $1) OR ($2::text IS NOT NULL AND phone = $2)',
        [email, phone],
      );
      const emailFree = email && !taken.rows.some((r) => r.email?.toLowerCase() === email);
      const phoneFree = phone && !taken.rows.some((r) => r.phone === phone);
      const made = await client.query<{ id: string }>(
        'INSERT INTO ops.member (name, role, email, phone) VALUES ($1, $2, $3, $4) RETURNING id',
        [request.name, role, emailFree ? email : null, phoneFree ? phone : null],
      );
      await client.query(`INSERT INTO ops.member_account (guest_id, member_id, how) VALUES ($1, $2, 'request')`, [
        request.guest_id,
        made.rows[0]!.id,
      ]);
    }
    const done = await client.query<Row>(
      `UPDATE ops.access_request SET state = 'approved', role = $2, decided_at = $3, decided_by = $4
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [input.id, role, input.now, input.by],
    );
    return shape(done.rows[0]!);
  });
  const member = await memberForAccount(decided.guestId, db);
  return { request: decided, member: member! };
}

/** No, and why. The account may ask again. */
export async function declineRequest(
  input: { id: string; reason?: string | null; by: string; now: Date },
  db: Db = getPool(),
): Promise<AccessRequest> {
  const { rows } = await db.query<Row>(
    `UPDATE ops.access_request
        SET state = 'declined', decided_at = $2, decided_by = $3, decline_reason = $4
      WHERE id = $1 AND state = 'pending'
      RETURNING ${COLUMNS}`,
    [input.id, input.now, input.by, input.reason?.trim().slice(0, 300) || null],
  );
  if (!rows[0]) throw new RequestError('NOT_PENDING', 'no request is waiting under that id');
  return shape(rows[0]);
}
