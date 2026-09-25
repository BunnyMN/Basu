import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  MODULES,
  PAGES,
  SCREEN_PERMISSIONS,
  TOP,
  buildMenu,
  grantsOf,
  known,
  mayHandOut,
  mayHandOutDesk,
  mayShape,
  orgGrantsOf,
  pagesOf,
  parse,
  permissionsOf,
  type Layout,
  type RoleShape,
} from './index.js';

/**
 * The rules that do not need a database: what a role opens, what a
 * business's kind leaves of it, who may hand out what, and how a menu is
 * drawn from a layout. The roles and the layout themselves are Basu's data
 * (see src/api/access.test.ts); here they are made up for each case.
 */

const role = (over: Partial<RoleShape> & Pick<RoleShape, 'scope' | 'permissions'>): RoleShape => ({
  key: 'r-test',
  name: 'Тест',
  locked: false,
  head: false,
  ...over,
});
const builtin = (scope: 'desk' | 'org', key: string): RoleShape => {
  const r = BUILTIN_ROLES.find((x) => x.scope === scope && x.key === key)!;
  return { scope, key, name: r.name, permissions: r.permissions, locked: Boolean(r.locked), head: Boolean(r.head) };
};
const supplier = { supplier: true, restaurant: false };
const restaurant = { supplier: false, restaurant: true };

/** The code's own layout — what a fresh server shows before Basu moves anything. */
const layoutOf = (scope: 'desk' | 'org'): Layout => ({
  modules: MODULES[scope].map((m) => ({ ...m })),
  pages: PAGES[scope].map((p, i) => ({ key: p.key, module: p.module, name: p.name, icon: p.icon, sort: (i + 1) * 10, hidden: false, href: null })),
});

describe('the catalogue', () => {
  it('names each page by its view and each thing on it by an action', () => {
    expect(parse('desk.guests')).toEqual({ scope: 'desk', page: 'guests', action: null });
    expect(parse('org.idesh.orders:act')).toEqual({ scope: 'org', page: 'idesh.orders', action: 'act' });
    expect(known('desk.guests:close')).toBe(true);
    expect(known('desk.guests:fly')).toBe(false);
    expect(known('org.nowhere')).toBe(false);
  });

  it('gives every built-in role only permissions the code honours', () => {
    for (const r of BUILTIN_ROLES) expect(r.permissions.filter((p) => !known(p))).toEqual([]);
    expect(SCREEN_PERMISSIONS.every(known)).toBe(true);
  });
});

describe('what a role opens', () => {
  it('opens everything of its scope when locked, links included', () => {
    const admin = grantsOf(builtin('desk', 'admin'), ['desk.link-abc123']);
    expect(permissionsOf('desk').every((p) => admin.has(p))).toBe(true);
    expect(admin.has('desk.link-abc123')).toBe(true);
    expect(admin.has('org.home')).toBe(false);
  });

  it('opens exactly its own list otherwise, less what the code no longer knows or another scope names', () => {
    const r = role({ scope: 'desk', permissions: ['desk.guests', 'desk.gone', 'org.home', 'desk.link-x'] });
    expect(grantsOf(r).list()).toEqual(['desk.guests']);
    expect(grantsOf(r, ['desk.link-x']).list().sort()).toEqual(['desk.guests', 'desk.link-x']);
  });

  it('leaves a butcher’s role no menu and a restaurant’s no stall, whatever the role says', () => {
    const staff = builtin('org', 'staff');
    expect(orgGrantsOf(staff, supplier).has('org.dine.menu')).toBe(false);
    expect(orgGrantsOf(staff, supplier).has('org.idesh.stall:edit')).toBe(true);
    expect(orgGrantsOf(staff, restaurant).has('org.idesh.stall')).toBe(false);
    expect(orgGrantsOf(staff, restaurant).has('org.dine.menu')).toBe(true);
    expect(orgGrantsOf(builtin('desk', 'ops'), supplier).list()).toEqual([]);
  });
});

describe('handing out a role at a business', () => {
  const owner = orgGrantsOf(builtin('org', 'owner'), supplier);
  const manager = orgGrantsOf(builtin('org', 'manager'), supplier);
  const staffGrants = orgGrantsOf(builtin('org', 'staff'), supplier);

  it('lets the owner hand out any role, head roles included', () => {
    for (const key of ['owner', 'manager', 'staff', 'accountant']) expect(mayHandOut(owner, builtin('org', key), supplier)).toBe(true);
  });

  it('keeps a manager to roles that open no more than a manager, and never a head or another manager', () => {
    expect(mayHandOut(manager, builtin('org', 'staff'), supplier)).toBe(true);
    expect(mayHandOut(manager, builtin('org', 'accountant'), supplier)).toBe(true);
    expect(mayHandOut(manager, builtin('org', 'manager'), supplier)).toBe(false);
    expect(mayHandOut(manager, builtin('org', 'owner'), supplier)).toBe(false);
    // A role Basu made that reaches the bank is beyond a manager, whatever it is called.
    const cashier = role({ scope: 'org', permissions: ['org.idesh.orders', 'org.idesh.profile', 'org.idesh.profile:bank'] });
    expect(mayHandOut(manager, cashier, supplier)).toBe(false);
    expect(mayHandOut(manager, role({ scope: 'org', permissions: ['org.idesh.orders', 'org.idesh.orders:act'] }), supplier)).toBe(true);
  });

  it('gives staff nobody to hand anything to', () => {
    expect(mayHandOut(staffGrants, builtin('org', 'staff'), supplier)).toBe(false);
  });

  it('judges a role by what it opens at this business, not by what it says elsewhere', () => {
    // The restaurant half of a role is nothing at a butcher's, so a manager may still hand it out there.
    const both = role({ scope: 'org', permissions: ['org.idesh.orders', 'org.dine.menu', 'org.dine.menu:edit'] });
    expect(mayHandOut(manager, both, supplier)).toBe(true);
  });
});

describe('seating somebody at the desk', () => {
  const admin = grantsOf(builtin('desk', 'admin'));
  const hr = grantsOf(role({ scope: 'desk', permissions: ['desk.members', 'desk.members:manage', 'desk.guests'] }));

  it('lets only the locked role seat somebody in it', () => {
    expect(mayHandOutDesk(admin, builtin('desk', 'admin'), [], true)).toBe(true);
    expect(mayHandOutDesk(hr, builtin('desk', 'admin'), [], false)).toBe(false);
  });

  it('keeps anybody else to roles within what they hold', () => {
    expect(mayHandOutDesk(hr, role({ scope: 'desk', permissions: ['desk.guests'] }))).toBe(true);
    expect(mayHandOutDesk(hr, builtin('desk', 'finance'))).toBe(false);
  });

  it('writes nothing into a role that its writer does not hold', () => {
    expect(mayShape(hr, ['desk.guests'])).toBe(true);
    expect(mayShape(hr, ['desk.money'])).toBe(false);
  });
});

describe('the menu', () => {
  it('draws the modules in Basu’s order with the pages the person may open, and drops a module left empty', () => {
    const finance = grantsOf(builtin('desk', 'finance'));
    const menu = buildMenu('desk', layoutOf('desk'), finance);
    expect(menu.map((g) => g.label)).toEqual([null, 'Платформ', 'Идэш', 'Байгууллага', 'Удирдлага']);
    expect(pagesOf(menu)).toEqual(['overview', 'guests', 'money', 'stats', 'orders', 'suppliers', 'pay', 'orgs', 'audit']);
    expect(menu.find((g) => g.key === 'idesh')?.icon).toBe('stall');
  });

  it('follows a page Basu moved, renamed or hid, and a module Basu put first', () => {
    const layout = layoutOf('desk');
    layout.modules.find((m) => m.key === 'admin')!.sort = 1;
    const guests = layout.pages.find((p) => p.key === 'guests')!;
    guests.module = 'admin';
    guests.name = 'Хэрэглэгчид';
    layout.pages.find((p) => p.key === 'notify')!.hidden = true;
    const menu = buildMenu('desk', layout, grantsOf(builtin('desk', 'admin')));
    expect(menu[0]!.key).toBe(TOP);
    expect(menu[1]!.key).toBe('admin');
    expect(menu[1]!.items.map((i) => i.label)).toContain('Хэрэглэгчид');
    expect(pagesOf(menu)).not.toContain('notify');
  });

  it('opens a supplier’s pages on the supplier’s screen for that business, and a link where Basu pointed it', () => {
    const layout = layoutOf('org');
    layout.pages.push({ key: 'link-help', module: 'org', name: 'Гарын авлага', icon: 'link', sort: 999, hidden: false, href: 'https://basu.mn/help' });
    // A link is opened like any page: by a role it was given to.
    const withLink = role({ scope: 'org', permissions: [...builtin('org', 'owner').permissions, 'org.link-help'] });
    const held = orgGrantsOf(withLink, supplier, ['org.link-help']);
    expect(orgGrantsOf(builtin('org', 'owner'), supplier, ['org.link-help']).has('org.link-help')).toBe(false);
    const menu = buildMenu('org', layout, held, { orgId: 'o1' });
    const items = menu.flatMap((g) => g.items);
    expect(items.find((i) => i.key === 'idesh.orders')?.href).toBe('/supplier?org=o1#orders');
    expect(items.find((i) => i.key === 'link-help')?.href).toBe('https://basu.mn/help');
    expect(menu.some((g) => g.key === 'dine')).toBe(false);
  });
});
