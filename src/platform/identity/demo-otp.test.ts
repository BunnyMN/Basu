import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { getPool } from '../../db/pool.js';
import { DEMO_OTP, purgeChallenges, requestOtp, verifyOtp } from './index.js';

/**
 * The demo server has no SMS, so its one-time code is always the same one —
 * which is how a store build pointed at the demo, and Apple's reviewer, get
 * in. Production must never do this.
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

afterEach(() => {
  delete process.env['BASU_MODE'];
});

afterAll(async () => {
  await closePool();
});

describe('the one-time code', () => {
  it('is the demo code in demo mode, and opens a session', async () => {
    process.env['BASU_MODE'] = 'demo';
    const { code } = await requestOtp(ctx, '+97699000001');
    expect(code).toBe(DEMO_OTP);
    const session = await verifyOtp(ctx, '+97699000001', DEMO_OTP, 'reviewer');
    expect(session.token).toBeTruthy();
  });

  it('is drawn at random in production', async () => {
    process.env['BASU_MODE'] = 'production';
    const first = await requestOtp(ctx, '+97699000002');
    const second = await requestOtp(ctx, '+97699000003');
    expect(first.code).toMatch(/^\d{6}$/);
    expect([first.code, second.code]).not.toEqual([DEMO_OTP, DEMO_OTP]);
  });
});

describe('yesterday’s codes', () => {
  it('are swept out after a day, today’s left alone', async () => {
    await requestOtp(ctx, '+97699000004');
    const clock = ctx.clock as VirtualClock;
    clock.advanceMinutes(25 * 60);
    await requestOtp(ctx, '+97699000005');
    expect(await purgeChallenges(clock.now())).toBe(1);
    const { rows } = await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM identity.otp_challenge');
    expect(rows[0]?.n).toBe(1);
  });
});
