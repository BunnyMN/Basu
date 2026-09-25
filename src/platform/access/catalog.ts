/**
 * Every page Basu's code can draw, and what can be done on each.
 *
 * Two places have pages: Basu's own desk (`desk`) and a business's
 * dashboard (`org`). A page is opened by its view permission — `desk.guests`
 * — and each thing that can be pressed on it by an action permission —
 * `desk.guests:close`. Roles are lists of these, made and edited by Basu
 * (see `store.ts`); the menu places these pages under modules, also as Basu
 * arranges them. What lives here is only what the code can do: a page that
 * is not in this list has nothing to draw it, and an action not named here
 * has no route that honours it.
 *
 * A business's page may belong to a kind of business: the идэш pages run
 * only at a supplier, the хоол pages only at a restaurant, whatever a role
 * says.
 */

export type Scope = 'desk' | 'org';
export type OrgKind = 'supplier' | 'restaurant';
export const SCOPES: readonly Scope[] = ['desk', 'org'];

export interface PageSpec {
  key: string;
  /** Where the page sits until Basu moves it. */
  module: string;
  name: string;
  icon: string;
  /** Each thing that can be done on the page, and what it lets a person do. */
  actions?: Record<string, string>;
  /** A business's page that runs only at a business of this kind. */
  kind?: OrgKind;
}

export interface ModuleSpec {
  key: string;
  /** Null for the top of the menu, whose pages need no heading. */
  name: string | null;
  icon: string;
  sort: number;
}

/** The top of every menu: pages that stand alone, above the modules. */
export const TOP = 'main';

/** The icons a module or a page may wear: every one the sidebar can draw (`src/web/sidenav.js`). */
export const ICONS = [
  'overview', 'home', 'layers', 'bowl', 'stall', 'org', 'settings', 'layout', 'link',
  'guests', 'members', 'person', 'money', 'pay', 'notify', 'system', 'venues', 'lunches', 'reviews',
  'stats', 'orders', 'suppliers', 'audit', 'shield', 'today', 'menu', 'kitchen', 'truck', 'tag', 'file',
] as const;

export const MODULES: Record<Scope, ModuleSpec[]> = {
  desk: [
    { key: TOP, name: null, icon: 'overview', sort: 0 },
    { key: 'platform', name: 'Платформ', icon: 'layers', sort: 10 },
    { key: 'dine', name: 'Хоол', icon: 'bowl', sort: 20 },
    { key: 'idesh', name: 'Идэш', icon: 'stall', sort: 30 },
    { key: 'business', name: 'Байгууллага', icon: 'org', sort: 40 },
    { key: 'admin', name: 'Удирдлага', icon: 'settings', sort: 50 },
  ],
  org: [
    { key: TOP, name: null, icon: 'overview', sort: 0 },
    { key: 'idesh', name: 'Идэш', icon: 'stall', sort: 10 },
    { key: 'dine', name: 'Хоол', icon: 'bowl', sort: 20 },
    { key: 'org', name: 'Байгууллага', icon: 'org', sort: 30 },
  ],
};

export const PAGES: Record<Scope, PageSpec[]> = {
  desk: [
    { key: 'overview', module: TOP, name: 'Самбар', icon: 'overview' },
    { key: 'guests', module: 'platform', name: 'Зочид', icon: 'guests', actions: { sessions: 'Алдсан утсыг бүртгэлээс гаргах', close: 'Зочны бүртгэл хаах' } },
    { key: 'money', module: 'platform', name: 'Мөнгө', icon: 'money', actions: { manage: 'Тулгалт хийх, CSV татах, баримт дахин илгээх' } },
    { key: 'notify', module: 'platform', name: 'Мэдэгдэл', icon: 'notify', actions: { retry: 'Мэдэгдэл дахин илгээх' } },
    { key: 'venues', module: 'dine', name: 'Ресторан', icon: 'venues', actions: { manage: 'Таблет холбох, цэснээс нуух, ресторан зогсоох' } },
    { key: 'lunches', module: 'dine', name: 'Захиалга', icon: 'lunches', actions: { manage: 'Зочны өмнөөс цуцлах, ирээгүй гэж тэмдэглэх' } },
    { key: 'reviews', module: 'dine', name: 'Үнэлгээ', icon: 'reviews' },
    { key: 'stats', module: 'idesh', name: 'Тоон үзүүлэлт', icon: 'stats' },
    { key: 'orders', module: 'idesh', name: 'Захиалгууд', icon: 'orders', actions: { manage: 'Цуцлах, хүлээлгэн өгөх, мэдэгдэл дахин илгээх' } },
    { key: 'suppliers', module: 'idesh', name: 'Нийлүүлэгчид', icon: 'suppliers', actions: { manage: 'Батлах, бүртгэх, зогсоох, код гаргах, зар нуух', terms: 'Шимтгэл, данс, дансны баталгаажуулалт' } },
    { key: 'pay', module: 'idesh', name: 'Олголт, буцаалт', icon: 'pay', actions: { approve: 'Олголт батлах, шилжүүлснийг тэмдэглэх' } },
    { key: 'orgs', module: 'business', name: 'Байгууллагууд', icon: 'org', actions: { decide: 'Бүртгэл батлах, татгалзах', access: 'Байгууллагад үүрэг оноох, ажилтных нь үүргийг өөрчлөх' } },
    { key: 'members', module: 'admin', name: 'Гишүүд', icon: 'members', actions: { manage: 'Гишүүн нэмэх, хаах, эрхийн хүсэлт шийдэх' } },
    { key: 'roles', module: 'admin', name: 'Үүрэг, эрх', icon: 'shield', actions: { manage: 'Үүрэг үүсгэх, засах, хуудас оноох' } },
    { key: 'menus', module: 'admin', name: 'Цэс', icon: 'layout', actions: { manage: 'Модуль, цэсний нэр, дараалал, байршил өөрчлөх' } },
    { key: 'system', module: 'admin', name: 'Систем', icon: 'system', actions: { manage: 'Системийн тохиргоо өөрчлөх' } },
    { key: 'audit', module: 'admin', name: 'Үйлдлийн түүх', icon: 'audit' },
  ],
  org: [
    { key: 'home', module: TOP, name: 'Нүүр', icon: 'overview' },
    { key: 'idesh.today', module: 'idesh', name: 'Өнөөдөр', icon: 'today', kind: 'supplier' },
    { key: 'idesh.orders', module: 'idesh', name: 'Захиалга', icon: 'orders', kind: 'supplier', actions: { act: 'Бэлтгэх, бэлэн болгох, хүлээлгэн өгөх, цуцлах' } },
    { key: 'idesh.stall', module: 'idesh', name: 'Зар', icon: 'stall', kind: 'supplier', actions: { edit: 'Зар нэмэх, засах, зогсоох' } },
    { key: 'idesh.money', module: 'idesh', name: 'Мөнгө', icon: 'pay', kind: 'supplier' },
    { key: 'idesh.profile', module: 'idesh', name: 'Профайл', icon: 'person', kind: 'supplier', actions: { edit: 'Нэр, мах авах цэг, тайлбар засах', bank: 'Мөнгө очих данс солих' } },
    { key: 'dine.orders', module: 'dine', name: 'Захиалга', icon: 'lunches', kind: 'restaurant', actions: { act: 'Захиалгыг гал тогоонд удирдах' } },
    { key: 'dine.menu', module: 'dine', name: 'Цэс', icon: 'menu', kind: 'restaurant', actions: { edit: 'Цэс засах, үнэ өөрчлөх' } },
    { key: 'dine.kitchen', module: 'dine', name: 'Гал тогоо', icon: 'kitchen', kind: 'restaurant' },
    { key: 'dine.money', module: 'dine', name: 'Мөнгө', icon: 'pay', kind: 'restaurant' },
    { key: 'team', module: 'org', name: 'Ажилтнууд', icon: 'members', actions: { manage: 'Ажилтан нэмэх, хасах, үүрэг өөрчлөх', heads: 'Эзэн болон ажилтан удирдах эрхтэй үүрэг оноох' } },
    { key: 'profile', module: 'org', name: 'Мэдээлэл', icon: 'org', actions: { edit: 'Байгууллагын мэдээлэл засах' } },
    { key: 'roles', module: 'org', name: 'Эрхүүд', icon: 'shield' },
    { key: 'log', module: 'org', name: 'Түүх', icon: 'audit' },
  ],
};

/** The permission that opens a page. */
export const view = (scope: Scope, page: string): string => `${scope}.${page}`;
/** The permission for one thing on a page. */
export const act = (scope: Scope, page: string, action: string): string => `${scope}.${page}:${action}`;

/** Which scope, page and action a permission names — or null when the code knows no such thing. */
export function parse(permission: string): { scope: Scope; page: string; action: string | null } | null {
  const m = /^(desk|org)\.([a-z][a-z0-9.-]*)(?::([a-z][a-z0-9-]*))?$/.exec(permission);
  if (!m) return null;
  return { scope: m[1] as Scope, page: m[2]!, action: m[3] ?? null };
}

export const pageSpec = (scope: Scope, key: string): PageSpec | undefined => PAGES[scope].find((p) => p.key === key);

/** Every permission the code of a scope honours, pages first then their actions, in catalogue order. */
export function permissionsOf(scope: Scope): string[] {
  return PAGES[scope].flatMap((p) => [view(scope, p.key), ...Object.keys(p.actions ?? {}).map((a) => act(scope, p.key, a))]);
}

/** Whether the code honours a permission: a page it draws, or an action one of them has. */
export function known(permission: string): boolean {
  const p = parse(permission);
  if (!p) return false;
  const spec = pageSpec(p.scope, p.page);
  return Boolean(spec && (p.action === null || (spec.actions && p.action in spec.actions)));
}

/**
 * A business's pages that run at a business of these kinds: its own pages
 * always, a supplier's only at a supplier, a restaurant's only at a
 * restaurant. The ceiling any role there lives under.
 */
export function orgCeiling(kinds: { supplier: boolean; restaurant: boolean }): Set<string> {
  const runs = (p: PageSpec) => !p.kind || (p.kind === 'supplier' ? kinds.supplier : kinds.restaurant);
  return new Set(PAGES.org.filter(runs).flatMap((p) => [view('org', p.key), ...Object.keys(p.actions ?? {}).map((a) => act('org', p.key, a))]));
}

/* ── the roles every server starts with ─────────────────────────────── */

export interface RoleSeed {
  scope: Scope;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  locked?: boolean;
  head?: boolean;
  sort: number;
}

const desk = (...keys: string[]) => keys.map((k) => `desk.${k}`);
const org = (...keys: string[]) => keys.map((k) => `org.${k}`);

/**
 * Where a fresh server starts. Every one of these is Basu's to change on the
 * roles page — except the desk's admin, which opens everything so that the
 * desk can never be locked out of itself. They are written once, when
 * missing, and never overwritten.
 */
export const BUILTIN_ROLES: RoleSeed[] = [
  {
    scope: 'desk',
    key: 'admin',
    name: 'Админ',
    description: 'Бүх хуудас, бүх үйлдэл. Үүрэг, цэс, гишүүдийг удирдана.',
    permissions: [],
    locked: true,
    sort: 0,
  },
  {
    scope: 'desk',
    key: 'ops',
    name: 'Ops',
    description: 'Өдөр тутмын ажил: захиалга, нийлүүлэгч, ресторан, байгууллага.',
    permissions: desk(
      'overview', 'guests', 'guests:sessions', 'notify', 'notify:retry', 'system',
      'venues', 'venues:manage', 'lunches', 'lunches:manage', 'reviews',
      'stats', 'orders', 'orders:manage', 'suppliers', 'suppliers:manage', 'pay',
      'orgs', 'orgs:decide', 'audit',
    ),
    sort: 10,
  },
  {
    scope: 'desk',
    key: 'finance',
    name: 'Санхүү',
    description: 'Мөнгө: дэвтэр, олголт, буцаалт, гэрээний данс.',
    permissions: desk('overview', 'guests', 'money', 'money:manage', 'stats', 'orders', 'suppliers', 'suppliers:terms', 'pay', 'pay:approve', 'orgs', 'audit'),
    sort: 20,
  },
  {
    scope: 'desk',
    key: 'viewer',
    name: 'Зөвхөн харах',
    description: 'Ажлын хуудсуудыг уншина, юу ч дардаггүй.',
    permissions: desk('overview', 'guests', 'money', 'notify', 'system', 'venues', 'lunches', 'reviews', 'stats', 'orders', 'suppliers', 'pay', 'orgs', 'audit'),
    sort: 30,
  },
  {
    scope: 'org',
    key: 'owner',
    name: 'Эзэн',
    description: 'Байгууллагын бүх зүйл, мөнгө очих данс, эзэн томилох.',
    permissions: permissionsOf('org'),
    head: true,
    sort: 0,
  },
  {
    scope: 'org',
    key: 'manager',
    name: 'Менежер',
    description: 'Өдрийн ажил, ажилтнууд, мэдээлэл. Данс, эзэн томилохгүй.',
    permissions: permissionsOf('org').filter((p) => p !== 'org.idesh.profile:bank' && p !== 'org.team:heads'),
    sort: 10,
  },
  {
    scope: 'org',
    key: 'staff',
    name: 'Ажилтан',
    description: 'Захиалга, зар, гал тогоо. Мөнгө харахгүй.',
    permissions: org(
      'home', 'idesh.today', 'idesh.orders', 'idesh.orders:act', 'idesh.stall', 'idesh.stall:edit', 'idesh.profile',
      'dine.orders', 'dine.orders:act', 'dine.menu', 'team', 'profile', 'roles',
    ),
    sort: 20,
  },
  {
    scope: 'org',
    key: 'accountant',
    name: 'Нягтлан',
    description: 'Мөнгө ба түүний эх болсон захиалгыг харна. Юу ч өөрчлөхгүй.',
    permissions: org('home', 'idesh.orders', 'idesh.money', 'idesh.profile', 'dine.orders', 'dine.money', 'team', 'profile', 'roles'),
    sort: 30,
  },
];

/**
 * What a screen paired to a supplier's counter may do: the day's work, the
 * stall and the money, as a manager would — never the bank, which takes a
 * person's password. A screen is not a person, so no role holds it.
 */
export const SCREEN_PERMISSIONS: readonly string[] = org(
  'idesh.today', 'idesh.orders', 'idesh.orders:act', 'idesh.stall', 'idesh.stall:edit', 'idesh.money', 'idesh.profile', 'idesh.profile:edit',
);

/** A supplier from before there were businesses, run by the one person whose it is: every supplier page. */
export const LONE_OWNER_PERMISSIONS: readonly string[] = PAGES.org
  .filter((p) => p.kind === 'supplier')
  .flatMap((p) => [view('org', p.key), ...Object.keys(p.actions ?? {}).map((a) => act('org', p.key, a))]);
