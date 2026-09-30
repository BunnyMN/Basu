import { TOP, known, orgCeiling, parse, permissionsOf, type Scope } from './catalog.js';

/**
 * What a role lets a person do, worked out from the role Basu wrote and
 * what the code can draw. Pure: the rows come from `store.ts`, the menu's
 * layout too; nothing here touches the database.
 *
 * Deny is the default. A role opens exactly the permissions in its list
 * that the code still knows — a page renamed away in a release simply
 * stops being opened — and a business's role opens only the pages that
 * run at a business of its kind. Nobody may hand out, or write into a role,
 * more than they hold themselves.
 */

export interface RoleShape {
  scope: Scope;
  key: string;
  name: string;
  permissions: readonly string[];
  locked: boolean;
  head: boolean;
}

/** A set of permissions, asked one at a time. */
export interface Grants {
  has(permission: string): boolean;
  list(): string[];
}

export function grants(permissions: Iterable<string>): Grants {
  const held = new Set(permissions);
  return { has: (p) => held.has(p), list: () => [...held] };
}

export const NO_GRANTS: Grants = grants([]);

/**
 * What a role opens: a locked role everything of its scope — every page the
 * code draws and every link Basu added to the menu — and any other role its
 * own list, less whatever the code no longer knows. `links` are the view
 * permissions of the links in that scope's menu.
 */
export function grantsOf(role: RoleShape | null | undefined, links: readonly string[] = []): Grants {
  if (!role) return NO_GRANTS;
  const linkSet = new Set(links);
  if (role.locked) return grants([...permissionsOf(role.scope), ...links]);
  return grants(role.permissions.filter((p) => parse(p)?.scope === role.scope && (known(p) || linkSet.has(p))));
}

/**
 * What a role opens at one business: its grants, less the pages that do
 * not run at a business of that kind — a butcher's staff hold no menu,
 * whatever their role says elsewhere.
 */
export function orgGrantsOf(role: RoleShape | null | undefined, kinds: { supplier: boolean; restaurant: boolean }, links: readonly string[] = []): Grants {
  if (!role || role.scope !== 'org') return NO_GRANTS;
  const ceiling = orgCeiling(kinds);
  for (const l of links) ceiling.add(l);
  return grants(grantsOf(role, links).list().filter((p) => ceiling.has(p)));
}

/** Whether every permission in `wanted` is one the actor holds. */
const within = (actor: Grants, wanted: Iterable<string>): boolean => [...wanted].every((p) => actor.has(p));

/** The permissions that put a person in charge of people at a business. */
const RULES_PEOPLE = ['org.team:manage', 'org.team:heads'];

/**
 * Whether somebody at a business, holding `actor`, may give, change or take
 * away `role` there. They must manage the team; the role must open nothing
 * they cannot open themselves; and a head role, or one that manages people,
 * is only for somebody who may appoint heads.
 */
export function mayHandOut(actor: Grants, role: RoleShape, kinds: { supplier: boolean; restaurant: boolean }, links: readonly string[] = []): boolean {
  if (role.scope !== 'org' || !actor.has('org.team:manage')) return false;
  const opens = orgGrantsOf(role, kinds, links).list();
  if (!within(actor, opens)) return false;
  if ((role.head || opens.some((p) => RULES_PEOPLE.includes(p))) && !actor.has('org.team:heads')) return false;
  return true;
}

/**
 * Whether a desk member holding `actor` may seat somebody in `role`: they
 * manage the members, and the role opens nothing they cannot. Only somebody
 * in a locked role seats somebody in one.
 */
export function mayHandOutDesk(actor: Grants, role: RoleShape, links: readonly string[] = [], actorLocked = false): boolean {
  if (role.scope !== 'desk' || !actor.has('desk.members:manage')) return false;
  if (role.locked) return actorLocked;
  return within(actor, grantsOf(role, links).list());
}

/** Whether the actor may write these permissions into a role: only those they hold. */
export const mayShape = (actor: Grants, permissions: Iterable<string>): boolean => within(actor, permissions);

/* ── the menu ───────────────────────────────────────────────────────── */

export interface LayoutModule {
  key: string;
  name: string | null;
  icon: string;
  sort: number;
}

export interface LayoutPage {
  key: string;
  module: string;
  name: string;
  icon: string;
  sort: number;
  hidden: boolean;
  /** Set for a link Basu added; a page the code draws has none. */
  href: string | null;
}

export interface Layout {
  modules: LayoutModule[];
  pages: LayoutPage[];
}

export interface MenuItem {
  key: string;
  label: string;
  icon: string;
  /** Another page draws it — the supplier's screen, or a link Basu added. */
  href?: string;
}

export interface MenuGroup {
  key: string;
  /** Null for the top of the menu, whose pages need no heading. */
  label: string | null;
  icon: string;
  items: MenuItem[];
}

/**
 * What a link Basu adds to a menu may point at: a path on Basu, or an https
 * address elsewhere — the address as given, or null when it is neither.
 * Whoever presses a menu link follows it with their own session, the
 * admin's included, so `javascript:` and `data:` are no link; nor is
 * `//host` or `/\host`, which a browser reads as another site that only
 * looks like a path, nor an address with somebody's name before an `@`.
 * Nothing that could end an attribute or start a tag — a quote, an angle
 * bracket, a space, a control character — is in one either.
 */
export function linkHref(raw: unknown): string | null {
  const href = typeof raw === 'string' ? raw.trim() : '';
  if (!href || href.length > 500 || /[\s\\"'<>`\u0000-\u001f\u007f]/.test(href)) return null;
  if (href.startsWith('/')) return href.startsWith('//') ? null : href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? href : null;
}

/**
 * The menu one person sees in one place: Basu's modules in Basu's order,
 * under each the pages Basu put there that this person may open, and no
 * module left with nothing in it. A supplier's pages are the supplier's own
 * screen, opened for this business. A link whose address `linkHref` would
 * refuse — one written before it did — is left out.
 */
export function buildMenu(scope: Scope, layout: Layout, held: Grants, opts: { orgId?: string } = {}): MenuGroup[] {
  const modules = [...layout.modules].sort((a, b) => Number(b.key === TOP) - Number(a.key === TOP) || a.sort - b.sort);
  return modules
    .map((m) => ({
      key: m.key,
      label: m.key === TOP ? null : m.name,
      icon: m.icon,
      items: layout.pages
        .filter((p) => p.module === m.key && !p.hidden && held.has(`${scope}.${p.key}`) && (!p.href || linkHref(p.href)))
        .sort((a, b) => a.sort - b.sort)
        .map((p) => ({
          key: p.key,
          label: p.name,
          icon: p.icon,
          ...(p.href
            ? { href: p.href }
            : scope === 'org' && p.key.startsWith('idesh.') && opts.orgId
              ? { href: `/supplier?org=${opts.orgId}#${p.key.slice('idesh.'.length)}` }
              : {}),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

/** Every page key a menu opens. */
export const pagesOf = (menu: MenuGroup[]): string[] => menu.flatMap((g) => g.items.map((i) => i.key));
