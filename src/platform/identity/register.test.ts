import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { hashPassword, verifyPassword } from './password.js';
import { changePassword, registerGuest, signInWithPassword } from './register.js';
import { resolveGuest } from './auth.js';

/**
 * A door that opens without an SMS gateway.
 *
 * What has to hold: a number cannot be taken twice, a wrong password says
 * nothing about whether the number is known, and a script that guesses gets
 * shut out before it gets far.
 */

let ctx: Ctx;

beforeEach(async () => {
  await truncateAll();
  ctx = {
    clock: new VirtualClock(at('11:40')),
    payments: new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier: new FakeNotifier(),
  };
});

afterAll(async () => {
  await closePool();
});

describe('a password at rest', () => {
  it('never stores what was typed, and still recognises it', async () => {
    const stored = await hashPassword('нуусан үг 12');
    expect(stored).not.toContain('нуусан');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('нуусан үг 12', stored)).toBe(true);
    expect(await verifyPassword('нуусан үг 13', stored)).toBe(false);
  });

  it('hashes the same password differently every time', async () => {
    expect(await hashPassword('ижилхэн үг')).not.toBe(await hashPassword('ижилхэн үг'));
  });

  it('refuses a short one, and a stored value it cannot read', async () => {
    await expect(hashPassword('богино')).rejects.toMatchObject({ code: 'TOO_SHORT' });
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('signing up', () => {
  it('makes the account and hands back a session that works', async () => {
    const session = await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг', name: 'Батаа' });
    expect(session.token).toBeTruthy();
    expect(await resolveGuest(ctx, session.token)).toBe(session.guestId);
  });

  it('will not let one number be claimed twice', async () => {
    await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
    await expect(registerGuest(ctx, { phone: '+97699001122', password: 'өөр нууц үг' })).rejects.toMatchObject({
      code: 'PHONE_TAKEN',
    });
    // And the first password still opens it.
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг' })).resolves.toMatchObject({
      guestId: expect.any(String),
    });
  });

  it('will not attach a password to an account that exists without one', async () => {
    // An account made some other way — the desk, an older sign-in — has no
    // password. Knowing its number must not be enough to take it.
    const { startSession } = await import('./auth.js');
    await startSession(ctx, '+97688010001');
    await expect(registerGuest(ctx, { phone: '+97688010001', password: 'булаах гэсэн' })).rejects.toMatchObject({
      code: 'PHONE_TAKEN',
    });
    await expect(signInWithPassword(ctx, { login: '+97688010001', password: 'булаах гэсэн' })).rejects.toMatchObject({
      code: 'BAD_CREDENTIALS',
    });
  });

  it('refuses a number that is not Mongolian, and a password that is too short', async () => {
    await expect(registerGuest(ctx, { phone: '+15551234567', password: 'сайн нууц үг' })).rejects.toMatchObject({ code: 'BAD_PHONE' });
    await expect(registerGuest(ctx, { phone: '+97699001122', password: 'богино' })).rejects.toMatchObject({ code: 'TOO_SHORT' });
  });
});

describe('a number as people type it', () => {
  it('is one account whether it was typed with +976, without, or with spaces', async () => {
    const made = await registerGuest(ctx, { phone: '8811 2233', password: 'нэг хоёр гурав' });
    await expect(registerGuest(ctx, { phone: '+97688112233', password: 'нэг хоёр гурав' })).rejects.toMatchObject({ code: 'PHONE_TAKEN' });
    const session = await signInWithPassword(ctx, { login: '976-8811-2233', password: 'нэг хоёр гурав' });
    expect(await resolveGuest(ctx, session.token)).toBe(made.guestId);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await registerGuest(ctx, { phone: '+97699001122', password: 'сайн нууц үг' });
  });

  it('opens with the right password', async () => {
    const session = await signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг', device: 'iPhone' });
    expect(await resolveGuest(ctx, session.token)).toBe(session.guestId);
  });

  it('says the same thing for a wrong password and an unknown number', async () => {
    const wrong = await signInWithPassword(ctx, { login: '+97699001122', password: 'буруу нууц үг' }).catch((e: unknown) => e);
    const unknown = await signInWithPassword(ctx, { login: '+97688009999', password: 'ямар ч нууц үг' }).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect(unknown).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect((wrong as Error).message).toBe((unknown as Error).message);
  });

  it('rests the door after five wrong guesses, even for the right password', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(signInWithPassword(ctx, { login: '+97699001122', password: `буруу ${i}` })).rejects.toMatchObject({
        code: 'BAD_CREDENTIALS',
      });
    }
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг' })).rejects.toMatchObject({
      code: 'LOCKED',
    });
    // A quarter of an hour later it opens again.
    (ctx.clock as VirtualClock).advanceMinutes(16);
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг' })).resolves.toBeTruthy();
  });

  it('forgets the failures once somebody gets in', async () => {
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'буруу' })).rejects.toBeTruthy();
    await signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг' });
    for (let i = 0; i < 4; i++) {
      await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'буруу' })).rejects.toMatchObject({
        code: 'BAD_CREDENTIALS',
      });
    }
    // Four after a success is still under the ceiling.
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'сайн нууц үг' })).resolves.toBeTruthy();
  });
});

describe('changing it', () => {
  it('needs the old one, and the new one opens the door', async () => {
    const { guestId } = await registerGuest(ctx, { phone: '+97699001122', password: 'хуучин нууц үг' });
    await expect(changePassword(ctx, { guestId, current: 'таамаг', next: 'шинэ нууц үг' })).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
    await changePassword(ctx, { guestId, current: 'хуучин нууц үг', next: 'шинэ нууц үг' });
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'хуучин нууц үг' })).rejects.toBeTruthy();
    await expect(signInWithPassword(ctx, { login: '+97699001122', password: 'шинэ нууц үг' })).resolves.toBeTruthy();
  });
});
