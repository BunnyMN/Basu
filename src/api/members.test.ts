import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { NO_GRANTS } from '../platform/access/index.js';
import { setMemberRole, syncMembersFromEnv, upsertMember } from '../ops/index.js';
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
 * proves nothing when anybody can type it and choose a password for it. The
 * environment only seeds: what the desk changes afterwards stays changed.
 * Nobody moves a seat past what they hold — as the desk has them when the
 * change is made — the desk always keeps an admin, and a seat wants a
 * sign-in from the last twelve hours, which an older one cannot make itself
 * by choosing a new way in. The guests' pages leave the people at the desk
 * to the members page. There are no codes to hand out, and no addresses for
 * an admin to type.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let ctx: Ctx;
let mailer: FakeMailer;
let notifier: FakeNotifier;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => bearer(opsToken()!);

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  mailer = new FakeMailer();
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier, mailer };
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

/** Signed in by a code the phone received: the one way a number is proved. */
async function bySms(phone: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  return verified.json().token as string;
}

type Listed = { id: string; name: string; phone: string | null; email: string | null; role: string; active: boolean; joined: boolean };

const seat = (payload: Record<string, string>, token?: string) =>
  app.inject({ method: 'POST', url: '/v1/ops/members', headers: token ? bearer(token) : desk(), payload });
const people = (q: string, token?: string) =>
  app.inject({ method: 'GET', url: `/v1/ops/people?q=${encodeURIComponent(q)}`, headers: token ? bearer(token) : desk() });
const me = (token: string) => app.inject({ method: 'GET', url: '/v1/ops/me', headers: bearer(token) });
const accountId = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/ops/whoami', headers: bearer(token) })).json().account.id as string;
/** The account's id as the website knows it — without coming to the desk, where a proved address would sit down at once. */
const websiteId = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).json().id as string;
const setRole = (id: string, role: string, token?: string) =>
  app.inject({ method: 'POST', url: `/v1/ops/members/${id}/role`, headers: token ? bearer(token) : desk(), payload: { role } });
const setActive = (id: string, active: boolean, token?: string) =>
  app.inject({ method: 'POST', url: `/v1/ops/members/${id}/active`, headers: token ? bearer(token) : desk(), payload: { active } });
const members = async (): Promise<Listed[]> => (await app.inject({ method: 'GET', url: '/v1/ops/members', headers: desk() })).json().members;

/** A desk role that manages who sits at the desk and nothing else: the clerk who does the paperwork. */
async function clerkRole(): Promise<string> {
  const made = await app.inject({
    method: 'POST',
    url: '/v1/ops/roles/desk',
    headers: desk(),
    payload: { name: 'Хүний нөөц', permissions: ['desk.members', 'desk.members:manage'] },
  });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().key as string;
}

/** Somebody signed in by email, seated by the desk in that role. */
async function seatedByEmail(address: string, role: string): Promise<string> {
  const token = await byEmail(address);
  const given = await seat({ guest_id: await websiteId(token), role });
  expect(given.statusCode, given.body).toBe(201);
  return token;
}

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
    const given = await seat({ guest_id: person.id, role: 'ops' });
    expect(given.statusCode, given.body).toBe(201);
    // The seat is the account's; the number it typed names nobody at the desk.
    expect(given.json()).toMatchObject({ name: 'Ганхүлэг', role: 'ops', phone: null, joined: true, active: true });
    const sitting = await me(person.token);
    expect(sitting.json().member).toMatchObject({ name: 'Ганхүлэг', role: 'ops' });

    expect((await setActive(sitting.json().member.id, false)).statusCode).toBe(200);
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

  it('says whether a number was proved, so the picker never passes a typed one off as its owner’s', async () => {
    // A password sign-up types any number it likes — «Бат» with Бат's number,
    // before Бат ever comes — so the picker must be able to mark it unproved.
    const typed = await byPhone('+97699119001', 'Хэн нэгэн');
    await bySms('+97699119002');

    const rows = (await people('9911900')).json().people as Array<{ phone: string; phone_verified: boolean; email: string | null }>;
    const typedRow = rows.find((p) => p.phone === '+97699119001')!;
    const provedRow = rows.find((p) => p.phone === '+97699119002')!;
    expect(typedRow.phone_verified).toBe(false);
    expect(provedRow.phone_verified).toBe(true);
    void typed;
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
    await setActive(first.id, false);
    expect((await me(token)).statusCode).toBe(401);

    const again = (await seat({ guest_id: id, role: 'finance' })).json();
    expect(again).toMatchObject({ id: first.id, role: 'finance', active: true });
    expect((await me(token)).json().member).toMatchObject({ id: first.id, role: 'finance' });
  });

  it('never hands over the seat the environment named by a number the chosen account only typed', async () => {
    await syncMembersFromEnv('+97699778899:Санхүү:admin');
    // Anybody can type the admin's number and choose a password for it…
    const squatter = await byPhone('+97699778899', 'Булаагч');
    expect((await me(squatter.token)).statusCode).toBe(401);

    // …and when an admin chooses that account, for anything, it gets a seat of its own, named by nothing it typed.
    const given = await seat({ guest_id: squatter.id, role: 'viewer' });
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({ name: 'Булаагч', role: 'viewer', phone: null, joined: true });
    expect((await me(squatter.token)).json().member).toMatchObject({ id: given.json().id, role: 'viewer' });
    // The seat the environment named waits for its owner, exactly as it was.
    const named = (await members()).find((m) => m.phone === '+97699778899');
    expect(named).toMatchObject({ name: 'Санхүү', role: 'admin', active: true, joined: false });
    expect(named!.id).not.toBe(given.json().id);
  });

  it('never hands a colleague’s old seat to whoever registers their number after them', async () => {
    // A colleague whose number a code proved, who has left: the seat switched off, the account closed.
    await upsertMember({ phone: '+97699778800', name: 'Хуучин нягтлан', role: 'finance' });
    const colleague = await bySms('+97699778800');
    const old = (await me(colleague)).json().member.id as string;
    expect((await setActive(old, false)).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(colleague) })).statusCode).toBe(200);

    // The number is free, and somebody types it.
    const stranger = await byPhone('+97699778800', 'Шинэ хүн');
    const given = await seat({ guest_id: stranger.id, role: 'viewer' });
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({ name: 'Шинэ хүн', role: 'viewer', active: true, phone: null });
    expect(given.json().id).not.toBe(old);
    expect((await members()).find((m) => m.id === old)).toMatchObject({ name: 'Хуучин нягтлан', role: 'finance', active: false });
  });

  it('gives the seat the environment named by an address the chosen account proved, not a second one', async () => {
    await syncMembersFromEnv('bat@gmail.com:Бат:viewer');
    // Signed in on the website, not yet come to the desk.
    const token = await byEmail('bat@gmail.com');
    const given = await seat({ guest_id: await websiteId(token), role: 'finance' });
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({ name: 'Бат', email: 'bat@gmail.com', role: 'finance', joined: true });
    expect((await members()).filter((m) => m.email === 'bat@gmail.com')).toHaveLength(1);
    expect((await me(token)).json().member).toMatchObject({ id: given.json().id, role: 'finance' });
  });

  it('refuses somebody already at the desk — a role is changed in the table — and your own account', async () => {
    const token = await seatedByEmail('bold@gmail.com', 'viewer');
    const again = await seat({ guest_id: await websiteId(token), role: 'ops' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'ALREADY_SEATED', message_mn: expect.stringContaining('Эрх солих') });
    expect((await me(token)).json().member.role).toBe('viewer');

    // An admin choosing themselves is not a way to be something else.
    await syncMembersFromEnv('admin@gmail.com:Админ:admin');
    const admin = await byEmail('admin@gmail.com');
    const own = await seat({ guest_id: await websiteId(admin), role: 'viewer' }, admin);
    expect(own.statusCode).toBe(400);
    expect(own.json().error.message_mn).toBe('Өөрийн эрхийг өөрчлөх боломжгүй.');
    expect((await me(admin)).json().member.role).toBe('admin');
  });

  it('refuses your own seat when it is asked for through another of your accounts', async () => {
    // One admin, named by an address and a number: in by email on one account, by a code to the phone on another.
    await upsertMember({ email: 'admin@gmail.com', phone: '+97699001100', name: 'Админ', role: 'admin' });
    const admin = await byEmail('admin@gmail.com');
    expect((await me(admin)).json().member.role).toBe('admin');
    const phone = await bySms('+97699001100');
    const own = await seat({ guest_id: await websiteId(phone), role: 'viewer' }, admin);
    expect(own.statusCode).toBe(400);
    expect(own.json().error.code).toBe('OWN_SEAT');
    expect((await me(admin)).json().member.role).toBe('admin');
  });
});

describe('nobody moves a seat past what they hold', () => {
  it('keeps a members clerk off the admins: not off, not on, not another role, however it is asked', async () => {
    const hr = await clerkRole();
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,second@gmail.com:Хоёр:admin,boss@gmail.com:Эзэн:admin');
    const admin = await byEmail('admin@gmail.com');
    const second = await byEmail('second@gmail.com');
    const adminSeat = (await me(admin)).json().member.id as string;
    const secondSeat = (await me(second)).json().member.id as string;
    const clerk = await seatedByEmail('clerk@gmail.com', hr);

    // Off: refused, and the admin is still at the desk.
    expect((await setActive(adminSeat, false, clerk)).statusCode).toBe(403);
    expect((await me(admin)).statusCode).toBe(200);
    // Another role, in the table or by choosing the admin's account again: refused both ways.
    expect((await setRole(adminSeat, hr, clerk)).statusCode).toBe(403);
    const chosen = await seat({ guest_id: await websiteId(admin), role: hr }, clerk);
    expect(chosen.statusCode).toBe(409);
    expect(chosen.json().error.code).toBe('ALREADY_SEATED');
    // On again, for an admin the desk switched off: refused, in the table and by choosing the account.
    expect((await setActive(secondSeat, false, admin)).statusCode).toBe(200);
    expect((await setActive(secondSeat, true, clerk)).statusCode).toBe(403);
    expect((await seat({ guest_id: await websiteId(second), role: hr }, clerk)).statusCode).toBe(403);
    expect((await me(second)).statusCode).toBe(401);
    // Nor the admin seat the environment named, taken over by choosing the account that proves its address.
    const boss = await byEmail('boss@gmail.com');
    expect((await seat({ guest_id: await websiteId(boss), role: hr }, clerk)).statusCode).toBe(403);

    const admins = (await members()).filter((m) => m.role === 'admin');
    expect(admins.map((m) => [m.name, m.active]).sort()).toEqual([['Админ', true], ['Хоёр', false], ['Эзэн', true]]);
  });

  it('never switches the last active admin off, nor lets two changes at once leave none', async () => {
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,second@gmail.com:Хоёр:admin');
    const admin = await byEmail('admin@gmail.com');
    const second = await byEmail('second@gmail.com');
    const adminSeat = (await me(admin)).json().member.id as string;
    const secondSeat = (await me(second)).json().member.id as string;
    const activeAdmins = async () => (await members()).filter((m) => m.role === 'admin' && m.active);
    /**
     * The two admins each take the other out at the same moment. The calls
     * before open enough connections that neither request waits for one —
     * else they do not happen at the same moment at all.
     */
    const atOnce = async (one: () => ReturnType<typeof me>, other: () => ReturnType<typeof me>) => {
      await Promise.all(Array.from({ length: 6 }, (_, i) => me(i % 2 ? admin : second)));
      return (await Promise.all([one(), other()])).map((r) => r.statusCode);
    };

    // Both switched off at once: one goes through, the other is told no.
    const off = await atOnce(() => setActive(secondSeat, false, admin), () => setActive(adminSeat, false, second));
    expect(off.filter((s) => s === 200)).toHaveLength(1);
    expect(await activeAdmins()).toHaveLength(1);

    // Both back, and both given another role at once: the same.
    const back = (await members()).find((m) => m.role === 'admin' && !m.active)!;
    expect((await setActive(back.id, true)).statusCode).toBe(200);
    const demoted = await atOnce(() => setRole(secondSeat, 'viewer', admin), () => setRole(adminSeat, 'viewer', second));
    expect(demoted.filter((s) => s === 200)).toHaveLength(1);
    const left = await activeAdmins();
    expect(left).toHaveLength(1);

    // The one left stays on, whoever asks — the demo's key, which is nobody's seat, too.
    const last = await setActive(left[0]!.id, false);
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toMatchObject({ code: 'LAST_ADMIN', message_mn: 'Ядаж нэг идэвхтэй админ үлдэх ёстой.' });
    expect(await activeAdmins()).toHaveLength(1);
  });

  it('finds no member by an id that is nobody’s, or no id at all', async () => {
    for (const id of ['not-an-id', '00000000-0000-0000-0000-000000000000']) {
      const off = await setActive(id, false);
      expect(off.statusCode, id).toBe(404);
      expect(off.json().error.message_mn, id).toBe('Ийм гишүүн олдсонгүй.');
      const role = await setRole(id, 'viewer');
      expect(role.statusCode, id).toBe(404);
      expect(role.json().error.message_mn, id).toBe('Ийм гишүүн олдсонгүй.');
    }
  });

  it('knows your own seat however its id is spelled', async () => {
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,second@gmail.com:Хоёр:admin');
    const admin = await byEmail('admin@gmail.com');
    await byEmail('second@gmail.com');
    const own = ((await me(admin)).json().member.id as string).toUpperCase();

    for (const refused of [await setRole(own, 'viewer', admin), await setActive(own, false, admin)]) {
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('OWN_SEAT');
    }
    expect((await me(admin)).json().member).toMatchObject({ role: 'admin' });
    // Somebody else's seat, spelled so, is that seat — and answered under its own id.
    const second = (await members()).find((m) => m.email === 'second@gmail.com')!;
    const off = await setActive(second.id.toUpperCase(), false, admin);
    expect(off.json()).toEqual({ id: second.id, active: false });
  });

  it('asks again, inside the change, what the one changing holds now', async () => {
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,second@gmail.com:Хоёр:admin');
    const admin = await byEmail('admin@gmail.com');
    const second = await byEmail('second@gmail.com');
    const secondSeat = (await me(second)).json().member.id as string;
    const viewer = await seatedByEmail('viewer@gmail.com', 'viewer');
    const viewerSeat = (await me(viewer)).json().member.id as string;
    /** How many changes wait for the desk's turn, in this database: Postgres hands it on in the order they came. */
    const waiting = async () =>
      (
        await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
      ).rows[0]!.n;
    const queued = async (n: number) => {
      for (let i = 0; i < 300 && (await waiting()) < n; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await waiting()).toBe(n);
    };

    // Another change holds the desk. Behind it the first admin switches the second off; behind that,
    // the second — let in at the door while still on — asks to switch the viewer off.
    const other = await getPool().connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT pg_advisory_xact_lock(hashtext('ops.member'))`);
      const first = setActive(secondSeat, false, admin);
      await queued(1);
      const then = setActive(viewerSeat, false, second);
      await queued(2);
      await other.query('COMMIT');

      expect((await first).statusCode).toBe(200);
      const refused = await then;
      expect(refused.statusCode, refused.body).toBe(403);
    } finally {
      other.release();
    }
    expect((await me(viewer)).json().member).toMatchObject({ role: 'viewer' });
  });

  it('says a role that went while the change waited is no role, not a failure of its own', async () => {
    const token = await seatedByEmail('bold@gmail.com', 'viewer');
    const seatId = (await me(token)).json().member.id as string;
    await expect(setMemberRole(seatId, 'deleted-meanwhile', { grants: NO_GRANTS, locked: true, seatId: null, account: null })).rejects.toMatchObject({
      name: 'MemberError',
      code: 'NO_ROLE',
    });
  });
});

describe('the guests’ pages leave the desk to the members page', () => {
  /** The desk's file on an account: its sessions among it. */
  const file = async (guestId: string) => (await app.inject({ method: 'GET', url: `/v1/ops/guests/${guestId}`, headers: desk() })).json();
  const signOutOne = (guestId: string, sessionId: string, token?: string) =>
    app.inject({ method: 'POST', url: `/v1/ops/guests/${guestId}/sessions/${sessionId}/revoke`, headers: token ? bearer(token) : desk(), payload: {} });
  const close = (guestId: string, token?: string) =>
    app.inject({ method: 'POST', url: `/v1/ops/guests/${guestId}/close`, headers: token ? bearer(token) : desk(), payload: { note: 'тест' } });

  it('closes no account whose seat is on — that seat is switched off on «Гишүүд» first — whoever asks', async () => {
    const closer = (
      await app.inject({
        method: 'POST',
        url: '/v1/ops/roles/desk',
        headers: desk(),
        payload: { name: 'Хаагч', permissions: ['desk.guests', 'desk.guests:close'] },
      })
    ).json().key as string;
    // Two admins, so that one of them may be switched off.
    await syncMembersFromEnv('admin@gmail.com:Админ:admin,boss@gmail.com:Эзэн:admin');
    const admin = await byEmail('admin@gmail.com');
    const adminId = await accountId(admin);
    const clerk = await seatedByEmail('closer@gmail.com', closer);

    for (const token of [clerk, undefined]) {
      const refused = await close(adminId, token);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toMatchObject({ code: 'AT_THE_DESK', message_mn: expect.stringContaining('«Гишүүд»') });
    }
    expect((await me(admin)).json().member.role).toBe('admin');

    // Off on the members page, under its rules, the account is a guest like any other.
    expect((await setActive((await me(admin)).json().member.id, false)).statusCode).toBe(200);
    expect((await close(adminId, clerk)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(admin) })).statusCode).toBe(401);
    // Anybody with no seat is closed as before.
    const guest = await byPhone('+97699110003', 'Зочин');
    expect((await close(guest.id, clerk)).statusCode).toBe(200);
  });

  it('signs a desk member out only for whoever may hand out their seat’s role', async () => {
    await syncMembersFromEnv('admin@gmail.com:Админ:admin');
    const admin = await byEmail('admin@gmail.com');
    const adminId = await accountId(admin);
    // The built-in ops role signs lost phones out: a guest's, not an admin's.
    const worker = await seatedByEmail('ops@gmail.com', 'ops');
    const guest = await byPhone('+97699110004', 'Зочин');

    const refused = await signOutOne(adminId, (await file(adminId)).sessions[0].id, worker);
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await me(admin)).statusCode).toBe(200);
    expect((await signOutOne(guest.id, (await file(guest.id)).sessions[0].id, worker)).statusCode).toBe(200);
    // Whoever may seat an admin may sign one out.
    expect((await signOutOne(adminId, (await file(adminId)).sessions[0].id)).statusCode).toBe(200);
    expect((await me(admin)).statusCode).toBe(401);
  });
});

describe('the environment only seeds the desk', () => {
  it('makes the members it names once, and leaves what the desk changed as the desk left it', async () => {
    const list = 'boss@gmail.com:Эзэн:admin,deputy@gmail.com:Орлогч:admin,bat@gmail.com:Бат:finance';
    expect(await syncMembersFromEnv(list)).toBe(3);
    const named = async (email: string) => (await members()).find((m) => m.email === email)!;
    // The desk demotes one admin and switches the finance seat off…
    expect((await setRole((await named('deputy@gmail.com')).id, 'viewer')).statusCode).toBe(200);
    expect((await setActive((await named('bat@gmail.com')).id, false)).statusCode).toBe(200);

    // …and the next deploy, with the same list or one that says otherwise, makes nobody and undoes nothing.
    expect(await syncMembersFromEnv(list)).toBe(0);
    expect(await syncMembersFromEnv('deputy@gmail.com:Шинэ нэр:admin,bat@gmail.com:Бат:admin')).toBe(0);
    expect(await named('deputy@gmail.com')).toMatchObject({ name: 'Орлогч', role: 'viewer', active: true });
    expect(await named('bat@gmail.com')).toMatchObject({ name: 'Бат', role: 'finance', active: false });
    // Taken out of the list, nobody is taken off the desk either: that is the desk's to do.
    expect(await syncMembersFromEnv('boss@gmail.com:Эзэн:admin')).toBe(0);
    expect((await members()).map((m) => m.email).sort()).toEqual(['bat@gmail.com', 'boss@gmail.com', 'deputy@gmail.com']);
  });

  it('skips an entry it cannot read, says which and why but never what it held, and writes the rest', async () => {
    const said: string[] = [];
    const list = [
      'nobody@gmail.com',
      '+9769977:Богино:ops',
      'ghost@gmail.com:Сүнс:owner',
      'blank@gmail.com: :viewer',
      '',
      ' Boss@Gmail.com : Эзэн : Admin ',
      'ops@gmail.com:Бат: Ажилтан:ops',
      '+976 9911 2233:Утастай:viewer',
    ].join(',');
    expect(await syncMembersFromEnv(list, (line) => said.push(line))).toBe(3);
    expect((await members()).map((m) => [m.email ?? m.phone, m.name, m.role]).sort()).toEqual([
      ['+97699112233', 'Утастай', 'viewer'],
      ['boss@gmail.com', 'Эзэн', 'admin'],
      ['ops@gmail.com', 'Бат: Ажилтан', 'ops'],
    ]);
    expect(said).toEqual([
      'OPS_MEMBERS entry 1 skipped: it is not address:name:role',
      'OPS_MEMBERS entry 2 skipped: the address is neither an email nor a +976 number',
      'OPS_MEMBERS entry 3 skipped: the desk has no such role',
      'OPS_MEMBERS entry 4 skipped: the name is missing',
    ]);
    // Boot logs are public: no line repeats an address, a name or a role it was given.
    for (const line of said) expect(line).not.toMatch(/@|9977|Богино|Сүнс|ghost|nobody|blank|owner/);
  });
});

describe('a seat wants a recent sign-in', () => {
  it('asks a seat signed in twelve hours ago to sign in again, at every desk door, and only there', async () => {
    const token = await seatedByEmail('bold@gmail.com', 'viewer');
    clock.advanceMinutes(12 * 60 - 1);
    expect((await me(token)).statusCode).toBe(200);

    clock.advanceMinutes(1);
    for (const url of ['/v1/ops/me', '/v1/ops/whoami', '/v1/ops/overview', '/v1/access', '/v1/access/roles?scope=desk']) {
      const asked = await app.inject({ method: 'GET', url, headers: bearer(token) });
      expect(asked.statusCode, url).toBe(401);
      expect(asked.json().error, url).toMatchObject({ code: 'SIGN_IN_AGAIN', message_mn: 'Аюулгүй байдлын үүднээс ops-д дахин нэвтэрнэ үү.' });
    }
    // The same session still opens the person's own things: it is only the desk that wants more.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode).toBe(200);
    // Signed in again, the desk is there.
    expect((await me(await byEmail('bold@gmail.com'))).json().member).toMatchObject({ role: 'viewer' });
  });

  it('leaves alone an account with no seat, a seat switched off, and the demo’s key', async () => {
    const person = await byPhone('+97699110001', 'Болд');
    const gone = await seatedByEmail('gone@gmail.com', 'viewer');
    await setActive((await me(gone)).json().member.id, false);
    clock.advanceMinutes(13 * 60);

    for (const token of [person.token, gone]) {
      const access = await app.inject({ method: 'GET', url: '/v1/access', headers: bearer(token) });
      expect(access.statusCode).toBe(200);
      expect(access.json().workspaces.map((w: { kind: string }) => w.kind)).toEqual(['me']);
      expect((await me(token)).json().error.code).toBe('UNAUTHORIZED');
      expect((await app.inject({ method: 'GET', url: '/v1/ops/whoami', headers: bearer(token) })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/ops/overview', headers: desk() })).statusCode).toBe(200);
  });

  /*
   * A session the desk no longer takes must not make itself a new sign-in.
   * A password of its holder's choosing, or an address of theirs on the
   * account, is exactly that: sign in with it, and the desk opens again.
   */
  const setPassword = (token: string, body: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/v1/me/password', headers: bearer(token), payload: body });
  const askAttachCode = (token: string, body: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/v1/me/email/code', headers: bearer(token), payload: body });
  const attach = (token: string, email: string, code: string | undefined) =>
    app.inject({ method: 'POST', url: '/v1/me/email', headers: bearer(token), payload: { email, code: code ?? '' } });
  const login = (who: string, password: string) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { login: who, password } });

  it('lets no stale desk session set a first password and sign in afresh with it', async () => {
    // An admin who signs in by email has no password: every admin in production.
    await syncMembersFromEnv('boss@gmail.com:Эзэн:admin');
    const stale = await byEmail('boss@gmail.com');
    expect((await me(stale)).json().member.role).toBe('admin');
    clock.advanceMinutes(13 * 60);
    expect((await me(stale)).json().error.code).toBe('SIGN_IN_AGAIN');

    // Nor is the code a first password takes sent: the letter is the first half of setting one.
    const letters = mailer.sent.length;
    const code = await app.inject({ method: 'POST', url: '/v1/me/password/code', headers: bearer(stale) });
    expect(code.statusCode).toBe(401);
    expect(code.json().error.code).toBe('SIGN_IN_AGAIN');
    expect(mailer.sent).toHaveLength(letters);

    const set = await setPassword(stale, { next: 'миний шинэ нууц үг' });
    expect(set.statusCode).toBe(401);
    expect(set.json().error.code).toBe('SIGN_IN_AGAIN');
    expect(set.json().error.message_mn).toContain('дахин нэвтэр');
    expect((await login('boss@gmail.com', 'миний шинэ нууц үг')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(stale) })).json().has_password).toBe(false);
  });

  it('lets no stale desk session tie an address of its holder’s to the account', async () => {
    // A seat an SMS code proved: no password, no address.
    await upsertMember({ phone: '+97699001100', name: 'Санхүү', role: 'finance' });
    const stale = await bySms('+97699001100');
    expect((await me(stale)).json().member.role).toBe('finance');
    clock.advanceMinutes(13 * 60);

    const asked = await askAttachCode(stale, { email: 'thief@evil.test' });
    expect(asked.statusCode).toBe(401);
    expect(asked.json().error.code).toBe('SIGN_IN_AGAIN');
    expect(mailer.to('thief@evil.test')).toBeUndefined();
    // Nor with a code the public door sends to any inbox for the asking.
    await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'thief@evil.test' } });
    const code = mailer.codeFor('thief@evil.test');
    const tied = await attach(stale, 'thief@evil.test', code);
    expect(tied.statusCode).toBe(401);
    expect(tied.json().error.code).toBe('SIGN_IN_AGAIN');
    // Signed in with it at that address, the thief is somebody else, with no seat.
    const theirs = await app.inject({ method: 'POST', url: '/v1/auth/email/verify', payload: { email: 'thief@evil.test', code } });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect((await me(theirs.json().token)).json().error.code).toBe('UNAUTHORIZED');
  });

  it('asks a stale desk session with a password to sign in again too, and a recent one nothing', async () => {
    const person = await byPhone('+97699110001', 'Болд');
    expect((await seat({ guest_id: person.id, role: 'ops' })).statusCode).toBe(201);
    // Signed in a moment ago, the seat changes its password knowing the old one, as anybody does.
    expect((await setPassword(person.token, { current: 'миний нууц үг', next: 'дараагийн нууц үг' })).statusCode).toBe(200);

    clock.advanceMinutes(13 * 60);
    for (const refused of [
      await setPassword(person.token, { current: 'дараагийн нууц үг', next: 'гурав дахь нууц үг' }),
      await askAttachCode(person.token, { email: 'thief@evil.test', password: 'дараагийн нууц үг' }),
      // A code the door sent to any inbox proves nothing about this account: without the rule it would tie it.
      await (async () => {
        await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'thief@evil.test' } });
        return attach(person.token, 'thief@evil.test', mailer.codeFor('thief@evil.test'));
      })(),
    ]) {
      expect(refused.statusCode, refused.body).toBe(401);
      expect(refused.json().error.code).toBe('SIGN_IN_AGAIN');
    }
    const profile = (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(person.token) })).json();
    expect(profile.email).toBeNull();
    expect((await login('+97699110001', 'дараагийн нууц үг')).statusCode).toBe(200);
  });

  it('leaves an account with no seat its sixty days for its own ways in', async () => {
    const person = await byPhone('+97699110002', 'Сараа');
    clock.advanceMinutes(13 * 60);
    expect((await setPassword(person.token, { current: 'миний нууц үг', next: 'дараагийн нууц үг' })).statusCode).toBe(200);
    expect((await askAttachCode(person.token, { email: 'saraa@gmail.com', password: 'дараагийн нууц үг' })).statusCode).toBe(202);
    const tied = await attach(person.token, 'saraa@gmail.com', mailer.codeFor('saraa@gmail.com'));
    expect(tied.statusCode, tied.body).toBe(200);
    expect(tied.json().email).toBe('saraa@gmail.com');
  });

  it('gives a retried seat back to the admin who gave it, and to nobody who only has the key', async () => {
    const person = await byPhone('+97699110002', 'Цэцэг');
    const payload = { guest_id: person.id, role: 'ops' };
    const key = { 'idempotency-key': 'seat-tap' };
    const given = await app.inject({ method: 'POST', url: '/v1/ops/members', headers: { ...desk(), ...key }, payload });
    expect(given.statusCode, given.body).toBe(201);

    // The key alone, with no session: the desk's own answer to that, not the admin's.
    const nobody = await app.inject({ method: 'POST', url: '/v1/ops/members', headers: key, payload });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.body).not.toContain(given.json().id);
    // Signed in, but not at the desk: the same.
    const outsider = await byPhone('+97699110003', 'Хөндлөнгийн');
    const refused = await app.inject({ method: 'POST', url: '/v1/ops/members', headers: { ...bearer(outsider.token), ...key }, payload });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain(given.json().id);

    const again = await app.inject({ method: 'POST', url: '/v1/ops/members', headers: { ...desk(), ...key }, payload });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json().id).toBe(given.json().id);
  });
});
