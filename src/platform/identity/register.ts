import { getPool, tx } from '../../db/pool.js';
import { hhmm } from '../../domain/time.js';
import { publicOrigin, renderLetter } from '../../letter.js';
import {
  AuthError,
  LETTERS_PER_DAY,
  checkEmailCode,
  emailAddress,
  lettersToday,
  sendEmailCode,
  startSession,
  startSessionFor,
  type GuestSession,
} from './auth.js';
import { checkPassword, hashPassword, verifyNobody, verifyPassword } from './password.js';
import { sessionOpenedAt } from './sessions.js';
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
 * account. And five wrong passwords in a row — at the door, or asked for
 * again inside a session — rest the door for a while, so that the rate
 * limiter is not the only thing between a script and a keyspace.
 *
 * A password is forgotten sooner or later, and there is no SMS to send a
 * number a code. So a password is only ever *set* by proving an inbox: a new
 * account with one is made by the code sent to its address, and a forgotten
 * one is replaced by a code sent to the address on the account. A number with
 * no address behind it has no way back but the ones it already has.
 *
 * That holds from inside a session too. An account made by an address,
 * Google or Apple has no password to know, and a session is only something
 * somebody holds — a borrowed browser, a tab left open — so its first
 * password is set by a code to the address on it, never on the session's
 * word. And the address hears of every password set or replaced, so one its
 * owner did not choose is found the day it is chosen.
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
    // business it belongs to. An old account gets its first password through
    // a session it already holds, or a code to the address on it.
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
 * password are the same answer on purpose, and take the same time: a login
 * with no password behind it — nobody's, or an account made by an address,
 * Google or Apple — is checked against nobody's (`verifyNobody`), at the
 * cost of a real one.
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

  const ok =
    guest && !guest.closed_at && guest.password_hash
      ? await verifyPassword(input.password, guest.password_hash)
      : await verifyNobody(input.password);
  if (!ok) {
    if (guest) await countWrongPassword(guest.id, now);
    throw new AuthError('BAD_CREDENTIALS', 'wrong login or password');
  }

  await getPool().query('UPDATE identity.guest SET failed_sign_ins = 0, locked_until = NULL WHERE id = $1', [guest!.id]);
  return startSessionFor(ctx, guest!.id, input.device ?? null);
}

/**
 * One more wrong password on this account, wherever it was typed: the fifth
 * in a row rests every door that asks for it for a quarter of an hour. Added
 * up in the row itself, so two guesses sent at once still count as two.
 */
async function countWrongPassword(guestId: string, now: Date): Promise<void> {
  await getPool().query(
    `UPDATE identity.guest
        SET failed_sign_ins = failed_sign_ins + 1,
            locked_until = CASE WHEN failed_sign_ins + 1 >= $2 THEN $3::timestamptz ELSE NULL END
      WHERE id = $1`,
    [guestId, MAX_FAILURES, new Date(now.getTime() + LOCK_MINUTES * 60 * 1000)],
  );
}

/**
 * Is this the account's password — asked from inside a session, before
 * something that outlasts it: a new password, a new address, money going
 * somewhere new. The question there is not who you are but whether it is
 * still you, and a session somebody else holds is no more entitled to guess
 * than a stranger at the door. So the door's count holds here too: while the
 * door rests nothing is asked, a wrong password counts toward resting it,
 * and the right one clears the count.
 */
async function ownPassword(ctx: Ctx, guestId: string, password: string | null | undefined): Promise<boolean> {
  const now = ctx.clock.now();
  const { rows } = await getPool().query<Row>(
    'SELECT id, password_hash, failed_sign_ins, locked_until, closed_at FROM identity.guest WHERE id = $1 AND closed_at IS NULL',
    [guestId],
  );
  const me = rows[0];
  if (!me?.password_hash) return false;
  if (me.locked_until && me.locked_until > now) {
    throw new AuthError('LOCKED', 'too many wrong passwords — wait a few minutes');
  }
  if (!(await verifyPassword(password ?? '', me.password_hash))) {
    await countWrongPassword(me.id, now);
    return false;
  }
  if (me.failed_sign_ins > 0 || me.locked_until) {
    await getPool().query('UPDATE identity.guest SET failed_sign_ins = 0, locked_until = NULL WHERE id = $1', [me.id]);
  }
  return true;
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
 * the new password. An account that was already there hears of it by letter
 * (`tellInbox`, past the day's count when it is `alwaysTold`); one made just
 * now asked for exactly this, a moment ago.
 *
 * On an account that was already there, every session ends. A replaced
 * password is a way in somebody else may know, and every session it opened
 * goes with it. An account that had none — made by Google, Apple or a code —
 * comes here too when a letter has told its owner that somebody is signed in
 * as them, and this door is what the letter's button opens: the one who has
 * just proved the inbox is signed in afresh, and whoever held a session they
 * should not is out, whatever it was opened with.
 *
 * The password is checked before the code is looked at: a password that is
 * too short is a typing mistake, and must not spend the code.
 */
export async function setPasswordWithCode(
  ctx: Ctx,
  input: {
    login: string;
    code: string;
    password: string;
    name?: string | null;
    device?: string | null;
    alwaysTold?: AlwaysTold;
  },
): Promise<{ session: GuestSession; created: boolean }> {
  checkPassword(input.password);
  const email = await inboxFor(input.login);
  await checkEmailCode(ctx, email, input.code);
  const hash = await hashPassword(input.password);
  const now = ctx.clock.now();
  const name = input.name?.trim() || null;

  const { guestId, created, replaced } = await tx(async (client) => {
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
      return { guestId: id, created: true, replaced: false };
    }
    await client.query(
      `UPDATE identity.guest
          SET password_hash = $2, password_set_at = $3, failed_sign_ins = 0, locked_until = NULL,
              email_verified_at = COALESCE(email_verified_at, $3), name = COALESCE(name, $4)
        WHERE id = $1`,
      [found.id, hash, now, name],
    );
    await client.query(
      'UPDATE identity.guest_session SET revoked_at = $2 WHERE guest_id = $1 AND revoked_at IS NULL',
      [found.id, now],
    );
    return { guestId: found.id, created: false, replaced: Boolean(found.password_hash) };
  });

  const session = await startSessionFor(ctx, guestId, input.device ?? null);
  if (!created) await tellInbox(ctx, { guestId, email }, replaced ? 'changed' : 'set', input.alwaysTold);
  return { session, created };
}

/* ── an address for an account that has none ───────────────────────── */

/**
 * How lately an account with neither a password nor an address must have
 * come through a door to give itself an address. It came in by Google,
 * Apple or a code to its phone, and a session opened a moment ago is that
 * door passed again; one left open in a browser for longer is only a token
 * somebody holds. The refusal says how long (`SIGN_IN_AGAIN`).
 */
export const FRESH_SIGN_IN_MINUTES = 10;

/**
 * The first step of giving an account an address: a code to it.
 *
 * An account made by phone has no way back when its password is forgotten;
 * an address on it is that way back. The person is signed in, but a session
 * can be stolen, and an address is how a password gets replaced — so the
 * session shows first that it is still its person, or a stolen one could
 * make itself permanent. An account with a password types it, counted like
 * every wrong password (`ownPassword`). One without has no secret to type:
 * it shows it by having come through its door a moment ago, which a session
 * lifted from a borrowed browser has not.
 *
 * The code is held to this account and this purpose (`sendEmailCode`): a
 * code the door sends to anybody's inbox for the asking, or one another
 * account asked for, ties no address to this one.
 */
export async function sendAttachCode(
  ctx: Ctx,
  input: { guestId: string; email: string; password?: string | null; token?: string | null },
): Promise<void> {
  const email = emailAddress(input.email);
  const { rows } = await getPool().query<{ email: string | null; password_hash: string | null }>(
    'SELECT email, password_hash FROM identity.guest WHERE id = $1 AND closed_at IS NULL',
    [input.guestId],
  );
  const me = rows[0];
  if (!me) throw new AuthError('UNAUTHORIZED', 'no such account');
  if (me.email) throw new AuthError('EMAIL_SET', 'this account already has an address');
  if (me.password_hash) {
    if (!(await ownPassword(ctx, input.guestId, input.password))) {
      throw new AuthError('WRONG_PASSWORD', 'the password is wrong');
    }
  } else {
    const opened = input.token ? await sessionOpenedAt(input.guestId, input.token) : null;
    const since = ctx.clock.now().getTime() - FRESH_SIGN_IN_MINUTES * 60 * 1000;
    if (!opened || opened.getTime() < since) {
      throw new AuthError('SIGN_IN_AGAIN', 'an account with no password adds an address only from a sign-in a moment old');
    }
  }
  const { rows: taken } = await getPool().query('SELECT 1 FROM identity.guest WHERE lower(email) = $1', [email]);
  if (taken.length) throw new AuthError('EMAIL_TAKEN', 'another account has this address');
  await sendEmailCode(ctx, email, 'attach', input.guestId);
}

/**
 * The second: the code from the letter, and the address is the account's —
 * the code this account asked for, for this, and no other.
 */
export async function attachEmail(ctx: Ctx, input: { guestId: string; email: string; code: string }): Promise<void> {
  const email = emailAddress(input.email);
  await checkEmailCode(ctx, email, input.code, { guestId: input.guestId, purpose: 'attach' });
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

/* ── a password, from inside a session ─────────────────────────────── */

/** What an account has to prove itself with: its password, and its address once proved. */
async function secretsOf(guestId: string): Promise<{ passwordHash: string | null; email: string | null } | null> {
  const { rows } = await getPool().query<{ password_hash: string | null; email: string | null }>(
    `SELECT password_hash, CASE WHEN email_verified_at IS NOT NULL THEN email END AS email
       FROM identity.guest WHERE id = $1 AND closed_at IS NULL`,
    [guestId],
  );
  const row = rows[0];
  return row ? { passwordHash: row.password_hash, email: row.email } : null;
}

/**
 * The code for an account's first password, to the address on the account —
 * never one the request names — so the letter reaches whoever the account
 * is, and says what it means when they did not ask for it.
 *
 * An account with a password is sent nothing: it changes that one knowing
 * it. One with no address is told to add one first.
 */
export async function sendFirstPasswordCode(ctx: Ctx, input: { guestId: string }): Promise<{ sentTo: string }> {
  const me = await secretsOf(input.guestId);
  if (!me) throw new AuthError('UNAUTHORIZED', 'no such account');
  if (me.passwordHash) throw new AuthError('PASSWORD_SET', 'this account has a password; it is changed knowing that one');
  if (!me.email) throw new AuthError('NO_EMAIL', 'no address stands behind this account');
  await sendEmailCode(ctx, me.email, 'set_password', input.guestId);
  return { sentTo: me.email };
}

/**
 * Change it, knowing the old one — or set the first, with the code from the
 * letter `sendFirstPasswordCode` sent. The caller ends every other session.
 * The address hears of it (`tellInbox`, past the day's count when the
 * account is `alwaysTold`).
 *
 * An account made by an address, Google or Apple has no old password to
 * prove, and the session asking proves nothing about who holds it: a first
 * password set on its word let whoever found one open in a borrowed browser
 * keep the account after it — and sign its owner out everywhere on the way.
 * So the first is set by proving the inbox, as every password is. And the
 * old one, where there is one, is guessed no more freely here than at the
 * door: the same five wrong in a row rest both (`ownPassword`).
 *
 * The new password is checked before the code is looked at: one that is too
 * short is a typing mistake, and must not spend the code.
 */
export async function changePassword(
  ctx: Ctx,
  input: { guestId: string; current?: string | null; next: string; code?: string | null; alwaysTold?: AlwaysTold },
): Promise<void> {
  checkPassword(input.next);
  const me = await secretsOf(input.guestId);
  if (!me) throw new AuthError('UNAUTHORIZED', 'no such account');
  if (me.passwordHash) {
    if (!(await ownPassword(ctx, input.guestId, input.current))) {
      throw new AuthError('WRONG_PASSWORD', 'the current password is wrong');
    }
  } else {
    if (!me.email) throw new AuthError('NO_EMAIL', 'no address stands behind this account');
    if (!input.code) throw new AuthError('PROOF_REQUIRED', 'a first password needs the code sent to the address on the account');
    await checkEmailCode(ctx, me.email, input.code, { guestId: input.guestId, purpose: 'set_password' });
  }
  const hash = await hashPassword(input.next);
  await getPool().query(
    `UPDATE identity.guest SET password_hash = $2, password_set_at = $3, failed_sign_ins = 0, locked_until = NULL WHERE id = $1`,
    [input.guestId, hash, ctx.clock.now()],
  );
  await tellInbox(ctx, { guestId: input.guestId, email: me.email }, me.passwordHash ? 'changed' : 'set', input.alwaysTold);
}

/* ── telling the inbox ─────────────────────────────────────────────── */

/**
 * How many letters about a password go to one address: one an hour.
 *
 * A password is changed knowing the old one without any code, so with
 * nothing counting them one person switching between two passwords sent a
 * letter a switch. A second change inside the hour goes untold; the letter
 * about the first said the same a moment before, and what to do about it.
 * In all they are counted with the codes, the day's `LETTERS_PER_DAY` from
 * the one Gmail account both leave from.
 */
export const NOTICES_PER_EMAIL_PER_HOUR = 1;

/**
 * Whether the letter about this account's password goes out whatever the
 * day's count says — its hour's one letter still holds. Identity cannot
 * tell which accounts those are: they are the ones Basu's desk sits in,
 * where a password somebody else chose is worth the most to them and its
 * owner most needs to hear of it, and the desk is not identity's to ask.
 * So whoever changes a password says.
 */
export type AlwaysTold = (guestId: string) => Promise<boolean>;

/**
 * A letter to the account's own address: its password was just set, or
 * replaced. A password is a way in that lasts, so its owner hears of every
 * new one, and one they did not choose is found the day it is chosen rather
 * than the day something is gone. The one button is the way to take it back:
 * the forgotten-password door, which signs every other device out as the
 * new password is set.
 *
 * Best-effort, and counted: one an hour to an address, and in all what is
 * left of the day's letters (`LETTERS_PER_DAY`) — except to an account
 * that is `alwaysTold`, whose letter the day's count never stops. Past the
 * count nothing goes. The password is set already, and neither a letter
 * that cannot go nor a mail server taking its time may undo it, make the
 * person think it failed, or keep them waiting for their answer.
 */
async function tellInbox(
  ctx: Ctx,
  account: { guestId: string; email: string | null },
  what: 'set' | 'changed',
  alwaysTold?: AlwaysTold,
): Promise<void> {
  const { guestId, email } = account;
  const mailer = ctx.mailer;
  if (!email || !mailer) return;
  const now = ctx.clock.now();
  try {
    // Not knowing is not knowing: the letter is then counted like anybody's.
    const always = alwaysTold ? await alwaysTold(guestId).catch(() => false) : false;
    // Written down only if it fits under the counts, and only then sent.
    const { rowCount } = await getPool().query(
      `INSERT INTO identity.notice (email, guest_id, created_at)
       SELECT $2::text, $3::uuid, $1::timestamptz
        WHERE (SELECT count(*) FROM identity.notice
                WHERE email = $2 AND created_at > $1::timestamptz - interval '1 hour') < $4
          AND ($6::boolean OR ${lettersToday('$1')} < $5)`,
      [now, email, guestId, NOTICES_PER_EMAIL_PER_HOUR, LETTERS_PER_DAY, always],
    );
    if (!rowCount) return;

    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: 'numeric', day: 'numeric' });
    const part = (type: Intl.DateTimeFormatPartTypes) => day.formatToParts(now).find((p) => p.type === type)?.value ?? '';
    const when = `Хэзээ: ${part('year')} оны ${part('month')}-р сарын ${part('day')}, ${hhmm(now)} (Улаанбаатарын цагаар).`;
    const title = what === 'set' ? 'Нууц үг тохирууллаа' : 'Нууц үг солигдлоо';
    const said = what === 'set' ? 'Таны Basu бүртгэлд нууц үг тохирууллаа.' : 'Таны Basu бүртгэлийн нууц үг солигдлоо.';
    const notYou =
      'Та өөрөө хийгээгүй бол хэн нэгэн таны бүртгэлд нэвтэрсэн байна. Нууц үгээ даруй сэргээнэ үү — шинэ нууц үг тавихад бусад бүх төхөөрөмж дээрх нэвтрэлт хаагдана.';
    const you = 'Та өөрөө хийсэн бол юу ч хийх шаардлагагүй.';
    const reset = '/login?forgot';
    // Not waited for. A mail server can take forty seconds to give up, and
    // the person — and the other sessions this change ends — should not wait
    // on it: the app gives up after fifteen and would say it failed.
    void mailer
      .send({
        to: email,
        subject: `Basu · ${title}`,
        text: [said, when, '', notYou, `${publicOrigin()}${reset}`, '', you].join('\n'),
        html: renderLetter({
          preheader: `${said} Та өөрөө хийгээгүй бол нууц үгээ даруй сэргээнэ үү.`,
          title,
          paragraphs: [said, when],
          note: notYou,
          action: { label: 'Нууц үг сэргээх', url: reset },
          small: you,
        }),
      })
      .catch(() => {});
  } catch {
    // The password stands whether or not the letter went: nothing to undo.
  }
}

/**
 * Is this the password on that account?
 *
 * For confirming something inside a session that is already open — money
 * going to a new bank account — where the question is not "who are you" but
 * "is it still you holding the phone". Counted like the door counts
 * (`ownPassword`): LOCKED while it rests.
 */
export async function confirmPassword(ctx: Ctx, guestId: string, password: string): Promise<boolean> {
  return ownPassword(ctx, guestId, password);
}

/** Whether this account can be signed into with a password at all. */
export async function hasPassword(guestId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ set: boolean }>(
    'SELECT password_hash IS NOT NULL AS set FROM identity.guest WHERE id = $1',
    [guestId],
  );
  return rows[0]?.set ?? false;
}
