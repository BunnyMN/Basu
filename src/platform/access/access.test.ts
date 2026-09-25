import { describe, expect, it } from 'vitest';
import {
  DESK_ROLES,
  ORG_ROLES,
  PERMISSIONS,
  deskGrants,
  deskMenu,
  mayAssign,
  modulesOf,
  orgGrants,
  orgMenu,
  pagesOf,
  type OrgModule,
  type Permission,
} from './index.js';

/**
 * The whole table, pinned.
 *
 * Each case is a person a real business will have — the butcher's staff,
 * the restaurant's manager, the accountant who does both — and what the
 * dashboard must, and must not, put in front of them. A change to the table
 * that breaks one of these is a decision, and belongs in the commit that
 * makes it.
 */

const org = (role: string, modules: OrgModule[], active = true) =>
  pagesOf(orgMenu(orgGrants(role, modules), { orgId: 'o1', modules, active }));
const desk = (role: string) => pagesOf(deskMenu(deskGrants(role)));

describe('a supplier that sells only идэш', () => {
  it('shows its staff the day’s work and the stall — not the money, and no menu at all', () => {
    const pages = org('staff', ['idesh']);
    expect(pages).toEqual(['home', 'idesh.today', 'idesh.orders', 'idesh.stall', 'idesh.profile', 'team', 'profile', 'roles']);
    expect(pages).not.toContain('idesh.money');
    expect(pages.some((p) => p.startsWith('dine.'))).toBe(false);
    expect(orgGrants('staff', ['idesh']).has('dine.menu.view')).toBe(false);
  });

  it('shows its accountant the orders and the money, and nothing to press', () => {
    const grants = orgGrants('accountant', ['idesh']);
    expect(org('accountant', ['idesh'])).toEqual(['home', 'idesh.orders', 'idesh.money', 'idesh.profile', 'team', 'profile', 'roles']);
    expect(grants.has('idesh.orders.act')).toBe(false);
    expect(grants.has('idesh.listings.edit')).toBe(false);
    expect(grants.has('org.profile.edit')).toBe(false);
  });

  it('gives a manager the day and the people, and keeps managers and the bank for the owner', () => {
    const manager = orgGrants('manager', ['idesh']);
    expect(org('manager', ['idesh'])).toContain('log');
    expect(manager.has('org.team.manage')).toBe(true);
    expect(manager.has('org.managers.manage')).toBe(false);
    expect(manager.has('org.bank.manage')).toBe(false);
    expect(orgGrants('owner', ['idesh']).has('org.bank.manage')).toBe(true);
  });

  it('links its supplier pages to the supplier’s own screen, for this business', () => {
    const idesh = orgMenu(orgGrants('owner', ['idesh']), { orgId: 'o1', modules: ['idesh'], active: true }).find((g) => g.key === 'idesh')!;
    expect(idesh.items.find((i) => i.key === 'idesh.orders')?.href).toBe('/supplier?org=o1#orders');
  });
});

describe('a restaurant', () => {
  it('shows its staff the orders and the menu, never the kitchen screens or the money, and no stall', () => {
    const pages = org('staff', ['dine']);
    expect(pages).toEqual(['home', 'dine.orders', 'dine.menu', 'team', 'profile', 'roles']);
    expect(orgGrants('staff', ['dine']).has('dine.menu.edit')).toBe(false);
    expect(pages.some((p) => p.startsWith('idesh.'))).toBe(false);
  });

  it('lets its manager change the menu and pair the kitchen', () => {
    expect(org('manager', ['dine'])).toEqual(expect.arrayContaining(['dine.orders', 'dine.menu', 'dine.kitchen', 'dine.money']));
    expect(orgGrants('manager', ['dine']).has('dine.menu.edit')).toBe(true);
  });
});

describe('a business that is both', () => {
  it('opens both modules to its owner, each under its own heading', () => {
    const menu = orgMenu(orgGrants('owner', ['idesh', 'dine']), { orgId: 'o1', modules: ['idesh', 'dine'], active: true });
    expect(menu.map((g) => g.label)).toEqual([null, 'Идэш', 'Хоол', 'Байгууллага']);
  });
});

describe('a business still waiting for the desk', () => {
  it('opens only its front page, whatever the role', () => {
    expect(org('owner', ['idesh'], false)).toEqual(['home']);
  });
});

describe('what a business is decides what it runs', () => {
  it('reads the modules off what it registered as', () => {
    expect(modulesOf({ supplier: true, restaurant: false })).toEqual(['idesh']);
    expect(modulesOf({ supplier: false, restaurant: true })).toEqual(['dine']);
    expect(modulesOf({ supplier: true, restaurant: true })).toEqual(['idesh', 'dine']);
  });
});

describe('the desk', () => {
  it('shows an admin every part of the house', () => {
    expect(deskMenu(deskGrants('admin')).map((g) => g.label)).toEqual([null, 'Платформ', 'Хоол', 'Идэш', 'Байгууллага', 'Удирдлага']);
    expect(desk('admin')).toContain('members');
  });

  it('keeps finance to the money: no kitchens, no messages, no members', () => {
    const pages = desk('finance');
    expect(pages).toEqual(['overview', 'guests', 'money', 'stats', 'orders', 'suppliers', 'pay', 'orgs', 'audit']);
    expect(deskGrants('finance').has('desk.payouts.approve')).toBe(true);
    expect(deskGrants('finance').has('desk.idesh.manage')).toBe(false);
  });

  it('keeps ops to the work: no books, no members, no knobs', () => {
    const pages = desk('ops');
    expect(pages).not.toContain('money');
    expect(pages).not.toContain('members');
    expect(deskGrants('ops').has('desk.system.manage')).toBe(false);
    expect(deskGrants('ops').has('desk.payouts.approve')).toBe(false);
  });

  it('lets a viewer read everything a desk reads and press nothing', () => {
    const grants = deskGrants('viewer');
    expect(desk('viewer')).not.toContain('members');
    expect(grants.list().every((p) => p.endsWith('.view') || p === 'desk.overview')).toBe(true);
  });

  it('gives an unknown role nothing at all', () => {
    expect(deskGrants('owner').list()).toEqual([]);
    expect(orgGrants('admin', ['idesh', 'dine']).list()).toEqual([]);
    expect(deskGrants(null).list()).toEqual([]);
  });
});

describe('who may hand out which role', () => {
  it('lets the owner give any, a manager only staff and accountants, and the rest none', () => {
    for (const role of ORG_ROLES) expect(mayAssign('owner', role)).toBe(true);
    expect(ORG_ROLES.filter((r) => mayAssign('manager', r))).toEqual(['staff', 'accountant']);
    expect(ORG_ROLES.filter((r) => mayAssign('staff', r))).toEqual([]);
    expect(ORG_ROLES.filter((r) => mayAssign('accountant', r))).toEqual([]);
  });
});

describe('the table itself', () => {
  const all = Object.keys(PERMISSIONS) as Permission[];

  it('never crosses a desk permission into a business, or back', () => {
    for (const role of DESK_ROLES) expect(deskGrants(role).list().every((p) => PERMISSIONS[p].scope === 'desk')).toBe(true);
    for (const role of ORG_ROLES) expect(orgGrants(role, ['idesh', 'dine']).list().every((p) => PERMISSIONS[p].scope === 'org')).toBe(true);
  });

  it('names no permission that no role holds', () => {
    const held = new Set<Permission>([
      ...DESK_ROLES.flatMap((r) => deskGrants(r).list()),
      ...ORG_ROLES.flatMap((r) => orgGrants(r, ['idesh', 'dine']).list()),
    ]);
    expect(all.filter((p) => !held.has(p))).toEqual([]);
  });
});
