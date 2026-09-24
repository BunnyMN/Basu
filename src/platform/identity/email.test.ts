import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { CODES_PER_EMAIL_PER_HOUR, resolveGuest, sendEmailCode, verifyEmailCode } from './auth.js';
import { registerGuest } from './register.js';

/**
 * A code by email: the way in that needs nothing but an inbox.
 *
 * What has to hold: the code leaves only in the letter, one address is one
 * account however it is typed, guessing stops after three tries, and a script
 * cannot turn the server into a mail cannon.
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

describe('signing in with a code by email', () => {
  it('makes the account on first use, and finds the same one after', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    const letter = mailer.to('bat@example.mn')!;
    expect(letter.subject).toContain(mailer.codeFor('bat@example.mn'));
    const first = await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!, 'Chrome');
    expect(await resolveGuest(ctx, first.token)).toBe(first.guestId);

    await sendEmailCode(ctx, 'bat@example.mn');
    const again = await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!);
    expect(again.guestId).toBe(first.guestId);
  });

  it('is one account however the address is typed', async () => {
    await sendEmailCode(ctx, '  Bat@Example.MN ');
    const made = await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!);
    await sendEmailCode(ctx, 'BAT@example.mn');
    const back = await verifyEmailCode(ctx, 'Bat@EXAMPLE.mn', mailer.codeFor('bat@example.mn')!);
    expect(back.guestId).toBe(made.guestId);
    const { rows } = await getPool().query('SELECT email FROM identity.guest');
    expect(rows).toEqual([{ email: 'bat@example.mn' }]);
  });

  it('is used once', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    const code = mailer.codeFor('bat@example.mn')!;
    await verifyEmailCode(ctx, 'bat@example.mn', code);
    await expect(verifyEmailCode(ctx, 'bat@example.mn', code)).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  it('stops listening after three wrong guesses, even for the right code', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    const code = mailer.codeFor('bat@example.mn')!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      await expect(verifyEmailCode(ctx, 'bat@example.mn', wrong)).rejects.toMatchObject({ code: 'INVALID_CODE' });
    }
    await expect(verifyEmailCode(ctx, 'bat@example.mn', code)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('runs out after ten minutes', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    clock.advanceMinutes(11);
    await expect(verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!)).rejects.toMatchObject({
      code: 'EXPIRED',
    });
  });

  it('does not open one address with the code sent to another', async () => {
    await sendEmailCode(ctx, 'bat@example.mn');
    await expect(verifyEmailCode(ctx, 'dorj@example.mn', mailer.codeFor('bat@example.mn')!)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });
});

describe('what the door refuses', () => {
  it('an address that is not one', async () => {
    for (const nonsense of ['', 'bat', 'bat@', '@example.mn', 'bat@example', 'b at@example.mn']) {
      await expect(sendEmailCode(ctx, nonsense)).rejects.toMatchObject({ code: 'BAD_EMAIL' });
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it('more than a handful of letters an hour to one address', async () => {
    for (let i = 0; i < CODES_PER_EMAIL_PER_HOUR; i++) await sendEmailCode(ctx, 'bat@example.mn');
    await expect(sendEmailCode(ctx, 'bat@example.mn')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mailer.sent).toHaveLength(CODES_PER_EMAIL_PER_HOUR);
    // Somebody else is not held up by it, and the hour passes.
    await sendEmailCode(ctx, 'dorj@example.mn');
    clock.advanceMinutes(61);
    await sendEmailCode(ctx, 'bat@example.mn');
  });

  it('says so when there is nothing to send mail with', async () => {
    const { mailer: _, ...closed } = ctx;
    await expect(sendEmailCode(closed, 'bat@example.mn')).rejects.toMatchObject({ code: 'EMAIL_CLOSED' });
  });

  it('says so when the mail server does not take the letter', async () => {
    mailer.failNext = true;
    await expect(sendEmailCode(ctx, 'bat@example.mn')).rejects.toMatchObject({ code: 'EMAIL_FAILED' });
  });
});

describe('an account that has a phone and no email', () => {
  it('is untouched by somebody signing in with an address', async () => {
    const phone = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    await sendEmailCode(ctx, 'bat@example.mn');
    const byEmail = await verifyEmailCode(ctx, 'bat@example.mn', mailer.codeFor('bat@example.mn')!);
    // No guessing that they are the same person: an address and a number are two accounts.
    expect(byEmail.guestId).not.toBe(phone.guestId);
  });
});
