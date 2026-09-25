import { getPool, tx } from '../../db/pool.js';
import { AuthError, checkEmailCode, emailAddress, sendEmailCode, startSession, startSessionFor, type GuestSession } from './auth.js';
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
 *
 * A password is forgotten sooner or later, and there is no SMS to send a
 * number a code. So a password is only ever *set* by proving an inbox: a new
 * account with one is made by the code sent to its address, and a forgotten
 * one is replaced by a code sent to the address on the account. A number with
 * no address behind it has no way back but the ones it already has.
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

/**
 * A Mongolian number as people actually type it — «8811 2233», «976…»,
 * «+976 8811-2233» — in the one form the rest of Basu stores.
 */
export function phoneE164(raw: string): string {
  const typed = raw.replace(/[\s\-().]/g, '');
  if (/^\d{8}$/.test(typed)) return `+976${typed}`;
  if (/^(00)?976\d{8}$/.test(typed)) return `+${typed.replace(/^00/, '')}`;
  return typed;
}

/** The same, refused unless it is a Mongolian mobile number. */
export function requirePhone(raw: string): string {
  const phone = phoneE164(raw);
  if (!PHONE.test(phone)) throw new AuthError('BAD_PHONE', 'phone must be +976XXXXXXXX');
  return phone;
}

/**
 * Make an account, for a number nobody has used.
 *
 * A number that already has one is refused rather than quietly taken over:
 * "register" must never be a way to claim somebody else's number. The
 * refusal says so plainly, because a person who forgot they had an account
 * needs to be told to sign in, not left guessing.
 */
export async function registerGuest(
  ctx: Ctx,
  input: { phone: string; password: string; name?: string | null; device?: string | null },
): Promise<GuestSession> {
  const phone = requirePhone(input.phone);
  checkPassword(input.password);
  const name = input.name?.trim() || null;
  const hash = await hashPassword(input.password);

  const taken = await tx(async (client) => {
    const { rows } = await client.query<Row>(
      'SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE phone_e164 = $1 FOR UPDATE',
      [phone],
    );
    // Any account on this number, with a password or without, is somebody's.
    // Registering proves nothing about who holds the phone, so it must never
    // attach a password to an account that already exists — that would let
    // anybody who knows a number walk into its wallet, its orders, or the
    // supplier it owns. An old account gets its first password through a
    // session it already holds, or an invite from the desk.
    if (rows[0]) return true;
    const made = await client.query<{ id: string }>(
      `INSERT INTO identity.guest (phone_e164, name, password_hash, password_set_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [phone, name, hash, ctx.clock.now()],
    );
    await client.query('INSERT INTO identity.profile (guest_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      made.rows[0]!.id,
      name,
    ]);
    return false;
  });
  if (taken) throw new AuthError('PHONE_TAKEN', 'that number already has an account');

  return startSession(ctx, phone, input.device ?? null);
}

/**
 * An account for a person someone has vouched for — an invite from the desk.
 *
 * This is the one path allowed to give a password to an account that already
 * exists without one, because the caller has already proven who the person
 * is by other means. An account that already has a password is never
 * overwritten: the person must type it, which is them proving it is theirs.
 */
export async function claimAccount(
  ctx: Ctx,
  input: { phone: string; password: string; name?: string | null; device?: string | null },
): Promise<GuestSession> {
  const phone = requirePhone(input.phone);
  checkPassword(input.password);
  const name = input.name?.trim() || null;
  const { rows } = await getPool().query<Row>(
    'SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE phone_e164 = $1',
    [phone],
  );
  const existing = rows[0];
  if (existing?.password_hash) {
    if (!(await verifyPassword(input.password, existing.password_hash))) {
      throw new AuthError('BAD_CREDENTIALS', 'this number already has a password, and that is not it');
    }
  } else if (existing) {
    await getPool().query(
      `UPDATE identity.guest SET password_hash = $2, password_set_at = $3, name = COALESCE(name, $4) WHERE id = $1`,
      [existing.id, await hashPassword(input.password), ctx.clock.now(), name],
    );
  } else {
    return registerGuest(ctx, { ...input, phone });
  }
  return startSession(ctx, phone, input.device ?? null);
}

/**
 * The account a login names: an address if it has an @ in it, otherwise a
 * phone number. The column is ours, never the input.
 */
function byLogin(login: string): { where: string; value: string } {
  return login.includes('@')
    ? { where: 'lower(email) = $1', value: emailAddress(login) }
    : { where: 'phone_e164 = $1', value: requirePhone(login) };
}

/**
 * Sign in, by an email address or a phone number. A wrong login and a wrong
 * password are the same answer on purpose.
 */
export async function signInWithPassword(
  ctx: Ctx,
  input: { login: string; password: string; device?: string | null },
): Promise<GuestSession> {
  const { where, value } = byLogin(input.login);
  const now = ctx.clock.now();
  const { rows } = await getPool().query<Row>(
    `SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE ${where}`,
    [value],
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
    throw new AuthError('BAD_CREDENTIALS', 'wrong login or password');
  }

  await getPool().query('UPDATE identity.guest SET failed_sign_ins = 0, locked_until = NULL WHERE id = $1', [guest!.id]);
  return startSessionFor(ctx, guest!.id, input.device ?? null);
}

/* ── a password by way of an inbox ─────────────────────────────────── */

/**
 * The inbox behind a login: the address itself, or the one on the account a
 * number belongs to. A number with no address — or no account — gets the
 * same refusal, which says no more than registering it would.
 */
async function inboxFor(login: string): Promise<string> {
  if (login.includes('@')) return emailAddress(login);
  const phone = requirePhone(login);
  const { rows } = await getPool().query<{ email: string | null }>(
    'SELECT email FROM identity.guest WHERE phone_e164 = $1 AND closed_at IS NULL',
    [phone],
  );
  const email = rows[0]?.email;
  if (!email) throw new AuthError('NO_EMAIL', 'no address stands behind this number');
  return email;
}

/**
 * An address as it may be shown to somebody who typed only a phone number:
 * enough to know which inbox to open, not enough to learn it. «ba•••mn@gmail.com».
 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dots = '\u2022\u2022\u2022';
  const hidden = local.length <= 3 ? `${local.slice(0, 1)}${dots}` : `${local.slice(0, 2)}${dots}${local.slice(-2)}`;
  return `${hidden}@${domain}`;
}

/**
 * Send the code that lets a password be set: to a new address for a new
 * account, or to the address on the account for a forgotten password.
 *
 * Asked to sign up with an address that already has an account, the letter
 * says so — it goes to the owner of that inbox, so it tells nobody else
 * anything — and the code then resets that account's password rather than
 * making a second one.
 *
 * Says where the letter went: the address as typed, or masked when only a
 * number was typed.
 */
export async function sendPasswordCode(
  ctx: Ctx,
  input: { login: string; purpose: 'sign_up' | 'reset' },
): Promise<{ sentTo: string }> {
  const email = await inboxFor(input.login);
  let purpose = input.purpose;
  if (purpose === 'sign_up') {
    const { rows } = await getPool().query('SELECT 1 FROM identity.guest WHERE lower(email) = $1 AND closed_at IS NULL', [email]);
    if (rows.length) purpose = 'reset';
  }
  await sendEmailCode(ctx, email, purpose);
  return { sentTo: input.login.includes('@') ? email : maskEmail(email) };
}

/**
 * Set a password with the code from the letter, and be signed in.
 *
 * Proving the inbox is proving the account behind it — the same proof the
 * code-by-email door accepts — so the address with no account becomes one
 * here, with the password and the name given, and the address with one gets
 * the new password. A password somebody else might know is a way in, so a
 * replaced one ends every session it could have opened.
 *
 * The password is checked before the code is looked at: a password that is
 * too short is a typing mistake, and must not spend the code.
 */
export async function setPasswordWithCode(
  ctx: Ctx,
  input: { login: string; code: string; password: string; name?: string | null; device?: string | null },
): Promise<{ session: GuestSession; created: boolean }> {
  checkPassword(input.password);
  const email = await inboxFor(input.login);
  await checkEmailCode(ctx, email, input.code);
  const hash = await hashPassword(input.password);
  const now = ctx.clock.now();
  const name = input.name?.trim() || null;

  const { guestId, created } = await tx(async (client) => {
    const { rows } = await client.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM identity.guest WHERE lower(email) = $1 AND closed_at IS NULL FOR UPDATE',
      [email],
    );
    const found = rows[0];
    if (!found) {
      const made = await client.query<{ id: string }>(
        `INSERT INTO identity.guest (email, email_verified_at, name, password_hash, password_set_at)
         VALUES ($1, $2, $3, $4, $2) RETURNING id`,
        [email, now, name, hash],
      );
      const id = made.rows[0]!.id;
      await client.query('INSERT INTO identity.profile (guest_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        id,
        name,
      ]);
      return { guestId: id, created: true };
    }
    await client.query(
      `UPDATE identity.guest
          SET password_hash = $2, password_set_at = $3, failed_sign_ins = 0, locked_until = NULL,
              email_verified_at = COALESCE(email_verified_at, $3), name = COALESCE(name, $4)
        WHERE id = $1`,
      [found.id, hash, now, name],
    );
    if (found.password_hash) {
      await client.query(
        'UPDATE identity.guest_session SET revoked_at = $2 WHERE guest_id = $1 AND revoked_at IS NULL',
        [found.id, now],
      );
    }
    return { guestId: found.id, created: false };
  });

  return { session: await startSessionFor(ctx, guestId, input.device ?? null), created };
}

/* ── an address for an account that has none ───────────────────────── */

/**
 * The first step of giving an account an address: a code to it.
 *
 * An account made by phone has no way back when its password is forgotten;
 * an address on it is that way back. The person is signed in, but a session
 * can be stolen, and an address is how a password gets replaced — so an
 * account with a password must type it here, or a stolen session could make
 * itself permanent.
 */
export async function sendAttachCode(
  ctx: Ctx,
  input: { guestId: string; email: string; password?: string | null },
): Promise<void> {
  const email = emailAddress(input.email);
  const { rows } = await getPool().query<{ email: string | null; password_hash: string | null }>(
    'SELECT email, password_hash FROM identity.guest WHERE id = $1 AND closed_at IS NULL',
    [input.guestId],
  );
  const me = rows[0];
  if (!me) throw new AuthError('UNAUTHORIZED', 'no such account');
  if (me.email) throw new AuthError('EMAIL_SET', 'this account already has an address');
  if (me.password_hash && !(await verifyPassword(input.password ?? '', me.password_hash))) {
    throw new AuthError('WRONG_PASSWORD', 'the password is wrong');
  }
  const { rows: taken } = await getPool().query('SELECT 1 FROM identity.guest WHERE lower(email) = $1', [email]);
  if (taken.length) throw new AuthError('EMAIL_TAKEN', 'another account has this address');
  await sendEmailCode(ctx, email, 'attach');
}

/** The second: the code from the letter, and the address is the account's. */
export async function attachEmail(ctx: Ctx, input: { guestId: string; email: string; code: string }): Promise<void> {
  const email = emailAddress(input.email);
  await checkEmailCode(ctx, email, input.code);
  try {
    const { rowCount } = await getPool().query(
      `UPDATE identity.guest SET email = $2, email_verified_at = $3
        WHERE id = $1 AND email IS NULL AND closed_at IS NULL`,
      [input.guestId, email, ctx.clock.now()],
    );
    if (!rowCount) throw new AuthError('EMAIL_SET', 'this account already has an address');
  } catch (error) {
    // Taken by somebody else between the letter and the code.
    if ((error as { code?: string }).code === '23505') throw new AuthError('EMAIL_TAKEN', 'another account has this address');
    throw error;
  }
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
    throw new AuthError('WRONG_PASSWORD', 'the current password is wrong');
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
