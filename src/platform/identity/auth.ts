import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getPool, tx } from '../../db/pool.js';
import { addMinutes } from '../../domain/time.js';
import { mode } from '../../mode.js';
import type { Ctx } from '../../ports.js';

/**
 * Phone plus a one-time code, and a paired tablet.
 *
 * No passwords anywhere: a guest orders lunch, they should not have to invent
 * a credential to do it. What is stored are hashes — a leaked table must not
 * let anyone log in as somebody else.
 *
 * This module knows nothing about food. It creates the person and the session
 * and stops there: a vertical that needs its own record of a guest — dine's
 * trust profile, say — makes it when it first has a reason to.
 */

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;
const SESSION_DAYS = 60;

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
    readonly code: 'RATE_LIMITED' | 'INVALID_CODE' | 'EXPIRED' | 'UNAUTHORIZED' | 'BAD_PHONE' | 'PHONE_TAKEN' | 'BAD_CREDENTIALS' | 'LOCKED',
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

/**
 * Codes the whole service may send in a day. Every code is an SMS somebody
 * pays for; a script feeding numbers in is a bill, not a sign-up wave. The
 * demo, which has no SMS, is not held to it.
 */
export const OTP_PER_DAY = 2000;

export async function requestOtp(ctx: Ctx, phone: string): Promise<OtpIssued> {
  const now = ctx.clock.now();

  if (mode() === 'production') {
    const { rows: day } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.otp_challenge WHERE created_at > $1::timestamptz - interval '24 hours'`,
      [now],
    );
    if ((day[0]?.n ?? 0) >= OTP_PER_DAY) {
      throw new AuthError('RATE_LIMITED', 'the day’s allowance of codes is spent');
    }
  }

  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM identity.otp_challenge
      WHERE phone_e164 = $1 AND created_at > $2::timestamptz - interval '1 hour'`,
    [phone, now],
  );
  if ((rows[0]?.n ?? 0) >= OTP_PER_PHONE_PER_HOUR) {
    throw new AuthError('RATE_LIMITED', 'too many codes requested for this number');
  }

  // The demo has no SMS: its code is the same every time, so a phone with a
  // store build, a reviewer at Apple and a tester on TestFlight can all get
  // in against the demo server. Production draws a real one.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const inserted = await getPool().query<{ id: string }>(
    `INSERT INTO identity.otp_challenge (phone_e164, code_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, sha256(code), addMinutes(now, OTP_TTL_MINUTES), now],
  );

  return { challengeId: inserted.rows[0]!.id, code };
}

/**
 * The account behind a phone number, made if there is none. What a supplier
 * written in from a contract needs so that messages can reach them — no
 * session, no code, just the row a sign-in would have made.
 */
export async function guestForPhone(phone: string): Promise<string> {
  return tx(async (client) => {
    const guest = await client.query<{ id: string }>(
      `INSERT INTO identity.guest (phone_e164) VALUES ($1)
       ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
       RETURNING id`,
      [phone],
    );
    const guestId = guest.rows[0]!.id;
    await client.query(`INSERT INTO identity.profile (guest_id) VALUES ($1) ON CONFLICT DO NOTHING`, [guestId]);
    return guestId;
  });
}

/** Challenges older than a day are neither valid nor evidence. Swept by the scheduler. */
export async function purgeChallenges(now: Date): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM identity.otp_challenge WHERE created_at < $1::timestamptz - interval '24 hours'`,
    [now],
  );
  return rowCount ?? 0;
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
export async function verifyOtp(
  ctx: Ctx,
  phone: string,
  code: string,
  label?: string | null,
): Promise<GuestSession> {
  await checkOtp(ctx, phone, code);
  return startSession(ctx, phone, label);
}

/**
 * Request a code and send it, the one way a code ever leaves: by SMS to
 * the phone itself. Never returned, never stored in the clear.
 */
export async function sendOtp(ctx: Ctx, phone: string): Promise<void> {
  const { code } = await requestOtp(ctx, phone);
  await ctx.notifier.send({ channel: 'sms', to: phone, template: 'auth.otp', body: `Таны код: ${code}` });
}

/**
 * Is this the code we sent this phone? Consumed on success, counted on
 * failure. Signing in uses it; so does anything a person must be at their
 * phone for — changing where their money goes.
 */
export async function checkOtp(ctx: Ctx, phone: string, code: string): Promise<void> {
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
         FROM identity.otp_challenge
        WHERE phone_e164 = $1 AND consumed_at IS NULL
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
      await client.query('UPDATE identity.otp_challenge SET attempts = attempts + 1 WHERE id = $1', [
        challenge.id,
      ]);
      return { ok: false, code: 'INVALID_CODE' } as const;
    }

    await client.query('UPDATE identity.otp_challenge SET consumed_at = $2 WHERE id = $1', [
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
export async function startSession(
  ctx: Ctx,
  phone: string,
  /** What the phone calls itself, for the session list. */
  label?: string | null,
): Promise<GuestSession> {
  const now = ctx.clock.now();

  return tx(async (client) => {
    const guest = await client.query<{ id: string }>(
      `INSERT INTO identity.guest (phone_e164) VALUES ($1)
       ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
       RETURNING id`,
      [phone],
    );
    const guestId = guest.rows[0]!.id;
    await client.query(
      `INSERT INTO identity.profile (guest_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [guestId],
    );

    const token = randomBytes(32).toString('base64url');
    const expiresAt = addMinutes(now, SESSION_DAYS * 24 * 60);
    await client.query(
      `INSERT INTO identity.guest_session
         (guest_id, token_hash, expires_at, created_at, last_seen_at, label)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [guestId, sha256(token), expiresAt, now, label?.slice(0, 60) || null],
    );

    return { token, guestId, expiresAt };
  });
}

/**
 * Who is asking, and a note that they were here.
 *
 * Resolving a token also records the heartbeat — the same trick the kitchen
 * tablets use. Any authenticated call is proof the session is alive, so
 * liveness needs no separate ping and cannot drift out of step with real use.
 * It is what makes the session list on the profile screen worth reading.
 */
export async function resolveGuest(ctx: Ctx, token: string): Promise<string | null> {
  const { rows } = await getPool().query<{ guest_id: string }>(
    `UPDATE identity.guest_session SET last_seen_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
      RETURNING guest_id`,
    [sha256(token), ctx.clock.now()],
  );
  return rows[0]?.guest_id ?? null;
}
