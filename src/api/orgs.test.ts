import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * A business and the people who run it.
 *
 * What has to hold: whoever registers a business owns it and it waits for
 * the desk; the owner brings in a manager, the manager brings in staff and
 * an accountant — never another manager; and at the supplier each role does
 * its own work and no more.
 */

let app: FastifyInstance;
let ctx: Ctx;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => bearer(opsToken()!);

beforeEach(async () => {
  await truncateAll();
  ctx = { clock: new VirtualClock(at('11:40')), payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier() };
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

/** Somebody who has signed in to Basu once, with a name. */
async function person(phone: string, name: string): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: 'нууц үг 1234', name } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().token as string;
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(token), ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

/** A supplier business, registered by `owner` and approved by the desk. */
async function aButcher(owner: string): Promise<string> {
  const made = await call('POST', '/v1/orgs', owner, {
    name: 'Хэрлэн мах',
    supplier: true,
    phone: '8811 0001',
    address: 'Нарантуул, 3-р хаалга',
    tin: '6501234',
  });
  expect(made.statusCode, made.body).toBe(201);
  const yes = await app.inject({ method: 'POST', url: `/v1/ops/orgs/${made.json().id}/approve`, headers: desk() });
  expect(yes.statusCode, yes.body).toBe(200);
  return made.json().id as string;
}

async function bringIn(orgId: string, by: string, phone: string, role: string) {
  const found = await call('GET', `/v1/orgs/${orgId}/lookup?contact=${encodeURIComponent(phone)}`, by);
  expect(found.statusCode, found.body).toBe(200);
  return call('POST', `/v1/orgs/${orgId}/members`, by, { guest_id: found.json().guest_id, role });
}

describe('registering a business', () => {
  it('makes its registrant the owner, and waits for the desk', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const made = await call('POST', '/v1/orgs', owner, { name: 'Хэрлэн мах', supplier: true, phone: '88110001', address: 'Нарантуул' });
    expect(made.json()).toMatchObject({ state: 'applied', role: 'owner', supplier: true, restaurant: false });

    const mine = (await call('GET', '/v1/orgs/mine', owner)).json().orgs;
    expect(mine).toEqual([expect.objectContaining({ name: 'Хэрлэн мах', state: 'applied', role: 'owner' })]);
    // Not active yet: it opens nothing at the supplier's side.
    expect((await call('GET', '/v1/supplier/me', owner)).json().supplier).toBeNull();

    const listed = (await app.inject({ method: 'GET', url: '/v1/ops/orgs', headers: desk() })).json().orgs;
    expect(listed[0]).toMatchObject({ name: 'Хэрлэн мах', state: 'applied', applicant: '+97699110001', members: 1 });
    // Somebody else's business is not theirs to read.
    const stranger = await person('+97699110009', 'Танихгүй');
    expect((await call('GET', `/v1/orgs/${made.json().id}`, stranger)).statusCode).toBe(404);
  });

  it('needs a kind, a phone and an address', async () => {
    const owner = await person('+97699110001', 'Дорж');
    expect((await call('POST', '/v1/orgs', owner, { name: 'Хоосон', phone: '88110001', address: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/orgs', owner, { name: 'Утасгүй', supplier: true, address: 'x' })).statusCode).toBe(400);
  });

  it('once approved, is a contracted supplier its owner can run', async () => {
    const owner = await person('+97699110001', 'Дорж');
    await aButcher(owner);
    expect((await call('GET', '/v1/supplier/me', owner)).json().supplier).toMatchObject({ name: 'Хэрлэн мах', state: 'contracted' });
    expect((await call('GET', '/v1/supplier/board', owner)).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/money', owner)).statusCode).toBe(200);
  });

  it('takes over the application its owner also sent from the supplier screen, rather than failing on a second', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const made = await call('POST', '/v1/orgs', owner, { name: 'Хэрлэн мах', supplier: true, phone: '88110001', address: 'Нарантуул, 3-р хаалга' });
    expect(made.statusCode, made.body).toBe(201);
    // The same person, on /supplier, does not see the business waiting and asks again there.
    const asked = await call('POST', '/v1/supplier/apply', owner, { name: 'Дорж мах', tin: '6505678901', address: 'Хархорин зах', about: 'хонь' });
    expect(asked.statusCode, asked.body).toBe(201);

    const yes = await app.inject({ method: 'POST', url: `/v1/ops/orgs/${made.json().id}/approve`, headers: desk() });
    expect(yes.statusCode, yes.body).toBe(200);
    expect((await call('GET', '/v1/supplier/me', owner)).json().supplier).toMatchObject({ name: 'Хэрлэн мах', state: 'contracted' });
    expect((await call('GET', '/v1/supplier/board', owner)).statusCode).toBe(200);
    // One supplier, the business's — not an application left waiting beside an active business with none.
    const suppliers = (await app.inject({ method: 'GET', url: '/v1/ops/suppliers', headers: desk() })).json().suppliers as { name: string; state: string }[];
    expect(suppliers.map((x) => [x.name, x.state])).toEqual([['Хэрлэн мах', 'contracted']]);
  });

  it('is refused before anything is approved when its owner already runs a supplier', async () => {
    const owner = await person('+97699110001', 'Дорж');
    await aButcher(owner);
    const second = await call('POST', '/v1/orgs', owner, { name: 'Хоёр дахь мах', supplier: true, phone: '88110002', address: 'Бөмбөгөр' });
    expect(second.statusCode, second.body).toBe(201);
    const no = await app.inject({ method: 'POST', url: `/v1/ops/orgs/${second.json().id}/approve`, headers: desk() });
    expect(no.statusCode, no.body).toBe(409);
    expect(no.json().error.code).toBe('ALREADY_SUPPLIER');
    // Still waiting, for the desk to decline — nothing made active with no supplier behind it.
    const mine = (await call('GET', '/v1/orgs/mine', owner)).json().orgs as { name: string; state: string }[];
    expect(mine.find((o) => o.name === 'Хоёр дахь мах')).toMatchObject({ state: 'applied' });
    expect((await app.inject({ method: 'POST', url: `/v1/ops/orgs/${second.json().id}/decline`, headers: desk(), payload: { reason: 'Давхар' } })).statusCode).toBe(200);
  });

  it('can be declined with a reason, which the registrant sees', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const made = (await call('POST', '/v1/orgs', owner, { name: 'Хэрлэн мах', supplier: true, phone: '88110001', address: 'x' })).json();
    const no = await app.inject({ method: 'POST', url: `/v1/ops/orgs/${made.id}/decline`, headers: desk(), payload: { reason: 'Гэрээ дутуу' } });
    expect(no.statusCode, no.body).toBe(200);
    expect((await call('GET', '/v1/orgs/mine', owner)).json().orgs[0]).toMatchObject({ state: 'declined', decline_reason: 'Гэрээ дутуу' });
    expect((await app.inject({ method: 'POST', url: `/v1/ops/orgs/${made.id}/approve`, headers: desk() })).statusCode).toBe(409);
  });
});

describe('the people who work there', () => {
  it('are brought in by the owner and a manager, each only as far as their role reaches', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const manager = await person('+97699110002', 'Сараа');
    const staff = await person('+97699110003', 'Бат');
    const accountant = await person('+97699110004', 'Туяа');
    const orgId = await aButcher(owner);

    // The owner appoints a manager; the manager brings in the rest.
    expect((await bringIn(orgId, owner, '9911 0002', 'manager')).statusCode).toBe(201);
    expect((await bringIn(orgId, manager, '+97699110003', 'staff')).statusCode).toBe(201);
    expect((await bringIn(orgId, manager, '99110004', 'accountant')).statusCode).toBe(201);
    // A manager cannot make another manager, or an owner.
    const fifth = await person('+97699110005', 'Оюун');
    void fifth;
    expect((await bringIn(orgId, manager, '99110005', 'manager')).statusCode).toBe(403);
    // Staff bring in nobody, and cannot even look people up.
    expect((await call('GET', `/v1/orgs/${orgId}/lookup?contact=99110005`, staff)).statusCode).toBe(403);
    // Twice is refused.
    expect((await bringIn(orgId, owner, '99110003', 'staff')).statusCode).toBe(409);

    const page = (await call('GET', `/v1/orgs/${orgId}`, staff)).json();
    expect(page.role).toBe('staff');
    expect(page.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual([
      'Дорж:owner',
      'Сараа:manager',
      'Туяа:accountant',
      'Бат:staff',
    ]);
    // Staff see who their colleagues are, not their numbers.
    expect(page.members.find((m: { name: string }) => m.name === 'Дорж').contact).toBe('···0001');
  });

  it('do their own work at the supplier and nothing more', async () => {
    const owner = await person('+97699110001', 'Дорж');
    await person('+97699110003', 'Бат');
    await person('+97699110004', 'Туяа');
    const staff = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+97699110003', password: 'нууц үг 1234' } })).json().token;
    const accountant = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+97699110004', password: 'нууц үг 1234' } })).json().token;
    const orgId = await aButcher(owner);
    await bringIn(orgId, owner, '99110003', 'staff');
    await bringIn(orgId, owner, '99110004', 'accountant');

    const listing = {
      kind: 'sheep',
      unit: 'whole',
      title: 'Хонь, бүтэн',
      price_mnt: 400_000,
      approx_kg: 35,
      quantity: 5,
      origin: 'Архангай',
      ready_from: '2026-10-01',
    };
    // Staff: the board, and the listings.
    expect((await call('GET', '/v1/supplier/board', staff)).statusCode).toBe(200);
    const made = await call('POST', '/v1/supplier/listings', staff, listing);
    expect(made.statusCode).toBe(201);
    // …but paying Basu to put one first is the owner's or a manager's to do.
    expect((await call('POST', `/v1/supplier/listings/${made.json().listing.id}/promote`, staff, { tier: 'vip' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/supplier/listings/${made.json().listing.id}/promote`, accountant, { tier: 'vip' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/supplier/listings/${made.json().listing.id}/promote`, owner, { tier: 'vip' })).statusCode).toBe(201);
    // …not the money, not the details.
    expect((await call('GET', '/v1/supplier/money', staff)).statusCode).toBe(403);
    expect((await call('PATCH', '/v1/supplier/profile', staff, { about: 'шинэ' })).statusCode).toBe(403);
    // The accountant: the money, and no listings.
    expect((await call('GET', '/v1/supplier/money', accountant)).statusCode).toBe(200);
    expect((await call('POST', '/v1/supplier/listings', accountant, listing)).statusCode).toBe(403);
  });

  it('keeps an owner, lets people leave, and lets the owner take people out', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const staff = await person('+97699110003', 'Бат');
    const orgId = await aButcher(owner);
    await bringIn(orgId, owner, '99110003', 'staff');
    const ownerId = (await call('GET', `/v1/orgs/${orgId}`, owner)).json().members.find((m: { you: boolean }) => m.you).guest_id;
    const staffId = (await call('GET', `/v1/orgs/${orgId}`, staff)).json().members.find((m: { you: boolean }) => m.you).guest_id;

    // The only owner cannot leave, or be made less.
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${ownerId}`, owner)).json().error.code).toBe('LAST_OWNER');
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${ownerId}`, owner, { role: 'manager' })).json().error.code).toBe('LAST_OWNER');
    // Staff cannot take anybody out but themselves.
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${ownerId}`, staff)).statusCode).toBe(403);
    // The owner promotes, then takes out.
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${staffId}`, owner, { role: 'accountant' })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${staffId}`, owner)).statusCode).toBe(204);
    expect((await call('GET', '/v1/supplier/me', staff)).json().supplier).toBeNull();
  });

  it('names a person found by a number by the address they proved, and says whether a code ever reached the number', async () => {
    // A password sign-up types any number it likes — a cook's, before the
    // cook ever comes — and whoever is brought in reads the guests' names,
    // phones and addresses. So the manager sees what the account proved.
    const owner = await person('+97699110001', 'Дорж');
    const orgId = await aButcher(owner);
    const typed = await person('+97699110005', 'Бат');
    const mailer = new FakeMailer();
    ctx.mailer = mailer;
    expect((await call('POST', '/v1/me/email/code', typed, { email: 'bat@example.mn', password: 'нууц үг 1234' })).statusCode).toBe(202);
    expect((await call('POST', '/v1/me/email', typed, { email: 'bat@example.mn', code: mailer.codeFor('bat@example.mn') })).statusCode).toBe(200);
    // Another number, proved by the code it received.
    await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone: '+97699110006' } });
    const code = /(\d{6})/.exec((ctx.notifier as FakeNotifier).of('auth.otp').at(-1)?.body ?? '')?.[1];
    expect((await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '+97699110006', code } })).statusCode).toBe(200);

    const lookup = async (contact: string) => (await call('GET', `/v1/orgs/${orgId}/lookup?contact=${encodeURIComponent(contact)}`, owner)).json();
    expect(await lookup('9911 0005')).toMatchObject({ name: 'Бат', email: 'bat@example.mn', phone: '+97699110005', phone_verified: false });
    expect(await lookup('99110006')).toMatchObject({ phone: '+97699110006', phone_verified: true });
    // Found by the address: no number comes back — the manager had none to type.
    expect(await lookup('bat@example.mn')).toMatchObject({ name: 'Бат', email: 'bat@example.mn', phone: null, phone_verified: false });
  });

  it('says plainly when nobody signs in with that phone or address', async () => {
    const owner = await person('+97699110001', 'Дорж');
    const orgId = await aButcher(owner);
    const none = await call('GET', `/v1/orgs/${orgId}/lookup?contact=${encodeURIComponent('nobody@example.mn')}`, owner);
    expect(none.statusCode).toBe(404);
    expect(none.json().error.message_mn).toContain('нэг удаа нэвтэрсэн');
  });
});
