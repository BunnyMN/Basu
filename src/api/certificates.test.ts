import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { createListing, registerSupplier, type Listing } from '../idesh/index.js';
import { inbox } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * The veterinary certificate the meat came with. What has to hold: the
 * supplier writes one in once and points meat at it; meat by the kilogram is
 * not listed without one; a whole animal gets its own at «Бэлэн»; a guest
 * reads which certificate, never its photograph; and one the desk finds
 * false takes its meat out of sight, tells the supplier, and is on record.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let ctx: Ctx;
let owner: { token: string; id: string };
let rival: { token: string; id: string };
let supplierId: string;
let sheep: Listing;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => ({ ...auth(opsToken()!), 'x-ops-name': 'Сараа' });
const PASSWORD = 'туршилтын нууц үг';

/** The smallest JPEG there is: enough to be one by its first bytes. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const photo = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

async function person(phone: string): Promise<{ token: string; id: string }> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  expect(made.statusCode, made.body).toBe(201);
  return { token: made.json().token as string, id: made.json().guest_id as string };
}

async function written(token: string, body: Record<string, unknown> = {}): Promise<{ id: string; number: string }> {
  const made = await app.inject({
    method: 'POST',
    url: '/v1/supplier/certificates',
    headers: auth(token),
    payload: { number: ' 6511 0421 ', issuer: 'Архангай, Их тамир сумын мал эмнэлэг', issued_on: '2026-09-01', photo, ...body },
  });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().certificate;
}

const beefByKg = (certificateId?: string) => ({
  kind: 'beef',
  unit: 'kg',
  title: 'Үхрийн мах, кг-аар',
  price_mnt: 13_500,
  min_qty: 20,
  quantity: 600,
  origin: 'Архангай, Их тамир',
  ready_from: '2026-09-05',
  ...(certificateId ? { certificate_id: certificateId } : {}),
});

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier() };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });

  owner = await person('+97688010001');
  rival = await person('+97688010002');
  supplierId = await registerSupplier({ ownerId: owner.id, name: 'Архангай · Дорж', phone: '+97688010001', pickupAddress: 'Нарантуул' });
  await registerSupplier({ ownerId: rival.id, name: 'Хэнтий · Болд', phone: '+97688010002', pickupAddress: 'Хүчит шонхор' });
  sheep = await createListing(
    supplierId,
    { kind: 'sheep', unit: 'whole', title: 'Хонь, залуу ирэг', priceMnt: 460_000, approxKg: 38, quantity: 5, origin: 'Архангай, Их тамир', readyFrom: '2026-09-10' },
    clock.now(),
  );
});

afterEach(async () => {
  await app?.close();
  delete process.env['OPS_TOKEN'];
});

afterAll(async () => {
  await closePool();
});

describe('a supplier’s certificates', () => {
  it('are written in once, tidied, listed, and photographed for their owner alone', async () => {
    const paper = await written(owner.token);
    expect(paper).toMatchObject({ number: '65110421', issued_on: '2026-09-01', has_photo: true, state: 'unchecked', listings: 0, orders: 0 });

    const mine = (await app.inject({ method: 'GET', url: '/v1/supplier/certificates', headers: auth(owner.token) })).json();
    expect(mine.may_add).toBe(true);
    expect(mine.certificates.map((c: { id: string }) => c.id)).toEqual([paper.id]);

    const seen = await app.inject({ method: 'GET', url: `/v1/supplier/certificates/${paper.id}/photo`, headers: auth(owner.token) });
    expect(seen.statusCode).toBe(200);
    expect(seen.headers['content-type']).toBe('image/jpeg');
    expect(seen.rawPayload.equals(JPEG)).toBe(true);

    // Another supplier's is not theirs to see, and nobody's without signing in.
    expect((await app.inject({ method: 'GET', url: `/v1/supplier/certificates/${paper.id}/photo`, headers: auth(rival.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/supplier/certificates/${paper.id}/photo` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/supplier/certificates', headers: auth(rival.token) })).json().certificates).toEqual([]);
  });

  it('refuse the same number twice, a day that has not come, and a file that is no photograph', async () => {
    await written(owner.token);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/supplier/certificates', headers: auth(owner.token), payload });
    const base = { number: '70010001', issuer: 'Төв, Баянчандмань сумын мал эмнэлэг', issued_on: '2026-09-01' };

    expect((await post({ ...base, number: '65110421' })).json().error.code).toBe('CERTIFICATE_EXISTS');
    expect((await post({ ...base, issued_on: '2026-12-01' })).json().error.code).toBe('BAD_CERTIFICATE');
    expect((await post({ ...base, number: '7' })).json().error.code).toBe('BAD_CERTIFICATE');
    expect((await post({ ...base, issuer: '' })).json().error.code).toBe('BAD_CERTIFICATE');
    expect((await post({ ...base, photo: `data:image/jpeg;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` })).statusCode).toBe(400);
    expect((await post({ ...base, photo: 'data:image/svg+xml;base64,AAAA' })).statusCode).toBe(400);
    // The same number at another supplier is another certificate.
    await written(rival.token);
  });

  it('are taken away while unused, and stay once meat was listed under them', async () => {
    const spare = await written(owner.token, { number: '70010001' });
    const gone = await app.inject({ method: 'DELETE', url: `/v1/supplier/certificates/${spare.id}`, headers: auth(owner.token) });
    expect(gone.statusCode, gone.body).toBe(204);

    const paper = await written(owner.token);
    const listed = await app.inject({ method: 'POST', url: '/v1/supplier/listings', headers: auth(owner.token), payload: beefByKg(paper.id) });
    expect(listed.statusCode, listed.body).toBe(201);
    const kept = await app.inject({ method: 'DELETE', url: `/v1/supplier/certificates/${paper.id}`, headers: auth(owner.token) });
    expect(kept.json().error.code).toBe('CERTIFICATE_IN_USE');
    // And never somebody else's.
    expect((await app.inject({ method: 'DELETE', url: `/v1/supplier/certificates/${paper.id}`, headers: auth(rival.token) })).json().error.code).toBe('NO_CERTIFICATE');
  });
});

describe('meat and its certificate', () => {
  it('by the kilogram is not listed without one, nor under another supplier’s', async () => {
    const post = (token: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/supplier/listings', headers: auth(token), payload });
    expect((await post(owner.token, beefByKg())).json().error.code).toBe('NEEDS_CERTIFICATE');

    const theirs = await written(rival.token);
    expect((await post(owner.token, beefByKg(theirs.id))).json().error.code).toBe('NO_CERTIFICATE');

    const paper = await written(owner.token);
    const listed = await post(owner.token, beefByKg(paper.id));
    expect(listed.statusCode, listed.body).toBe(201);

    // A guest reads which certificate — and nothing that opens its photograph.
    const stall = (await app.inject({ method: 'GET', url: `/v1/idesh/listings/${listed.json().listing.id}` })).json().listing;
    expect(stall.certificate).toEqual({ number: '65110421', issuer: 'Архангай, Их тамир сумын мал эмнэлэг', issued_on: '2026-09-01', checked: false });
    expect(JSON.stringify(stall)).not.toContain(paper.id);
    // A whole animal is listed before it has one.
    expect((await app.inject({ method: 'GET', url: `/v1/idesh/listings/${sheep.id}` })).json().listing.certificate).toBeNull();
  });

  it('the next shipment’s certificate replaces the last on a listing', async () => {
    const first = await written(owner.token);
    const listed = (await app.inject({ method: 'POST', url: '/v1/supplier/listings', headers: auth(owner.token), payload: beefByKg(first.id) })).json().listing;
    const next = await written(owner.token, { number: '65110999', issued_on: '2026-09-02' });
    const changed = await app.inject({ method: 'PATCH', url: `/v1/supplier/listings/${listed.id}`, headers: auth(owner.token), payload: { certificate_id: next.id } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().listing.certificate.number).toBe('65110999');
  });

  it('a whole animal gets its certificate at «Бэлэн», and the guest reads it on the order', async () => {
    const guest = await person('+97699001122');
    const topup = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(guest.token), payload: { amount_mnt: 500_000 } });
    await app.inject({ method: 'POST', url: `/v1/wallet/topup/${topup.json().topup_id}/settle`, headers: auth(guest.token) });
    const made = await app.inject({ method: 'POST', url: '/v1/idesh', headers: auth(guest.token), payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' } });
    expect(made.statusCode, made.body).toBe(201);
    const orderId = made.json().id as string;
    expect((await app.inject({ method: 'POST', url: `/v1/idesh/${orderId}/pay`, headers: auth(guest.token) })).statusCode).toBe(200);

    const act = (action: string, payload: Record<string, unknown> = {}, token = owner.token) =>
      app.inject({ method: 'POST', url: `/v1/supplier/orders/${orderId}/${action}`, headers: auth(token), payload });
    expect((await act('prepare')).statusCode).toBe(200);

    const theirs = await written(rival.token);
    expect((await act('ready', { certificate_id: theirs.id })).json().error.code).toBe('NO_CERTIFICATE');
    const paper = await written(owner.token);
    const ready = await act('ready', { certificate_id: paper.id });
    expect(ready.statusCode, ready.body).toBe(200);

    const order = (await app.inject({ method: 'GET', url: `/v1/idesh/${orderId}`, headers: auth(guest.token) })).json();
    expect(order.certificate).toEqual({ number: '65110421', issuer: 'Архангай, Их тамир сумын мал эмнэлэг', issued_on: '2026-09-01', checked: false });

    // The wrong one was chosen: the right one is put on while the order is still being worked on.
    const right = await written(owner.token, { number: '65110999' });
    expect((await act('certify', { certificate_id: right.id })).statusCode).toBe(200);
    expect((await act('certify', {})).json().error.code).toBe('NO_CERTIFICATE');
    const again = (await app.inject({ method: 'GET', url: `/v1/idesh/${orderId}`, headers: auth(guest.token) })).json();
    expect(again.certificate.number).toBe('65110999');
    const story = (await app.inject({ method: 'GET', url: `/v1/supplier/orders/${orderId}`, headers: auth(owner.token) })).json();
    expect(story.events.map((e: { type: string }) => e.type)).toContain('CERTIFIED');
  });
});

describe('the desk’s certificates', () => {
  it('lists them unchecked first, shows the photograph, and is not a guest’s to read', async () => {
    const paper = await written(owner.token);
    const page = (await app.inject({ method: 'GET', url: '/v1/ops/certificates', headers: desk() })).json();
    expect(page.summary).toEqual({ unchecked: 1, genuine: 0, false: 0 });
    expect(page.certificates[0]).toMatchObject({ id: paper.id, number: '65110421', supplier_name: 'Архангай · Дорж', state: 'unchecked', has_photo: true });

    const seen = await app.inject({ method: 'GET', url: `/v1/ops/certificates/${paper.id}/photo`, headers: desk() });
    expect(seen.statusCode).toBe(200);
    expect(seen.rawPayload.equals(JPEG)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/certificates/not-an-id/photo', headers: desk() })).statusCode).toBe(404);

    expect((await app.inject({ method: 'GET', url: '/v1/ops/certificates', headers: auth(owner.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/ops/certificates/${paper.id}/photo`, headers: auth(owner.token) })).statusCode).toBe(401);
  });

  it('says a certificate is genuine, and the guest is told Basu looked it up', async () => {
    const paper = await written(owner.token);
    const listed = (await app.inject({ method: 'POST', url: '/v1/supplier/listings', headers: auth(owner.token), payload: beefByKg(paper.id) })).json().listing;
    const checked = await app.inject({ method: 'POST', url: `/v1/ops/certificates/${paper.id}/check`, headers: desk(), payload: { genuine: true } });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().certificate).toMatchObject({ state: 'genuine', checked_by: expect.stringContaining('ops') });

    const stall = (await app.inject({ method: 'GET', url: `/v1/idesh/listings/${listed.id}` })).json().listing;
    expect(stall.certificate.checked).toBe(true);
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ action: 'certificate.genuine', target_kind: 'certificate', target_id: paper.id });
    // Checked, it is the record: its supplier no longer takes it away.
    expect((await app.inject({ method: 'DELETE', url: `/v1/supplier/certificates/${paper.id}`, headers: auth(owner.token) })).json().error.code).toBe('CERTIFICATE_IN_USE');
  });

  it('finds one false with a reason: its meat leaves the stalls, is not sold, and its supplier is told', async () => {
    const paper = await written(owner.token);
    const listed = (await app.inject({ method: 'POST', url: '/v1/supplier/listings', headers: auth(owner.token), payload: beefByKg(paper.id) })).json().listing;
    const stalls = async () => ((await app.inject({ method: 'GET', url: '/v1/idesh/listings' })).json().listings as Array<{ id: string }>).map((l) => l.id);
    expect(await stalls()).toContain(listed.id);

    const check = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/v1/ops/certificates/${paper.id}/check`, headers: desk(), payload });
    expect((await check({})).statusCode).toBe(400);
    expect((await check({ genuine: false })).statusCode).toBe(400);
    const found = await check({ genuine: false, note: 'МЭНС-д ийм дугаар алга' });
    expect(found.statusCode, found.body).toBe(200);

    expect(await stalls()).toEqual([sheep.id]);
    const guest = await person('+97699001122');
    const tried = await app.inject({ method: 'POST', url: '/v1/idesh', headers: auth(guest.token), payload: { listing_id: listed.id, qty: 20, receive: 'pickup', receive_on: '2026-09-12' } });
    expect(tried.json().error.code).toBe('NOT_FOUND');

    // The supplier reads why on their own list, is told once, and cannot put it on other meat.
    const mine = (await app.inject({ method: 'GET', url: '/v1/supplier/certificates', headers: auth(owner.token) })).json().certificates[0];
    expect(mine).toMatchObject({ state: 'false', check_note: 'МЭНС-д ийм дугаар алга' });
    await check({ genuine: false, note: 'дахин' });
    const told = (await inbox(owner.id)).filter((m) => m.template === 'supplier.certificate');
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('65110421');
    const reused = await app.inject({ method: 'PATCH', url: `/v1/supplier/listings/${sheep.id}`, headers: auth(owner.token), payload: { certificate_id: paper.id } });
    expect(reused.json().error.code).toBe('CERTIFICATE_FALSE');

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit.some((a: { action: string; note: string }) => a.action === 'certificate.false' && a.note.includes('МЭНС-д ийм дугаар алга'))).toBe(true);
    // An id that is not one is no certificate.
    expect((await app.inject({ method: 'POST', url: '/v1/ops/certificates/nope/check', headers: desk(), payload: { genuine: true } })).statusCode).toBe(404);
  });
});
