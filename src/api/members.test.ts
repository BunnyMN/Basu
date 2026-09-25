import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { syncMembersFromEnv } from '../ops/index.js';
import { relay } from '../platform/notify/index.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * Who sits at the desk, and as what.
 *
 * A seat is a role an account holds. The person signs in however they like
 * and asks; an admin says yes with a role, changes it, or switches the seat
 * off. An email address may be named ahead of time, because the address
 * proves itself; a phone number proves nothing when anybody can type it and
 * choose a password for it. There are no codes to hand out.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let ctx: Ctx;
let mailer: FakeMailer;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => bearer(opsToken()!);

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  mailer = new FakeMailer();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier: new FakeNotifier(), mailer };
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

/** Signed in by a code to the inbox — an address proved, the way Google or Apple proves one. */
async function byEmail(address: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: address } });
  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/email/verify',
    payload: { email: address, code: mailer.codeFor(address) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return verified.json().token as string;
}

const addMember = (payload: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/v1/ops/members', headers: desk(), payload });
const me = (token: string) => app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(token) });

describe('a seat is an account that proved the address', () => {
  it('will not seat somebody who registered a member’s number before its owner came', async () => {
    await syncMembersFromEnv('+97699778899:Санхүү:finance');
    // Anybody can type a number and choose a password for it.
    const squatter = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97699778899', password: 'булаах гэсэн' } });
    expect(squatter.statusCode).toBe(201);
    expect((await me(squatter.json().token)).statusCode).toBe(401);
  });

  it('names a member ahead of time only by email', async () => {
    const byPhone = await addMember({ phone: '+97699778899', name: 'Санхүү', role: 'finance' });
    expect(byPhone.statusCode).toBe(400);
    expect(byPhone.json().error.message_mn).toBe('Имэйл хаягаа оруулна уу.');
  });

  it('seats a member named by email the first time that address signs in', async () => {
    const added = await addMember({ email: 'Bat@Gmail.com', name: 'Бат', role: 'ops' });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ email: 'bat@gmail.com', phone: null, joined: false });

    const token = await byEmail('bat@gmail.com');
    const seat = await me(token);
    expect(seat.statusCode, seat.body).toBe(200);
    expect(seat.json().member).toMatchObject({ name: 'Бат', role: 'ops', email: 'bat@gmail.com' });

    const listed = (await app.inject({ method: 'GET', url: '/v1/ops/members', headers: desk() })).json().members;
    expect(listed.find((m: { email: string }) => m.email === 'bat@gmail.com')).toMatchObject({ joined: true });
    // Somebody else's address is somebody else.
    expect((await me(await byEmail('dorj@gmail.com'))).statusCode).toBe(401);
  });

  it('seats a person who signed up by phone once they ask and an admin says yes, and off is off', async () => {
    const byPhone = (await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97699112233', password: 'миний нууц үг' } })).json().token as string;
    const { id } = (await app.inject({ method: 'POST', url: '/v1/ops/requests', headers: bearer(byPhone), payload: { name: 'Ганхүлэг', role: 'admin' } })).json();
    await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/approve`, headers: desk(), payload: {} });
    const seat = await me(byPhone);
    expect(seat.json().member).toMatchObject({ name: 'Ганхүлэг', role: 'admin', phone: '+97699112233' });

    await app.inject({ method: 'POST', url: `/v1/ops/members/${seat.json().member.id}/active`, headers: desk(), payload: { active: false } });
    expect((await me(byPhone)).statusCode).toBe(401);
  });

  it('takes a member named by email from the environment, which by itself seats nobody', async () => {
    await syncMembersFromEnv('owner@gmail.com:Эзэн:admin');
    const listed = (await app.inject({ method: 'GET', url: '/v1/ops/members', headers: desk() })).json().members;
    expect(listed.find((m: { email: string }) => m.email === 'owner@gmail.com')).toMatchObject({ role: 'admin', joined: false });
    expect((await me(await byEmail('owner@gmail.com'))).json().member).toMatchObject({ name: 'Эзэн', role: 'admin' });
  });

  it('has no codes to hand out or redeem', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'admin' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { code: '12345 67890', phone: '+97699112233', password: 'x' } })).statusCode).toBe(404);
  });
});

describe('changing a member’s role', () => {
  const setRole = (id: string, role: string, token?: string) =>
    app.inject({ method: 'POST', url: `/v1/ops/members/${id}/role`, headers: token ? bearer(token) : desk(), payload: { role } });

  it('gives another role, which the seat has at once, and records it', async () => {
    await syncMembersFromEnv('bat@gmail.com:Бат:ops');
    const token = await byEmail('bat@gmail.com');
    const seat = (await me(token)).json().member;
    const changed = await setRole(seat.id, 'finance');
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ id: seat.id, role: 'finance' });
    expect((await me(token)).json().member.role).toBe('finance');
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json();
    expect(JSON.stringify(audit)).toContain('member.role');
    expect((await setRole(seat.id, 'owner')).statusCode).toBe(400);
  });

  it('is an admin’s to change, never your own, and never the last admin’s', async () => {
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,viewer@gmail.com:Харагч:viewer');
    const admin = await byEmail('admin@gmail.com');
    const viewer = await byEmail('viewer@gmail.com');
    const adminSeat = (await me(admin)).json().member.id;
    const viewerSeat = (await me(viewer)).json().member.id;

    expect((await setRole(adminSeat, 'viewer', viewer)).statusCode).toBe(403);
    const own = await setRole(adminSeat, 'viewer', admin);
    expect(own.statusCode).toBe(400);
    expect(own.json().error.message_mn).toBe('Өөрийн эрхийг өөрчлөх боломжгүй.');
    // From the shared desk key (the demo's), the only admin stays one.
    const last = await setRole(adminSeat, 'ops');
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('LAST_ADMIN');

    expect((await setRole(viewerSeat, 'admin', admin)).statusCode).toBe(200);
    expect((await setRole(adminSeat, 'ops', viewer)).statusCode).toBe(200);
  });
});

describe('asking for a seat from the dashboard', () => {
  const whoami = (token: string) => app.inject({ method: 'GET', url: '/v1/ops/whoami', headers: bearer(token) });
  const ask = (token: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/v1/ops/requests', headers: bearer(token), payload });

  it('lets anybody signed in ask, and an admin say yes — no address typed by anybody', async () => {
    const token = await byEmail('bold@gmail.com');
    const first = (await whoami(token)).json();
    expect(first).toMatchObject({ account: { email: 'bold@gmail.com' }, member: null, request: null });

    const asked = await ask(token, { name: 'Болд', role: 'finance', note: 'Санхүүгийн ажилтан' });
    expect(asked.statusCode, asked.body).toBe(201);
    expect((await whoami(token)).json().request).toMatchObject({ state: 'pending', role: 'finance', contact: 'bold@gmail.com' });
    // Asking is not sitting.
    expect((await me(token)).statusCode).toBe(401);

    const waiting = (await app.inject({ method: 'GET', url: '/v1/ops/requests', headers: desk() })).json().requests;
    expect(waiting).toHaveLength(1);
    // The admin gives a smaller role than asked for.
    const yes = await app.inject({ method: 'POST', url: `/v1/ops/requests/${waiting[0].id}/approve`, headers: desk(), payload: { role: 'viewer' } });
    expect(yes.statusCode, yes.body).toBe(200);

    expect((await whoami(token)).json()).toMatchObject({ member: { name: 'Болд', role: 'viewer', email: 'bold@gmail.com' }, request: { state: 'approved' } });
    expect((await me(token)).statusCode).toBe(200);
    // Told so, by email here — the account has no app.
    await relay(ctx);
    expect(mailer.to('bold@gmail.com')?.subject).toContain('Ops эрх олголоо');
    expect((await app.inject({ method: 'GET', url: '/v1/ops/requests', headers: desk() })).json().requests).toEqual([]);
  });

  it('says no with a reason, and lets them ask again', async () => {
    const token = await byEmail('bold@gmail.com');
    const { id } = (await ask(token, { name: 'Болд', role: 'admin' })).json();
    const no = await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/decline`, headers: desk(), payload: { reason: 'Админ эрх хэрэггүй' } });
    expect(no.statusCode, no.body).toBe(200);
    expect((await whoami(token)).json().request).toMatchObject({ state: 'declined', decline_reason: 'Админ эрх хэрэггүй' });
    expect((await me(token)).statusCode).toBe(401);
    // Once answered, not again.
    expect((await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/approve`, headers: desk(), payload: {} })).statusCode).toBe(409);

    expect((await ask(token, { name: 'Болд', role: 'ops' })).statusCode).toBe(201);
    expect((await whoami(token)).json().request).toMatchObject({ state: 'pending', role: 'ops' });
  });

  it('keeps the answering to admins, and the asking to people not already seated', async () => {
    const asker = await byEmail('bold@gmail.com');
    const { id } = (await ask(asker, { name: 'Болд', role: 'ops' })).json();
    // Asking again while waiting changes the ask; it does not queue a second one.
    await ask(asker, { name: 'Болд', role: 'finance' });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/requests', headers: desk() })).json().requests).toHaveLength(1);

    // A viewer sits at the desk but cannot seat anybody.
    await syncMembersFromEnv('viewer@gmail.com:Харагч:viewer');
    const viewer = await byEmail('viewer@gmail.com');
    expect((await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/approve`, headers: bearer(viewer), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/approve`, headers: bearer(asker), payload: {} })).statusCode).toBe(401);
    // And somebody seated has nothing to ask for.
    expect((await ask(viewer, { name: 'Харагч', role: 'admin' })).statusCode).toBe(409);
    // Nobody signed in asks nothing.
    expect((await app.inject({ method: 'POST', url: '/v1/ops/requests', payload: { name: 'X', role: 'admin' } })).statusCode).toBe(401);
  });

  it('switches a member who was switched off back on, in the same seat', async () => {
    const token = await byEmail('bold@gmail.com');
    const { id } = (await ask(token, { name: 'Болд', role: 'ops' })).json();
    await app.inject({ method: 'POST', url: `/v1/ops/requests/${id}/approve`, headers: desk(), payload: {} });
    const seat = (await me(token)).json().member.id;
    await app.inject({ method: 'POST', url: `/v1/ops/members/${seat}/active`, headers: desk(), payload: { active: false } });
    expect((await me(token)).statusCode).toBe(401);

    const again = (await ask(token, { name: 'Болд', role: 'finance' })).json();
    await app.inject({ method: 'POST', url: `/v1/ops/requests/${again.id}/approve`, headers: desk(), payload: {} });
    expect((await me(token)).json().member).toMatchObject({ id: seat, role: 'finance' });
  });
});
