import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { createListing, registerSupplier, type Listing } from '../idesh/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * The desk's page of listings put first. What has to hold: the desk sees
 * every purchase with what it cost and who paid; taking one off needs a
 * reason, stops it at once, and goes into the record; and a purchase that
 * has already run out is not taken off twice.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let ctx: Ctx;
let sheep: Listing;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => ({ ...auth(opsToken()!), 'x-ops-name': 'Сараа' });
const PASSWORD = 'туршилтын нууц үг';

async function person(phone: string): Promise<{ token: string; id: string }> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  expect(made.statusCode, made.body).toBe(201);
  return { token: made.json().token as string, id: made.json().guest_id as string };
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier() };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });
});

afterEach(async () => {
  await app?.close();
  delete process.env['OPS_TOKEN'];
});

afterAll(async () => {
  await closePool();
});

async function aVipBought(): Promise<{ owner: string; promotionId: string }> {
  const owner = await person('+97688010001');
  const supplierId = await registerSupplier({ ownerId: owner.id, name: 'Архангай · Дорж', phone: '+97688010001', pickupAddress: 'Нарантуул' });
  sheep = await createListing(
    supplierId,
    { kind: 'sheep', unit: 'whole', title: 'Хонь, залуу ирэг', priceMnt: 460_000, approxKg: 38, quantity: 5, origin: 'Архангай', readyFrom: '2026-09-10' },
    clock.now(),
  );
  const asked = await app.inject({ method: 'POST', url: `/v1/supplier/listings/${sheep.id}/promote`, headers: auth(owner.token), payload: { tier: 'vip' } });
  expect(asked.statusCode, asked.body).toBe(201);
  const id = asked.json().promotion.id as string;
  expect((await app.inject({ method: 'POST', url: `/v1/supplier/promotions/${id}/settle`, headers: auth(owner.token) })).statusCode).toBe(200);
  return { owner: owner.token, promotionId: id };
}

describe('the desk’s promotions', () => {
  it('lists every purchase with its price, its buyer and whether it holds', async () => {
    const { promotionId } = await aVipBought();
    const page = (await app.inject({ method: 'GET', url: '/v1/ops/promotions', headers: desk() })).json();
    expect(page.summary).toEqual({ live: 1, live_vip: 1, revenue_30d_mnt: 50_000, pending: 0 });
    expect(page.promotions[0]).toMatchObject({
      id: promotionId,
      listing_title: 'Хонь, залуу ирэг',
      supplier_name: 'Архангай · Дорж',
      tier: 'vip',
      price_mnt: 50_000,
      standing: 'live',
      buyer_contact: '+97688010001',
    });
    // A guest is not the desk.
    const stranger = await person('+97699001100');
    expect((await app.inject({ method: 'GET', url: '/v1/ops/promotions', headers: auth(stranger.token) })).statusCode).toBe(401);
  });

  it('takes one off with a reason, at once, into the record', async () => {
    const { promotionId } = await aVipBought();
    const bare = await app.inject({ method: 'POST', url: `/v1/ops/promotions/${promotionId}/end`, headers: desk(), payload: {} });
    expect(bare.statusCode).toBe(400);

    const ended = await app.inject({ method: 'POST', url: `/v1/ops/promotions/${promotionId}/end`, headers: desk(), payload: { note: 'зар дүрэм зөрчсөн' } });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().state).toBe('cancelled');

    const stall = (await app.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` })).json().listing;
    expect(stall.tier).toBeNull();
    const row = (await app.inject({ method: 'GET', url: '/v1/ops/promotions', headers: desk() })).json().promotions[0];
    expect(row).toMatchObject({ standing: 'ended', ended_note: 'зар дүрэм зөрчсөн' });
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ action: 'promotion.end', target_kind: 'promotion', target_id: promotionId });
    expect(audit[0].note).toContain('зар дүрэм зөрчсөн');

    // Once over, it is not taken off twice.
    const again = await app.inject({ method: 'POST', url: `/v1/ops/promotions/${promotionId}/end`, headers: desk(), payload: { note: 'дахин' } });
    expect(again.json().error.code).toBe('WRONG_STATE');
  });
});
