import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { registerGuest, sendOtp, verifyOtp } from '../platform/identity/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { listMembers, memberForAccount, syncMembersFromEnv } from './index.js';

/**
 * The seats the desk gave before it named them only by proof.
 *
 * Choosing an account for a seat wrote the account's phone number onto the
 * seat, typed or proved. Migration 042 lets go of the typed ones. What was
 * written then can only be written here by hand: nothing the desk does now
 * writes it.
 */

let ctx: Ctx;
let notifier: FakeNotifier;

beforeEach(async () => {
  await truncateAll();
  notifier = new FakeNotifier();
  ctx = { clock: new VirtualClock(at('11:40')), payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
});

afterAll(async () => {
  await closePool();
});

/** An account on a number an SMS code reached: the one way a number is proved. */
async function proved(phone: string): Promise<string> {
  await sendOtp(ctx, phone);
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1] ?? '';
  return (await verifyOtp(ctx, phone, code)).guestId;
}

/** A seat as choosing wrote it before: the chosen account's number, whatever proved it. */
async function chosenBefore(guestId: string, name: string, phone: string, role: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>('INSERT INTO ops.member (name, role, phone) VALUES ($1, $2, $3) RETURNING id', [name, role, phone]);
  await getPool().query(`INSERT INTO ops.member_account (guest_id, member_id, how) VALUES ($1, $2, 'chosen')`, [guestId, rows[0]!.id]);
  return rows[0]!.id;
}

describe('migration 042: a seat keeps no number its person only typed', () => {
  it('lets the typed number go and keeps the seat, a proved number and one the environment named', async () => {
    const typed = await registerGuest(ctx, { phone: '+97699120001', password: 'миний нууц үг', name: 'Бичсэн' });
    const typedSeat = await chosenBefore(typed.guestId, 'Бичсэн', '+97699120001', 'ops');
    const provedSeat = await chosenBefore(await proved('+97699120002'), 'Баталсан', '+97699120002', 'finance');
    // Named by the environment, and nobody chosen for it: the number is the owner's word.
    await syncMembersFromEnv('+97699120003:Орчин:viewer', () => {});

    await getPool().query(await readFile(new URL('../../migrations/042_seats_keep_no_typed_numbers.sql', import.meta.url), 'utf8'));

    const now = await listMembers();
    expect(now.find((m) => m.id === typedSeat)).toMatchObject({ phone: null, name: 'Бичсэн', role: 'ops', active: true, accounts: 1 });
    expect(now.find((m) => m.id === provedSeat)).toMatchObject({ phone: '+97699120002', role: 'finance' });
    expect(now.find((m) => m.name === 'Орчин')).toMatchObject({ phone: '+97699120003', accounts: 0 });
    // The person chosen still sits where they sat.
    expect(await memberForAccount(typed.guestId)).toMatchObject({ id: typedSeat, role: 'ops', active: true });
    // And the number is free for the environment to name its owner by.
    expect(await syncMembersFromEnv('+97699120001:Жинхэнэ эзэн:viewer', () => {})).toBe(1);
  });
});
