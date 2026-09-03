import { randomBytes, randomInt } from 'node:crypto';
import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { mode } from '../mode.js';
import { AuthError } from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';

/**
 * The kitchen tablets.
 *
 * This used to sit beside the guest sign-in, on the grounds that both mint a
 * token. They are not the same thing: a guest is a person the platform knows
 * across every vertical, and a tablet is a piece of restaurant equipment that
 * only dine-in has. Identity does not know what a kitchen is, and after
 * migration 010 it cannot read `dine.kds_device` either.
 */

const PAIRING_TTL_MINUTES = 10;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Ops generates this; the manager types it into the tablet once.
 *
 * `ttlMinutes` is a parameter because the demo drives the clock forward by
 * hours, and a ten-minute code minted at 11:40 is useless by 12:22 — which is
 * exactly when someone following the walkthrough tries to use it.
 */
export async function createPairingCode(
  ctx: Ctx,
  restaurantId: string,
  label: string,
  ttlMinutes = PAIRING_TTL_MINUTES,
): Promise<string> {
  const now = ctx.clock.now();
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  await getPool().query(
    `INSERT INTO dine.kds_device (restaurant_id, label, pairing_code, pairing_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [restaurantId, label, code, addMinutes(now, ttlMinutes)],
  );
  return code;
}

export interface DeviceSession {
  token: string;
  deviceId: string;
  restaurantId: string;
}

export async function pairDevice(ctx: Ctx, pairingCode: string): Promise<DeviceSession> {
  const now = ctx.clock.now();
  const token = randomBytes(32).toString('base64url');

  const { rows } = await getPool().query<{ id: string; restaurant_id: string }>(
    `UPDATE dine.kds_device
        SET token_hash = $2, paired_at = $3, pairing_code = NULL, last_seen_at = $3
      WHERE pairing_code = $1
        AND paired_at IS NULL
        AND pairing_expires_at > $3
      RETURNING id, restaurant_id`,
    [pairingCode, sha256(token), now],
  );
  const device = rows[0];
  if (!device) throw new AuthError('INVALID_CODE', 'that pairing code is not usable');

  return { token, deviceId: device.id, restaurantId: device.restaurant_id };
}

export interface DeviceIdentity {
  deviceId: string;
  restaurantId: string;
}

/**
 * Resolving a device token also records the heartbeat. That is deliberate: any
 * call from the tablet proves it is alive, so liveness needs no separate ping
 * and cannot drift out of sync with real activity.
 */
export async function resolveDevice(ctx: Ctx, token: string): Promise<DeviceIdentity | null> {
  const { rows } = await getPool().query<{ id: string; restaurant_id: string }>(
    `UPDATE dine.kds_device SET last_seen_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, restaurant_id`,
    [sha256(token), ctx.clock.now()],
  );
  const device = rows[0];
  return device ? { deviceId: device.id, restaurantId: device.restaurant_id } : null;
}

export async function revokeDevice(deviceId: string, at: Date): Promise<void> {
  await getPool().query('UPDATE dine.kds_device SET revoked_at = $2, token_hash = NULL WHERE id = $1', [
    deviceId,
    at,
  ]);
}

/**
 * A restaurant nobody is watching cannot be sent new orders.
 *
 * In production this is load-bearing: taking money for food when no tablet is
 * on to cook it is the worst thing the system can do. In demo mode it is only
 * in the way — the point of the demo is to walk the ordering flow, and needing
 * a second tab open before the first one works turns a guard into a puzzle.
 */
export async function isRestaurantOnline(
  ctx: Ctx,
  restaurantId: string,
  staleSeconds = 90,
): Promise<boolean> {
  if (mode() === 'demo') return true;

  const { rows } = await getPool().query<{ online: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dine.kds_device
        WHERE restaurant_id = $1 AND revoked_at IS NULL
          AND last_seen_at > $2::timestamptz - make_interval(secs => $3)
     ) AS online`,
    [restaurantId, ctx.clock.now(), staleSeconds],
  );
  return rows[0]?.online ?? false;
}
