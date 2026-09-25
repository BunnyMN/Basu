import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getPool, tx, type Db } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { AuthError, contactsFor, requirePhone } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import { orgForExisting, orgsOf, type OrgRole } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';
import { seal, unseal } from '../secret.js';

/**
 * Suppliers, how one becomes one, and the screens they hold.
 *
 * A supplier is somebody Basu has a contract with — `contracted_at` is what
 * the guest's screen calls «баталгаатай». Two ways in: ops writes the row
 * (by script, or from the ops page), or a person applies from the supplier
 * page with a phone they have proved and ops says yes. Either way the row
 * carries a state, and nothing an unapproved row lists reaches a guest.
 *
 * The device half is the kitchen tablet's mechanism in its own table:
 * identity does not know what a supplier is, and dine's table names a
 * restaurant.
 */

const PAIRING_TTL_MINUTES = 10;
/** A code that goes out by SMS has to survive a day of not being read. */
const APPROVAL_CODE_TTL_MINUTES = 24 * 60;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type SupplierState = 'applied' | 'contracted' | 'declined';

export interface BankDetails {
  bankName?: string | null | undefined;
  bankAccount?: string | null | undefined;
  bankHolder?: string | null | undefined;
}

export interface SupplierInput extends BankDetails {
  name: string;
  phone: string;
  merchantTin?: string | null;
  pickupAddress: string;
  lat?: number | null;
  lon?: number | null;
}

/**
 * Ops writes a contracted supplier straight in — the script, or the ops page
 * — for a person who already has a Basu account: `ownerId` is that account,
 * and it owns the business from the start. An account is never made here
 * for somebody who has not signed in; one made so would hold the business
 * with nobody able to open it.
 */
export async function registerSupplier(input: SupplierInput & { ownerId: string }, db: Db = getPool()): Promise<string> {
  const id = await insertContracted(input, db);
  await giveOrganisation(id, db);
  return id;
}

async function insertContracted(input: SupplierInput & { ownerId: string }, db: Db): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.supplier
       (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, state, contracted_at,
        bank_name, bank_account, bank_holder, owner_guest_id, bank_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'contracted', now(), $7, $8, $9, $10, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [
      input.name.trim(),
      input.phone,
      input.merchantTin ?? null,
      input.pickupAddress.trim(),
      input.lat ?? null,
      input.lon ?? null,
      input.bankName?.trim() || null,
      seal(input.bankAccount?.replace(/\s+/g, '')),
      seal(input.bankHolder?.trim()),
      input.ownerId,
    ],
  );
  return rows[0]!.id;
}

/** The account a supplier answers to, if it has one. */
export async function ownerOf(supplierId: string, db: Db = getPool()): Promise<string | null> {
  const { rows } = await db.query<{ owner_guest_id: string | null }>(
    'SELECT owner_guest_id FROM idesh.supplier WHERE id = $1',
    [supplierId],
  );
  return rows[0]?.owner_guest_id ?? null;
}

/**
 * A supplier that has no organisation yet gets one, its owner the
 * organisation's owner — so the people who work there can be brought in.
 */
async function giveOrganisation(supplierId: string, db: Db = getPool()): Promise<void> {
  const { rows } = await db.query<{
    name: string;
    phone: string;
    pickup_address: string;
    lat: string | null;
    lon: string | null;
    ebarimt_merchant_tin: string | null;
    about: string | null;
    owner_guest_id: string | null;
    org_id: string | null;
  }>(
    `SELECT name, phone, pickup_address, lat, lon, ebarimt_merchant_tin, about, owner_guest_id, org_id
       FROM idesh.supplier WHERE id = $1`,
    [supplierId],
  );
  const s = rows[0];
  if (!s || s.org_id || !s.owner_guest_id) return;
  const org = await orgForExisting({
    name: s.name,
    restaurant: false,
    supplier: true,
    phone: s.phone,
    address: s.pickup_address,
    lat: s.lat === null ? null : Number(s.lat),
    lon: s.lon === null ? null : Number(s.lon),
    tin: s.ebarimt_merchant_tin,
    about: s.about,
    ownerId: s.owner_guest_id,
    now: new Date(),
  });
  await db.query('UPDATE idesh.supplier SET org_id = $2 WHERE id = $1 AND org_id IS NULL', [supplierId, org.id]);
}

/**
 * The supplier of an organisation the desk has just approved: contracted at
 * once, its owner the organisation's owner.
 */
export async function supplierForOrg(input: {
  orgId: string;
  ownerId: string;
  name: string;
  phone: string;
  address: string;
  lat?: number | null;
  lon?: number | null;
  tin?: string | null;
  about?: string | null;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO idesh.supplier
       (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, about, state, contracted_at, owner_guest_id, org_id, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'contracted', now(), $8, $9, now()) RETURNING id`,
    [input.name, input.phone, input.tin ?? null, input.address, input.lat ?? null, input.lon ?? null, input.about ?? null, input.ownerId, input.orgId],
  );
  return rows[0]!.id;
}

/** Who a person is at a supplier: their role in the organisation it belongs to. */
export type SupplierRole = OrgRole;

const ROLE_RANK: Record<OrgRole, number> = { owner: 0, manager: 1, accountant: 2, staff: 3 };

/**
 * The supplier this guest works at, if any that is not declined, and their
 * role there.
 *
 * The organisation is the only thing that grants a role: a member of an
 * active supplier organisation is whatever the organisation says, and an
 * owner who handed the business on, or was taken out of it, is nothing
 * here any more — whatever `owner_guest_id` still remembers. With `orgId`
 * the answer is about that business alone, for a person in several; without
 * it, the one where they hold the most, contracted first.
 *
 * Only a supplier with no organisation yet — an application still waiting,
 * or a row ops wrote in before there were organisations — is its owner's by
 * `owner_guest_id`, and one written in before there were owners at all is
 * claimed here by the phone on its row matching the one the guest proved.
 */
export async function supplierOf(
  guestId: string,
  opts: { orgId?: string | null } = {},
  db: Db = getPool(),
): Promise<{ id: string; name: string; state: SupplierState; role: SupplierRole; orgId: string | null } | null> {
  const memberships = (await orgsOf(guestId, db)).filter(
    (m) => m.org.state === 'active' && m.org.supplier && (!opts.orgId || m.org.id === opts.orgId),
  );
  if (memberships.length) {
    const { rows } = await db.query<{ id: string; name: string; state: SupplierState; org_id: string; contracted_at: Date | null }>(
      `SELECT id, name, state, org_id, contracted_at FROM idesh.supplier
        WHERE org_id = ANY($1::uuid[]) AND state <> 'declined' AND active`,
      [memberships.map((m) => m.org.id)],
    );
    const roleOf = (orgId: string) => memberships.find((m) => m.org.id === orgId)!.role;
    const best = rows.sort(
      (a, b) =>
        ROLE_RANK[roleOf(a.org_id)] - ROLE_RANK[roleOf(b.org_id)] ||
        Number(b.state === 'contracted') - Number(a.state === 'contracted') ||
        (b.contracted_at?.getTime() ?? 0) - (a.contracted_at?.getTime() ?? 0),
    )[0];
    if (best) return { id: best.id, name: best.name, state: best.state, role: roleOf(best.org_id), orgId: best.org_id };
  }
  if (opts.orgId) return null;

  const owned = await db.query<{ id: string; name: string; state: SupplierState }>(
    `SELECT id, name, state FROM idesh.supplier
      WHERE owner_guest_id = $1 AND org_id IS NULL AND state <> 'declined' AND active
      ORDER BY (state = 'contracted') DESC, contracted_at DESC NULLS LAST
      LIMIT 1`,
    [guestId],
  );
  if (owned.rows[0]) return { ...owned.rows[0], role: 'owner', orgId: null };

  const phone = (await contactsFor([guestId])).get(guestId)?.phone;
  if (!phone) return null;
  const claimed = await db.query<{ id: string; name: string; state: SupplierState }>(
    `UPDATE idesh.supplier SET owner_guest_id = $1
      WHERE id = (SELECT id FROM idesh.supplier
                   WHERE phone = $2 AND owner_guest_id IS NULL AND state <> 'declined' AND active
                   ORDER BY (state = 'contracted') DESC, contracted_at DESC NULLS LAST
                   LIMIT 1)
      RETURNING id, name, state`,
    [guestId, phone],
  );
  if (!claimed.rows[0]) return null;
  await giveOrganisation(claimed.rows[0].id, db);
  const org = await db.query<{ org_id: string | null }>('SELECT org_id FROM idesh.supplier WHERE id = $1', [claimed.rows[0].id]);
  return { ...claimed.rows[0], role: 'owner', orgId: org.rows[0]?.org_id ?? null };
}

/** The supplier a business runs, if it is one — what the business's dashboard asks before opening its supplier pages. */
export async function supplierOfOrg(
  orgId: string,
  db: Db = getPool(),
): Promise<{ id: string; name: string; state: SupplierState; active: boolean } | null> {
  const { rows } = await db.query<{ id: string; name: string; state: SupplierState; active: boolean }>(
    `SELECT id, name, state, active FROM idesh.supplier WHERE org_id = $1
      ORDER BY (state = 'contracted') DESC, contracted_at DESC NULLS LAST LIMIT 1`,
    [orgId],
  );
  return rows[0] ?? null;
}

/* ── applying ──────────────────────────────────────────────────────── */

export interface ApplicationInput extends BankDetails {
  guestId: string;
  name: string;
  /** Only for an account made without a phone; an account's own always wins. */
  phone?: string | null;
  merchantTin?: string | null;
  pickupAddress: string;
  lat?: number | null;
  lon?: number | null;
  about?: string | null;
}

/**
 * Ask to become a supplier.
 *
 * The phone is the number a guest will ring about their meat. An account
 * made with one applies with that one, never a number typed over it. An
 * account made by email, Google or Apple has none, so it types one — and ops,
 * ringing it before saying yes, is the proof it is theirs. One open
 * application per person; a declined one may ask again.
 */
export async function applySupplier(ctx: Ctx, input: ApplicationInput): Promise<string> {
  const name = input.name.trim();
  const address = input.pickupAddress.trim();
  if (name.length < 2) throw new IdeshError('WRONG_STATE', 'a supplier needs a name');
  if (address.length < 4) throw new IdeshError('WRONG_STATE', 'a supplier needs a pickup address');
  if (input.merchantTin && !/^\d{7,10}$/.test(input.merchantTin)) {
    throw new IdeshError('WRONG_STATE', 'a TIN is seven to ten digits');
  }

  const contact = (await contactsFor([input.guestId])).get(input.guestId);
  if (!contact) throw new IdeshError('NOT_FOUND', 'no such guest');
  const typed = input.phone?.trim();
  const phone = contact.phone ?? (typed ? requirePhone(typed) : null);
  if (!phone) throw new IdeshError('NEEDS_PHONE', 'an account without a phone gives one to apply');

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO idesh.supplier
         (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, about,
          state, owner_guest_id, applied_at, active, bank_name, bank_account, bank_holder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, $9, true, $10, $11, $12) RETURNING id`,
      [
        name,
        phone,
        input.merchantTin || null,
        address,
        input.lat ?? null,
        input.lon ?? null,
        input.about?.trim() || null,
        input.guestId,
        ctx.clock.now(),
        input.bankName?.trim() || null,
        seal(input.bankAccount?.replace(/\s+/g, '')),
        seal(input.bankHolder?.trim()),
      ],
    );
    return rows[0]!.id;
  } catch (error) {
    // The partial unique index: this person already has one open, or is one.
    if ((error as { code?: string }).code === '23505') {
      throw new IdeshError('ALREADY_APPLIED', 'this guest already applied or is a supplier');
    }
    throw error;
  }
}

export interface Application {
  id: string;
  name: string;
  state: SupplierState;
  appliedAt: Date | null;
  decidedAt: Date | null;
  declineReason: string | null;
  /** A code minted for this supplier that nobody has typed yet. */
  pairingCode: string | null;
  /** Whether a screen is already paired — the code has done its job. */
  paired: boolean;
}

/** What the applicant sees on the supplier page: the latest thing they asked. */
export async function applicationOf(ctx: Ctx, guestId: string): Promise<Application | null> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    state: SupplierState;
    applied_at: Date | null;
    decided_at: Date | null;
    decline_reason: string | null;
    pairing_code: string | null;
    paired: boolean;
  }>(
    `SELECT s.id, s.name, s.state, s.applied_at, s.decided_at, s.decline_reason,
            (SELECT d.pairing_code FROM idesh.supplier_device d
              WHERE d.supplier_id = s.id AND d.paired_at IS NULL
                AND d.pairing_code IS NOT NULL AND d.pairing_expires_at > $2
              ORDER BY d.created_at DESC LIMIT 1) AS pairing_code,
            EXISTS (SELECT 1 FROM idesh.supplier_device d
                     WHERE d.supplier_id = s.id AND d.paired_at IS NOT NULL
                       AND d.revoked_at IS NULL) AS paired
       FROM idesh.supplier s
      WHERE s.owner_guest_id = $1
      -- The one that still matters: an open or contracted row over a declined
      -- one, then the newest. Two rows can share an instant on the demo clock.
      ORDER BY (s.state = 'declined') ASC, s.applied_at DESC NULLS LAST
      LIMIT 1`,
    [guestId, ctx.clock.now()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    appliedAt: r.applied_at,
    decidedAt: r.decided_at,
    declineReason: r.decline_reason,
    pairingCode: r.pairing_code,
    paired: r.paired,
  };
}

/* ── ops decides ───────────────────────────────────────────────────── */

/**
 * Yes. The row becomes a supplier, a code good for a day is minted, and the
 * applicant is told by SMS — the same message a script would have read out
 * over the phone.
 */
export async function approveSupplier(ctx: Ctx, supplierId: string): Promise<{ pairingCode: string }> {
  const now = ctx.clock.now();
  const approved = await tx(async (client) => {
    const { rows } = await client.query<{ owner_guest_id: string | null; name: string }>(
      `UPDATE idesh.supplier
          SET state = 'contracted', contracted_at = $2, decided_at = $2,
             bank_verified_at = CASE WHEN bank_account IS NOT NULL THEN $2::timestamptz ELSE NULL END, decline_reason = NULL
        WHERE id = $1 AND state = 'applied'
        RETURNING owner_guest_id, name`,
      [supplierId, now],
    );
    return rows[0] ?? null;
  });
  if (!approved) throw new IdeshError('NOT_PENDING', 'no application is waiting under that id');
  await giveOrganisation(supplierId);

  const pairingCode = await createSupplierCode(
    ctx,
    supplierId,
    'Нийлүүлэгчийн дэлгэц',
    APPROVAL_CODE_TTL_MINUTES,
  );

  if (approved.owner_guest_id) {
    await enqueue(ctx, {
      guestId: approved.owner_guest_id,
      subject: 'supplier',
      subjectId: supplierId,
      template: 'supplier.approved',
      channel: 'sms',
      title: 'Нийлүүлэгчээр батлагдлаа',
      body: `Basu: «${approved.name}» нийлүүлэгчээр батлагдлаа. Дэлгэц холбох код: ${pairingCode} (24 цаг). /supplier хуудсанд оруулаад зараа тавина уу.`,
      dedupeKey: `supplier:${supplierId}:approved:${pairingCode}`,
    });
  }
  return { pairingCode };
}

/** No, and why. The row stays as the record; the person may ask again. */
export async function declineSupplier(ctx: Ctx, supplierId: string, reason: string): Promise<void> {
  const now = ctx.clock.now();
  const why = reason.trim() || 'шалтгаан заагаагүй';
  const { rows } = await getPool().query<{ owner_guest_id: string | null; name: string }>(
    `UPDATE idesh.supplier
        SET state = 'declined', decided_at = $2, decline_reason = $3, active = false
      WHERE id = $1 AND state = 'applied'
      RETURNING owner_guest_id, name`,
    [supplierId, now, why],
  );
  const declined = rows[0];
  if (!declined) throw new IdeshError('NOT_PENDING', 'no application is waiting under that id');

  if (declined.owner_guest_id) {
    await enqueue(ctx, {
      guestId: declined.owner_guest_id,
      subject: 'supplier',
      subjectId: supplierId,
      template: 'supplier.declined',
      channel: 'sms',
      title: 'Нийлүүлэгчийн хүсэлт',
      body: `Basu: «${declined.name}» хүсэлтийг батлах боломжгүй байлаа. Шалтгаан: ${why}. Засаад дахин хүсэлт гаргаж болно.`,
      dedupeKey: `supplier:${supplierId}:declined:${now.getTime()}`,
    });
  }
}

export interface SupplierRow {
  id: string;
  name: string;
  phone: string;
  merchantTin: string | null;
  pickupAddress: string;
  about: string | null;
  lat: number | null;
  lon: number | null;
  state: SupplierState;
  active: boolean;
  appliedAt: Date | null;
  contractedAt: Date | null;
  declineReason: string | null;
  /** Basu's share of the meat price, per contract. */
  commissionPct: number;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  /** Checked against the contract by finance; a changed account is not, until they do. */
  bankVerified: boolean;
  bankChangedAt: Date | null;
  /** Whether a screen is currently paired — «холбогдсон» on the demo list. */
  watched: boolean;
  listings: number;
}

/** Every supplier and would-be supplier, for ops. Applications first. */
export async function listSuppliers(db: Db = getPool()): Promise<SupplierRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    phone: string;
    ebarimt_merchant_tin: string | null;
    pickup_address: string;
    about: string | null;
    lat: number | null;
    lon: number | null;
    state: SupplierState;
    active: boolean;
    applied_at: Date | null;
    contracted_at: Date | null;
    decline_reason: string | null;
    commission_pct: string;
    bank_name: string | null;
    bank_account: string | null;
    bank_holder: string | null;
    bank_verified_at: Date | null;
    bank_changed_at: Date | null;
    watched: boolean;
    listings: number;
  }>(
    `SELECT s.id, s.name, s.phone, s.ebarimt_merchant_tin, s.pickup_address, s.about,
            s.lat, s.lon, s.state, s.active, s.applied_at, s.contracted_at, s.decline_reason,
            s.commission_pct, s.bank_name, s.bank_account, s.bank_holder, s.bank_verified_at, s.bank_changed_at,
            EXISTS (SELECT 1 FROM idesh.supplier_device d
                     WHERE d.supplier_id = s.id AND d.revoked_at IS NULL
                       AND d.paired_at IS NOT NULL) AS watched,
            (SELECT count(*)::int FROM idesh.listing l WHERE l.supplier_id = s.id AND l.active) AS listings
       FROM idesh.supplier s
      ORDER BY (s.state = 'applied') DESC, s.applied_at DESC NULLS LAST, s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    merchantTin: r.ebarimt_merchant_tin,
    pickupAddress: r.pickup_address,
    about: r.about,
    lat: r.lat === null ? null : Number(r.lat),
    lon: r.lon === null ? null : Number(r.lon),
    state: r.state,
    active: r.active,
    appliedAt: r.applied_at,
    contractedAt: r.contracted_at,
    declineReason: r.decline_reason,
    commissionPct: Number(r.commission_pct),
    bankName: r.bank_name,
    bankAccount: unseal(r.bank_account),
    bankHolder: unseal(r.bank_holder),
    bankVerified: r.bank_verified_at !== null,
    bankChangedAt: r.bank_changed_at,
    watched: r.watched,
    listings: r.listings,
  }));
}

/** One supplier, as ops sees the row. */
export async function supplierById(supplierId: string, db: Db = getPool()): Promise<SupplierRow | null> {
  return (await listSuppliers(db)).find((s) => s.id === supplierId) ?? null;
}

export interface ProfileEdit extends BankDetails {
  name?: string | undefined;
  pickupAddress?: string | undefined;
  about?: string | null | undefined;
  lat?: number | null | undefined;
  lon?: number | null | undefined;
}

/**
 * What a supplier may change about themselves: how they are named and
 * found, and where the money goes. A changed account comes back flagged —
 * the caller tells the owner and finance checks it before anything is paid
 * to it.
 */
export async function updateSupplierProfile(
  supplierId: string,
  edit: ProfileEdit,
  db: Db = getPool(),
): Promise<{ bankChanged: boolean }> {
  if (edit.name !== undefined && edit.name.trim().length < 2) throw new IdeshError('WRONG_STATE', 'a supplier needs a name');
  if (edit.pickupAddress !== undefined && edit.pickupAddress.trim().length < 4) {
    throw new IdeshError('WRONG_STATE', 'a supplier needs a pickup address');
  }
  const account = edit.bankAccount?.replace(/\s+/g, '') || null;
  if (account && !/^\d{6,20}$/.test(account)) throw new IdeshError('WRONG_STATE', 'an account number is 6 to 20 digits');
  const bankChanged = await bankWouldChange(supplierId, edit, db);
  const { rowCount } = await db.query(
    `UPDATE idesh.supplier
        SET name           = COALESCE($2, name),
            pickup_address = COALESCE($3, pickup_address),
            about          = CASE WHEN $4::boolean THEN $5 ELSE about END,
            lat            = CASE WHEN $6::boolean THEN $7 ELSE lat END,
            lon            = CASE WHEN $6::boolean THEN $8 ELSE lon END,
            bank_name      = COALESCE($9, bank_name),
            bank_account   = COALESCE($10, bank_account),
            bank_holder    = COALESCE($11, bank_holder),
            bank_changed_at  = CASE WHEN $12::boolean THEN now() ELSE bank_changed_at END,
            bank_verified_at = CASE WHEN $12::boolean THEN NULL ELSE bank_verified_at END
      WHERE id = $1`,
    [
      supplierId,
      edit.name?.trim() || null,
      edit.pickupAddress?.trim() || null,
      edit.about !== undefined,
      edit.about?.trim() || null,
      edit.lat !== undefined || edit.lon !== undefined,
      edit.lat ?? null,
      edit.lon ?? null,
      edit.bankName?.trim() || null,
      seal(account),
      seal(edit.bankHolder?.trim()),
      bankChanged,
    ],
  );
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such supplier');
  return { bankChanged };
}

/** Would this edit move the money somewhere else than it goes today? */
export async function bankWouldChange(supplierId: string, edit: BankDetails, db: Db = getPool()): Promise<boolean> {
  const { rows } = await db.query<{ bank_name: string | null; bank_account: string | null; bank_holder: string | null }>(
    'SELECT bank_name, bank_account, bank_holder FROM idesh.supplier WHERE id = $1',
    [supplierId],
  );
  const now = rows[0];
  if (!now) return false;
  // Sealed text differs on every write, so the comparison happens in the clear.
  const held = { name: now.bank_name, account: unseal(now.bank_account), holder: unseal(now.bank_holder) };
  const next = {
    name: edit.bankName?.trim() || held.name,
    account: edit.bankAccount?.replace(/\s+/g, '') || held.account,
    holder: edit.bankHolder?.trim() || held.holder,
  };
  return next.name !== held.name || next.account !== held.account || next.holder !== held.holder;
}

/** Finance has checked the account against the contract: money may go there. */
export async function verifySupplierBank(supplierId: string, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query(
    'UPDATE idesh.supplier SET bank_verified_at = now() WHERE id = $1 AND bank_account IS NOT NULL',
    [supplierId],
  );
  if (!rowCount) throw new IdeshError('NEEDS_ACCOUNT', 'nothing on file to verify');
}

/** Ops takes a supplier off the market, or puts them back. Their orders in flight are untouched. */
export async function setSupplierActive(supplierId: string, active: boolean, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query('UPDATE idesh.supplier SET active = $2 WHERE id = $1', [supplierId, active]);
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such supplier');
}

export interface SupplierPatch extends BankDetails {
  commissionPct?: number | undefined;
  merchantTin?: string | null | undefined;
}

/** Ops writes the contract's terms in: the rate, the account, the TIN. */
export async function updateSupplier(supplierId: string, patch: SupplierPatch, db: Db = getPool()): Promise<void> {
  if (patch.commissionPct !== undefined && !(patch.commissionPct >= 0 && patch.commissionPct <= 100)) {
    throw new IdeshError('WRONG_STATE', 'a commission is 0 to 100 percent');
  }
  if (patch.merchantTin && !/^\d{7,14}$/.test(patch.merchantTin)) {
    throw new IdeshError('WRONG_STATE', 'a TIN is seven to fourteen digits');
  }
  const { rowCount } = await db.query(
    `UPDATE idesh.supplier
        SET commission_pct       = COALESCE($2, commission_pct),
            bank_name            = COALESCE($3, bank_name),
            bank_account         = COALESCE($4, bank_account),
            bank_holder          = COALESCE($5, bank_holder),
            ebarimt_merchant_tin = COALESCE($6, ebarimt_merchant_tin),
            bank_verified_at     = CASE WHEN $4::text IS NOT NULL THEN now() ELSE bank_verified_at END
      WHERE id = $1`,
    [
      supplierId,
      patch.commissionPct ?? null,
      patch.bankName?.trim() || null,
      seal(patch.bankAccount?.replace(/\s+/g, '')),
      seal(patch.bankHolder?.trim()),
      patch.merchantTin?.trim() || null,
    ],
  );
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such supplier');
}

/* ── the supplier's screen ─────────────────────────────────────────── */

/**
 * Ops mints this; the supplier types it once. `ttlMinutes` is a parameter for
 * the same reason as the tablet's: the demo clock jumps hours.
 */
export async function createSupplierCode(
  ctx: Ctx,
  supplierId: string,
  label: string,
  ttlMinutes = PAIRING_TTL_MINUTES,
): Promise<string> {
  const now = ctx.clock.now();
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  await getPool().query(
    `INSERT INTO idesh.supplier_device (supplier_id, label, pairing_code, pairing_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [supplierId, label, code, addMinutes(now, ttlMinutes)],
  );
  return code;
}

export interface SupplierSession {
  token: string;
  deviceId: string;
  supplierId: string;
}

/** Only a contracted supplier's code opens a screen; an applicant's does not exist yet. */
export async function pairSupplier(ctx: Ctx, pairingCode: string): Promise<SupplierSession> {
  const now = ctx.clock.now();
  const token = randomBytes(32).toString('base64url');

  const { rows } = await getPool().query<{ id: string; supplier_id: string }>(
    `UPDATE idesh.supplier_device d
        SET token_hash = $2, paired_at = $3, pairing_code = NULL, last_seen_at = $3
       FROM idesh.supplier s
      WHERE d.pairing_code = $1
        AND d.paired_at IS NULL
        AND d.pairing_expires_at > $3
        AND s.id = d.supplier_id AND s.state = 'contracted'
      RETURNING d.id, d.supplier_id`,
    [pairingCode, sha256(token), now],
  );
  const device = rows[0];
  if (!device) throw new AuthError('INVALID_CODE', 'that pairing code is not usable');

  return { token, deviceId: device.id, supplierId: device.supplier_id };
}

export interface SupplierDevice {
  deviceId: string;
  supplierId: string;
}

/** Resolving the token is the heartbeat, as with the tablet. */
export async function resolveSupplierDevice(
  ctx: Ctx,
  token: string,
): Promise<SupplierDevice | null> {
  const { rows } = await getPool().query<{ id: string; supplier_id: string }>(
    `UPDATE idesh.supplier_device SET last_seen_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, supplier_id`,
    [sha256(token), ctx.clock.now()],
  );
  const device = rows[0];
  return device ? { deviceId: device.id, supplierId: device.supplier_id } : null;
}

export async function revokeSupplierDevice(deviceId: string, at: Date): Promise<void> {
  await getPool().query(
    'UPDATE idesh.supplier_device SET revoked_at = $2, token_hash = NULL WHERE id = $1',
    [deviceId, at],
  );
}

/** The codes minted and not yet typed, for contracted suppliers. Demo only. */
export async function unpairedCodes(
  db: Db = getPool(),
): Promise<Array<{ code: string; name: string; supplierId: string }>> {
  const { rows } = await db.query<{ code: string; name: string; supplier_id: string }>(
    `SELECT d.pairing_code AS code, s.name, s.id AS supplier_id
       FROM idesh.supplier_device d JOIN idesh.supplier s ON s.id = d.supplier_id
      WHERE d.paired_at IS NULL AND d.pairing_code IS NOT NULL AND s.state = 'contracted'
      ORDER BY s.name`,
  );
  return rows.map((r) => ({ code: r.code, name: r.name, supplierId: r.supplier_id }));
}
