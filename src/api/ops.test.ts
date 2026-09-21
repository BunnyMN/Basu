import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { opsToken } from './ops.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { storedBankOf, truncateAll } from '../test/seed.js';
import { createListing, housekeeping, markHanded, markReady, registerSupplier, startPreparing } from '../idesh/index.js';
import { listMembers, syncMembersFromEnv, upsertMember } from '../ops/index.js';

/**
 * Becoming a supplier, over HTTP: the guest's side, the ops desk, and the
 * one secret between them.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone = '+97688010009'): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function applied(token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/supplier/apply',
    headers: auth(token),
    payload: { name: 'Завхан · Бат-Эрдэнэ', tin: '6505678901', address: 'Хархорин зах', about: 'хонь' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });
});

afterEach(() => {
  delete process.env['OPS_TOKEN'];
  delete process.env['BASU_MODE'];
  delete process.env['BANK_KEY'];
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('the ops desk', () => {
  it('lives at /dashboard, and the old /ops address still leads there', async () => {
    const page = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('renderOverview');
    const old = await app.inject({ method: 'GET', url: '/ops' });
    expect(old.statusCode).toBe(301);
    expect(old.headers.location).toBe('/dashboard');
  });

  it('opens only to the secret', async () => {
    const none = await app.inject({ method: 'GET', url: '/v1/ops/suppliers' });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth('nope') });
    expect(wrong.statusCode).toBe(401);
    const right = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) });
    expect(right.statusCode).toBe(200);
    // The demo hands the secret out; it is the configured one when there is one.
    const handed = await app.inject({ method: 'GET', url: '/dev/ops-token' });
    expect(handed.json().token).toBe('ops-secret-for-the-test');
  });

  it('opens to members only in production — a secret, set or not, is no key', async () => {
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    try {
      expect(opsToken()).toBeNull();
      for (const sent of ['anything', 'ops-secret-for-the-test']) {
        const response = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(sent) });
        expect(response.statusCode, sent).toBe(401);
      }
    } finally {
      if (before === undefined) delete process.env['BASU_MODE'];
      else process.env['BASU_MODE'] = before;
    }
  });

  it('walks an application from the form to a paired screen', async () => {
    const guest = await signIn();
    const id = await applied(guest);

    // The applicant sees it waiting; a guest sees nothing of it.
    const waiting = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(waiting.json().application).toMatchObject({ id, state: 'applied', pairing_code: null });
    expect((await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings).toEqual([]);

    // Ops sees it first in the list, with the phone that was proved.
    const desk = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) });
    expect(desk.json().suppliers[0]).toMatchObject({ id, state: 'applied', phone: '+97688010009' });

    const yes = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${id}/approve`,
      headers: auth(opsToken()!),
      payload: {},
    });
    expect(yes.statusCode, yes.body).toBe(200);
    const code = yes.json().pairing_code as string;
    expect(code).toMatch(/^\d{8}$/);

    // The applicant now sees the code — and can pair with it.
    const done = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(done.json().application).toMatchObject({ state: 'contracted', pairing_code: code });
    const paired = await app.inject({ method: 'POST', url: '/v1/supplier/pair', payload: { pairing_code: code } });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json().supplier_id).toBe(id);

    const board = await app.inject({ method: 'GET', url: '/v1/supplier/board', headers: auth(paired.json().token) });
    expect(board.json().supplier.name).toBe('Завхан · Бат-Эрдэнэ');
  });

  it('declines with a reason the applicant reads', async () => {
    const guest = await signIn();
    const id = await applied(guest);
    const no = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${id}/decline`,
      headers: auth(opsToken()!),
      payload: { reason: 'ТТД баталгаажаагүй' },
    });
    expect(no.json()).toEqual({ state: 'declined' });
    const mine = await app.inject({ method: 'GET', url: '/v1/supplier/application', headers: auth(guest) });
    expect(mine.json().application).toMatchObject({ state: 'declined', decline_reason: 'ТТД баталгаажаагүй' });
  });

  it('lets ops register a contracted supplier straight in, and mint a fresh code later', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(opsToken()!),
      payload: { name: 'Хэнтий · Хэрлэн', phone: '+97688010002', tin: '6502345678', address: 'Эмээлт' },
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().pairing_code).toMatch(/^\d{8}$/);

    const again = await app.inject({
      method: 'POST',
      url: `/v1/ops/suppliers/${made.json().id}/code`,
      headers: auth(opsToken()!),
      payload: {},
    });
    expect(again.json().pairing_code).toMatch(/^\d{8}$/);
    expect(again.json().pairing_code).not.toBe(made.json().pairing_code);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(opsToken()!),
      payload: { name: 'x', phone: '99001122', address: 'y' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a second open application and a form without an address', async () => {
    const guest = await signIn();
    await applied(guest);
    const twice = await app.inject({
      method: 'POST',
      url: '/v1/supplier/apply',
      headers: auth(guest),
      payload: { name: 'Дахиад', address: 'Хархорин зах, урд хаалга' },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('ALREADY_APPLIED');

    const other = await signIn('+97688010010');
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/supplier/apply',
      headers: auth(other),
      payload: { name: 'Нэр л' },
    });
    expect(bare.statusCode).toBe(400);
  });
});

describe('the contract’s terms and the list to pay', () => {
  it('lets ops write the rate and the account in, and shows them on the row', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(opsToken()!),
      payload: { name: 'УБ махны төв', phone: '+97688010004', address: 'Бага тойруу 24', bank_name: 'Голомт', bank_account: '1105 0123 45', bank_holder: 'Махны төв ХХК' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;

    const rows = (await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) })).json().suppliers;
    expect(rows.find((s: { id: string }) => s.id === id)).toMatchObject({
      commission_pct: 2,
      bank_name: 'Голомт',
      bank_account: '1105012345',
      bank_holder: 'Махны төв ХХК',
    });

    const changed = await app.inject({
      method: 'PATCH',
      url: `/v1/ops/suppliers/${id}`,
      headers: auth(opsToken()!),
      payload: { commission_pct: 3.5, tin: '6505678901' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ commission_pct: 3.5, merchant_tin: '6505678901', bank_name: 'Голомт' });

    const silly = await app.inject({
      method: 'PATCH',
      url: `/v1/ops/suppliers/${id}`,
      headers: auth(opsToken()!),
      payload: { commission_pct: 140 },
    });
    expect(silly.statusCode).toBe(409);
  });

  it('keeps the bank details an applicant typed, for ops to check against the contract', async () => {
    const token = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/supplier/apply',
      headers: auth(token),
      payload: {
        name: 'Завхан · Бат-Эрдэнэ',
        tin: '6505678901',
        address: 'Хархорин зах',
        bank_name: 'Хаан банк',
        bank_account: '5012345678',
        bank_holder: 'Бат-Эрдэнэ',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const rows = (await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth(opsToken()!) })).json().suppliers;
    expect(rows[0]).toMatchObject({ state: 'applied', bank_name: 'Хаан банк', bank_account: '5012345678' });
  });

  it('starts with nothing to pay, and refuses to pay what is not there', async () => {
    const empty = await app.inject({ method: 'GET', url: '/v1/ops/settlements', headers: auth(opsToken()!) });
    expect(empty.json()).toEqual({ settlements: [] });
    const nothing = await app.inject({
      method: 'POST',
      url: '/v1/ops/settlements/00000000-0000-0000-0000-000000000000/paid',
      headers: auth(opsToken()!),
      payload: { reference: 'x' },
    });
    expect(nothing.statusCode).toBe(404);
  });
});

/* ── the desk's window onto orders, the numbers, and the record ── */

async function topUp(token: string, amountMnt: number): Promise<void> {
  const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: amountMnt } });
  expect(started.statusCode, started.body).toBe(200);
  const settled = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${started.json().topup_id}/settle`, headers: auth(token) });
  expect(settled.statusCode, settled.body).toBe(200);
}

/** A contracted supplier with one sheep on offer, and a guest who has paid for it. */
async function aPaidOrder() {
  const supplierId = await registerSupplier({ name: 'Архангай · Дорж', phone: '+97688010001', merchantTin: '6501234567', pickupAddress: 'Нарантуул' });
  const sheep = await createListing(
    supplierId,
    { kind: 'sheep', unit: 'whole', title: 'Хонь', priceMnt: 460_000, approxKg: 38, quantity: 3, origin: 'Архангай', readyFrom: '2026-09-10' },
    clock.now(),
  );
  const guest = await signIn('+97699004009');
  await topUp(guest, 500_000);
  const created = await app.inject({
    method: 'POST',
    url: '/v1/idesh',
    headers: auth(guest),
    payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id, code } = created.json();
  const paid = await app.inject({ method: 'POST', url: `/v1/idesh/${id}/pay`, headers: auth(guest) });
  expect(paid.statusCode, paid.body).toBe(200);
  return { supplierId, listingId: sheep.id as string, guest, id: id as string, code: code as string };
}

const desk = (name?: string) => ({ ...auth(opsToken()!), ...(name ? { 'x-ops-name': name } : {}) });

describe('the desk’s window onto orders', () => {
  it('sees every order, finds one by anything, and reads its story', async () => {
    const { id, code } = await aPaidOrder();
    const all = await app.inject({ method: 'GET', url: '/v1/ops/orders', headers: desk() });
    expect(all.json().orders.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(all.json().orders[0]).toMatchObject({ code, guest_phone: '+97699004009', supplier: { name: 'Архангай · Дорж' } });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/orders?scope=done', headers: desk() })).json().orders).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/orders?q=${code}`, headers: desk() })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/orders?q=Дорж', headers: desk() })).json().orders).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/orders?day=2026-09-13', headers: desk() })).json().orders).toEqual([]);

    const one = await app.inject({ method: 'GET', url: `/v1/ops/orders/${id}`, headers: desk() });
    expect(one.json().events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'PAID']);
    expect(one.json().settlements).toEqual([]);
  });

  it('cancels on a guest’s behalf, for a reason, and the record says who and why', async () => {
    const { id } = await aPaidOrder();
    const unsaid = await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/cancel`, headers: desk('Bayaraa'), payload: {} });
    expect(unsaid.statusCode).toBe(409);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${id}/cancel`,
      headers: desk('Bayaraa'),
      payload: { reason: 'guest_asked', note: 'зочин утсаар хүссэн, нийлүүлэгч холбогдохгүй' },
    });
    expect(cancelled.json()).toEqual({ state: 'CANCELLED', refund_mnt: 460_000, forfeit_mnt: 0 });

    const one = await app.inject({ method: 'GET', url: `/v1/ops/orders/${id}`, headers: desk() });
    expect(one.json().events.at(-2)).toMatchObject({ type: 'CANCELLED', actor: 'ops:Демо' });
    expect(one.json().settlements).toEqual([expect.objectContaining({ kind: 'refund', state: 'needs_account', amount_mnt: 460_000 })]);

    const audit = await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() });
    expect(audit.json().audit[0]).toMatchObject({ who: 'ops:Демо', action: 'order.cancel', target_id: id, note: 'зочин утсаар хүссэн, нийлүүлэгч холбогдохгүй' });
  });

  it('says a message again, and hands over on the supplier’s behalf', async () => {
    const { id } = await aPaidOrder();
    const again = await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/resend`, headers: desk(), payload: {} });
    expect(again.json()).toEqual({ state: 'PAID' });
    await startPreparing(ctx, id, 'supplier:d1');
    await markReady(ctx, id, 'supplier:d1');
    const handed = await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/hand`, headers: desk(), payload: { note: 'нийлүүлэгч утсаар хэлсэн' } });
    expect(handed.json()).toEqual({ state: 'HANDED' });
    const one = await app.inject({ method: 'GET', url: `/v1/ops/orders/${id}`, headers: desk() });
    expect(one.json().events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'PAID', 'RESENT', 'PREPARING', 'READY', 'HANDED']);
    expect(one.json().order).toMatchObject({ state: 'HANDED', payout_mnt: 450_800 });
  });

  it('reads the numbers: today, the week, the season, each supplier, each kind of meat', async () => {
    const { id, supplierId } = await aPaidOrder();
    await startPreparing(ctx, id, 'supplier:d1');
    clock.advanceMinutes(90);
    await markReady(ctx, id, 'supplier:d1');
    await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/hand`, headers: desk(), payload: {} });

    const stats = (await app.inject({ method: 'GET', url: '/v1/ops/stats', headers: desk() })).json();
    expect(stats.today).toMatchObject({ paid: 1, sales_mnt: 460_000, handed: 1, commission_mnt: 9_200, cancelled: 0 });
    expect(stats.season).toMatchObject({ paid: 1, handed: 1 });
    expect(stats.suppliers).toEqual([
      expect.objectContaining({ id: supplierId, paid: 1, handed: 1, cancelled: 0, no_shows: 0, sales_mnt: 460_000, commission_mnt: 9_200, ready_hours: 1.5 }),
    ]);
    expect(stats.by_kind).toEqual([{ kind: 'sheep', unit: 'whole', qty: 1, orders: 1, sales_mnt: 460_000 }]);
  });

  it('lays the whole house on one page, and says what needs somebody', async () => {
    const { id } = await aPaidOrder();
    const view = (await app.inject({ method: 'GET', url: '/v1/ops/overview', headers: desk() })).json();
    // Two phones verified: the supplier's owner and the guest.
    expect(view.guests).toMatchObject({ total: 2, closed: 0, joined: { season: 2 }, active: { season: 1 } });
    expect(view.wallet).toMatchObject({
      drift: 0,
      liability_mnt: 40_000,
      topups: { pending: 0, stuck: 0, settled: { season: 1 }, settled_mnt: { season: 500_000 } },
      purchases: { count: { season: 1 }, mnt: { season: 460_000 } },
      refunds: { count: { season: 0 } },
    });
    expect(view.idesh).toMatchObject({ live: 1, applied: 0, settlements: { due: 0, needs_account: 0 }, paid: { today: 1, week: 1, season: 1 }, sales_mnt: { today: 460_000 } });
    expect(view.dine).toMatchObject({ live: 0, held: 0, late: 0, restaurants: { active: 0, offline: 0 }, placed: { season: 0 } });
    expect(view.notify).toMatchObject({ stuck: 0 });
    expect(view.alerts).toEqual([]);

    // A cancellation puts a refund on the list, and the page says so.
    await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/cancel`, headers: desk(), payload: { reason: 'guest_asked', note: 'зочин хүссэн' } });
    const again = (await app.inject({ method: 'GET', url: '/v1/ops/overview', headers: desk() })).json();
    expect(again.idesh).toMatchObject({ live: 0, settlements: { needs_account: 1 }, cancelled: { today: 1 }, refund_mnt: { today: 460_000 } });
    expect(again.alerts).toEqual([{ level: 'info', text: '1 буцаалт зочны дансыг хүлээж байна.', tab: 'pay' }]);
  });

  it('finds a person by phone or name, and reads their whole file', async () => {
    const { id, code, guest } = await aPaidOrder();
    await app.inject({ method: 'PATCH', url: '/v1/me', headers: auth(guest), payload: { display_name: 'Сараа' } });

    const byPhone = (await app.inject({ method: 'GET', url: '/v1/ops/guests?q=9900 4009', headers: desk() })).json().guests;
    expect(byPhone).toEqual([expect.objectContaining({ phone: '+97699004009', name: 'Сараа', closed_at: null })]);
    const byName = (await app.inject({ method: 'GET', url: '/v1/ops/guests?q=сар', headers: desk() })).json().guests;
    expect(byName.map((g: { id: string }) => g.id)).toEqual([byPhone[0].id]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/guests?q=123', headers: desk() })).json().guests).toEqual([]);
    // No question: everybody, newest first.
    expect((await app.inject({ method: 'GET', url: '/v1/ops/guests', headers: desk() })).json().guests).toHaveLength(2);

    const file = (await app.inject({ method: 'GET', url: `/v1/ops/guests/${byPhone[0].id}`, headers: desk() })).json();
    expect(file.guest).toMatchObject({ phone: '+97699004009', name: 'Сараа' });
    expect(file.wallet.balance_mnt).toBe(40_000);
    expect(file.wallet.lines.map((l: { kind: string; amount_mnt: number }) => [l.kind, l.amount_mnt])).toEqual([['purchase', -460_000], ['topup', 500_000]]);
    expect(file.sessions).toHaveLength(1);
    expect(file.dine_orders).toEqual([]);
    expect(file.idesh_orders).toEqual([expect.objectContaining({ id, code, state: 'PAID' })]);
    expect(file.messages.length).toBeGreaterThan(0);

    const nobody = await app.inject({ method: 'GET', url: '/v1/ops/guests/00000000-0000-0000-0000-000000000000', headers: desk() });
    expect(nobody.statusCode).toBe(404);
  });

  it('signs a lost phone out, and closes an account with a reason — or refuses while money is held', async () => {
    const { guest } = await aPaidOrder();
    const [me] = (await app.inject({ method: 'GET', url: '/v1/ops/guests?q=99004009', headers: desk() })).json().guests;
    const file = (await app.inject({ method: 'GET', url: `/v1/ops/guests/${me.id}`, headers: desk() })).json();

    const out = await app.inject({ method: 'POST', url: `/v1/ops/guests/${me.id}/sessions/${file.sessions[0].id}/revoke`, headers: desk(), payload: { note: 'утсаа гээсэн гэж залгасан' } });
    expect(out.json()).toEqual({ revoked: true });
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(guest) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/guests/${me.id}/sessions/${file.sessions[0].id}/revoke`, headers: desk(), payload: {} })).statusCode).toBe(404);

    // Money in the wallet: the desk is refused the same way the app is.
    const held = await app.inject({ method: 'POST', url: `/v1/ops/guests/${me.id}/close`, headers: desk(), payload: { note: 'зочин хүссэн' } });
    expect(held.statusCode).toBe(409);
    const unsaid = await app.inject({ method: 'POST', url: `/v1/ops/guests/${me.id}/close`, headers: desk(), payload: {} });
    expect(unsaid.statusCode).toBe(400);

    // The supplier's owner holds nothing and has nothing running: closed, and gone from the directory by phone.
    const [owner] = (await app.inject({ method: 'GET', url: '/v1/ops/guests?q=88010001', headers: desk() })).json().guests;
    const closed = await app.inject({ method: 'POST', url: `/v1/ops/guests/${owner.id}/close`, headers: desk('Bayaraa'), payload: { note: 'бичгээр хүссэн' } });
    expect(closed.json()).toEqual({ closed: true });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/guests?q=88010001', headers: desk() })).json().guests).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/guests/${owner.id}`, headers: desk() })).json().guest).toMatchObject({ phone: null, name: null });
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['guest.close', 'guest.session_revoke']);
    expect(audit[0]).toMatchObject({ who: 'ops:Демо', target_kind: 'guest', target_id: owner.id, note: 'бичгээр хүссэн' });
  });

  it('takes a supplier off the market, and a listing out of sight, with the reason kept', async () => {
    const { supplierId, listingId } = await aPaidOrder();
    expect((await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings).toHaveLength(1);

    const hidden = await app.inject({ method: 'POST', url: `/v1/ops/listings/${listingId}/hide`, headers: desk(), payload: { note: 'зураг буруу' } });
    expect(hidden.json()).toEqual({ id: listingId, active: false });
    expect((await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings).toEqual([]);

    const off = await app.inject({ method: 'POST', url: `/v1/ops/suppliers/${supplierId}/active`, headers: desk('Bayaraa'), payload: { active: false, note: 'гэрээ зөрчсөн' } });
    expect(off.json()).toMatchObject({ id: supplierId, active: false });
    // Suspended, the owner's phone no longer opens the supplier's side.
    const owner = await signIn('+97688010001');
    expect((await app.inject({ method: 'GET', url: '/v1/supplier/me', headers: auth(owner) })).json()).toEqual({ supplier: null });
    const back = await app.inject({ method: 'POST', url: `/v1/ops/suppliers/${supplierId}/active`, headers: desk(), payload: { active: true } });
    expect(back.json()).toMatchObject({ active: true });

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['supplier.activate', 'supplier.suspend', 'listing.hide']);
    expect(audit[1]).toMatchObject({ who: 'ops:Демо', note: 'гэрээ зөрчсөн' });
  });
});

/* ── who sits at the desk ── */

describe('the desk’s members', () => {
  it('lets a member in by their own phone, and records them by name', async () => {
    await upsertMember({ phone: '+97688102856', name: 'Баярцогт', role: 'admin' });
    const token = await signIn('+97688102856');
    const me = await app.inject({ method: 'GET', url: '/v1/ops/me', headers: auth(token) });
    expect(me.json().member).toMatchObject({ name: 'Баярцогт', role: 'admin', phone: '+97688102856' });

    const made = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: auth(token),
      payload: { name: 'Хэрлэн', phone: '+97688010002', address: 'Эмээлт' },
    });
    expect(made.statusCode, made.body).toBe(201);
    // Nobody else gets in on a phone that is not on the list.
    const stranger = await signIn('+97699001234');
    expect((await app.inject({ method: 'GET', url: '/v1/ops/me', headers: auth(stranger) })).statusCode).toBe(401);
  });

  it('keeps each role to its own: a viewer looks, ops runs, finance pays, admin decides who', async () => {
    await upsertMember({ phone: '+97699000011', name: 'Харагч', role: 'viewer' });
    await upsertMember({ phone: '+97699000012', name: 'Ажилтан', role: 'ops' });
    await upsertMember({ phone: '+97699000013', name: 'Санхүү', role: 'finance' });
    const viewer = await signIn('+97699000011');
    const worker = await signIn('+97699000012');
    const finance = await signIn('+97699000013');
    const { id, supplierId } = await aPaidOrder();

    expect((await app.inject({ method: 'GET', url: '/v1/ops/orders', headers: auth(viewer) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/resend`, headers: auth(viewer), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/orders/${id}/resend`, headers: auth(worker), payload: {} })).statusCode).toBe(200);

    const nobodys = '00000000-0000-0000-0000-000000000000';
    expect((await app.inject({ method: 'POST', url: `/v1/ops/settlements/${nobodys}/paid`, headers: auth(worker), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/settlements/${nobodys}/paid`, headers: auth(finance), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/ops/suppliers/${supplierId}`, headers: auth(worker), payload: { commission_pct: 3 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/ops/suppliers/${supplierId}`, headers: auth(finance), payload: { commission_pct: 3 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/members', headers: auth(finance) })).statusCode).toBe(403);

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: auth(viewer) })).json().audit;
    expect(audit.map((a: { who: string }) => a.who)).toEqual(['ops:Санхүү', 'ops:Ажилтан']);
  });

  /** A handed-over order, a day later: the supplier's share is a line to pay. */
  async function aPayout(): Promise<{ id: string; supplierId: string }> {
    const { id, supplierId } = await aPaidOrder();
    await app.inject({
      method: 'PATCH',
      url: `/v1/ops/suppliers/${supplierId}`,
      headers: desk(),
      payload: { bank_name: 'Хаан банк', bank_account: '5012345678', bank_holder: 'Д. Дорж' },
    });
    await startPreparing(ctx, id, 'supplier:d1');
    await markReady(ctx, id, 'supplier:d1');
    await markHanded(ctx, id, 'supplier:d1');
    // A day after the handover the share is theirs and a line appears.
    clock.advanceMinutes(25 * 60);
    await housekeeping(ctx);
    return { id, supplierId };
  }

  it('needs two people to move money out, and says which did which half', async () => {
    await upsertMember({ phone: '+97699000014', name: 'Санхүү нэг', role: 'finance' });
    await upsertMember({ phone: '+97699000015', name: 'Санхүү хоёр', role: 'finance' });
    const one = await signIn('+97699000014');
    const two = await signIn('+97699000015');
    await aPayout();
    // From here the desk is production: two real members, and the rule holds.
    process.env['BASU_MODE'] = 'production';

    const [payout] = (await app.inject({ method: 'GET', url: '/v1/ops/settlements', headers: auth(one) })).json().settlements;
    expect(payout).toMatchObject({ kind: 'payout', state: 'due', approved_by: null, approved_at: null });

    // Nobody has released it yet.
    const early = await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/paid`, headers: auth(one), payload: { reference: 'KB-1' } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NOT_APPROVED');

    const released = await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/approve`, headers: auth(one), payload: {} });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json()).toMatchObject({ approved_by: 'ops:Санхүү нэг', state: 'due' });

    // The hand that released it is not the hand that sends it.
    const same = await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/paid`, headers: auth(one), payload: { reference: 'KB-1' } });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('SAME_PERSON');

    const paid = await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/paid`, headers: auth(two), payload: { reference: 'KB-1' } });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ state: 'paid', reference: 'KB-1', approved_by: 'ops:Санхүү нэг' });

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: auth(one) })).json().audit;
    expect(audit.slice(0, 2).map((a: { who: string; action: string }) => [a.who, a.action])).toEqual([
      ['ops:Санхүү хоёр', 'settlement.paid'],
      ['ops:Санхүү нэг', 'settlement.approve'],
    ]);
    expect(audit[0].note).toContain('баталсан ops:Санхүү нэг');
  });

  it('lets the demo desk, which is one shared identity, do both halves', async () => {
    await aPayout();
    const [payout] = (await app.inject({ method: 'GET', url: '/v1/ops/settlements', headers: desk() })).json().settlements;
    expect((await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/approve`, headers: desk(), payload: {} })).statusCode).toBe(200);
    const paid = await app.inject({ method: 'POST', url: `/v1/ops/settlements/${payout.id}/paid`, headers: desk(), payload: { reference: 'KB-2' } });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ state: 'paid', approved_by: 'ops:Демо' });
  });

  it('keeps a bank account out of the clear in the database, and still shows it at the desk', async () => {
    process.env['BANK_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const made = await app.inject({
      method: 'POST',
      url: '/v1/ops/suppliers',
      headers: desk(),
      payload: { name: 'Сэлэнгэ', phone: '+97688010007', address: 'Мандал', bank_name: 'Хаан банк', bank_account: '5012345678', bank_holder: 'Д. Болд' },
    });
    expect(made.statusCode, made.body).toBe(201);

    const stored = await storedBankOf(made.json().id);
    expect(stored.bankAccount).not.toContain('5012345678');
    expect(stored.bankAccount?.startsWith('v1:')).toBe(true);
    expect(stored.bankHolder).not.toContain('Болд');
    // The bank's own name is not a secret and the desk lists by it.
    expect(stored.bankName).toBe('Хаан банк');

    const row = (await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: desk() })).json().suppliers.find((x: { id: string }) => x.id === made.json().id);
    expect(row).toMatchObject({ bank_account: '5012345678', bank_holder: 'Д. Болд' });

    // Typing the same account again is not a change, so it does not un-verify the contract.
    const again = await app.inject({ method: 'PATCH', url: `/v1/ops/suppliers/${made.json().id}`, headers: desk(), payload: { bank_account: '5012345678', bank_holder: 'Д. Болд', bank_name: 'Хаан банк' } });
    expect(again.statusCode, again.body).toBe(200);
    delete process.env['BANK_KEY'];
  });

  it('is seeded from the environment, and an admin may add and close members', async () => {
    expect(await syncMembersFromEnv('+97699000021:Аа:admin, +97699000022:Бб:finance')).toBe(2);
    expect((await listMembers()).map((m) => [m.name, m.role])).toEqual([['Аа', 'admin'], ['Бб', 'finance']]);

    const admin = await signIn('+97699000021');
    const added = await app.inject({ method: 'POST', url: '/v1/ops/members', headers: auth(admin), payload: { phone: '+9769900 0023', name: 'Вв', role: 'viewer' } });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ phone: '+97699000023', role: 'viewer', active: true });
    const closed = await app.inject({ method: 'POST', url: `/v1/ops/members/${added.json().id}/active`, headers: auth(admin), payload: { active: false } });
    expect(closed.json()).toEqual({ id: added.json().id, active: false });
    const shut = await signIn('+97699000023');
    expect((await app.inject({ method: 'GET', url: '/v1/ops/me', headers: auth(shut) })).statusCode).toBe(401);
    // Not yourself: the desk must keep at least the person closing doors.
    const self = (await app.inject({ method: 'GET', url: '/v1/ops/me', headers: auth(admin) })).json().member.id;
    expect((await app.inject({ method: 'POST', url: `/v1/ops/members/${self}/active`, headers: auth(admin), payload: { active: false } })).statusCode).toBe(400);
  });

  it('opens to no shared secret in production', async () => {
    const before = process.env['BASU_MODE'];
    process.env['BASU_MODE'] = 'production';
    try {
      expect(opsToken()).toBeNull();
      const res = await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: auth('ops-secret-for-the-test') });
      expect(res.statusCode).toBe(401);
    } finally {
      if (before === undefined) delete process.env['BASU_MODE'];
      else process.env['BASU_MODE'] = before;
    }
  });
});

describe('an account nobody has checked', () => {
  it('is paid nothing until finance has held it up against the contract', async () => {
    const { supplierId } = await aPaidOrder();
    const before = (await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: desk() })).json().suppliers.find((s: { id: string }) => s.id === supplierId);
    expect(before.bank_verified).toBe(false);
    expect(before.bank_account).toBeNull();
    // Written in from the contract by the desk: trusted as it is written.
    const terms = await app.inject({ method: 'PATCH', url: `/v1/ops/suppliers/${supplierId}`, headers: desk(), payload: { bank_name: 'Голомт', bank_account: '1105012345', bank_holder: 'Дорж' } });
    expect(terms.json()).toMatchObject({ bank_account: '1105012345', bank_verified: true });
    // The verify button, and the record of who pressed it.
    const nothing = await app.inject({ method: 'POST', url: `/v1/ops/suppliers/${supplierId}/bank-verify`, headers: desk(), payload: {} });
    expect(nothing.statusCode).toBe(200);
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ action: 'supplier.bank_verify', target_id: supplierId });
  });
});
