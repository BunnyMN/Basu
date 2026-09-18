import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { opsToken } from './ops.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { failReceipt, truncateAll } from '../test/seed.js';
import { createListing, registerSupplier } from '../idesh/index.js';

/** The books over HTTP: the checks, the accounts, every movement, and the two exports. */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => auth(opsToken()!);

async function signIn(phone: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function topUp(token: string, amountMnt: number): Promise<string> {
  const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: amountMnt } });
  expect(started.statusCode, started.body).toBe(200);
  const settled = await app.inject({ method: 'POST', url: `/v1/wallet/topup/${started.json().topup_id}/settle`, headers: auth(token) });
  expect(settled.statusCode, settled.body).toBe(200);
  return started.json().topup_id as string;
}

/** A guest with 500 000₮ who bought a 460 000₮ sheep. */
async function aSale(): Promise<{ guest: string; orderId: string }> {
  const supplierId = await registerSupplier({ name: 'Архангай · Дорж', phone: '+97688010001', merchantTin: '6501234567', pickupAddress: 'Нарантуул' });
  const sheep = await createListing(
    supplierId,
    { kind: 'sheep', unit: 'whole', title: 'Хонь', priceMnt: 460_000, approxKg: 38, quantity: 3, origin: 'Архангай', readyFrom: '2026-09-10' },
    clock.now(),
  );
  const guest = await signIn('+97699004009');
  await topUp(guest, 500_000);
  const created = await app.inject({ method: 'POST', url: '/v1/idesh', headers: auth(guest), payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' } });
  expect(created.statusCode, created.body).toBe(201);
  const paid = await app.inject({ method: 'POST', url: `/v1/idesh/${created.json().id}/pay`, headers: auth(guest) });
  expect(paid.statusCode, paid.body).toBe(200);
  return { guest, orderId: created.json().id };
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
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('the books at the desk', () => {
  it('reads the checks and the accounts, with every label in plain words', async () => {
    await aSale();
    const money = (await app.inject({ method: 'GET', url: '/v1/ops/money', headers: desk() })).json();
    expect(money.checks).toMatchObject({
      drift: 0,
      qpay: { settled_mnt: 500_000, clearing_mnt: -500_000, gap_mnt: 0, pending: 0, stuck: 0 },
      wallets: { liability_mnt: 40_000, payable_mnt: 0 },
      bank: { out_mnt: 0 },
    });
    expect(money.wallets).toEqual({ count: 1, holding: 1, balance_mnt: 40_000 });
    const byLabel = Object.fromEntries(money.accounts.map((a: { label: string }) => [a.label, a]));
    expect(byLabel['house:revenue']).toMatchObject({ name: 'Basu · орлого', balance_mnt: 460_000, entries: 1 });
    expect(byLabel['qpay:clearing']).toMatchObject({ name: 'QPay · клиринг', balance_mnt: -500_000 });
    expect(byLabel['bank:out']).toMatchObject({ name: 'Банк · гадагш', balance_mnt: 0, entries: 0 });
  });

  it('lists movements and top-ups by kind, window and person, and exports both as CSV', async () => {
    const { guest } = await aSale();
    const all = (await app.inject({ method: 'GET', url: '/v1/ops/money/transfers', headers: desk() })).json().transfers;
    expect(all.map((t: { kind: string; amount_mnt: number }) => [t.kind, t.amount_mnt])).toEqual([['purchase', 460_000], ['topup', 500_000]]);
    expect(all[1]).toMatchObject({ from: { label: 'qpay:clearing', name: 'QPay · клиринг' }, to: { name: expect.stringContaining('+97699004009') } });
    expect(all[0]).toMatchObject({ from: { name: expect.stringContaining('+97699004009') }, to: { name: 'Basu · орлого' }, subject: 'idesh' });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money/transfers?kind=topup', headers: desk() })).json().transfers).toHaveLength(1);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(guest) })).json();
    expect((await app.inject({ method: 'GET', url: `/v1/ops/money/transfers?guest=${me.id}`, headers: desk() })).json().transfers).toHaveLength(2);
    // Real time is what the rows carry; a window that ends before it holds nothing.
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money/transfers?to=2020-01-01', headers: desk() })).json().transfers).toEqual([]);

    const csv = await app.inject({ method: 'GET', url: '/v1/ops/money/transfers.csv', headers: desk() });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('basu-transfers-all-all.csv');
    const lines = csv.body.replace(/^﻿/, '').trim().split('\n');
    expect(lines[0]).toBe('at,kind,amount_mnt,from,to,subject,subject_id,memo,transfer_id');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('purchase,460000');

    const topups = (await app.inject({ method: 'GET', url: '/v1/ops/money/topups', headers: desk() })).json().topups;
    expect(topups).toEqual([expect.objectContaining({ amount_mnt: 500_000, provider: 'qpay', state: 'settled', guest_phone: '+97699004009' })]);
    expect(topups[0].settled_at).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money/topups?state=pending', headers: desk() })).json().topups).toEqual([]);
    const topupCsv = await app.inject({ method: 'GET', url: '/v1/ops/money/topups.csv?state=settled', headers: desk() });
    expect(topupCsv.body.replace(/^﻿/, '').trim().split('\n')).toHaveLength(2);

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['ledger.export', 'ledger.export']);
    expect(audit[1]).toMatchObject({ target_kind: 'ledger', note: 'transfers .. (2)' });

    // Nobody without a seat reads the books, let alone carries them out.
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money/transfers.csv' })).statusCode).toBe(401);
  });

  it('shows the receipt queue, pushes it on request, and puts a failed one back', async () => {
    await aSale();
    const queued = (await app.inject({ method: 'GET', url: '/v1/ops/money/receipts?state=queued', headers: desk() })).json().receipts;
    expect(queued).toEqual([expect.objectContaining({ kind: 'SALE', amount_mnt: 460_000, attempts: 0, merchant_tin: '6501234567' })]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money', headers: desk() })).json().checks.receipts).toMatchObject({ queued: 1, issued: 0, failed: 0, purchases: 1, gap: 1 });

    const ran = await app.inject({ method: 'POST', url: '/v1/ops/money/checks', headers: desk(), payload: {} });
    expect(ran.json()).toMatchObject({ ledger: { drift: 0 }, pushed: { issued: 1, failed: 0 } });
    const issued = (await app.inject({ method: 'GET', url: '/v1/ops/money/receipts', headers: desk() })).json().receipts;
    expect(issued[0]).toMatchObject({ state: 'issued' });
    expect(issued[0].lottery).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money', headers: desk() })).json().checks.receipts).toMatchObject({ issued: 1, gap: 0 });

    // Only a failed receipt goes back in the queue.
    expect((await app.inject({ method: 'POST', url: `/v1/ops/money/receipts/${issued[0].id}/retry`, headers: desk(), payload: {} })).statusCode).toBe(404);
    await failReceipt(issued[0].id);
    const back = await app.inject({ method: 'POST', url: `/v1/ops/money/receipts/${issued[0].id}/retry`, headers: desk(), payload: {} });
    expect(back.json()).toEqual({ id: issued[0].id, state: 'queued' });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/money/receipts?state=queued', headers: desk() })).json().receipts[0]).toMatchObject({ attempts: 0, last_error: null });

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['receipt.retry', 'ledger.checks']);
    expect(audit[1].note).toContain('issued 1');
  });
});
