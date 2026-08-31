import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getPool, tx } from '../db/pool.js';
import { addMinutes } from '../domain/time.js';
import { mode } from '../mode.js';
import type { Ctx } from '../ports.js';

/**
 * Phone plus a one-time code, and a paired tablet.
 *
 * No passwords anywhere: a guest orders lunch, they should not have to invent
 * a credential to do it, and the restaurant's tablet is a device we hand over
 * in person. What is stored are hashes — a leaked table must not let anyone log
 * in as a guest or drive a kitchen display.
 */

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;
const SESSION_DAYS = 60;
const PAIRING_TTL_MINUTES = 10;

/** Per-phone and per-IP ceilings, from the security section of the spec. */
export const OTP_PER_PHONE_PER_HOUR = 3;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class AuthError extends Error {
  constructor(
    readonly code: 'RATE_LIMITED' | 'INVALID_CODE' | 'EXPIRED' | 'UNAUTHORIZED',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/* ── guests ────────────────────────────────────────────────────────── */

export interface OtpIssued {
  challengeId: string;
  /**
   * Returned only so the SMS layer can send it. It is never stored in the
   * clear and never returned over HTTP.
   */
  code: string;
}

export async function requestOtp(ctx: Ctx, phone: string): Promise<OtpIssued> {
  const now = ctx.clock.now();

  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM otp_challenge
      WHERE phone_e164 = $1 AND created_at > $2::timestamptz - interval '1 hour'`,
    [phone, now],
  );
  if ((rows[0]?.n ?? 0) >= OTP_PER_PHONE_PER_HOUR) {
    throw new AuthError('RATE_LIMITED', 'too many codes requested for this number');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const inserted = await getPool().query<{ id: string }>(
    `INSERT INTO otp_challenge (phone_e164, code_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, sha256(code), addMinutes(now, OTP_TTL_MINUTES), now],
  );

  return { challengeId: inserted.rows[0]!.id, code };
}

export interface GuestSession {
  token: string;
  guestId: string;
  expiresAt: Date;
}

/**
 * Verify and mint a session. The guest row is created here on first login —
 * there is no separate sign-up step, because asking someone to register before
 * they have seen a menu is the single biggest drop-off in the funnel.
 */
export async function verifyOtp(ctx: Ctx, phone: string, code: string): Promise<GuestSession> {
  const now = ctx.clock.now();

  /**
   * The check runs in its own transaction that always commits.
   *
   * Throwing from inside a transaction rolls it back — including the failed
   * attempt we just recorded, which would hand an attacker unlimited guesses.
   * So the outcome is returned, committed, and only then turned into an error.
   */
  const verdict = await tx(async (client) => {
    const { rows } = await client.query<{
      id: string;
      code_hash: string;
      attempts: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, code_hash, attempts, expires_at, consumed_at
         FROM otp_challenge
        WHERE phone_e164 = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [phone],
    );
    const challenge = rows[0];
    if (!challenge || challenge.consumed_at) return { ok: false, code: 'INVALID_CODE' } as const;
    if (challenge.expires_at <= now) return { ok: false, code: 'EXPIRED' } as const;
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      return { ok: false, code: 'RATE_LIMITED' } as const;
    }

    if (!constantTimeEquals(challenge.code_hash, sha256(code))) {
      await client.query('UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1', [
        challenge.id,
      ]);
      return { ok: false, code: 'INVALID_CODE' } as const;
    }

    await client.query('UPDATE otp_challenge SET consumed_at = $2 WHERE id = $1', [
      challenge.id,
      now,
    ]);
    return { ok: true } as const;
  });

  if (!verdict.ok) {
    if (verdict.code === 'EXPIRED') throw new AuthError('EXPIRED', 'that code has expired');
    if (verdict.code === 'RATE_LIMITED') {
      throw new AuthError('RATE_LIMITED', 'too many attempts — request a new code');
    }
    throw new AuthError('INVALID_CODE', 'that code is not right');
  }

  return startSession(ctx, phone);
}

/**
 * Mint a session for a phone number, creating the guest on first sight.
 *
 * There is no sign-up step: asking someone to register before they have seen a
 * menu is the single biggest drop-off in the funnel. The number becomes an
 * account the first time it proves it can receive a code.
 *
 * Separate from `verifyOtp` because the demo needs a session without an SMS
 * round trip, and the OTP rate limit — three codes an hour, which is there to
 * stop somebody running up an SMS bill — has no business blocking a
 * walkthrough.
 */
export async function startSession(ctx: Ctx, phone: string): Promise<GuestSession> {
  const now = ctx.clock.now();

  return tx(async (client) => {
    const guest = await client.query<{ id: string }>(
      `INSERT INTO guest (phone_e164) VALUES ($1)
       ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
       RETURNING id`,
      [phone],
    );
    const guestId = guest.rows[0]!.id;
    await client.query(
      `INSERT INTO trust_profile (guest_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [guestId],
    );

    const token = randomBytes(32).toString('base64url');
    const expiresAt = addMinutes(now, SESSION_DAYS * 24 * 60);
    await client.query(
      `INSERT INTO guest_session (guest_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [guestId, sha256(token), expiresAt, now],
    );

    return { token, guestId, expiresAt };
  });
}

export async function resolveGuest(ctx: Ctx, token: string): Promise<string | null> {
  const { rows } = await getPool().query<{ guest_id: string }>(
    `SELECT guest_id FROM guest_session
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [sha256(token), ctx.clock.now()],
  );
  return rows[0]?.guest_id ?? null;
}

/* ── tablets ───────────────────────────────────────────────────────── */

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
    `INSERT INTO kds_device (restaurant_id, label, pairing_code, pairing_expires_at)
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
    `UPDATE kds_device
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
    `UPDATE kds_device SET last_seen_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, restaurant_id`,
    [sha256(token), ctx.clock.now()],
  );
  const device = rows[0];
  return device ? { deviceId: device.id, restaurantId: device.restaurant_id } : null;
}

export async function revokeDevice(deviceId: string, at: Date): Promise<void> {
  await getPool().query('UPDATE kds_device SET revoked_at = $2, token_hash = NULL WHERE id = $1', [
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
       SELECT 1 FROM kds_device
        WHERE restaurant_id = $1 AND revoked_at IS NULL
          AND last_seen_at > $2::timestamptz - make_interval(secs => $3)
     ) AS online`,
    [restaurantId, ctx.clock.now(), staleSeconds],
  );
  return rows[0]?.online ?? false;
}
