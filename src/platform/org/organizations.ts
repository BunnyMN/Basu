import { getPool, tx, type Db } from '../../db/pool.js';

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
 * The verticals ask here who may do what; they keep their own tables.
 */

export type OrgRole = 'owner' | 'manager' | 'staff' | 'accountant';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'manager', 'staff', 'accountant'];
export type OrgState = 'applied' | 'active' | 'declined' | 'suspended';

/**
 * What a role may do. `members` is bringing in staff and accountants;
 * `managers` is appointing managers and owners. `catalog` is listings and
 * menus, `profile` the organisation's details, `bank` where its money goes.
 */
export type OrgAction = 'members' | 'managers' | 'profile' | 'bank' | 'money' | 'orders' | 'catalog' | 'screens';

const MAY: Record<OrgAction, readonly OrgRole[]> = {
  managers: ['owner'],
  bank: ['owner'],
  members: ['owner', 'manager'],
  profile: ['owner', 'manager'],
  screens: ['owner', 'manager'],
  catalog: ['owner', 'manager', 'staff'],
  orders: ['owner', 'manager', 'staff'],
  money: ['owner', 'manager', 'accountant'],
};

export const can = (role: OrgRole | null | undefined, action: OrgAction): boolean =>
  Boolean(role && MAY[action].includes(role));

export class OrgError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_MEMBER' | 'LAST_OWNER' | 'NOT_PENDING' | 'BAD_INPUT',
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
 * Who may give which role: an owner any, a manager only staff and
 * accountants. The same rule changes and removes people.
 */
function mayHandle(actor: OrgRole | null, role: OrgRole): boolean {
  if (actor === 'owner') return true;
  if (actor === 'manager') return role === 'staff' || role === 'accountant';
  return false;
}

async function actorRole(orgId: string, actorId: string, db: Db): Promise<OrgRole> {
  const org = await orgById(orgId, db);
  if (!org) throw new OrgError('NOT_FOUND', 'no such organisation');
  const role = await roleIn(orgId, actorId, db);
  if (!role) throw new OrgError('FORBIDDEN', 'not a member of an active organisation');
  return role;
}

/** Bring somebody in. They must already have signed in to Basu once — that is who they are. */
export async function addMember(input: { orgId: string; guestId: string; role: OrgRole; by: string; now: Date }): Promise<void> {
  if (!ORG_ROLES.includes(input.role)) throw new OrgError('BAD_INPUT', `no such role: ${input.role}`);
  const db = getPool();
  const actor = await actorRole(input.orgId, input.by, db);
  if (!mayHandle(actor, input.role)) throw new OrgError('FORBIDDEN', `a ${actor} cannot give the role ${input.role}`);
  const { rowCount } = await db.query(
    `INSERT INTO org.membership (org_id, guest_id, role, added_by, added_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, guest_id) DO NOTHING`,
    [input.orgId, input.guestId, input.role, input.by, input.now],
  );
  if (!rowCount) throw new OrgError('ALREADY_MEMBER', 'already a member here');
}

/** Change a member's role. Both the old role and the new must be the actor's to give. */
export async function setRole(input: { orgId: string; guestId: string; role: OrgRole; by: string }): Promise<void> {
  if (!ORG_ROLES.includes(input.role)) throw new OrgError('BAD_INPUT', `no such role: ${input.role}`);
  await tx(async (client) => {
    const actor = await actorRole(input.orgId, input.by, client);
    const current = await client.query<{ role: OrgRole }>(
      'SELECT role FROM org.membership WHERE org_id = $1 AND guest_id = $2 FOR UPDATE',
      [input.orgId, input.guestId],
    );
    const was = current.rows[0]?.role;
    if (!was) throw new OrgError('NOT_FOUND', 'not a member here');
    if (!mayHandle(actor, was) || !mayHandle(actor, input.role)) {
      throw new OrgError('FORBIDDEN', `a ${actor} cannot change a ${was} into a ${input.role}`);
    }
    if (was === 'owner' && input.role !== 'owner') await keepAnOwner(client, input.orgId);
    await client.query('UPDATE org.membership SET role = $3 WHERE org_id = $1 AND guest_id = $2', [
      input.orgId,
      input.guestId,
      input.role,
    ]);
  });
}

/** Take somebody out. Anybody may leave; an organisation never loses its last owner. */
export async function removeMember(input: { orgId: string; guestId: string; by: string }): Promise<void> {
  await tx(async (client) => {
    const current = await client.query<{ role: OrgRole }>(
      'SELECT role FROM org.membership WHERE org_id = $1 AND guest_id = $2 FOR UPDATE',
      [input.orgId, input.guestId],
    );
    const was = current.rows[0]?.role;
    if (!was) throw new OrgError('NOT_FOUND', 'not a member here');
    if (input.guestId !== input.by) {
      const actor = await actorRole(input.orgId, input.by, client);
      if (!mayHandle(actor, was)) throw new OrgError('FORBIDDEN', `a ${actor} cannot remove a ${was}`);
    }
    if (was === 'owner') await keepAnOwner(client, input.orgId);
    await client.query('DELETE FROM org.membership WHERE org_id = $1 AND guest_id = $2', [input.orgId, input.guestId]);
  });
}

async function keepAnOwner(client: Db, orgId: string): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org.membership WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  if ((rows[0]?.n ?? 0) <= 1) throw new OrgError('LAST_OWNER', 'an organisation keeps at least one owner');
}

/** The organisation's details, changed by its owner or a manager. */
export async function updateOrg(input: Partial<OrgInput> & { orgId: string; by: string }): Promise<Organization> {
  const db = getPool();
  const actor = await actorRole(input.orgId, input.by, db);
  if (!can(actor, 'profile')) throw new OrgError('FORBIDDEN', 'only an owner or a manager changes the details');
  const current = (await orgById(input.orgId, db))!;
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

export async function approveOrg(input: { id: string; by: string; now: Date }, db: Db = getPool()): Promise<Organization> {
  const { rows } = await db.query<Row>(
    `UPDATE org.organization o SET state = 'active', decided_at = $2, decided_by = $3, decline_reason = NULL
      WHERE o.id = $1 AND o.state = 'applied' RETURNING ${COLUMNS}`,
    [input.id, input.now, input.by],
  );
  if (!rows[0]) throw new OrgError('NOT_PENDING', 'nothing is waiting under that id');
  return shape(rows[0]);
}

export async function declineOrg(input: { id: string; reason?: string | null; by: string; now: Date }, db: Db = getPool()): Promise<Organization> {
  const { rows } = await db.query<Row>(
    `UPDATE org.organization o SET state = 'declined', decided_at = $2, decided_by = $3, decline_reason = $4
      WHERE o.id = $1 AND o.state = 'applied' RETURNING ${COLUMNS}`,
    [input.id, input.now, input.by, input.reason?.trim().slice(0, 300) || null],
  );
  if (!rows[0]) throw new OrgError('NOT_PENDING', 'nothing is waiting under that id');
  return shape(rows[0]);
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
    return (await orgById(rows[0]!.id, client))!;
  });
}
