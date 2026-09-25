import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { syncMembersFromEnv, upsertMember } from '../ops/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { forgetRoles, truncateAll } from '../test/seed.js';
import { rolesOf } from '../platform/access/index.js';
import { opsToken } from './ops.js';
import { buildServer } from './server.js';

/**
 * Basu makes the roles and arranges the menu, and everybody's pages follow.
 *
 * What has to hold: a role Basu writes opens exactly the pages and actions
 * ticked in it — in the menu and at the door alike; a business hands out
 * only the roles open to it, and nobody there hands out more than they
 * hold; a page moved, renamed or hidden, a module added, a link added, show
 * in the menu at once; and the desk cannot lock itself out — the admin role
 * stays whole, a built-in role stays, a role somebody holds stays.
 */

let app: FastifyInstance;
let ctx: Ctx;
let notifier: FakeNotifier;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const DESK = () => opsToken()!;
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

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

async function person(phone: string, name: string): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD, name } });
  expect(made.statusCode, made.body).toBe(201);
  return made.json().token as string;
}

/** A desk member in `role`, signed in with a code their phone received — the proof a seat needs. */
async function member(phone: string, name: string, role: string): Promise<string> {
  await upsertMember({ phone, name, role });
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  return verified.json().token as string;
}

async function aBusiness(owner: string, name: string, kinds: { supplier?: boolean; restaurant?: boolean }): Promise<string> {
  const made = await call('POST', '/v1/orgs', owner, { name, ...kinds, phone: '8811 0001', address: 'Нарантуул, 3-р хаалга' });
  expect(made.statusCode, made.body).toBe(201);
  expect((await call('POST', `/v1/ops/orgs/${made.json().id}/approve`, DESK())).statusCode).toBe(200);
  return made.json().id as string;
}

async function found(orgId: string, by: string, phone: string): Promise<string> {
  const res = await call('GET', `/v1/orgs/${orgId}/lookup?contact=${encodeURIComponent(phone)}`, by);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().guest_id as string;
}

type Menu = Array<{ key: string; label: string | null; icon: string; items: Array<{ key: string; label: string; href?: string }> }>;
const pages = (menu: Menu) => menu.flatMap((g) => g.items.map((i) => i.key));
const workspace = async (token: string, id: string) => {
  const res = await call('GET', '/v1/access', token);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().workspaces as Array<{ id: string; permissions: string[]; menu: Menu }>).find((w) => w.id === id)!;
};

const LISTING = { kind: 'sheep', unit: 'whole', title: 'Хонь, бүтэн', price_mnt: 400_000, approx_kg: 35, quantity: 5, origin: 'Архангай', ready_from: '2026-10-01' };

describe('a role Basu makes at the desk', () => {
  it('opens exactly the pages ticked in it, in the menu and at the door', async () => {
    const made = await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Туслах', permissions: ['desk.overview', 'desk.guests', 'desk.orders'] });
    expect(made.statusCode, made.body).toBe(201);
    const key = made.json().key as string;
    const helper = await member('+97699130001', 'Туслах', key);

    const seat = await workspace(helper, 'desk');
    expect(pages(seat.menu)).toEqual(['overview', 'guests', 'orders']);
    expect((await call('GET', '/v1/ops/guests', helper)).statusCode).toBe(200);
    expect((await call('GET', '/v1/ops/orders', helper)).statusCode).toBe(200);
    expect((await call('GET', '/v1/ops/money', helper)).statusCode).toBe(403);
    // A page, but not the buttons on it.
    expect((await call('POST', '/v1/ops/guests/00000000-0000-0000-0000-000000000000/close', helper, { note: 'x' })).statusCode).toBe(403);

    // Ticking one more thing is one PATCH, and the next answer has it.
    expect((await call('PATCH', `/v1/ops/roles/desk/${key}`, DESK(), { permissions: ['desk.overview', 'desk.guests', 'desk.orders', 'desk.money'] })).statusCode).toBe(200);
    expect(pages((await workspace(helper, 'desk')).menu)).toContain('money');
    expect((await call('GET', '/v1/ops/money', helper)).statusCode).toBe(200);
  });

  it('carries an action only with its page, and refuses a permission the code does not have', async () => {
    const made = await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Цуцлагч', permissions: ['desk.orders:manage'] });
    const table = (await call('GET', '/v1/ops/access/desk', DESK())).json();
    expect(table.roles.find((r: { key: string }) => r.key === made.json().key).permissions.sort()).toEqual(['desk.orders', 'desk.orders:manage']);
    expect((await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Буруу', permissions: ['desk.nowhere'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Хоёр', permissions: ['org.home'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Цуцлагч', permissions: [] })).json().error.code).toBe('NAME_TAKEN');
  });
});

describe('the desk cannot lock itself out', () => {
  it('keeps the admin role whole, the built-in roles in place, and a role somebody holds', async () => {
    expect((await call('PATCH', '/v1/ops/roles/desk/admin', DESK(), { permissions: ['desk.overview'] })).json().error.code).toBe('LOCKED');
    expect((await call('DELETE', '/v1/ops/roles/org/staff', DESK())).json().error.code).toBe('BUILTIN');
    const key = (await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Шинэ', permissions: ['desk.overview'] })).json().key;
    await member('+97699130002', 'Нэг', key);
    expect((await call('DELETE', `/v1/ops/roles/desk/${key}`, DESK())).json().error.code).toBe('IN_USE');
    const unused = (await call('POST', '/v1/ops/roles/desk', DESK(), { name: 'Хоосон', permissions: [] })).json().key;
    expect((await call('DELETE', `/v1/ops/roles/desk/${unused}`, DESK())).statusCode).toBe(204);
  });

  it('lets nobody but the admin write into a role what they do not hold themselves', async () => {
    const hr = (await call('POST', '/v1/ops/roles/desk', DESK(), {
      name: 'Хүний нөөц',
      permissions: ['desk.members', 'desk.members:manage', 'desk.roles', 'desk.roles:manage'],
    })).json().key;
    const clerk = await member('+97699130003', 'Нарийн бичиг', hr);
    expect((await call('POST', '/v1/ops/roles/desk', clerk, { name: 'Мөнгөтэй', permissions: ['desk.money'] })).statusCode).toBe(403);
    expect((await call('POST', '/v1/ops/roles/desk', clerk, { name: 'Гишүүд', permissions: ['desk.members'] })).statusCode).toBe(201);
    // Nor seat anybody in a role that opens more than theirs — an admin least of all.
    expect((await call('POST', '/v1/ops/members', clerk, { email: 'friend@basu.mn', name: 'Найз', role: 'admin' })).statusCode).toBe(403);
    expect((await call('POST', '/v1/ops/members', clerk, { email: 'friend@basu.mn', name: 'Найз', role: 'finance' })).statusCode).toBe(403);
    expect((await call('POST', '/v1/ops/members', clerk, { email: 'friend@basu.mn', name: 'Найз', role: hr })).statusCode).toBe(201);
  });
});

describe('a business role Basu writes', () => {
  it('changes what everybody in it may do at once — a page kept, a button taken away', async () => {
    const owner = await person('+97699130011', 'Дорж');
    const staff = await person('+97699130013', 'Бат');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    await call('POST', `/v1/orgs/${orgId}/members`, owner, { guest_id: await found(orgId, owner, '99130013'), role: 'staff' });
    expect((await call('POST', '/v1/supplier/listings', staff, LISTING)).statusCode).toBe(201);

    const table = (await call('GET', '/v1/ops/access/org', DESK())).json();
    const was = table.roles.find((r: { key: string }) => r.key === 'staff').permissions as string[];
    expect((await call('PATCH', '/v1/ops/roles/org/staff', DESK(), { permissions: was.filter((p) => p !== 'org.idesh.stall:edit') })).statusCode).toBe(200);

    expect((await call('POST', '/v1/supplier/listings', staff, LISTING)).statusCode).toBe(403);
    expect((await call('GET', '/v1/supplier/listings', staff)).statusCode).toBe(200);
    expect(pages((await workspace(staff, orgId)).menu)).toContain('idesh.stall');
  });

  it('is handed out only where Basu opened it, and then only by somebody who holds as much', async () => {
    const owner = await person('+97699130021', 'Сараа');
    const manager = await person('+97699130022', 'Болд');
    const cashier = await person('+97699130023', 'Туяа');
    const orgId = await aBusiness(owner, 'Туул мах', { supplier: true });
    await call('POST', `/v1/orgs/${orgId}/members`, owner, { guest_id: await found(orgId, owner, '99130022'), role: 'manager' });

    const made = await call('POST', '/v1/ops/roles/org', DESK(), {
      name: 'Кассир',
      permissions: ['org.home', 'org.idesh.today', 'org.idesh.orders', 'org.idesh.orders:act'],
      everyone: false,
    });
    expect(made.statusCode, made.body).toBe(201);
    const key = made.json().key as string;
    const tuyaa = await found(orgId, owner, '99130023');

    // Not open to this business yet: nobody there may give it.
    expect((await call('POST', `/v1/orgs/${orgId}/members`, owner, { guest_id: tuyaa, role: key })).json().error.code).toBe('NO_SUCH_ROLE');
    expect((await call('GET', `/v1/orgs/${orgId}`, owner)).json().roles.some((r: { key: string }) => r.key === key)).toBe(false);

    // Basu opens it for this one business.
    expect((await call('PUT', `/v1/ops/orgs/${orgId}/roles`, DESK(), { keys: [key] })).json().chosen).toEqual([key]);
    const roles = (await call('GET', `/v1/orgs/${orgId}`, manager)).json().roles as Array<{ key: string; assignable: boolean }>;
    expect(roles.find((r) => r.key === key)?.assignable).toBe(true);
    expect(roles.find((r) => r.key === 'owner')?.assignable).toBe(false);
    expect(roles.find((r) => r.key === 'manager')?.assignable).toBe(false);

    expect((await call('POST', `/v1/orgs/${orgId}/members`, manager, { guest_id: tuyaa, role: key })).statusCode).toBe(201);
    const seat = await workspace(cashier, orgId);
    expect(pages(seat.menu)).toEqual(['home', 'idesh.today', 'idesh.orders']);
    expect((await call('GET', '/v1/supplier/board', cashier)).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/listings', cashier)).statusCode).toBe(403);

    // A role that reaches the bank is beyond a manager, whoever made it.
    const banker = (await call('POST', '/v1/ops/roles/org', DESK(), { name: 'Мөнгөчин', permissions: ['org.idesh.profile', 'org.idesh.profile:bank'] })).json().key;
    const fifth = await person('+97699130024', 'Оюун');
    void fifth;
    expect((await call('POST', `/v1/orgs/${orgId}/members`, manager, { guest_id: await found(orgId, owner, '99130024'), role: banker })).statusCode).toBe(403);
    expect((await call('POST', `/v1/orgs/${orgId}/members`, owner, { guest_id: await found(orgId, owner, '99130024'), role: banker })).statusCode).toBe(201);

    // The business's record says Basu changed what it may hand out.
    const log = (await call('GET', `/v1/orgs/${orgId}/log`, owner)).json().log as Array<{ action: string; role_name: string | null }>;
    expect(log.map((e) => e.action)).toContain('roles');
    expect(log.find((e) => e.action === 'added' && e.role_name === 'Кассир')).toBeTruthy();
  });

  it('lets the desk set anybody’s role at a business — its head too — and never leaves it without one', async () => {
    const owner = await person('+97699130031', 'Дорж');
    const staff = await person('+97699130033', 'Бат');
    const orgId = await aBusiness(owner, 'Хэрлэн мах', { supplier: true });
    const bat = await found(orgId, owner, '99130033');
    await call('POST', `/v1/orgs/${orgId}/members`, owner, { guest_id: bat, role: 'staff' });
    const dorj = (await call('GET', `/v1/orgs/${orgId}`, owner)).json().members.find((m: { you: boolean }) => m.you).guest_id;

    expect((await call('PATCH', `/v1/ops/orgs/${orgId}/members/${dorj}`, DESK(), { role: 'manager' })).json().error.code).toBe('LAST_OWNER');
    expect((await call('PATCH', `/v1/ops/orgs/${orgId}/members/${bat}`, DESK(), { role: 'owner' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/supplier/money', staff)).statusCode).toBe(200);
    const view = (await call('GET', `/v1/ops/orgs/${orgId}/access`, DESK())).json();
    expect(view.members.map((m: { role_name: string }) => m.role_name).sort()).toEqual(['Эзэн', 'Эзэн']);
  });
});

describe('a fresh server', () => {
  it('seats the desk named in its environment even before it has written its roles', async () => {
    // What production does at boot: the members from the environment first, the server after.
    await forgetRoles();
    expect(await syncMembersFromEnv('boss@basu.mn:Эзэн:admin')).toBe(1);
    expect((await rolesOf('desk')).map((r) => r.key)).toEqual(['admin', 'ops', 'finance', 'viewer']);
  });
});

describe('the menu Basu arranges', () => {
  it('moves, renames, hides and adds, and everybody’s menu follows at once', async () => {
    const worker = await member('+97699130041', 'Ops', 'ops');
    const layout = (await call('GET', '/v1/ops/access/desk', DESK())).json();
    expect(layout.all_modules.map((m: { key: string }) => m.key)).toEqual(['main', 'platform', 'dine', 'idesh', 'business', 'admin']);

    const report = (await call('POST', '/v1/ops/menus/desk/modules', DESK(), { name: 'Тайлан', icon: 'stats' })).json();
    const saved = await call('PUT', '/v1/ops/menus/desk', DESK(), {
      modules: [{ key: report.key, sort: 5 }],
      pages: [
        { key: 'stats', module: report.key },
        { key: 'guests', name: 'Хэрэглэгчид' },
        { key: 'notify', hidden: true },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const menu = (await workspace(worker, 'desk')).menu;
    expect(menu[1]).toMatchObject({ key: report.key, label: 'Тайлан', icon: 'stats' });
    expect(menu[1]!.items.map((i) => i.key)).toEqual(['stats']);
    expect(menu.flatMap((g) => g.items).find((i) => i.key === 'guests')?.label).toBe('Хэрэглэгчид');
    expect(pages(menu)).not.toContain('notify');
    // Hidden from the menu is not taken away: the page's route still answers the role.
    expect((await call('GET', '/v1/ops/notify/messages', worker)).statusCode).toBe(200);
    expect((await call('PUT', '/v1/ops/menus/desk', DESK(), { pages: [{ key: 'nowhere', hidden: true }] })).statusCode).toBe(400);
  });

  it('adds a link as a page of its own, opened only by the roles it is given', async () => {
    const worker = await member('+97699130042', 'Ops', 'ops');
    const link = await call('POST', '/v1/ops/menus/desk/links', DESK(), { name: 'Гарын авлага', href: 'https://basu.mn/help', module: 'admin' });
    expect(link.statusCode, link.body).toBe(201);
    const key = link.json().key as string;
    expect(pages((await workspace(worker, 'desk')).menu)).not.toContain(key);
    // The admin, who opens everything, has it at once.
    const admin = (await call('GET', '/v1/access', DESK())).json().workspaces[0];
    expect(admin.menu.flatMap((g: { items: Array<{ key: string; href?: string }> }) => g.items).find((i: { key: string }) => i.key === key)?.href).toBe('https://basu.mn/help');

    const ops = (await call('GET', '/v1/ops/access/desk', DESK())).json().roles.find((r: { key: string }) => r.key === 'ops');
    expect((await call('PATCH', '/v1/ops/roles/desk/ops', DESK(), { permissions: [...ops.permissions, `desk.${key}`] })).statusCode).toBe(200);
    expect(pages((await workspace(worker, 'desk')).menu)).toContain(key);

    expect((await call('DELETE', `/v1/ops/menus/desk/links/${key}`, DESK())).statusCode).toBe(204);
    expect(pages((await workspace(worker, 'desk')).menu)).not.toContain(key);
    const after = (await call('GET', '/v1/ops/access/desk', DESK())).json().roles.find((r: { key: string }) => r.key === 'ops');
    expect(after.permissions).not.toContain(`desk.${key}`);
    expect((await call('POST', '/v1/ops/menus/desk/links', DESK(), { name: 'Муу', href: 'javascript:alert(1)' })).statusCode).toBe(400);
  });

  it('is the desk’s to change only for a seat that holds the menu', async () => {
    const worker = await member('+97699130043', 'Ops', 'ops');
    expect((await call('PUT', '/v1/ops/menus/desk', worker, { pages: [{ key: 'guests', hidden: true }] })).statusCode).toBe(403);
    expect((await call('POST', '/v1/ops/roles/desk', worker, { name: 'Өөрийн', permissions: [] })).statusCode).toBe(403);
    expect((await call('GET', '/v1/ops/access/desk', worker)).statusCode).toBe(403);
  });
});
