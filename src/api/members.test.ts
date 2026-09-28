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
 * A seat is a role an account holds. Nobody applies for Basu's desk: an
 * admin finds the person among the accounts already on Basu and gives them
 * a role, changes it, or switches the seat off. The environment may name the
 * first members by email, because an address proves itself; a phone number
 * proves nothing when anybody can type it and choose a password for it.
 * There are no codes to hand out, and no addresses for an admin to type.
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

/** Signed up with a phone and a password, the way most people are — with a name. */
async function byPhone(phone: string, name: string): Promise<{ token: string; id: string }> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: 'миний нууц үг', name } });
  expect(made.statusCode, made.body).toBe(201);
  const token = made.json().token as string;
  const id = (await app.inject({ method: 'GET', url: '/v1/ops/whoami', headers: bearer(token) })).json().account.id as string;
  return { token, id };
}

const seat = (payload: Record<string, string>, token?: string) =>
  app.inject({ method: 'POST', url: '/v1/ops/members', headers: token ? bearer(token) : desk(), payload });
const people = (q: string, token?: string) =>
  app.inject({ method: 'GET', url: `/v1/ops/people?q=${encodeURIComponent(q)}`, headers: token ? bearer(token) : desk() });
const me = (token: string) => app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(token) });
const accountId = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/ops/whoami', headers: bearer(token) })).json().account.id as string;

describe('a seat is an account that proved the address', () => {
  it('will not seat somebody who registered a member’s number before its owner came', async () => {
    await syncMembersFromEnv('+97699778899:Санхүү:finance');
    // Anybody can type a number and choose a password for it.
    const squatter = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '+97699778899', password: 'булаах гэсэн' } });
    expect(squatter.statusCode).toBe(201);
    expect((await me(squatter.json().token)).statusCode).toBe(401);
  });

  it('seats nobody by an address typed in', async () => {
    const typed = await seat({ email: 'bat@gmail.com', name: 'Бат', role: 'ops' });
    expect(typed.statusCode).toBe(400);
    expect(typed.json().error.message_mn).toBe('Хэрэглэгчээ сонгоно уу.');
  });

  it('seats the account an admin chose, at once, and off is off', async () => {
    const person = await byPhone('+97699112233', 'Ганхүлэг');
    const given = await seat({ guest_id: person.id, role: 'admin' });
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({ name: 'Ганхүлэг', role: 'admin', phone: '+97699112233', joined: true, active: true });
    const sitting = await me(person.token);
    expect(sitting.json().member).toMatchObject({ name: 'Ганхүлэг', role: 'admin', phone: '+97699112233' });

    await app.inject({ method: 'POST', url: `/v1/ops/members/${sitting.json().member.id}/active`, headers: desk(), payload: { active: false } });
    expect((await me(person.token)).statusCode).toBe(401);
  });

  it('takes a member named by email from the environment, which by itself seats nobody', async () => {
    await syncMembersFromEnv('owner@gmail.com:Эзэн:admin');
    const listed = (await app.inject({ method: 'GET', url: '/v1/ops/members', headers: desk() })).json().members;
    expect(listed.find((m: { email: string }) => m.email === 'owner@gmail.com')).toMatchObject({ role: 'admin', joined: false });
    expect((await me(await byEmail('owner@gmail.com'))).json().member).toMatchObject({ name: 'Эзэн', role: 'admin' });
  });

  it('has no codes to hand out or redeem, and no asking', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/ops/invites', headers: desk(), payload: { role: 'admin' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { code: '12345 67890', phone: '+97699112233', password: 'x' } })).statusCode).toBe(404);
    const person = await byPhone('+97699112233', 'Ганхүлэг');
    expect((await app.inject({ method: 'POST', url: '/v1/ops/requests', headers: bearer(person.token), payload: { name: 'Ганхүлэг', role: 'admin' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/requests', headers: desk() })).statusCode).toBe(404);
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

describe('choosing a person from Basu’s users', () => {
  it('finds people by name, phone or email, the newest first, and marks who sits at the desk', async () => {
    const bold = await byPhone('+97699110001', 'Болд');
    await byPhone('+97699110002', 'Сараа');
    const mail = await byEmail('bat@gmail.com');

    const named = (await people('болд')).json().people;
    expect(named.map((p: { name: string }) => p.name)).toEqual(['Болд']);
    expect(named[0]).toMatchObject({ id: bold.id, phone: '+97699110001', member: null });
    expect((await people('99110002')).json().people.map((p: { name: string }) => p.name)).toEqual(['Сараа']);
    expect((await people('bat@')).json().people.map((p: { id: string }) => p.id)).toEqual([await accountId(mail)]);
    // Nothing typed: the newest accounts, to choose from at once.
    expect((await people('')).json().people[0].id).toBe(await accountId(mail));

    await seat({ guest_id: bold.id, role: 'finance' });
    expect((await people('Болд')).json().people[0].member).toMatchObject({ role: 'finance', active: true });
  });

  it('tells the person their seat is there, by email where they have no app, and records who gave it', async () => {
    const token = await byEmail('bold@gmail.com');
    const given = await seat({ guest_id: await accountId(token), role: 'viewer' });
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({ email: 'bold@gmail.com', role: 'viewer', joined: true });
    expect((await me(token)).json().member).toMatchObject({ role: 'viewer', email: 'bold@gmail.com' });

    await relay(ctx);
    const mail = mailer.to('bold@gmail.com');
    expect(mail?.subject).toContain('Basu ops эрх олголоо');
    expect(mail?.text ?? JSON.stringify(mail)).toContain('Зөвхөн харах');
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json();
    expect(JSON.stringify(audit)).toContain('member.grant');
  });

  it('keeps the choosing to whoever may seat people', async () => {
    const person = await byPhone('+97699110001', 'Болд');
    await syncMembersFromEnv('viewer@gmail.com:Харагч:viewer');
    const viewer = await byEmail('viewer@gmail.com');
    // A viewer sits at the desk but seats nobody, and does not browse Basu's users.
    expect((await people('', viewer)).statusCode).toBe(403);
    expect((await seat({ guest_id: person.id, role: 'ops' }, viewer)).statusCode).toBe(403);
    // Somebody with no seat is not at the desk at all.
    expect((await people('', person.token)).statusCode).toBe(401);
    expect((await seat({ guest_id: person.id, role: 'ops' }, person.token)).statusCode).toBe(401);
    // Nor are the people for anybody signed in to find by guessing.
    expect((await app.inject({ method: 'GET', url: '/v1/ops/people?q=Болд' })).statusCode).toBe(401);
  });

  it('says what is wrong with a choice: nobody chosen, an account that is not there, a role that is not', async () => {
    const person = await byPhone('+97699110001', 'Болд');
    expect((await seat({ role: 'ops' })).statusCode).toBe(400);
    expect((await seat({ guest_id: 'not-an-id', role: 'ops' })).statusCode).toBe(400);
    expect((await seat({ guest_id: '00000000-0000-0000-0000-000000000000', role: 'ops' })).statusCode).toBe(404);
    const wrong = await seat({ guest_id: person.id, role: 'owner' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message_mn).toBe('Эрх буруу байна.');
  });

  it('switches a member who was switched off back on, in the same seat, with the role given now', async () => {
    const token = await byEmail('bold@gmail.com');
    const id = await accountId(token);
    const first = (await seat({ guest_id: id, role: 'ops' })).json();
    await app.inject({ method: 'POST', url: `/v1/ops/members/${first.id}/active`, headers: desk(), payload: { active: false } });
    expect((await me(token)).statusCode).toBe(401);

    const again = (await seat({ guest_id: id, role: 'finance' })).json();
    expect(again).toMatchObject({ id: first.id, role: 'finance', active: true });
    expect((await me(token)).json().member).toMatchObject({ id: first.id, role: 'finance' });
  });

  it('gives the seat the environment named by the account’s number, not a second one', async () => {
    // A number typed in a password sign-up proves nothing, so the seat the environment named waits…
    const person = await byPhone('+97699778899', 'Санхүүч');
    await syncMembersFromEnv('+97699778899:Санхүү:viewer');
    expect((await me(person.token)).statusCode).toBe(401);

    // …until an admin chooses that account: then it is that seat, with the role given now.
    const given = (await seat({ guest_id: person.id, role: 'finance' })).json();
    expect(given).toMatchObject({ name: 'Санхүү', phone: '+97699778899', role: 'finance', joined: true });
    expect((await me(person.token)).json().member).toMatchObject({ id: given.id, role: 'finance' });
    const listed = (await app.inject({ method: 'GET', url: '/v1/ops/members', headers: desk() })).json().members;
    expect(listed.filter((m: { phone: string | null }) => m.phone === '+97699778899')).toHaveLength(1);
  });
});
