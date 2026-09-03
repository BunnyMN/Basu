import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { reconcileLedger } from '../platform/ledger/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { seedRestaurant, truncateAll, type SeededRestaurant } from '../test/seed.js';

/**
 * Profile, wallet and inbox over HTTP.
 *
 * Every test here is written without mentioning a restaurant on purpose: these
 * are the three things the platform owes a second vertical, and if any of them
 * needed a lunch to exist first, it would not be a platform service.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let payments: FakePaymentProvider;
let ctx: Ctx;
let venue: SeededRestaurant;

const pool = () => getPool();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone = '+97699001122', device?: string): Promise<string> {
  // A second sign-in needs a later second: `verifyOtp` takes the newest
  // challenge by `created_at`, and a frozen clock stamps two of them alike.
  clock.advanceSeconds(1);
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { phone, code, device },
  });
  return verified.json().token as string;
}

/** Money in, the way the phone does it: ask, then confirm it arrived. */
async function topUp(token: string, amountMnt: number): Promise<number> {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/wallet/topup',
    headers: auth(token),
    payload: { amount_mnt: amountMnt },
  });
  expect(started.statusCode, started.body).toBe(200);
  const settled = await app.inject({
    method: 'POST',
    url: `/v1/wallet/topup/${started.json().topup_id}/settle`,
    headers: auth(token),
  });
  expect(settled.statusCode, settled.body).toBe(200);
  return settled.json().balance_mnt as number;
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  payments = new FakePaymentProvider();
  ctx = { clock, payments, tax: new FakeTaxProvider(), notifier };
  app = await buildServer(ctx);
  venue = await seedRestaurant();
  await pool().query(
    `INSERT INTO dine.slot (restaurant_id, starts_at, ends_at, max_orders, max_covers)
     VALUES ($1, $2::timestamptz, $2::timestamptz + interval '15 minutes', 3, 12)`,
    [venue.restaurantId, at('12:30')],
  );
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('who you are', () => {
  it('answers the launcher with profile, balance and unread in one call', async () => {
    const token = await signIn();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      phone: '+97699001122',
      locale: 'mn',
      wallet: { balance_mnt: 0, currency: 'MNT' },
      unread: 0,
    });
    // A new guest has an avatar without anyone uploading anything.
    expect(me.json().avatar_seed).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps a name, and gives it back everywhere', async () => {
    const token = await signIn();
    const saved = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth(token),
      payload: { display_name: 'Батаа', locale: 'en' },
    });
    expect(saved.json()).toMatchObject({ display_name: 'Батаа', locale: 'en' });

    const again = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    expect(again.json().display_name).toBe('Батаа');
  });

  it('refuses an unsigned caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/wallet' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/notifications' })).statusCode).toBe(401);
  });
});

describe('the wallet', () => {
  it('credits nothing until the money is confirmed', async () => {
    const token = await signIn();
    const started = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: auth(token),
      payload: { amount_mnt: 50_000 },
    });
    expect(started.json()).toMatchObject({ amount_mnt: 50_000, state: 'pending' });
    expect(started.json().action_url).toMatch(/^qpay:/);

    // Asking is not paying: the balance moves in settle, not here.
    const before = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    expect(before.json().balance_mnt).toBe(0);

    await app.inject({
      method: 'POST',
      url: `/v1/wallet/topup/${started.json().topup_id}/settle`,
      headers: auth(token),
    });
    const after = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    expect(after.json().balance_mnt).toBe(50_000);
  });

  it('settles twice without paying twice', async () => {
    const token = await signIn();
    const started = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup',
      headers: auth(token),
      payload: { amount_mnt: 20_000 },
    });
    const url = `/v1/wallet/topup/${started.json().topup_id}/settle`;
    await app.inject({ method: 'POST', url, headers: auth(token) });
    const second = await app.inject({ method: 'POST', url, headers: auth(token) });

    expect(second.json().balance_mnt).toBe(20_000);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });

  it('refuses an amount outside what this app is for', async () => {
    const token = await signIn();
    for (const amount of [0, -5000, 500, 9_000_000, 1000.5]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/topup',
        headers: auth(token),
        payload: { amount_mnt: amount },
      });
      expect(response.statusCode, `${amount}`).toBe(400);
    }
  });

  it('spends the balance on lunch, and says so in the statement', async () => {
    const token = await signIn();
    await topUp(token, 50_000);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(token),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
      },
    });
    const order = created.json();
    await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pay`,
      headers: auth(token),
    });

    const statement = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    const lines = statement.json().lines as Array<{ kind: string; amount_mnt: number }>;

    expect(statement.json().balance_mnt).toBe(50_000 - order.total_mnt);
    expect(lines[0]).toMatchObject({ kind: 'purchase', amount_mnt: -order.total_mnt });
    expect(lines[1]).toMatchObject({ kind: 'topup', amount_mnt: 50_000 });
    // Paying out of a balance we already had should not touch the card.
    expect(payments.authorized).toHaveLength(1);
  });

  it('pulls only the shortfall from the card', async () => {
    const token = await signIn();
    await topUp(token, 5_000);
    payments.authorized.length = 0;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(token),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 2 }],
      },
    });
    const order = created.json();
    const paid = await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pay`,
      headers: auth(token),
    });
    expect(paid.statusCode, paid.body).toBe(200);

    // The guest is asked for the difference, not for the whole bill again —
    // read from the statement rather than the ledger's tables, because that is
    // the only thing anyone outside the ledger is allowed to look at.
    const statement = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    const lines = statement.json().lines as Array<{ kind: string; amount_mnt: number }>;
    expect(lines.filter((l) => l.kind === 'topup').map((l) => l.amount_mnt)).toEqual([
      order.total_mnt - 5_000,
      5_000,
    ]);
    expect(payments.authorized).toHaveLength(1);
    expect(statement.json().balance_mnt).toBe(0);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });

  it('never lets one wallet see another', async () => {
    const mine = await signIn('+97699001122');
    const theirs = await signIn('+97688112233');
    await topUp(theirs, 30_000);

    const wallet = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(mine) });
    expect(wallet.json().balance_mnt).toBe(0);
    expect(wallet.json().lines).toEqual([]);
  });
});

describe('where you are signed in', () => {
  it('lists the sessions and says which one is asking', async () => {
    const first = await signIn('+97699001122', 'iPhone 15')
    const second = await signIn('+97699001122', 'iPad')

    const seen = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: auth(second),
    });
    const sessions = seen.json().sessions as Array<{ label: string; current: boolean }>;

    expect(sessions.map((s) => s.label).sort()).toEqual(['iPad', 'iPhone 15']);
    // A list where you cannot tell which row is the phone in your hand is a
    // list nobody dares use.
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.current)?.label).toBe('iPad');
    void first;
  });

  it('signs the other phones out and leaves this one alone', async () => {
    const lost = await signIn('+97699001122', 'iPhone 15');
    const mine = await signIn('+97699001122', 'iPad');

    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke',
      headers: auth(mine),
    });
    expect(revoked.json()).toEqual({ revoked: 1 });

    // The lost phone is out; the one that asked is still in. Reversing those
    // two is the whole failure mode of this feature.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(lost) })).statusCode)
      .toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(mine) })).statusCode)
      .toBe(200);
  });
});

describe('leaving', () => {
  it('closes the account and lets the number come back as somebody new', async () => {
    const token = await signIn();
    const before = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth(token),
      payload: { display_name: 'Батаа' },
    });

    const closed = await app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(token) });
    expect(closed.json()).toEqual({ closed: true });

    // Every session goes with it, including the one that asked.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).statusCode)
      .toBe(401);

    // The same number opens a new account, and it is a stranger: a phone
    // number that could never be reused would be a tombstone, not a closure.
    const again = await signIn();
    const now = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(again) });
    expect(now.json().id).not.toBe(before.json().id);
    expect(now.json().display_name).toBeNull();
  });

  it('refuses while the wallet still holds money', async () => {
    const token = await signIn();
    await topUp(token, 20_000);

    const refused = await app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(token) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('HAS_BALANCE');
    // Still signed in, still holding the money.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).statusCode)
      .toBe(200);
  });

  it('refuses while something of theirs is still running', async () => {
    const token = await signIn();
    // No top-up: the whole bill is pulled from the card, so the wallet ends at
    // zero and this reaches the check it is actually about.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(token),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
      },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/orders/${created.json().id}/pay`,
      headers: auth(token),
    });

    const refused = await app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(token) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('HAS_LIVE_WORK');
  });
});

describe('one movement, in full', () => {
  it('hands back the tax receipt once the authority has issued it', async () => {
    const token = await signIn();
    await topUp(token, 200_000);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(token),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
      },
    });
    const order = created.json();
    await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pay`,
      headers: auth(token),
    });

    const statement = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
    const purchase = (statement.json().lines as Array<{ id: string; kind: string }>)
      .find((l) => l.kind === 'purchase')!;

    const before = await app.inject({
      method: 'GET',
      url: `/v1/wallet/${purchase.id}`,
      headers: auth(token),
    });
    // Nothing has been issued yet, and saying so is better than an empty box.
    expect(before.json().receipt).toBeNull();
    expect(before.json().memo).toMatch(/Хоол/);

    // Queue the receipt against the movement and drain it, which is what
    // closing an order does. Walking the whole state machine to get here would
    // be re-testing `lifecycle.test.ts`; what this test is about is the wallet
    // handing the receipt back once one exists.
    const { processReceipts, queueReceipt } = await import('../platform/ledger/index.js');
    await queueReceipt({
      transferId: purchase.id,
      kind: 'SALE',
      merchantTin: '1234567',
      orderCode: order.code,
      amountMnt: order.total_mnt,
    });
    await processReceipts(ctx);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/wallet/${purchase.id}`,
      headers: auth(token),
    });
    expect(after.json().receipt.lottery).toMatch(/^AA/);
    expect(after.json().receipt.qr).toMatch(/ebarimt/);
  });

  it('will not show one guest what another guest spent', async () => {
    const mine = await signIn('+97699001122');
    const theirs = await signIn('+97688112233');
    await topUp(theirs, 30_000);

    const statement = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(theirs) });
    const line = statement.json().lines[0];

    const peek = await app.inject({
      method: 'GET',
      url: `/v1/wallet/${line.id}`,
      headers: auth(mine),
    });
    expect(peek.statusCode).toBe(500);
  });
});

describe('the inbox', () => {
  it('shows what the guest was told, and counts what they have not read', async () => {
    const token = await signIn();
    const { enqueue } = await import('../platform/notify/index.js');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });

    await enqueue(ctx, {
      guestId: me.json().id,
      template: 'welcome',
      title: 'Basu-д тавтай морил',
      body: 'Түрийвчээ цэнэглээрэй.',
      channel: 'push',
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: auth(token),
    });
    expect(listed.json().unread).toBe(1);
    expect(listed.json().messages[0]).toMatchObject({
      title: 'Basu-д тавтай морил',
      read: false,
    });

    const read = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: auth(token),
    });
    expect(read.json().unread).toBe(0);
  });

  it('remembers a phone to push to, and what the guest agreed to', async () => {
    const token = await signIn();
    const registered = await app.inject({
      method: 'POST',
      url: '/v1/notifications/devices',
      headers: auth(token),
      payload: { push_token: 'apns-abc-123', platform: 'ios', label: 'iPhone' },
    });
    expect(registered.json()).toEqual({ registered: true });

    const off = await app.inject({
      method: 'PATCH',
      url: '/v1/notifications/preferences',
      headers: auth(token),
      payload: { marketing: false, push: false },
    });
    expect(off.json()).toMatchObject({ push: false, sms: true, marketing: false });
  });

  it('rejects a device registration that names nothing', async () => {
    const token = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/notifications/devices',
      headers: auth(token),
      payload: { platform: 'ios' },
    });
    expect(response.statusCode).toBe(400);
  });
});
