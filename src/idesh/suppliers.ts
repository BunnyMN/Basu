import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getPool, tx, type Db } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { AuthError, contactsFor } from '../platform/identity/index.js';
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

export interface SupplierInput {
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
       (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon, state, contracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'contracted', now()) RETURNING id`,
    [
      input.name.trim(),
      input.phone,
      input.merchantTin ?? null,
      input.pickupAddress.trim(),
      input.lat ?? null,
      input.lon ?? null,
    ],
  );
  return rows[0]!.id;
}

/* ── applying ──────────────────────────────────────────────────────── */

export interface ApplicationInput {
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
          state, applicant_guest_id, applied_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, $9, true) RETURNING id`,
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
      WHERE s.applicant_guest_id = $1
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
    const { rows } = await client.query<{ applicant_guest_id: string | null; name: string }>(
      `UPDATE idesh.supplier
          SET state = 'contracted', contracted_at = $2, decided_at = $2, decline_reason = NULL
        WHERE id = $1 AND state = 'applied'
        RETURNING applicant_guest_id, name`,
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

  if (approved.applicant_guest_id) {
    await enqueue(ctx, {
      guestId: approved.applicant_guest_id,
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
  const { rows } = await getPool().query<{ applicant_guest_id: string | null; name: string }>(
    `UPDATE idesh.supplier
        SET state = 'declined', decided_at = $2, decline_reason = $3, active = false
      WHERE id = $1 AND state = 'applied'
      RETURNING applicant_guest_id, name`,
    [supplierId, now, why],
  );
  const declined = rows[0];
  if (!declined) throw new IdeshError('NOT_PENDING', 'no application is waiting under that id');

  if (declined.applicant_guest_id) {
    await enqueue(ctx, {
      guestId: declined.applicant_guest_id,
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
    watched: boolean;
    listings: number;
  }>(
    `SELECT s.id, s.name, s.phone, s.ebarimt_merchant_tin, s.pickup_address, s.about,
            s.lat, s.lon, s.state, s.active, s.applied_at, s.contracted_at, s.decline_reason,
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
    watched: r.watched,
    listings: r.listings,
  }));
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
