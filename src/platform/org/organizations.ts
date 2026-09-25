import { getPool, tx, type Db } from '../../db/pool.js';
import {
  NO_GRANTS,
  headRoles,
  linksOf,
  mayHandOut,
  orgGrantsOf,
  roleOf,
  rolesForOrg,
  type Grants,
  type Role,
} from '../access/index.js';

/**
 * Businesses on Basu, and the people who run them.
 *
 * An organisation is a restaurant, a supplier, or both. A person registers
 * it and is its owner; Basu's desk approves it. From then on its owner and
 * managers bring in the people who work there, each with a role — so a
 * butcher's staff can take orders without being able to change where the
 * money goes, and an accountant can read the money without being able to
 * cancel anybody's sheep.
 *
 * A role is one of the business roles Basu keeps in `platform/access` —
 * what it opens is said there, and which of them a business may hand out.
 * This module keeps who holds which role, the rule that nobody hands out
 * more than they hold, and the record of every change.
 */

/** The key of a business role in `platform/access`: owner, manager, staff, accountant, or one Basu made. */
export type OrgRole = string;
export type OrgState = 'applied' | 'active' | 'declined' | 'suspended';

export class OrgError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_MEMBER' | 'LAST_OWNER' | 'NOT_PENDING' | 'BAD_INPUT' | 'NO_SUCH_ROLE',
    message: string,
  ) {
    super(message);
    this.name = 'OrgError';
  }
}

export interface Organization {
  id: string;
  name: string;
  restaurant: boolean;
  supplier: boolean;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  tin: string | null;
  about: string | null;
  state: OrgState;
  appliedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  declineReason: string | null;
}

export interface Membership {
  guestId: string;
  role: OrgRole;
  addedAt: Date;
}

type Row = {
  id: string;
  name: string;
  restaurant: boolean;
  supplier: boolean;
  phone: string | null;
  address: string | null;
  lat: string | null;
  lon: string | null;
  tin: string | null;
  about: string | null;
  state: OrgState;
  applied_by: string;
  created_at: Date;
  decided_at: Date | null;
  decline_reason: string | null;
};

const COLUMNS =
  'o.id, o.name, o.restaurant, o.supplier, o.phone, o.address, o.lat, o.lon, o.tin, o.about, o.state, o.applied_by, o.created_at, o.decided_at, o.decline_reason';

const shape = (r: Row): Organization => ({
  id: r.id,
  name: r.name,
  restaurant: r.restaurant,
  supplier: r.supplier,
  phone: r.phone,
  address: r.address,
  lat: r.lat === null ? null : Number(r.lat),
  lon: r.lon === null ? null : Number(r.lon),
  tin: r.tin,
  about: r.about,
  state: r.state,
  appliedBy: r.applied_by,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  declineReason: r.decline_reason,
});

export interface OrgInput {
  name: string;
  restaurant: boolean;
  supplier: boolean;
  phone?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  tin?: string | null;
  about?: string | null;
}

function checked(input: OrgInput) {
  const name = input.name?.trim() ?? '';
  if (name.length < 2 || name.length > 80) throw new OrgError('BAD_INPUT', 'an organisation needs a name');
  if (!input.restaurant && !input.supplier) throw new OrgError('BAD_INPUT', 'a restaurant, a supplier, or both');
  const tin = input.tin?.replace(/\s+/g, '') || null;
  if (tin && !/^\d{7,10}$/.test(tin)) throw new OrgError('BAD_INPUT', 'a TIN is seven to ten digits');
  return {
    name,
    restaurant: Boolean(input.restaurant),
    supplier: Boolean(input.supplier),
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    lat: typeof input.lat === 'number' ? input.lat : null,
    lon: typeof input.lon === 'number' ? input.lon : null,
    tin,
    about: input.about?.trim().slice(0, 1000) || null,
  };
}

/** Register a business. The person registering is its owner from the start, and it waits for the desk. */
export async function registerOrg(input: OrgInput & { guestId: string; now: Date }): Promise<Organization> {
  const v = checked(input);
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO org.organization (name, restaurant, supplier, phone, address, lat, lon, tin, about, applied_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [v.name, v.restaurant, v.supplier, v.phone, v.address, v.lat, v.lon, v.tin, v.about, input.guestId, input.now],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO org.membership (org_id, guest_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $2, $3)`,
      [id, input.guestId, input.now],
    );
    await note(client, { orgId: id, by: input.guestId, action: 'registered', guestId: input.guestId, role: 'owner', roleName: 'Эзэн', at: input.now });
    return (await orgById(id, client))!;
  });
}

export async function orgById(id: string, db: Db = getPool()): Promise<Organization | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM org.organization o WHERE o.id = $1`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/** The organisations this person belongs to, and their role in each. Declined ones stay visible to them. */
export async function orgsOf(guestId: string, db: Db = getPool()): Promise<Array<{ org: Organization; role: OrgRole }>> {
  const { rows } = await db.query<Row & { role: OrgRole }>(
    `SELECT ${COLUMNS}, m.role FROM org.organization o JOIN org.membership m ON m.org_id = o.id
      WHERE m.guest_id = $1 ORDER BY (o.state = 'active') DESC, o.created_at DESC`,
    [guestId],
  );
  return rows.map((r) => ({ org: shape(r), role: r.role }));
}

/** This person's role in that organisation, or null. Only an active organisation grants anything. */
export async function roleIn(orgId: string, guestId: string, db: Db = getPool()): Promise<OrgRole | null> {
  const { rows } = await db.query<{ role: OrgRole; state: OrgState }>(
    `SELECT m.role, o.state FROM org.membership m JOIN org.organization o ON o.id = m.org_id
      WHERE m.org_id = $1 AND m.guest_id = $2`,
    [orgId, guestId],
  );
  return rows[0]?.state === 'active' ? rows[0].role : null;
}

export async function membersOf(orgId: string, db: Db = getPool()): Promise<Membership[]> {
  const { rows } = await db.query<{ guest_id: string; role: OrgRole; added_at: Date }>(
    `SELECT guest_id, role, added_at FROM org.membership WHERE org_id = $1
      ORDER BY array_position(ARRAY['owner','manager','accountant','staff'], role), added_at`,
    [orgId],
  );
  return rows.map((r) => ({ guestId: r.guest_id, role: r.role, addedAt: r.added_at }));
}

/**
 * What this person may do at that business: their role there, as Basu wrote
 * it, less the pages that do not run at a business of its kind. Nothing at
 * a business that is not active, or for somebody not in it.
 */
export async function accessIn(
  orgId: string,
  guestId: string,
  db: Db = getPool(),
): Promise<{ org: Organization; role: Role; grants: Grants } | null> {
  const org = await orgById(orgId, db);
  if (!org || org.state !== 'active') return null;
  const key = await roleIn(orgId, guestId, db);
  const role = key ? await roleOf('org', key, db) : null;
  if (!role) return null;
  return { org, role, grants: orgGrantsOf(role, org, await linksOf('org', db)) };
}

/**
 * Every business this person belongs to, with their role and what it opens
 * there — nothing yet at one still waiting for the desk.
 */
export async function seatsOf(guestId: string, db: Db = getPool()): Promise<Array<{ org: Organization; role: Role | null; roleKey: OrgRole; grants: Grants }>> {
  const links = await linksOf('org', db);
  const out = [];
  for (const { org, role: key } of await orgsOf(guestId, db)) {
    const role = await roleOf('org', key, db);
    out.push({ org, role, roleKey: key, grants: org.state === 'active' ? orgGrantsOf(role, org, links) : NO_GRANTS });
  }
  return out;
}

/** The actor's standing at the business, or a refusal: they must be in it, and it must be active. */
async function actorAt(orgId: string, actorId: string, db: Db): Promise<{ org: Organization; grants: Grants }> {
  const org = await orgById(orgId, db);
  if (!org) throw new OrgError('NOT_FOUND', 'no such organisation');
  const seat = await accessIn(orgId, actorId, db);
  if (!seat) throw new OrgError('FORBIDDEN', 'not a member of an active organisation');
  return { org, grants: seat.grants };
}

/** A role this business may hand out, or a refusal. */
async function openRole(orgId: string, key: string, db: Db): Promise<Role> {
  const role = (await rolesForOrg(orgId, db)).find((r) => r.key === key);
  if (!role) throw new OrgError('NO_SUCH_ROLE', `this business has no role ${key}`);
  return role;
}

/** Whether somebody holding `grants` may give, change or take away `role` here — nobody hands out more than they hold. */
async function mayHandle(org: Organization, grants: Grants, role: Role | null, db: Db): Promise<boolean> {
  if (!role) return grants.has('org.team:heads');
  return mayHandOut(grants, role, org, await linksOf('org', db));
}

/** Bring somebody in, in one of the roles this business may hand out. They must have signed in to Basu once — that is who they are. */
export async function addMember(input: { orgId: string; guestId: string; role: OrgRole; by: string; now: Date }): Promise<void> {
  await tx(async (client) => {
    const { org, grants } = await actorAt(input.orgId, input.by, client);
    const role = await openRole(input.orgId, input.role, client);
    if (!(await mayHandle(org, grants, role, client))) throw new OrgError('FORBIDDEN', `cannot give the role ${input.role}`);
    const { rowCount } = await client.query(
      `INSERT INTO org.membership (org_id, guest_id, role, added_by, added_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, guest_id) DO NOTHING`,
      [input.orgId, input.guestId, role.key, input.by, input.now],
    );
    if (!rowCount) throw new OrgError('ALREADY_MEMBER', 'already a member here');
    await note(client, { orgId: input.orgId, by: input.by, action: 'added', guestId: input.guestId, role: role.key, roleName: role.name, at: input.now });
  });
}

/**
 * Change a member's role. Both the role they had and the one they get must
 * be the actor's to hand out; the desk, deciding for the business, may give
 * any role the business has. A business always keeps somebody in a head role.
 */
export async function setRole(input: { orgId: string; guestId: string; role: OrgRole; by: string; now: Date; desk?: string }): Promise<void> {
  await tx(async (client) => {
    const org = await orgById(input.orgId, client);
    if (!org) throw new OrgError('NOT_FOUND', 'no such organisation');
    const role = await openRole(input.orgId, input.role, client);
    const current = await client.query<{ role: OrgRole }>(
      'SELECT role FROM org.membership WHERE org_id = $1 AND guest_id = $2 FOR UPDATE',
      [input.orgId, input.guestId],
    );
    const was = current.rows[0]?.role;
    if (!was) throw new OrgError('NOT_FOUND', 'not a member here');
    const wasRole = await roleOf('org', was, client);
    if (!input.desk) {
      const { grants } = await actorAt(input.orgId, input.by, client);
      if (!(await mayHandle(org, grants, wasRole, client)) || !(await mayHandle(org, grants, role, client))) {
        throw new OrgError('FORBIDDEN', `cannot change a ${was} into a ${role.key}`);
      }
    }
    if (was === role.key) return;
    await client.query('UPDATE org.membership SET role = $3 WHERE org_id = $1 AND guest_id = $2', [input.orgId, input.guestId, role.key]);
    await keepAHead(client, input.orgId);
    await note(client, {
      orgId: input.orgId,
      ...(input.desk ? { desk: input.desk } : { by: input.by }),
      action: 'role',
      guestId: input.guestId,
      role: role.key,
      roleName: role.name,
      was,
      wasName: wasRole?.name ?? was,
      at: input.now,
    });
  });
}

/** Take somebody out. Anybody may leave; a business never loses its last head. */
export async function removeMember(input: { orgId: string; guestId: string; by: string; now: Date }): Promise<void> {
  await tx(async (client) => {
    const current = await client.query<{ role: OrgRole }>(
      'SELECT role FROM org.membership WHERE org_id = $1 AND guest_id = $2 FOR UPDATE',
      [input.orgId, input.guestId],
    );
    const was = current.rows[0]?.role;
    if (!was) throw new OrgError('NOT_FOUND', 'not a member here');
    const wasRole = await roleOf('org', was, client);
    const leaving = input.guestId === input.by;
    if (!leaving) {
      const { org, grants } = await actorAt(input.orgId, input.by, client);
      if (!(await mayHandle(org, grants, wasRole, client))) throw new OrgError('FORBIDDEN', `cannot remove a ${was}`);
    }
    await client.query('DELETE FROM org.membership WHERE org_id = $1 AND guest_id = $2', [input.orgId, input.guestId]);
    await keepAHead(client, input.orgId);
    await note(client, { orgId: input.orgId, by: input.by, action: leaving ? 'left' : 'removed', guestId: input.guestId, was, wasName: wasRole?.name ?? was, at: input.now });
  });
}

/** A business keeps at least one person in a head role: checked after the change, inside it. */
async function keepAHead(client: Db, orgId: string): Promise<void> {
  const heads = await headRoles(client);
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM org.membership WHERE org_id = $1 AND role = ANY($2)',
    [orgId, heads],
  );
  if ((rows[0]?.n ?? 0) < 1) throw new OrgError('LAST_OWNER', 'an organisation keeps at least one owner');
}

/** How many people hold each role, across every business — what the roles page says before a role is removed. */
export async function roleCounts(db: Db = getPool()): Promise<Map<OrgRole, number>> {
  const { rows } = await db.query<{ role: OrgRole; n: number }>('SELECT role, count(*)::int AS n FROM org.membership GROUP BY role');
  return new Map(rows.map((r) => [r.role, r.n]));
}

/** The organisation's details, changed by its owner or a manager. */
export async function updateOrg(input: Partial<OrgInput> & { orgId: string; by: string }): Promise<Organization> {
  const db = getPool();
  const { org: current, grants } = await actorAt(input.orgId, input.by, db);
  if (!grants.has('org.profile:edit')) throw new OrgError('FORBIDDEN', 'this role does not change the details');
  const v = checked({
    name: input.name ?? current.name,
    restaurant: current.restaurant,
    supplier: current.supplier,
    phone: input.phone === undefined ? current.phone : input.phone,
    address: input.address === undefined ? current.address : input.address,
    lat: input.lat === undefined ? current.lat : input.lat,
    lon: input.lon === undefined ? current.lon : input.lon,
    tin: input.tin === undefined ? current.tin : input.tin,
    about: input.about === undefined ? current.about : input.about,
  });
  await db.query(
    `UPDATE org.organization SET name = $2, phone = $3, address = $4, lat = $5, lon = $6, tin = $7, about = $8 WHERE id = $1`,
    [input.orgId, v.name, v.phone, v.address, v.lat, v.lon, v.tin, v.about],
  );
  return (await orgById(input.orgId, db))!;
}

/* ── the desk decides ─────────────────────────────────────────────── */

export async function listOrgs(opts: { state?: OrgState } = {}, db: Db = getPool()): Promise<Organization[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM org.organization o
      WHERE ($1::text IS NULL OR o.state = $1)
      ORDER BY (o.state = 'applied') DESC, o.created_at DESC`,
    [opts.state ?? null],
  );
  return rows.map(shape);
}

/** Yes, from the desk. `by` is the desk member's name, as the desk's own record writes it. */
export async function approveOrg(input: { id: string; by: string; now: Date }): Promise<Organization> {
  return tx(async (client) => {
    const { rows } = await client.query<Row>(
      `UPDATE org.organization o SET state = 'active', decided_at = $2, decided_by = $3, decline_reason = NULL
        WHERE o.id = $1 AND o.state = 'applied' RETURNING ${COLUMNS}`,
      [input.id, input.now, input.by],
    );
    if (!rows[0]) throw new OrgError('NOT_PENDING', 'nothing is waiting under that id');
    await note(client, { orgId: input.id, desk: input.by, action: 'approved', at: input.now });
    return shape(rows[0]);
  });
}

export async function declineOrg(input: { id: string; reason?: string | null; by: string; now: Date }): Promise<Organization> {
  return tx(async (client) => {
    const { rows } = await client.query<Row>(
      `UPDATE org.organization o SET state = 'declined', decided_at = $2, decided_by = $3, decline_reason = $4
        WHERE o.id = $1 AND o.state = 'applied' RETURNING ${COLUMNS}`,
      [input.id, input.now, input.by, input.reason?.trim().slice(0, 300) || null],
    );
    if (!rows[0]) throw new OrgError('NOT_PENDING', 'nothing is waiting under that id');
    await note(client, { orgId: input.id, desk: input.by, action: 'declined', at: input.now });
    return shape(rows[0]);
  });
}

/**
 * An organisation made for a business that already existed — a supplier
 * registered before there were organisations, now approved or claimed — with
 * its owner. Active from the start: the desk already said yes to it.
 */
export async function orgForExisting(input: OrgInput & { ownerId: string; now: Date }): Promise<Organization> {
  // Taken as it is: the business exists already, whatever its name looks like.
  const tin = input.tin?.replace(/\s+/g, '') || null;
  const v = {
    name: input.name?.trim() || 'Нэргүй',
    restaurant: Boolean(input.restaurant),
    supplier: Boolean(input.supplier),
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    lat: typeof input.lat === 'number' ? input.lat : null,
    lon: typeof input.lon === 'number' ? input.lon : null,
    tin: tin && /^\d{7,10}$/.test(tin) ? tin : null,
    about: input.about?.trim().slice(0, 1000) || null,
  };
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO org.organization
         (name, restaurant, supplier, phone, address, lat, lon, tin, about, applied_by, created_at, state, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $11) RETURNING id`,
      [v.name, v.restaurant, v.supplier, v.phone, v.address, v.lat, v.lon, v.tin, v.about, input.ownerId, input.now],
    );
    await client.query(
      `INSERT INTO org.membership (org_id, guest_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $2, $3)`,
      [rows[0]!.id, input.ownerId, input.now],
    );
    await note(client, { orgId: rows[0]!.id, by: input.ownerId, action: 'registered', guestId: input.ownerId, role: 'owner', roleName: 'Эзэн', at: input.now });
    return (await orgById(rows[0]!.id, client))!;
  });
}

/* ── the record of who holds what ────────────────────────────────── */

export type LogAction = 'registered' | 'approved' | 'declined' | 'added' | 'role' | 'removed' | 'left' | 'roles';

export interface LogEntry {
  id: string;
  /** The account that did it; null when the desk did. */
  byGuest: string | null;
  /** The desk member's name, when the desk did it. */
  byDesk: string | null;
  action: LogAction;
  guestId: string | null;
  role: OrgRole | null;
  was: OrgRole | null;
  /** The roles' names as they were that day. */
  roleName: string | null;
  wasName: string | null;
  at: Date;
}

async function note(
  client: Db,
  entry: {
    orgId: string;
    by?: string;
    desk?: string;
    action: LogAction;
    guestId?: string;
    role?: OrgRole;
    roleName?: string;
    was?: OrgRole;
    wasName?: string;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO org.membership_log (org_id, actor_guest, actor_desk, action, guest_id, role, was, role_name, was_name, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.orgId,
      entry.by ?? null,
      entry.desk ?? null,
      entry.action,
      entry.guestId ?? null,
      entry.role ?? null,
      entry.was ?? null,
      entry.roleName ?? null,
      entry.wasName ?? null,
      entry.at,
    ],
  );
}

/** The latest changes to who holds what in one organisation, newest first. */
export async function logOf(orgId: string, limit = 50, db: Db = getPool()): Promise<LogEntry[]> {
  const { rows } = await db.query<{
    id: string;
    actor_guest: string | null;
    actor_desk: string | null;
    action: LogAction;
    guest_id: string | null;
    role: OrgRole | null;
    was: OrgRole | null;
    role_name: string | null;
    was_name: string | null;
    at: Date;
  }>(
    `SELECT id::text, actor_guest, actor_desk, action, guest_id, role, was, role_name, was_name, at
       FROM org.membership_log WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [orgId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    byGuest: r.actor_guest,
    byDesk: r.actor_desk,
    action: r.action,
    guestId: r.guest_id,
    role: r.role,
    was: r.was,
    roleName: r.role_name,
    wasName: r.was_name,
    at: r.at,
  }));
}

/** The desk changed which roles this business may hand out: a line in its record, for its owner to see. */
export async function noteRolesChanged(input: { orgId: string; desk: string; at: Date }): Promise<void> {
  await note(getPool(), { orgId: input.orgId, desk: input.desk, action: 'roles', at: input.at });
}
