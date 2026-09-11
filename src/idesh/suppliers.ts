import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getPool, tx, type Db } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { AuthError, contactsFor, guestForPhone } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';

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

/** Ops writes a contracted supplier straight in — the script, or the ops page. */
export async function registerSupplier(input: SupplierInput, db: Db = getPool()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.supplier
       (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, state, contracted_at,
        bank_name, bank_account, bank_holder, owner_guest_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'contracted', now(), $7, $8, $9, $10) RETURNING id`,
    [
      input.name.trim(),
      input.phone,
      input.merchantTin ?? null,
      input.pickupAddress.trim(),
      input.lat ?? null,
      input.lon ?? null,
      input.bankName?.trim() || null,
      input.bankAccount?.replace(/\s+/g, '') || null,
      input.bankHolder?.trim() || null,
      await guestForPhone(input.phone),
    ],
  );
  return rows[0]!.id;
}

/**
 * The person a supplier answers to — the guest whose phone it is. Made on
 * first need for suppliers written in before there were owners.
 */
export async function ownerOf(supplierId: string, db: Db = getPool()): Promise<string | null> {
  const { rows } = await db.query<{ owner_guest_id: string | null; phone: string }>(
    'SELECT owner_guest_id, phone FROM idesh.supplier WHERE id = $1',
    [supplierId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.owner_guest_id) return row.owner_guest_id;
  const guestId = await guestForPhone(row.phone);
  await db.query('UPDATE idesh.supplier SET owner_guest_id = $2 WHERE id = $1 AND owner_guest_id IS NULL', [
    supplierId,
    guestId,
  ]);
  return guestId;
}

/** The supplier this guest owns, if they own one that is not declined. */
export async function supplierOf(
  guestId: string,
  db: Db = getPool(),
): Promise<{ id: string; name: string; state: SupplierState } | null> {
  const { rows } = await db.query<{ id: string; name: string; state: SupplierState }>(
    `SELECT id, name, state FROM idesh.supplier
      WHERE owner_guest_id = $1 AND state <> 'declined' AND active
      ORDER BY (state = 'contracted') DESC, contracted_at DESC NULLS LAST
      LIMIT 1`,
    [guestId],
  );
  return rows[0] ?? null;
}

/* ── applying ──────────────────────────────────────────────────────── */

export interface ApplicationInput extends BankDetails {
  guestId: string;
  name: string;
  merchantTin?: string | null;
  pickupAddress: string;
  lat?: number | null;
  lon?: number | null;
  about?: string | null;
}

/**
 * Ask to become a supplier.
 *
 * The phone is the one the guest signed in with, not one typed into the form:
 * it is the number a guest will ring about their meat, and the OTP is the
 * only proof anybody has that it is really theirs. One open application per
 * person; a declined one may ask again.
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

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO idesh.supplier
         (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, about,
          state, owner_guest_id, applied_at, active, bank_name, bank_account, bank_holder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, $9, true, $10, $11, $12) RETURNING id`,
      [
        name,
        contact.phone,
        input.merchantTin || null,
        address,
        input.lat ?? null,
        input.lon ?? null,
        input.about?.trim() || null,
        input.guestId,
        ctx.clock.now(),
        input.bankName?.trim() || null,
        input.bankAccount?.replace(/\s+/g, '') || null,
        input.bankHolder?.trim() || null,
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
          SET state = 'contracted', contracted_at = $2, decided_at = $2, decline_reason = NULL
        WHERE id = $1 AND state = 'applied'
        RETURNING owner_guest_id, name`,
      [supplierId, now],
    );
    return rows[0] ?? null;
  });
  if (!approved) throw new IdeshError('NOT_PENDING', 'no application is waiting under that id');

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
    watched: boolean;
    listings: number;
  }>(
    `SELECT s.id, s.name, s.phone, s.ebarimt_merchant_tin, s.pickup_address, s.about,
            s.lat, s.lon, s.state, s.active, s.applied_at, s.contracted_at, s.decline_reason,
            s.commission_pct, s.bank_name, s.bank_account, s.bank_holder,
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
    bankAccount: r.bank_account,
    bankHolder: r.bank_holder,
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

/** What a supplier may change about themselves: how they are named and found, and where the money goes. */
export async function updateSupplierProfile(supplierId: string, edit: ProfileEdit, db: Db = getPool()): Promise<void> {
  if (edit.name !== undefined && edit.name.trim().length < 2) throw new IdeshError('WRONG_STATE', 'a supplier needs a name');
  if (edit.pickupAddress !== undefined && edit.pickupAddress.trim().length < 4) {
    throw new IdeshError('WRONG_STATE', 'a supplier needs a pickup address');
  }
  if (edit.bankAccount && !/^\d{6,20}$/.test(edit.bankAccount.replace(/\s+/g, ''))) {
    throw new IdeshError('WRONG_STATE', 'an account number is 6 to 20 digits');
  }
  const { rowCount } = await db.query(
    `UPDATE idesh.supplier
        SET name           = COALESCE($2, name),
            pickup_address = COALESCE($3, pickup_address),
            about          = CASE WHEN $4::boolean THEN $5 ELSE about END,
            lat            = CASE WHEN $6::boolean THEN $7 ELSE lat END,
            lon            = CASE WHEN $6::boolean THEN $8 ELSE lon END,
            bank_name      = COALESCE($9, bank_name),
            bank_account   = COALESCE($10, bank_account),
            bank_holder    = COALESCE($11, bank_holder)
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
      edit.bankAccount?.replace(/\s+/g, '') || null,
      edit.bankHolder?.trim() || null,
    ],
  );
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
            ebarimt_merchant_tin = COALESCE($6, ebarimt_merchant_tin)
      WHERE id = $1`,
    [
      supplierId,
      patch.commissionPct ?? null,
      patch.bankName?.trim() || null,
      patch.bankAccount?.replace(/\s+/g, '') || null,
      patch.bankHolder?.trim() || null,
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
