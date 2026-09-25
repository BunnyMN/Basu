import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { upsertMember } from '../ops/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * What each person is shown, and what the server lets them do — the same
 * list, asked two ways.
 *
 * The cases are the people a real business has: the butcher's staff who
 * must never meet a menu or the money, the accountant who reads the money
 * and presses nothing, the restaurant that has no stall, the owner who
 * handed the business on and so holds nothing any more, and the desk's
 * finance who has no business in the kitchens.
 */

let app: FastifyInstance;
let ctx: Ctx;
let notifier: FakeNotifier;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => bearer(opsToken()!);
const PASSWORD = 'нууц үг 1234';

beforeEach(async () => {
  await truncateAll();
  notifier = new FakeNotifier();
  ctx = { clock: new VirtualClock(at('11:40')), payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
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

async function person(phone: string, name: string): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD, name } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().token as string;
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

async function aBusiness(owner: string, name: string, kinds: { supplier?: boolean; restaurant?: boolean }): Promise<string> {
  const made = await call('POST', '/v1/orgs', owner, { name, ...kinds, phone: '8811 0001', address: 'Нарантуул, 3-р хаалга' });
  expect(made.statusCode, made.body).toBe(201);
  const yes = await app.inject({ method: 'POST', url: `/v1/ops/orgs/${made.json().id}/approve`, headers: desk() });
  expect(yes.statusCode, yes.body).toBe(200);
  return made.json().id as string;
}

async function bringIn(orgId: string, by: string, phone: string, role: string) {
  const found = await call('GET', `/v1/orgs/${orgId}/lookup?contact=${encodeURIComponent(phone)}`, by);
  expect(found.statusCode, found.body).toBe(200);
  const added = await call('POST', `/v1/orgs/${orgId}/members`, by, { guest_id: found.json().guest_id, role });
  expect(added.statusCode, added.body).toBe(201);
  return found.json().guest_id as string;
}

type Menu = Array<{ key: string; label: string | null; items: Array<{ key: string; href?: string }> }>;
const pages = (menu: Menu) => menu.flatMap((g) => g.items.map((i) => i.key));
const access = async (token: string) => {
  const res = await call('GET', '/v1/access', token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    account: { id: string } | null;
    workspaces: Array<{ id: string; kind: string; name: string; sub: string; role: string | null; permissions: string[]; menu: Menu }>;
  };
};

describe('somebody who has only just signed in', () => {
  it('has their own corner and nothing else', async () => {
    const who = await person('+97699120001', 'Шинэ');
    const seen = await access(who);
    expect(seen.workspaces.map((w) => w.kind)).toEqual(['me']);
    expect(pages(seen.workspaces[0]!.menu)).toEqual(['home', 'profile']);
    expect(seen.workspaces[0]!.name).toBe('Шинэ');
  });

  it('is nobody to the endpoint without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/access' })).statusCode).toBe(401);
  });
});

describe('a supplier that sells only идэш', () => {
  it('shows its staff the day and the stall, never the money or a menu — and the server agrees', async () => {
    const owner = await person('+97699120001', 'Дорж');
    const staff = await person('+97699120003', 'Бат');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    await bringIn(orgId, owner, '99120003', 'staff');

    const mine = (await access(staff)).workspaces.find((w) => w.id === orgId)!;
    expect(mine.sub).toBe('Нийлүүлэгч · Ажилтан');
    expect(pages(mine.menu)).toEqual(['home', 'idesh.today', 'idesh.orders', 'idesh.stall', 'idesh.profile', 'team', 'profile', 'roles']);
    expect(mine.menu.map((g) => g.label)).not.toContain('Хоол');
    expect(mine.permissions).not.toContain('org.idesh.money');

    // The doors behind the pages it does not show stay shut.
    expect((await call('GET', '/v1/supplier/money', staff)).statusCode).toBe(403);
    expect((await call('GET', `/v1/orgs/${orgId}/log`, staff)).statusCode).toBe(403);
    // And the pages it does show leave the money out.
    await call('PATCH', '/v1/supplier/profile', owner, { bank_name: 'Хаан банк', bank_account: '5012345678', bank_holder: 'Д. Дорж', password: PASSWORD });
    const profile = (await call('GET', '/v1/supplier/profile', staff)).json();
    expect(profile).toMatchObject({ name: 'Хэрлэн мах', bank_account: null, bank_name: null, commission_pct: null });
    expect((await call('GET', '/v1/supplier/profile', owner)).json().bank_account).toBe('5012345678');
    const home = (await call('GET', '/v1/supplier/home', staff)).json();
    expect(home.season).toMatchObject({ revenue_mnt: null, payout_mnt: null, forfeit_mnt: null });
    expect(typeof (await call('GET', '/v1/supplier/home', owner)).json().season.revenue_mnt).toBe('number');

    // What the supplier's own page asks before drawing its tabs.
    const me = (await call('GET', '/v1/supplier/me', staff)).json().supplier;
    expect(me).toMatchObject({ role: 'staff', org_id: orgId });
    expect(me.permissions).toContain('org.idesh.orders:act');
    expect(me.permissions).not.toContain('org.idesh.money');
  });

  it('shows its accountant the money and the orders, and keeps the counter and the stall shut', async () => {
    const owner = await person('+97699120001', 'Дорж');
    const accountant = await person('+97699120004', 'Туяа');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    await bringIn(orgId, owner, '99120004', 'accountant');

    const mine = (await access(accountant)).workspaces.find((w) => w.id === orgId)!;
    expect(pages(mine.menu)).toEqual(['home', 'idesh.orders', 'idesh.money', 'idesh.profile', 'team', 'profile', 'roles']);
    expect((await call('GET', '/v1/supplier/money', accountant)).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/orders', accountant)).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/board', accountant)).statusCode).toBe(403);
    expect((await call('GET', '/v1/supplier/listings', accountant)).statusCode).toBe(403);
    expect((await call('POST', '/v1/supplier/orders/00000000-0000-0000-0000-000000000000/prepare', accountant)).statusCode).toBe(403);
  });
});

describe('a restaurant', () => {
  it('has a menu and no stall, and the supplier’s doors do not open to it', async () => {
    const owner = await person('+97699120001', 'Сараа');
    const orgId = await aBusiness(owner, 'Алтан тогоо', { restaurant: true });
    const mine = (await access(owner)).workspaces.find((w) => w.id === orgId)!;
    expect(mine.sub).toBe('Ресторан · Эзэн');
    expect(pages(mine.menu)).toEqual(['home', 'dine.orders', 'dine.menu', 'dine.kitchen', 'dine.money', 'team', 'profile', 'roles', 'log']);
    expect(mine.permissions.some((p) => p.startsWith('org.idesh.'))).toBe(false);
    expect((await call('GET', '/v1/supplier/board', owner, undefined, { 'x-basu-org': orgId })).statusCode).toBe(403);
    expect((await call('GET', '/v1/supplier/me', owner)).json().supplier).toBeNull();
  });
});

describe('somebody who works at two businesses', () => {
  it('works at the one the page has open, and only at the ones they are in', async () => {
    const one = await person('+97699120001', 'Дорж');
    const two = await person('+97699120002', 'Болд');
    const both = await person('+97699120005', 'Оюун');
    const first = await aBusiness(one, 'Хэрлэн мах', { supplier: true });
    const second = await aBusiness(two, 'Туул мах', { supplier: true });
    await bringIn(first, one, '99120005', 'staff');
    await bringIn(second, two, '99120005', 'manager');
    const stranger = await aBusiness(await person('+97699120009', 'Гадны'), 'Гадны мах', { supplier: true });

    const seen = await access(both);
    expect(seen.workspaces.filter((w) => w.kind === 'org').map((w) => `${w.name}:${w.role}`).sort()).toEqual(['Туул мах:manager', 'Хэрлэн мах:staff']);

    const at = (orgId: string) => ({ 'x-basu-org': orgId });
    expect((await call('GET', '/v1/supplier/me', both, undefined, at(first))).json().supplier).toMatchObject({ name: 'Хэрлэн мах', role: 'staff' });
    expect((await call('GET', '/v1/supplier/me', both, undefined, at(second))).json().supplier).toMatchObject({ name: 'Туул мах', role: 'manager' });
    // The manager's money at one is not the staff's at the other.
    expect((await call('GET', '/v1/supplier/money', both, undefined, at(second))).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/money', both, undefined, at(first))).statusCode).toBe(403);
    // A business they are not in is a refusal, not somebody else's stall.
    expect((await call('GET', '/v1/supplier/board', both, undefined, at(stranger))).statusCode).toBe(403);
    // Without saying which, the one where they hold the most.
    expect((await call('GET', '/v1/supplier/me', both)).json().supplier).toMatchObject({ name: 'Туул мах', role: 'manager' });
  });
});

describe('an owner who hands the business on', () => {
  it('holds only what the organisation now says, whatever the supplier row remembers', async () => {
    const founder = await person('+97699120001', 'Дорж');
    const heir = await person('+97699120002', 'Болд');
    const orgId = await aBusiness(founder, 'Хэрлэн мах', { supplier: true });
    const heirId = await bringIn(orgId, founder, '99120002', 'owner');
    const founderId = (await access(founder)).account!.id;
    // The heir makes the founder a manager.
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${founderId}`, heir, { role: 'manager' })).statusCode).toBe(200);

    expect((await call('GET', '/v1/supplier/me', founder)).json().supplier.role).toBe('manager');
    const change = { bank_name: 'Хаан банк', bank_account: '5099999999', bank_holder: 'Д. Дорж', password: PASSWORD };
    expect((await call('PATCH', '/v1/supplier/profile', founder, change)).statusCode).toBe(403);
    // The owner now is the heir, and it is their own password that proves it.
    expect((await call('PATCH', '/v1/supplier/profile', heir, { ...change, password: 'буруу нууц үг' })).json().error.code).toBe('BAD_PASSWORD');
    expect((await call('PATCH', '/v1/supplier/profile', heir, change)).statusCode).toBe(200);

    // Taken out altogether, the founder is nobody at the supplier.
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${founderId}`, heir)).statusCode).toBe(204);
    expect((await call('GET', '/v1/supplier/me', founder)).json().supplier).toBeNull();
    expect((await call('GET', '/v1/supplier/board', founder)).statusCode).toBe(401);
    void heirId;
  });
});

describe('the record of who holds what', () => {
  it('says who brought whom in as what, who changed it, and who left — newest first', async () => {
    const owner = await person('+97699120001', 'Дорж');
    await person('+97699120003', 'Бат');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    const bat = await bringIn(orgId, owner, '99120003', 'staff');
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${bat}`, owner, { role: 'accountant' })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${bat}`, owner)).statusCode).toBe(204);

    const log = (await call('GET', `/v1/orgs/${orgId}/log`, owner)).json().log;
    expect(log.map((e: { action: string; who: string | null; role: string | null; was: string | null }) => [e.action, e.who, e.role, e.was])).toEqual([
      ['removed', 'Бат', null, 'accountant'],
      ['role', 'Бат', 'accountant', 'staff'],
      ['added', 'Бат', 'staff', null],
      ['approved', null, null, null],
      ['registered', 'Дорж', 'owner', null],
    ]);
    expect(log[0].by).toBe('Дорж');
    expect(log[3].by).toMatch(/^Basu · /);
  });
});

describe('the table of roles', () => {
  it('lays out only the pages the business runs and the roles it may hand out, and says which the asker holds', async () => {
    const owner = await person('+97699120001', 'Дорж');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    const table = (await call('GET', `/v1/access/roles?org=${orgId}`, owner)).json();
    expect(table).toMatchObject({ scope: 'org', yours: 'owner', kinds: { supplier: true, restaurant: false } });
    expect(table.pages.some((p: { key: string }) => p.key.startsWith('dine.'))).toBe(false);
    const staff = table.roles.find((r: { key: string }) => r.key === 'staff');
    expect(staff.permissions).toContain('org.idesh.orders:act');
    expect(staff.permissions).not.toContain('org.dine.menu');
    expect(table.modules.map((m: { name: string }) => m.name)).toEqual(['Үндсэн', 'Идэш', 'Байгууллага']);

    const deskTable = (await call('GET', '/v1/access/roles?scope=desk', owner)).json();
    expect(deskTable.roles.map((r: { key: string }) => r.key)).toEqual(['admin', 'ops', 'finance', 'viewer']);
    expect(deskTable.roles[0]).toMatchObject({ locked: true, permissions: null });
    expect(deskTable.yours).toBeNull();
  });
});

describe('the desk', () => {
  /** A desk member, signed in with a code their phone received — the proof a seat needs. */
  async function member(phone: string, name: string, role: 'admin' | 'ops' | 'finance' | 'viewer'): Promise<string> {
    await upsertMember({ phone, name, role });
    await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
    const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
    const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json().token as string;
  }

  it('keeps finance out of the kitchens and ops out of the books, in the menu and at the door', async () => {
    const finance = await member('+97699000013', 'Санхүү', 'finance');
    const worker = await member('+97699000012', 'Ажилтан', 'ops');
    const viewer = await member('+97699000011', 'Харагч', 'viewer');

    const financeDesk = (await access(finance)).workspaces.find((w) => w.kind === 'desk')!;
    expect(financeDesk.sub).toBe('Ops · Санхүү');
    expect(financeDesk.menu.map((g) => g.label)).toEqual([null, 'Платформ', 'Идэш', 'Байгууллага', 'Удирдлага']);
    expect(pages(financeDesk.menu)).not.toContain('venues');
    expect((await call('GET', '/v1/ops/dine/restaurants', finance)).statusCode).toBe(403);
    expect((await call('GET', '/v1/ops/notify/messages', finance)).statusCode).toBe(403);
    expect((await call('GET', '/v1/ops/money', finance)).statusCode).toBe(200);

    expect(pages((await access(worker)).workspaces.find((w) => w.kind === 'desk')!.menu)).not.toContain('money');
    expect((await call('GET', '/v1/ops/money', worker)).statusCode).toBe(403);
    expect((await call('GET', '/v1/ops/dine/restaurants', worker)).statusCode).toBe(200);

    // A viewer reads the books and runs nothing.
    expect((await call('GET', '/v1/ops/money', viewer)).statusCode).toBe(200);
    expect((await call('POST', '/v1/ops/money/checks', viewer)).statusCode).toBe(403);
    expect((await call('PUT', '/v1/ops/system/settings/desk_banner', viewer, { value: 'x' })).statusCode).toBe(403);
  });

  it('opens the demo’s shared secret as one admin with no account behind it', async () => {
    const seen = (await app.inject({ method: 'GET', url: '/v1/access', headers: desk() })).json();
    expect(seen.account).toBeNull();
    expect(seen.workspaces).toHaveLength(1);
    expect(seen.workspaces[0]).toMatchObject({ id: 'desk', kind: 'desk', role: 'admin' });
    expect(pages(seen.workspaces[0].menu)).toContain('members');
  });

  it('puts a member’s own businesses beside the desk', async () => {
    const admin = await member('+97699000010', 'Админ', 'admin');
    await aBusiness(admin, 'Админы мах', { supplier: true });
    expect((await access(admin)).workspaces.map((w) => w.kind)).toEqual(['me', 'desk', 'org']);
  });
});
