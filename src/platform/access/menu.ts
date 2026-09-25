import type { Grants, OrgModule, Permission } from './policy.js';

/**
 * The dashboard's menu, drawn from the same permissions the routes check.
 *
 * A page is in the menu only if the person may open it, and a group only if
 * something in it is left — so a supplier's staff see the day's orders and
 * the stall, and no money, no menu, no desk. The page draws whatever this
 * returns and nothing else; there is no second list in the browser to fall
 * out of step with this one.
 */

export interface MenuItem {
  /** The page's name, unique within its workspace. */
  key: string;
  label: string;
  /** An icon the pages know by name. */
  icon: string;
  /** Set when another page of the site draws it — the supplier's own, say — with the tab to open there. */
  href?: string;
}

export interface MenuGroup {
  key: string;
  /** Null for the group at the top that needs no heading. */
  label: string | null;
  items: MenuItem[];
}

interface Entry {
  key: string;
  label: string;
  icon: string;
  needs: Permission | null;
  /** A tab of the supplier's page rather than a page of the dashboard. */
  supplierTab?: string;
}

interface Group {
  key: string;
  label: string | null;
  module?: OrgModule;
  entries: Entry[];
}

const e = (key: string, label: string, icon: string, needs: Permission | null, supplierTab?: string): Entry => ({
  key,
  label,
  icon,
  needs,
  ...(supplierTab ? { supplierTab } : {}),
});

/** Basu's own desk: the whole house, one group per part of it. */
const DESK: Group[] = [
  { key: 'main', label: null, entries: [e('overview', 'Самбар', 'overview', 'desk.overview')] },
  {
    key: 'platform',
    label: 'Платформ',
    entries: [
      e('guests', 'Зочид', 'guests', 'desk.guests.view'),
      e('money', 'Мөнгө', 'money', 'desk.money.view'),
      e('notify', 'Мэдэгдэл', 'notify', 'desk.notify.view'),
    ],
  },
  {
    key: 'dine',
    label: 'Хоол',
    entries: [
      e('venues', 'Ресторан', 'venues', 'desk.dine.view'),
      e('lunches', 'Захиалга', 'lunches', 'desk.dine.view'),
      e('reviews', 'Үнэлгээ', 'reviews', 'desk.dine.view'),
    ],
  },
  {
    key: 'idesh',
    label: 'Идэш',
    entries: [
      e('stats', 'Тоон үзүүлэлт', 'stats', 'desk.idesh.view'),
      e('orders', 'Захиалгууд', 'orders', 'desk.idesh.view'),
      e('suppliers', 'Нийлүүлэгчид', 'suppliers', 'desk.idesh.view'),
      e('pay', 'Олголт, буцаалт', 'pay', 'desk.payouts.view'),
    ],
  },
  { key: 'business', label: 'Байгууллага', entries: [e('orgs', 'Байгууллагууд', 'org', 'desk.orgs.view')] },
  {
    key: 'admin',
    label: 'Удирдлага',
    entries: [
      e('members', 'Гишүүд, эрх', 'members', 'desk.members.manage'),
      e('system', 'Систем', 'system', 'desk.system.view'),
      e('audit', 'Үйлдлийн түүх', 'audit', 'desk.audit.view'),
    ],
  },
];

/**
 * A business: its own front page, the modules of what it is, and the
 * business itself — its people, its details, who may do what, and the
 * record of who changed that.
 */
const ORG: Group[] = [
  { key: 'main', label: null, entries: [e('home', 'Нүүр', 'overview', 'org.view')] },
  {
    key: 'idesh',
    label: 'Идэш',
    module: 'idesh',
    entries: [
      e('idesh.today', 'Өнөөдөр', 'today', 'idesh.board', 'today'),
      e('idesh.orders', 'Захиалга', 'orders', 'idesh.orders.view', 'orders'),
      e('idesh.stall', 'Зар', 'stall', 'idesh.listings.view', 'stall'),
      e('idesh.money', 'Мөнгө', 'pay', 'idesh.money.view', 'money'),
      e('idesh.profile', 'Профайл', 'person', 'org.view', 'profile'),
    ],
  },
  {
    key: 'dine',
    label: 'Хоол',
    module: 'dine',
    entries: [
      e('dine.orders', 'Захиалга', 'lunches', 'dine.orders.view'),
      e('dine.menu', 'Цэс', 'menu', 'dine.menu.view'),
      e('dine.kitchen', 'Гал тогоо', 'kitchen', 'dine.kitchen'),
      e('dine.money', 'Мөнгө', 'pay', 'dine.money.view'),
    ],
  },
  {
    key: 'org',
    label: 'Байгууллага',
    entries: [
      e('team', 'Ажилтнууд', 'members', 'org.team.view'),
      e('profile', 'Мэдээлэл', 'org', 'org.view'),
      e('roles', 'Эрхүүд', 'shield', 'org.view'),
      e('log', 'Түүх', 'audit', 'org.log.view'),
    ],
  },
];

/** A person's own corner: always there, whatever else they sit in. */
const ME: Group[] = [
  {
    key: 'main',
    label: null,
    entries: [e('home', 'Нүүр', 'overview', null), e('profile', 'Профайл', 'person', null)],
  },
];

function build(groups: Group[], grants: Grants, opts: { modules?: readonly OrgModule[]; orgId?: string } = {}): MenuGroup[] {
  return groups
    .filter((g) => !g.module || (opts.modules ?? []).includes(g.module))
    .map((g) => ({
      key: g.key,
      label: g.label,
      items: g.entries
        .filter((x) => x.needs === null || grants.has(x.needs))
        .map((x) => ({
          key: x.key,
          label: x.label,
          icon: x.icon,
          ...(x.supplierTab ? { href: `/supplier?org=${opts.orgId}#${x.supplierTab}` } : {}),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

export const deskMenu = (grants: Grants): MenuGroup[] => build(DESK, grants);

/**
 * A business's menu. An organisation still waiting for the desk, or turned
 * down, has no modules to open yet — only its front page, which says so.
 */
export function orgMenu(grants: Grants, opts: { orgId: string; modules: readonly OrgModule[]; active: boolean }): MenuGroup[] {
  if (!opts.active) return [{ key: 'main', label: null, items: [{ key: 'home', label: 'Нүүр', icon: 'overview' }] }];
  return build(ORG, grants, opts);
}

export const meMenu = (grants: Grants): MenuGroup[] => build(ME, grants);

/** Every page key a menu opens — what a route may check a deep link against. */
export const pagesOf = (menu: MenuGroup[]): string[] => menu.flatMap((g) => g.items.map((i) => i.key));
