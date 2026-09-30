import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { LETTERS_PER_DAY, purgeChallenges, resolveGuest, sendEmailCode, startSession, verifyEmailCode } from './auth.js';
import {
  attachEmail,
  changePassword,
  maskEmail,
  registerGuest,
  sendAttachCode,
  sendFirstPasswordCode,
  sendPasswordCode,
  setPasswordWithCode,
  signInWithPassword,
} from './register.js';

/**
 * A password that can be forgotten, and got back.
 *
 * What has to hold: a password is set only by somebody who can read the
 * inbox behind the account; a new address becomes an account the same way;
 * a replaced password shuts out whoever knew the old one; and a number with
 * no address behind it is told so, without anything else being given away.
 */

let ctx: Ctx;
let mailer: FakeMailer;
let clock: VirtualClock;

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  mailer = new FakeMailer();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier(), mailer };
});

afterAll(async () => {
  await closePool();
});

/** A phone account, with an address proved on it. */
async function phoneAccountWithEmail(phone: string, password: string, email: string) {
  const made = await registerGuest(ctx, { phone, password });
  await sendAttachCode(ctx, { guestId: made.guestId, email, password });
  await attachEmail(ctx, { guestId: made.guestId, email, code: mailer.codeFor(email)! });
  return made;
}

describe('signing up with an address and a password', () => {
  it('makes the account once the code comes back, and signs in by the address after', async () => {
    const { sentTo } = await sendPasswordCode(ctx, { login: ' Saraa@Example.mn ', purpose: 'sign_up' });
    expect(sentTo).toBe('saraa@example.mn');
    expect(mailer.to('saraa@example.mn')!.subject).toContain('бүртгэлийн код');

    const { session, created } = await setPasswordWithCode(ctx, {
      login: 'saraa@example.mn',
      code: mailer.codeFor('saraa@example.mn')!,
      password: 'сайн нууц үг',
      name: ' Сараа ',
      device: 'Chrome',
    });
    expect(created).toBe(true);
    expect(await resolveGuest(ctx, session.token)).toBe(session.guestId);
    const { rows } = await getPool().query(
      'SELECT email, name, email_verified_at IS NOT NULL AS proved FROM identity.guest WHERE id = $1',
      [session.guestId],
    );
    expect(rows[0]).toEqual({ email: 'saraa@example.mn', name: 'Сараа', proved: true });

    const again = await signInWithPassword(ctx, { login: 'SARAA@example.mn', password: 'сайн нууц үг' });
    expect(again.guestId).toBe(session.guestId);
  });

  it('is the same account as the code-by-email one for that address, not a second', async () => {
    await sendEmailCode(ctx, 'saraa@example.mn');
    const first = await verifyEmailCode(ctx, 'saraa@example.mn', mailer.codeFor('saraa@example.mn')!);

    await sendPasswordCode(ctx, { login: 'saraa@example.mn', purpose: 'sign_up' });
    // The letter goes to the owner of the inbox, so it may say the account is there.
    expect(mailer.to('saraa@example.mn')!.subject).toContain('нууц үг сэргээх');
    const { session, created } = await setPasswordWithCode(ctx, {
      login: 'saraa@example.mn',
      code: mailer.codeFor('saraa@example.mn')!,
      password: 'сайн нууц үг',
    });
    expect(created).toBe(false);
    expect(session.guestId).toBe(first.guestId);
    // It had no password to know, but a session it opened may be somebody
    // else's by now — the letter that sends people here says so — and this
    // door ends every one of them, as it does for a password replaced.
    expect(await resolveGuest(ctx, first.token)).toBeNull();
    expect(await resolveGuest(ctx, session.token)).toBe(first.guestId);
  });

  it('does not spend the code on a password that is too short', async () => {
    await sendPasswordCode(ctx, { login: 'saraa@example.mn', purpose: 'sign_up' });
    const code = mailer.codeFor('saraa@example.mn')!;
    await expect(setPasswordWithCode(ctx, { login: 'saraa@example.mn', code, password: 'богино' })).rejects.toMatchObject({
      code: 'TOO_SHORT',
    });
    await expect(
      setPasswordWithCode(ctx, { login: 'saraa@example.mn', code, password: 'хангалттай урт' }),
    ).resolves.toMatchObject({ created: true });
  });

  it('will not make an account for a code that is wrong', async () => {
    await sendPasswordCode(ctx, { login: 'saraa@example.mn', purpose: 'sign_up' });
    await expect(
      setPasswordWithCode(ctx, { login: 'saraa@example.mn', code: '000000', password: 'сайн нууц үг' }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM identity.guest');
    expect(rows[0].n).toBe(0);
  });
});

describe('a forgotten password', () => {
  it('is replaced through the address, and whoever knew the old one is signed out', async () => {
    const old = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'bat@example.mn');

    const { sentTo } = await sendPasswordCode(ctx, { login: 'bat@example.mn', purpose: 'reset' });
    expect(sentTo).toBe('bat@example.mn');
    const letter = mailer.to('bat@example.mn')!;
    expect(letter.subject).toContain('нууц үг сэргээх');
    expect(letter.text).toContain('нууц үг тань хэвээр');

    const { session, created } = await setPasswordWithCode(ctx, {
      login: 'bat@example.mn',
      code: mailer.codeFor('bat@example.mn')!,
      password: 'шинэ нууц үг',
    });
    expect(created).toBe(false);
    expect(session.guestId).toBe(old.guestId);
    expect(await resolveGuest(ctx, old.token)).toBeNull();
    expect(await resolveGuest(ctx, session.token)).toBe(old.guestId);

    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'хуучин нууц үг' })).rejects.toMatchObject({
      code: 'BAD_CREDENTIALS',
    });
    await expect(signInWithPassword(ctx, { login: '9900 1122', password: 'шинэ нууц үг' })).resolves.toMatchObject({
      guestId: old.guestId,
    });
  });

  it('can be asked for by the phone number, and says only a masked address back', async () => {
    const old = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'batbold@example.mn');
    const { sentTo } = await sendPasswordCode(ctx, { login: '9900 1122', purpose: 'reset' });
    expect(sentTo).toBe('ba•••ld@example.mn');

    const { session } = await setPasswordWithCode(ctx, {
      login: '99001122',
      code: mailer.codeFor('batbold@example.mn')!,
      password: 'шинэ нууц үг',
    });
    expect(session.guestId).toBe(old.guestId);
  });

  it('opens a door that was resting after too many wrong guesses', async () => {
    await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'bat@example.mn');
    for (let i = 0; i < 5; i++) {
      await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: `таамаг ${i}` })).rejects.toBeTruthy();
    }
    await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: 'хуучин нууц үг' })).rejects.toMatchObject({
      code: 'LOCKED',
    });
    await sendPasswordCode(ctx, { login: 'bat@example.mn', purpose: 'reset' });
    await setPasswordWithCode(ctx, { login: 'bat@example.mn', code: mailer.codeFor('bat@example.mn')!, password: 'шинэ нууц үг' });
    await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: 'шинэ нууц үг' })).resolves.toBeTruthy();
  });

  it('tells a number with no address — known or not — the same thing, and sends nothing', async () => {
    await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    const known = await sendPasswordCode(ctx, { login: '+97699001122', purpose: 'reset' }).catch((e: unknown) => e);
    const unknown = await sendPasswordCode(ctx, { login: '+97688009999', purpose: 'reset' }).catch((e: unknown) => e);
    expect(known).toMatchObject({ code: 'NO_EMAIL' });
    expect(unknown).toMatchObject({ code: 'NO_EMAIL' });
    expect((known as Error).message).toBe((unknown as Error).message);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('an address for an account made by phone', () => {
  it('needs the account’s password, and the code from the letter', async () => {
    const made = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    await expect(
      sendAttachCode(ctx, { guestId: made.guestId, email: 'bat@example.mn', password: 'таамаг' }),
    ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    expect(mailer.sent).toHaveLength(0);

    await sendAttachCode(ctx, { guestId: made.guestId, email: 'Bat@Example.mn', password: 'сайн нууц үг' });
    expect(mailer.to('bat@example.mn')!.subject).toContain('имэйл баталгаажуулах');
    await expect(attachEmail(ctx, { guestId: made.guestId, email: 'bat@example.mn', code: '000000' })).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    clock.advanceMinutes(1);
    await sendAttachCode(ctx, { guestId: made.guestId, email: 'bat@example.mn', password: 'сайн нууц үг' });
    await attachEmail(ctx, { guestId: made.guestId, email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn')! });

    await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: 'сайн нууц үг' })).resolves.toMatchObject({
      guestId: made.guestId,
    });
  });

  it('refuses an address somebody else has, and a second address', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!);

    const made = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    await expect(
      sendAttachCode(ctx, { guestId: made.guestId, email: 'bat@example.mn', password: 'сайн нууц үг' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });

    await sendAttachCode(ctx, { guestId: made.guestId, email: 'dorj@example.mn', password: 'сайн нууц үг' });
    await attachEmail(ctx, { guestId: made.guestId, email: 'dorj@example.mn', code: mailer.codeFor('dorj@example.mn')! });
    await expect(
      sendAttachCode(ctx, { guestId: made.guestId, email: 'dorj2@example.mn', password: 'сайн нууц үг' }),
    ).rejects.toMatchObject({ code: 'EMAIL_SET' });
  });

  it('takes only the code this account asked for, past its own password', async () => {
    const made = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    // A code the door sends to anybody's inbox for the asking.
    await sendEmailCode(ctx, 'dorj@example.mn');
    await expect(
      attachEmail(ctx, { guestId: made.guestId, email: 'dorj@example.mn', code: mailer.codeFor('dorj@example.mn')! }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });

    // One another account asked for is that account's.
    const other = await registerGuest(ctx, { phone: '+97699003344', password: 'өөр нууц үг' });
    await sendAttachCode(ctx, { guestId: other.guestId, email: 'dorj@example.mn', password: 'өөр нууц үг' });
    const theirs = mailer.codeFor('dorj@example.mn')!;
    await expect(attachEmail(ctx, { guestId: made.guestId, email: 'dorj@example.mn', code: theirs })).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    await attachEmail(ctx, { guestId: other.guestId, email: 'dorj@example.mn', code: theirs });
  });

  it('asks an account with neither a password nor an address to have signed in a moment ago', async () => {
    // Made by a code to its phone: nothing to type, and nowhere else to send a code.
    const { guestId, token } = await startSession(ctx, '+97688010001');
    clock.advanceMinutes(11);
    await expect(sendAttachCode(ctx, { guestId, email: 'bat@example.mn', token })).rejects.toMatchObject({ code: 'SIGN_IN_AGAIN' });
    await expect(sendAttachCode(ctx, { guestId, email: 'bat@example.mn' })).rejects.toMatchObject({ code: 'SIGN_IN_AGAIN' });
    // Somebody else's session a moment old is not this account's.
    const stranger = await startSession(ctx, '+97688010002');
    await expect(sendAttachCode(ctx, { guestId, email: 'bat@example.mn', token: stranger.token })).rejects.toMatchObject({
      code: 'SIGN_IN_AGAIN',
    });
    expect(mailer.sent).toHaveLength(0);

    const again = await startSession(ctx, '+97688010001');
    await sendAttachCode(ctx, { guestId, email: 'bat@example.mn', token: again.token });
    await attachEmail(ctx, { guestId, email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn')! });
  });
});

describe('a first password, from inside a session', () => {
  it('is set only with the code sent to the account’s own address for it, and the address hears of it', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    const made = await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!);
    await expect(changePassword(ctx, { guestId: made.guestId, next: 'шинэ нууц үг' })).rejects.toMatchObject({
      code: 'PROOF_REQUIRED',
    });

    // A code the door sent to that inbox is the door's, and stays good there.
    clock.advanceMinutes(1);
    await sendEmailCode(ctx, 'bat@example.mn');
    const doors = mailer.codeFor('bat@example.mn')!;
    await expect(changePassword(ctx, { guestId: made.guestId, next: 'шинэ нууц үг', code: doors })).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });

    expect(await sendFirstPasswordCode(ctx, { guestId: made.guestId })).toEqual({ sentTo: 'bat@example.mn' });
    const code = mailer.codeFor('bat@example.mn')!;
    // …and this one is not the door's.
    await expect(verifyEmailCode(ctx, 'bat@example.mn', code)).rejects.toMatchObject({ code: 'INVALID_CODE' });
    await verifyEmailCode(ctx, 'bat@example.mn', doors);

    await changePassword(ctx, { guestId: made.guestId, next: 'шинэ нууц үг', code });
    await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: 'шинэ нууц үг' })).resolves.toMatchObject({
      guestId: made.guestId,
    });
    expect(mailer.to('bat@example.mn')!.subject).toBe('Basu · Нууц үг тохирууллаа');
    await expect(sendFirstPasswordCode(ctx, { guestId: made.guestId })).rejects.toMatchObject({ code: 'PASSWORD_SET' });
  });

  it('is a code the table itself will not let name nobody, or name an account at the door', async () => {
    const { guestId } = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    const code = (purpose: string, who: string | null) =>
      getPool().query(
        `INSERT INTO identity.otp_challenge (email, code_hash, expires_at, created_at, purpose, guest_id)
         VALUES ('bat@example.mn', 'x', $1, $1, $2, $3)`,
        [clock.now(), purpose, who],
      );
    await expect(code('set_password', null)).rejects.toThrow(/otp_asked_by_an_account/);
    await expect(code('attach', null)).rejects.toThrow(/otp_asked_by_an_account/);
    await expect(code('sign_in', guestId)).rejects.toThrow(/otp_asked_by_an_account/);
    await expect(code('whatever', null)).rejects.toThrow(/purpose/);
    await expect(code('set_password', guestId)).resolves.toBeTruthy();
  });
});

describe('letters about a password', () => {
  /**
   * The day's letters, gone to other addresses in the last hours: `codes`
   * codes by email and `notices` letters about a password (whose account
   * they were about matters to nobody here, so it is `guestId`'s).
   */
  async function lettersSent(guestId: string, codes: number, notices: number): Promise<void> {
    await getPool().query(
      `INSERT INTO identity.otp_challenge (email, code_hash, expires_at, created_at)
       SELECT 'code' || n || '@example.mn', 'x', $1::timestamptz, $1::timestamptz - n * interval '1 second' FROM generate_series(1, $2::int) n`,
      [clock.now(), codes],
    );
    await getPool().query(
      `INSERT INTO identity.notice (email, guest_id, created_at)
       SELECT 'other' || n || '@example.mn', $1, $2::timestamptz - n * interval '1 second' FROM generate_series(1, $3::int) n`,
      [guestId, clock.now(), notices],
    );
  }
  /** What the day's count is in production, where the codes are held to it too. */
  async function inProduction<T>(work: () => Promise<T>): Promise<T> {
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    try {
      return await work();
    } finally {
      if (before === undefined) delete process.env['BASU_MODE'];
      else process.env['BASU_MODE'] = before;
    }
  }

  it('stop once the day’s letters are gone, codes and all — the password set all the same — and are swept a day on', async () => {
    const made = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'bat@example.mn');
    // With the code that tied the address, the day's letters — every one of them a code.
    await lettersSent(made.guestId, LETTERS_PER_DAY - 1, 0);
    const before = mailer.sent.length;
    await changePassword(ctx, { guestId: made.guestId, current: 'хуучин нууц үг', next: 'шинэ нууц үг' });
    expect(mailer.sent).toHaveLength(before);
    await expect(signInWithPassword(ctx, { login: 'bat@example.mn', password: 'шинэ нууц үг' })).resolves.toBeTruthy();

    // A day on they count for nothing, and the sweep takes them.
    clock.advanceMinutes(24 * 60 + 1);
    await changePassword(ctx, { guestId: made.guestId, current: 'шинэ нууц үг', next: 'гурав дахь нууц үг' });
    expect(mailer.sent).toHaveLength(before + 1);
    expect(mailer.to('bat@example.mn')!.subject).toBe('Basu · Нууц үг солигдлоо');
    expect(await purgeChallenges(clock.now())).toBeGreaterThanOrEqual(LETTERS_PER_DAY);
    const { rows } = await getPool().query<{ email: string }>('SELECT email FROM identity.notice');
    expect(rows).toEqual([{ email: 'bat@example.mn' }]);
  });

  it('are not silenced for everybody by fifty of them to addresses somebody holds', async () => {
    const made = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'bat@example.mn');
    // Fifty accounts on the addresses of whoever wants the next letter unsent, each changing its password once.
    await lettersSent(made.guestId, 0, 50);
    await changePassword(ctx, { guestId: made.guestId, current: 'хуучин нууц үг', next: 'шинэ нууц үг' });
    expect(mailer.to('bat@example.mn')!.subject).toBe('Basu · Нууц үг солигдлоо');
  });

  it('go past the day’s count to an account the caller says is always told, one an hour still', async () => {
    const desk = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'boss@example.mn');
    const guest = await phoneAccountWithEmail('+97699003344', 'хуучин нууц үг', 'bat@example.mn');
    await lettersSent(desk.guestId, 0, LETTERS_PER_DAY);
    const asked: string[] = [];
    const alwaysTold = async (guestId: string) => {
      asked.push(guestId);
      return guestId === desk.guestId;
    };

    await changePassword(ctx, { guestId: desk.guestId, current: 'хуучин нууц үг', next: 'шинэ нууц үг', alwaysTold });
    expect(mailer.to('boss@example.mn')!.subject).toBe('Basu · Нууц үг солигдлоо');
    expect(asked).toEqual([desk.guestId]);
    // Anybody else's is counted as before, and the count is spent.
    const before = mailer.sent.length;
    await changePassword(ctx, { guestId: guest.guestId, current: 'хуучин нууц үг', next: 'шинэ нууц үг', alwaysTold });
    expect(mailer.sent).toHaveLength(before);
    // The hour's one letter to an address holds for the desk too.
    await changePassword(ctx, { guestId: desk.guestId, current: 'шинэ нууц үг', next: 'гурав дахь нууц үг', alwaysTold });
    expect(mailer.sent).toHaveLength(before);

    // The door's way to a new password, by the code in the letter, the same.
    clock.advanceMinutes(61);
    await sendPasswordCode(ctx, { login: 'boss@example.mn', purpose: 'reset' });
    await setPasswordWithCode(ctx, { login: 'boss@example.mn', code: mailer.codeFor('boss@example.mn')!, password: 'дөрөв дэх нууц үг', alwaysTold });
    expect(mailer.to('boss@example.mn')!.subject).toBe('Basu · Нууц үг солигдлоо');
    // A caller that cannot say is not taken for a yes.
    clock.advanceMinutes(61);
    const before2 = mailer.sent.length;
    await changePassword(ctx, {
      guestId: desk.guestId,
      current: 'дөрөв дэх нууц үг',
      next: 'тав дахь нууц үг',
      alwaysTold: () => Promise.reject(new Error('the desk did not answer')),
    });
    expect(mailer.sent).toHaveLength(before2);
    await expect(signInWithPassword(ctx, { login: 'boss@example.mn', password: 'тав дахь нууц үг' })).resolves.toBeTruthy();
  });

  it('use up the codes’ day as well: once the day’s letters are gone no code goes either', async () => {
    const made = await phoneAccountWithEmail('+97699001122', 'хуучин нууц үг', 'bat@example.mn');
    // With the code that tied the address, all the day's letters but one — every one of them about a password.
    await lettersSent(made.guestId, 0, LETTERS_PER_DAY - 2);
    await inProduction(async () => {
      await sendEmailCode(ctx, 'last@example.mn');
      await expect(sendEmailCode(ctx, 'next@example.mn')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });
    expect(mailer.to('next@example.mn')).toBeUndefined();
  });
});

describe('an address, masked', () => {
  it('keeps enough to recognise and no more', () => {
    expect(maskEmail('basuappmn@gmail.com')).toBe('ba•••mn@gmail.com');
    expect(maskEmail('bo@gmail.com')).toBe('b•••@gmail.com');
  });
});
