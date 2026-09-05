import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { AuthError } from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';

/**
 * Suppliers, and the screens they hold.
 *
 * There is no sign-up form. A supplier is somebody Basu has a contract with,
 * and ops writes the row by script once that is true — `contracted_at` is
 * what the guest's screen calls «баталгаатай». The device half is the kitchen
 * tablet's mechanism in its own table: identity does not know what a supplier
 * is, and dine's table names a restaurant.
 */

const PAIRING_TTL_MINUTES = 10;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface SupplierInput {
  name: string;
  phone: string;
  merchantTin?: string | null;
  pickupAddress: string;
  lat?: number | null;
  lon?: number | null;
}

export async function registerSupplier(input: SupplierInput, db: Db = getPool()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.supplier (name, phone, ebarimt_merchant_tin, pickup_address, lat, lon)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.name,
      input.phone,
      input.merchantTin ?? null,
      input.pickupAddress,
      input.lat ?? null,
      input.lon ?? null,
    ],
  );
  return rows[0]!.id;
}

export interface SupplierRow {
  id: string;
  name: string;
  phone: string;
  pickupAddress: string;
  lat: number | null;
  lon: number | null;
  active: boolean;
  /** Whether a screen is currently paired — the demo's «холбогдсон» tag. */
  watched: boolean;
}

export async function listSuppliers(db: Db = getPool()): Promise<SupplierRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    phone: string;
    pickup_address: string;
    lat: number | null;
    lon: number | null;
    active: boolean;
    watched: boolean;
  }>(
    `SELECT s.id, s.name, s.phone, s.pickup_address, s.lat, s.lon, s.active,
            EXISTS (SELECT 1 FROM idesh.supplier_device d
                     WHERE d.supplier_id = s.id AND d.revoked_at IS NULL
                       AND d.paired_at IS NOT NULL) AS watched
       FROM idesh.supplier s
      ORDER BY s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    pickupAddress: r.pickup_address,
    lat: r.lat === null ? null : Number(r.lat),
    lon: r.lon === null ? null : Number(r.lon),
    active: r.active,
    watched: r.watched,
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

export async function pairSupplier(ctx: Ctx, pairingCode: string): Promise<SupplierSession> {
  const now = ctx.clock.now();
  const token = randomBytes(32).toString('base64url');

  const { rows } = await getPool().query<{ id: string; supplier_id: string }>(
    `UPDATE idesh.supplier_device
        SET token_hash = $2, paired_at = $3, pairing_code = NULL, last_seen_at = $3
      WHERE pairing_code = $1
        AND paired_at IS NULL
        AND pairing_expires_at > $3
      RETURNING id, supplier_id`,
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

/** The codes the seed minted and nobody has typed yet. Demo only. */
export async function unpairedCodes(
  db: Db = getPool(),
): Promise<Array<{ code: string; name: string; supplierId: string }>> {
  const { rows } = await db.query<{ code: string; name: string; supplier_id: string }>(
    `SELECT d.pairing_code AS code, s.name, s.id AS supplier_id
       FROM idesh.supplier_device d JOIN idesh.supplier s ON s.id = d.supplier_id
      WHERE d.paired_at IS NULL AND d.pairing_code IS NOT NULL
      ORDER BY s.name`,
  );
  return rows.map((r) => ({ code: r.code, name: r.name, supplierId: r.supplier_id }));
}
