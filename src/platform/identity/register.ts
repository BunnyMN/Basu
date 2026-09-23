import { getPool, tx } from '../../db/pool.js';
import { AuthError, startSession, type GuestSession } from './auth.js';
import { checkPassword, hashPassword, verifyPassword } from './password.js';
import type { Ctx } from '../../ports.js';

/**
 * Signing up, and signing in, with a password.
 *
 * The one-time code was the only door, and it needs an SMS gateway to open.
 * A password is a door a person carries with them: they can make an account
 * today, on a server with no gateway at all, and the code path that used to
 * hand out `123456` to anybody who asked is gone.
 *
 * Two rules do most of the work here. A failed sign-in never says whether
 * the phone is known, so the door cannot be used to find out who has an
 * account. And five wrong passwords in a row rest the door for a while, so
 * that the rate limiter is not the only thing between a script and a
 * keyspace.
 */

/** Five in a row, then a quarter of an hour. Enough to stop a script, not a person. */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

interface Row {
  id: string;
  password_hash: string | null;
  failed_sign_ins: number;
  locked_until: Date | null;
  closed_at: Date | null;
}

const PHONE = /^\+976\d{8}$/;

function requirePhone(phone: string): void {
  if (!PHONE.test(phone)) throw new AuthError('BAD_PHONE', 'phone must be +976XXXXXXXX');
}

/**
 * Make an account.
 *
 * A phone that already has one is refused rather than quietly taken over:
 * "register" must never be a way to claim somebody else's number. The
 * refusal says so plainly, because a person who forgot they had an account
 * needs to be told to sign in, not left guessing.
 */
export async function registerGuest(
  ctx: Ctx,
  input: { phone: string; password: string; name?: string | null; device?: string | null },
): Promise<GuestSession> {
  requirePhone(input.phone);
  checkPassword(input.password);
  const name = input.name?.trim() || null;
  const hash = await hashPassword(input.password);

  const taken = await tx(async (client) => {
    const { rows } = await client.query<Row>(
      'SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE phone_e164 = $1 FOR UPDATE',
      [input.phone],
    );
    const existing = rows[0];
    if (existing?.password_hash) return true;
    if (existing) {
      // An account made by an older sign-in, never given a password. It is
      // the same person's number; letting them set one is the upgrade path.
      await client.query(
        `UPDATE identity.guest SET password_hash = $2, password_set_at = $3, name = COALESCE($4, name) WHERE id = $1`,
        [existing.id, hash, ctx.clock.now(), name],
      );
      return false;
    }
    const made = await client.query<{ id: string }>(
      `INSERT INTO identity.guest (phone_e164, name, password_hash, password_set_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.phone, name, hash, ctx.clock.now()],
    );
    await client.query('INSERT INTO identity.profile (guest_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      made.rows[0]!.id,
      name,
    ]);
    return false;
  });
  if (taken) throw new AuthError('PHONE_TAKEN', 'that number already has an account');

  return startSession(ctx, input.phone, input.device ?? null);
}

/** Sign in. Wrong phone and wrong password are the same answer on purpose. */
export async function signInWithPassword(
  ctx: Ctx,
  input: { phone: string; password: string; device?: string | null },
): Promise<GuestSession> {
  requirePhone(input.phone);
  const now = ctx.clock.now();
  const { rows } = await getPool().query<Row>(
    'SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE phone_e164 = $1',
    [input.phone],
  );
  const guest = rows[0];

  if (guest?.locked_until && guest.locked_until > now) {
    throw new AuthError('LOCKED', 'too many wrong passwords — wait a few minutes');
  }

  const ok = guest && !guest.closed_at ? await verifyPassword(input.password, guest.password_hash) : false;
  if (!ok) {
    if (guest) {
      const failures = guest.failed_sign_ins + 1;
      await getPool().query(
        `UPDATE identity.guest SET failed_sign_ins = $2, locked_until = $3 WHERE id = $1`,
        [
          guest.id,
          failures,
          failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) : null,
        ],
      );
    }
    throw new AuthError('BAD_CREDENTIALS', 'wrong number or password');
  }

  await getPool().query('UPDATE identity.guest SET failed_sign_ins = 0, locked_until = NULL WHERE id = $1', [guest!.id]);
  return startSession(ctx, input.phone, input.device ?? null);
}

/** Change it, knowing the old one. Every other session is ended. */
export async function changePassword(
  ctx: Ctx,
  input: { guestId: string; current: string; next: string },
): Promise<void> {
  checkPassword(input.next);
  const { rows } = await getPool().query<{ password_hash: string | null }>(
    'SELECT password_hash FROM identity.guest WHERE id = $1',
    [input.guestId],
  );
  const stored = rows[0]?.password_hash ?? null;
  // An account that has never had one (made before passwords) may set the
  // first without proving the old, because there is no old to prove.
  if (stored && !(await verifyPassword(input.current, stored))) {
    throw new AuthError('BAD_CREDENTIALS', 'the current password is wrong');
  }
  const hash = await hashPassword(input.next);
  await getPool().query(
    `UPDATE identity.guest SET password_hash = $2, password_set_at = $3, failed_sign_ins = 0, locked_until = NULL WHERE id = $1`,
    [input.guestId, hash, ctx.clock.now()],
  );
}

/**
 * Is this the password on that account?
 *
 * For confirming something inside a session that is already open — money
 * going to a new bank account — where the question is not "who are you" but
 * "is it still you holding the phone".
 */
export async function confirmPassword(guestId: string, password: string): Promise<boolean> {
  const { rows } = await getPool().query<{ password_hash: string | null }>(
    'SELECT password_hash FROM identity.guest WHERE id = $1 AND closed_at IS NULL',
    [guestId],
  );
  return verifyPassword(password, rows[0]?.password_hash ?? null);
}

/** Whether this account can be signed into with a password at all. */
export async function hasPassword(guestId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ set: boolean }>(
    'SELECT password_hash IS NOT NULL AS set FROM identity.guest WHERE id = $1',
    [guestId],
  );
  return rows[0]?.set ?? false;
}
