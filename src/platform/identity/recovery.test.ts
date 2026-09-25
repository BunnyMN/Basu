import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { resolveGuest, sendEmailCode, verifyEmailCode } from './auth.js';
import {
  attachEmail,
  maskEmail,
  registerGuest,
  sendAttachCode,
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
    // It had no password before, so nobody else could have known one: the session stays.
    expect(await resolveGuest(ctx, first.token)).toBe(first.guestId);
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
});

describe('an address, masked', () => {
  it('keeps enough to recognise and no more', () => {
    expect(maskEmail('basuappmn@gmail.com')).toBe('ba•••mn@gmail.com');
    expect(maskEmail('bo@gmail.com')).toBe('b•••@gmail.com');
  });
});
