/**
 * Who may do what, in one place.
 *
 * Basu has two kinds of seat. At Basu's own desk a member is an admin, ops,
 * finance or a viewer, and sees the whole house through that role. In a
 * business — a restaurant, a supplier, or both — a member is its owner, a
 * manager, staff or its accountant, and sees only that business, and of it
 * only what the role reaches.
 *
 * Everything a person can open or press is a permission named here; a role
 * is a list of permissions; and a business runs only the modules of what it
 * is. So a butcher's staff never meet a menu, whatever their role would
 * allow at a restaurant, and an accountant reads the money without being
 * able to cancel anybody's sheep.
 *
 * The pages ask this module what to draw and the routes ask it what to
 * allow, so the menu a person sees and the doors the server opens are the
 * same list. Deny is the default: a permission no role names is nobody's.
 */

export type DeskRole = 'admin' | 'ops' | 'finance' | 'viewer';
export type OrgRole = 'owner' | 'manager' | 'staff' | 'accountant';

/** What a business is decides which of Basu's modules it runs. */
export type OrgModule = 'idesh' | 'dine';

interface Spec {
  /** Where the permission can hold at all. */
  scope: 'desk' | 'org';
  /** The module a business must run for it to mean anything; none is every business. */
  module?: OrgModule;
  /** What it lets a person do, as the roles page says it. */
  mn: string;
}

export const PERMISSIONS = {
  /* ── Basu's desk ── */
  'desk.overview': { scope: 'desk', mn: 'Самбар — бүх системийн тойм' },
  'desk.guests.view': { scope: 'desk', mn: 'Зочин хайх, файлыг нь харах' },
  'desk.guests.sessions': { scope: 'desk', mn: 'Алдсан утсыг бүртгэлээс гаргах' },
  'desk.guests.close': { scope: 'desk', mn: 'Зочны бүртгэл хаах' },
  'desk.money.view': { scope: 'desk', mn: 'Түрийвч, дансны бүртгэл харах' },
  'desk.money.manage': { scope: 'desk', mn: 'Тулгалт хийх, CSV татах, баримт дахин илгээх' },
  'desk.notify.view': { scope: 'desk', mn: 'Илгээсэн мэдэгдэл харах' },
  'desk.notify.retry': { scope: 'desk', mn: 'Мэдэгдэл дахин илгээх' },
  'desk.system.view': { scope: 'desk', mn: 'Системийн төлөв харах' },
  'desk.system.manage': { scope: 'desk', mn: 'Системийн тохиргоо өөрчлөх' },
  'desk.dine.view': { scope: 'desk', mn: 'Ресторан, хоолны захиалга, үнэлгээ харах' },
  'desk.dine.manage': { scope: 'desk', mn: 'Ресторан, таблет, цэс, хоолны захиалга удирдах' },
  'desk.idesh.view': { scope: 'desk', mn: 'Идэшний захиалга, нийлүүлэгч, тоо харах' },
  'desk.idesh.manage': { scope: 'desk', mn: 'Нийлүүлэгч батлах, захиалга цуцлах, зар нуух' },
  'desk.idesh.terms': { scope: 'desk', mn: 'Гэрээний шимтгэл, данс, дансны баталгаажуулалт' },
  'desk.payouts.view': { scope: 'desk', mn: 'Олголт, буцаалтын жагсаалт харах' },
  'desk.payouts.approve': { scope: 'desk', mn: 'Олголт батлах, шилжүүлснийг тэмдэглэх' },
  'desk.orgs.view': { scope: 'desk', mn: 'Байгууллагуудын бүртгэл харах' },
  'desk.orgs.decide': { scope: 'desk', mn: 'Байгууллага батлах, татгалзах' },
  'desk.members.manage': { scope: 'desk', mn: 'Гишүүд, эрхийн хүсэлт шийдэх' },
  'desk.audit.view': { scope: 'desk', mn: 'Үйлдлийн түүх харах' },

  /* ── a business, whatever it is ── */
  'org.view': { scope: 'org', mn: 'Байгууллагын нүүр, мэдээлэл харах' },
  'org.team.view': { scope: 'org', mn: 'Хамт ажиллагсдаа харах' },
  'org.team.manage': { scope: 'org', mn: 'Ажилтан, нягтлан нэмэх, хасах' },
  'org.managers.manage': { scope: 'org', mn: 'Менежер, эзэн томилох' },
  'org.profile.edit': { scope: 'org', mn: 'Байгууллагын мэдээлэл засах' },
  'org.bank.manage': { scope: 'org', mn: 'Мөнгө очих данс солих' },
  'org.log.view': { scope: 'org', mn: 'Эрхийн өөрчлөлтийн түүх харах' },

  /* ── a supplier: өвлийн идэш ── */
  'idesh.board': { scope: 'org', module: 'idesh', mn: 'Өнөөдрийн ажил' },
  'idesh.orders.view': { scope: 'org', module: 'idesh', mn: 'Идэшний захиалга харах' },
  'idesh.orders.act': { scope: 'org', module: 'idesh', mn: 'Захиалга бэлтгэх, хүлээлгэн өгөх, цуцлах' },
  'idesh.listings.view': { scope: 'org', module: 'idesh', mn: 'Зар харах' },
  'idesh.listings.edit': { scope: 'org', module: 'idesh', mn: 'Зар нэмэх, засах' },
  'idesh.money.view': { scope: 'org', module: 'idesh', mn: 'Орлого, олголт, шимтгэл, данс харах' },

  /* ── a restaurant: хоол ── */
  'dine.orders.view': { scope: 'org', module: 'dine', mn: 'Хоолны захиалга харах' },
  'dine.orders.act': { scope: 'org', module: 'dine', mn: 'Захиалгыг гал тогоонд удирдах' },
  'dine.menu.view': { scope: 'org', module: 'dine', mn: 'Цэс харах' },
  'dine.menu.edit': { scope: 'org', module: 'dine', mn: 'Цэс засах, үнэ өөрчлөх' },
  'dine.kitchen': { scope: 'org', module: 'dine', mn: 'Гал тогооны дэлгэц холбох' },
  'dine.money.view': { scope: 'org', module: 'dine', mn: 'Орлого, олголт харах' },
} as const satisfies Record<string, Spec>;

export type Permission = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as Permission[];
const inScope = (scope: Spec['scope']) => ALL.filter((p) => PERMISSIONS[p].scope === scope);

export const DESK_ROLES: readonly DeskRole[] = ['admin', 'ops', 'finance', 'viewer'];
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'manager', 'staff', 'accountant'];

export const DESK_ROLE_WORD: Record<DeskRole, string> = { admin: 'Админ', ops: 'Ops', finance: 'Санхүү', viewer: 'Зөвхөн харах' };
export const ORG_ROLE_WORD: Record<OrgRole, string> = { owner: 'Эзэн', manager: 'Менежер', staff: 'Ажилтан', accountant: 'Нягтлан' };
export const MODULE_WORD: Record<OrgModule, string> = { idesh: 'Нийлүүлэгч', dine: 'Ресторан' };

/**
 * The desk. Admin holds everything; ops runs orders, suppliers, kitchens and
 * businesses; finance moves money and checks accounts; a viewer reads what
 * the others read and presses nothing. Only admin decides who sits here.
 */
const DESK: Record<DeskRole, readonly Permission[]> = {
  admin: inScope('desk'),
  ops: [
    'desk.overview',
    'desk.guests.view',
    'desk.guests.sessions',
    'desk.notify.view',
    'desk.notify.retry',
    'desk.system.view',
    'desk.dine.view',
    'desk.dine.manage',
    'desk.idesh.view',
    'desk.idesh.manage',
    'desk.payouts.view',
    'desk.orgs.view',
    'desk.orgs.decide',
    'desk.audit.view',
  ],
  finance: [
    'desk.overview',
    'desk.guests.view',
    'desk.money.view',
    'desk.money.manage',
    'desk.idesh.view',
    'desk.idesh.terms',
    'desk.payouts.view',
    'desk.payouts.approve',
    'desk.orgs.view',
    'desk.audit.view',
  ],
  viewer: [
    'desk.overview',
    'desk.guests.view',
    'desk.money.view',
    'desk.notify.view',
    'desk.system.view',
    'desk.dine.view',
    'desk.idesh.view',
    'desk.payouts.view',
    'desk.orgs.view',
    'desk.audit.view',
  ],
};

/**
 * A business. The owner holds everything, and alone appoints managers and
 * says where the money goes. A manager runs the day and the people in it.
 * Staff do the work — orders, the stall, the kitchen — and never see the
 * money. The accountant sees the money and the orders it came from, and
 * changes nothing.
 */
const ORG: Record<OrgRole, readonly Permission[]> = {
  owner: inScope('org'),
  manager: inScope('org').filter((p) => p !== 'org.managers.manage' && p !== 'org.bank.manage'),
  staff: [
    'org.view',
    'org.team.view',
    'idesh.board',
    'idesh.orders.view',
    'idesh.orders.act',
    'idesh.listings.view',
    'idesh.listings.edit',
    'dine.orders.view',
    'dine.orders.act',
    'dine.menu.view',
  ],
  accountant: ['org.view', 'org.team.view', 'idesh.orders.view', 'idesh.money.view', 'dine.orders.view', 'dine.money.view'],
};

/** A set of permissions, asked one at a time. */
export interface Grants {
  has(permission: Permission): boolean;
  list(): Permission[];
}

function grants(permissions: Iterable<Permission>): Grants {
  const held = new Set(permissions);
  return { has: (p) => held.has(p), list: () => ALL.filter((p) => held.has(p)) };
}

export const NO_GRANTS: Grants = grants([]);

/** What a member of the desk may do. An unknown role is nothing. */
export function deskGrants(role: string | null | undefined): Grants {
  return grants(role && role in DESK ? DESK[role as DeskRole] : []);
}

/**
 * What a member of a business may do there: the role's permissions, less
 * those of modules the business does not run. A supplier's manager holds no
 * menu; a restaurant's staff hold no listings.
 */
export function orgGrants(role: string | null | undefined, modules: readonly OrgModule[]): Grants {
  if (!role || !(role in ORG)) return NO_GRANTS;
  return grants(
    ORG[role as OrgRole].filter((p) => {
      const module = (PERMISSIONS[p] as Spec).module;
      return !module || modules.includes(module);
    }),
  );
}

/** The modules a business runs, from what it registered as. */
export function modulesOf(org: { supplier: boolean; restaurant: boolean }): OrgModule[] {
  return [...(org.supplier ? (['idesh'] as const) : []), ...(org.restaurant ? (['dine'] as const) : [])];
}

/**
 * Whether a member in `actor`'s role may give, change or take away `role`.
 * Staff and accountants are the managers' to handle; managers and owners
 * are the owner's alone. Changing somebody's role needs both their old role
 * and the new one to be within reach.
 */
export function mayAssign(actor: string | null | undefined, role: OrgRole): boolean {
  const reach: Permission = role === 'staff' || role === 'accountant' ? 'org.team.manage' : 'org.managers.manage';
  return orgGrants(actor, ['idesh', 'dine']).has(reach);
}

/** Every permission of a scope, with its words — what the roles page lays out as a table. */
export function catalogue(scope: 'desk' | 'org', modules?: readonly OrgModule[]) {
  return inScope(scope)
    .filter((p) => {
      const module = (PERMISSIONS[p] as Spec).module;
      return !module || !modules || modules.includes(module);
    })
    .map((p) => ({ key: p, module: (PERMISSIONS[p] as Spec).module ?? null, mn: PERMISSIONS[p].mn }));
}

export const deskRoleHas = (role: DeskRole, p: Permission): boolean => DESK[role].includes(p);
export const orgRoleHas = (role: OrgRole, p: Permission): boolean => ORG[role].includes(p);
