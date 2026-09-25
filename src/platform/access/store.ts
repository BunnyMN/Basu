import { randomBytes } from 'node:crypto';
import { getPool, tx, type Db } from '../../db/pool.js';
import { BUILTIN_ROLES, ICONS, MODULES, PAGES, TOP, known, parse, type Scope } from './catalog.js';
import type { Layout, LayoutModule, LayoutPage, RoleShape } from './policy.js';

/**
 * The roles Basu made and the menu Basu arranged, in the `access` schema.
 *
 * Roles are rows: a name, a list of page and action permissions, and a few
 * flags. The built-in ones are written when missing and never overwritten,
 * so what Basu changed stays changed across releases. The menu is the code's
 * pages placed under modules; a row here moves, renames, reorders or hides
 * one, and a page with no row sits where the code first put it.
 */

export class AccessError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'LOCKED' | 'BUILTIN' | 'BAD_INPUT' | 'NAME_TAKEN' | 'IN_USE' | 'NO_HEAD',
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface Role extends RoleShape {
  description: string | null;
  everyone: boolean;
  builtin: boolean;
  sort: number;
  updatedAt: Date;
  updatedBy: string | null;
}

type RoleRow = {
  scope: Scope;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  locked: boolean;
  head: boolean;
  everyone: boolean;
  builtin: boolean;
  sort: number;
  updated_at: Date;
  updated_by: string | null;
};

const ROLE_COLUMNS = 'scope, key, name, description, permissions, locked, head, everyone, builtin, sort, updated_at, updated_by';

const shapeRole = (r: RoleRow): Role => ({
  scope: r.scope,
  key: r.key,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  locked: r.locked,
  head: r.head,
  everyone: r.everyone,
  builtin: r.builtin,
  sort: r.sort,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

/** The roles every server starts with, written where missing. What Basu changed is left alone. */
export async function ensureRoles(db: Db = getPool()): Promise<void> {
  for (const r of BUILTIN_ROLES) {
    await db.query(
      `INSERT INTO access.role (scope, key, name, description, permissions, locked, head, everyone, builtin, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8, 'basu')
       ON CONFLICT (scope, key) DO NOTHING`,
      [r.scope, r.key, r.name, r.description, r.permissions, r.locked ?? false, r.head ?? false, r.sort],
    );
  }
}

export async function rolesOf(scope: Scope, db: Db = getPool()): Promise<Role[]> {
  const { rows } = await db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM access.role WHERE scope = $1 ORDER BY sort, lower(name)`, [scope]);
  return rows.map(shapeRole);
}

export async function roleOf(scope: Scope, key: string, db: Db = getPool()): Promise<Role | null> {
  const { rows } = await db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM access.role WHERE scope = $1 AND key = $2`, [scope, key]);
  return rows[0] ? shapeRole(rows[0]) : null;
}

/** The keys of a business's head roles: a business always keeps somebody in one. */
export async function headRoles(db: Db = getPool()): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(`SELECT key FROM access.role WHERE scope = 'org' AND head`);
  return rows.map((r) => r.key);
}

/** Permissions a role may carry: the code's, of its own scope, and the links in its scope's menu. */
async function checkedPermissions(scope: Scope, permissions: unknown, db: Db): Promise<string[]> {
  if (!Array.isArray(permissions)) throw new AccessError('BAD_INPUT', 'permissions is a list');
  const links = new Set(await linksOf(scope, db));
  const out = new Set<string>();
  for (const p of permissions) {
    if (typeof p !== 'string' || parse(p)?.scope !== scope || !(known(p) || links.has(p))) {
      throw new AccessError('BAD_INPUT', `no such permission here: ${String(p)}`);
    }
    out.add(p);
  }
  // An action without its page is a button on a page nobody can open.
  for (const p of [...out]) {
    const parsed = parse(p)!;
    if (parsed.action) out.add(`${scope}.${parsed.page}`);
  }
  return [...out];
}

function checkedName(name: unknown): string {
  const v = typeof name === 'string' ? name.trim() : '';
  if (v.length < 2 || v.length > 40) throw new AccessError('BAD_INPUT', 'a role needs a name of 2 to 40 letters');
  return v;
}

const freshKey = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex').slice(0, 6)}`;

const taken = (error: unknown) => (error as { code?: string }).code === '23505';

export async function createRole(input: {
  scope: Scope;
  name: string;
  description?: string | null;
  permissions: string[];
  everyone?: boolean;
  head?: boolean;
  by: string;
}): Promise<Role> {
  const db = getPool();
  const name = checkedName(input.name);
  const permissions = await checkedPermissions(input.scope, input.permissions, db);
  try {
    const { rows } = await db.query<RoleRow>(
      `INSERT INTO access.role (scope, key, name, description, permissions, head, everyone, sort, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, $8, $8) RETURNING ${ROLE_COLUMNS}`,
      [
        input.scope,
        freshKey('r'),
        name,
        input.description?.trim().slice(0, 200) || null,
        permissions,
        input.scope === 'org' && Boolean(input.head),
        input.everyone ?? true,
        input.by,
      ],
    );
    return shapeRole(rows[0]!);
  } catch (error) {
    if (taken(error)) throw new AccessError('NAME_TAKEN', 'a role of that name exists');
    throw error;
  }
}

/** Change a role. A locked role stays as it is; a business never ends up with no head role. */
export async function updateRole(input: {
  scope: Scope;
  key: string;
  name?: string;
  description?: string | null;
  permissions?: string[];
  everyone?: boolean;
  head?: boolean;
  by: string;
}): Promise<Role> {
  return tx(async (client) => {
    const current = await roleOf(input.scope, input.key, client);
    if (!current) throw new AccessError('NOT_FOUND', 'no such role');
    if (current.locked) throw new AccessError('LOCKED', 'the admin role opens everything and is not edited');
    const name = input.name === undefined ? current.name : checkedName(input.name);
    const permissions = input.permissions === undefined ? current.permissions : await checkedPermissions(input.scope, input.permissions, client);
    const head = input.scope === 'org' && (input.head === undefined ? current.head : Boolean(input.head));
    if (current.head && !head) {
      const others = await client.query(`SELECT 1 FROM access.role WHERE scope = 'org' AND head AND key <> $1`, [input.key]);
      if (!others.rowCount) throw new AccessError('NO_HEAD', 'a business always needs a head role');
    }
    try {
      const { rows } = await client.query<RoleRow>(
        `UPDATE access.role SET name = $3, description = $4, permissions = $5, everyone = $6, head = $7, updated_at = now(), updated_by = $8
          WHERE scope = $1 AND key = $2 RETURNING ${ROLE_COLUMNS}`,
        [
          input.scope,
          input.key,
          name,
          input.description === undefined ? current.description : input.description?.trim().slice(0, 200) || null,
          permissions,
          input.everyone === undefined ? current.everyone : Boolean(input.everyone),
          head,
          input.by,
        ],
      );
      return shapeRole(rows[0]!);
    } catch (error) {
      if (taken(error)) throw new AccessError('NAME_TAKEN', 'a role of that name exists');
      throw error;
    }
  });
}

/** Remove a role Basu made. The built-in ones stay; whoever holds a role is the caller's to check first. */
export async function deleteRole(scope: Scope, key: string, db: Db = getPool()): Promise<void> {
  const current = await roleOf(scope, key, db);
  if (!current) throw new AccessError('NOT_FOUND', 'no such role');
  if (current.builtin || current.locked) throw new AccessError('BUILTIN', 'a built-in role is edited, not removed');
  await db.query('DELETE FROM access.org_role WHERE role_key = $1', [key]);
  await db.query('DELETE FROM access.role WHERE scope = $1 AND key = $2', [scope, key]);
}

/* ── which roles a business may hand out ──────────────────────────── */

/** The roles open to this business: those open to every business, and those Basu chose for it. */
export async function rolesForOrg(orgId: string, db: Db = getPool()): Promise<Role[]> {
  const { rows } = await db.query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM access.role r
      WHERE r.scope = 'org' AND (r.everyone OR EXISTS (SELECT 1 FROM access.org_role c WHERE c.org_id = $1 AND c.role_key = r.key))
      ORDER BY r.sort, lower(r.name)`,
    [orgId],
  );
  return rows.map(shapeRole);
}

export async function chosenRoles(orgId: string, db: Db = getPool()): Promise<string[]> {
  const { rows } = await db.query<{ role_key: string }>('SELECT role_key FROM access.org_role WHERE org_id = $1 ORDER BY role_key', [orgId]);
  return rows.map((r) => r.role_key);
}

/** The roles, beyond those open to everyone, that this business may hand out. */
export async function setChosenRoles(orgId: string, keys: string[], by: string): Promise<string[]> {
  return tx(async (client) => {
    const { rows } = await client.query<{ key: string }>(`SELECT key FROM access.role WHERE scope = 'org' AND NOT everyone AND key = ANY($1)`, [keys]);
    const valid = rows.map((r) => r.key);
    await client.query('DELETE FROM access.org_role WHERE org_id = $1', [orgId]);
    for (const key of valid) {
      await client.query('INSERT INTO access.org_role (org_id, role_key, granted_by) VALUES ($1, $2, $3)', [orgId, key, by]);
    }
    return valid.sort();
  });
}

/* ── the menu ───────────────────────────────────────────────────────── */

type ModuleRow = { key: string; name: string; icon: string; sort: number };
type PageRow = { key: string; module_key: string; name: string; icon: string | null; sort: number; hidden: boolean; href: string | null };

/**
 * A scope's menu: the code's modules and pages, moved, renamed, reordered
 * and hidden as Basu said, and the links Basu added. A page whose module is
 * gone falls back to where the code first put it.
 */
export async function layoutOf(scope: Scope, db: Db = getPool()): Promise<Layout> {
  const [m, p] = await Promise.all([
    db.query<ModuleRow>('SELECT key, name, icon, sort FROM access.module WHERE scope = $1', [scope]),
    db.query<PageRow>('SELECT key, module_key, name, icon, sort, hidden, href FROM access.page WHERE scope = $1', [scope]),
  ]);
  const modules = new Map<string, LayoutModule>(MODULES[scope].map((x) => [x.key, { ...x }]));
  for (const r of m.rows) {
    const code = modules.get(r.key);
    modules.set(r.key, { key: r.key, name: r.key === TOP ? null : r.name, icon: r.icon, sort: r.sort ?? code?.sort ?? 100 });
  }
  const saved = new Map(p.rows.map((r) => [r.key, r]));
  const pages: LayoutPage[] = PAGES[scope].map((spec, i) => {
    const r = saved.get(spec.key);
    const module = r && modules.has(r.module_key) ? r.module_key : spec.module;
    return { key: spec.key, module, name: r?.name ?? spec.name, icon: r?.icon ?? spec.icon, sort: r?.sort ?? (i + 1) * 10, hidden: r?.hidden ?? false, href: null };
  });
  for (const r of p.rows) {
    if (!r.href) continue;
    pages.push({ key: r.key, module: modules.has(r.module_key) ? r.module_key : TOP, name: r.name, icon: r.icon ?? 'link', sort: r.sort, hidden: r.hidden, href: r.href });
  }
  return { modules: [...modules.values()].sort((a, b) => a.sort - b.sort), pages };
}

/** The view permissions of the links Basu added to a scope's menu. */
export async function linksOf(scope: Scope, db: Db = getPool()): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>('SELECT key FROM access.page WHERE scope = $1 AND href IS NOT NULL', [scope]);
  return rows.map((r) => `${scope}.${r.key}`);
}

const checkedIcon = (icon: unknown, fallback: string) => (typeof icon === 'string' && (ICONS as readonly string[]).includes(icon) ? icon : fallback);
function checkedLabel(label: unknown, what: string): string {
  const v = typeof label === 'string' ? label.trim() : '';
  if (v.length < 1 || v.length > 40) throw new AccessError('BAD_INPUT', `${what} needs a name of 1 to 40 letters`);
  return v;
}

/** A module of Basu's own, added to a scope's menu, empty until pages are moved into it. */
export async function addModule(scope: Scope, input: { name: string; icon?: string; by: string }): Promise<LayoutModule> {
  const name = checkedLabel(input.name, 'a module');
  const layout = await layoutOf(scope);
  const sort = Math.max(0, ...layout.modules.map((x) => x.sort)) + 10;
  const key = freshKey('m');
  const icon = checkedIcon(input.icon, 'layers');
  await getPool().query('INSERT INTO access.module (scope, key, name, icon, sort, updated_by) VALUES ($1, $2, $3, $4, $5, $6)', [scope, key, name, icon, sort, input.by]);
  return { key, name, icon, sort };
}

/** Remove a module Basu added. The code's modules stay; an empty one simply is not drawn. */
export async function removeModule(scope: Scope, key: string): Promise<void> {
  if (MODULES[scope].some((m) => m.key === key)) throw new AccessError('BUILTIN', 'a module the code made is renamed or emptied, not removed');
  const layout = await layoutOf(scope);
  if (layout.pages.some((p) => p.module === key)) throw new AccessError('IN_USE', 'move the pages out of it first');
  const { rowCount } = await getPool().query('DELETE FROM access.module WHERE scope = $1 AND key = $2', [scope, key]);
  if (!rowCount) throw new AccessError('NOT_FOUND', 'no such module');
}

/**
 * Save a scope's menu as a whole: every module's name, icon and order, and
 * every page's module, name, icon, order and whether it is shown. Keys the
 * scope does not have are refused; what is not sent is left as it was.
 */
export async function saveLayout(
  scope: Scope,
  input: { modules?: Array<Partial<LayoutModule>>; pages?: Array<Partial<LayoutPage>> },
  by: string,
): Promise<Layout> {
  await tx(async (client) => {
    const current = await layoutOf(scope, client);
    const modules = new Map(current.modules.map((m) => [m.key, m]));
    const pages = new Map(current.pages.map((p) => [p.key, p]));
    for (const m of input.modules ?? []) {
      const was = m.key ? modules.get(m.key) : undefined;
      if (!was) throw new AccessError('BAD_INPUT', `no such module: ${String(m.key)}`);
      const name = was.key === TOP ? 'Үндсэн' : m.name === undefined ? was.name! : checkedLabel(m.name, 'a module');
      const icon = checkedIcon(m.icon, was.icon);
      const sort = Number.isFinite(m.sort) ? Math.round(m.sort!) : was.sort;
      await client.query(
        `INSERT INTO access.module (scope, key, name, icon, sort, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scope, key) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, sort = EXCLUDED.sort, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [scope, was.key, name, icon, sort, by],
      );
      modules.set(was.key, { ...was, name: was.key === TOP ? null : name, icon, sort });
    }
    for (const p of input.pages ?? []) {
      const was = p.key ? pages.get(p.key) : undefined;
      if (!was) throw new AccessError('BAD_INPUT', `no such page: ${String(p.key)}`);
      const module = p.module === undefined ? was.module : String(p.module);
      if (!modules.has(module)) throw new AccessError('BAD_INPUT', `no such module: ${module}`);
      const name = p.name === undefined ? was.name : checkedLabel(p.name, 'a page');
      const icon = checkedIcon(p.icon, was.icon);
      const sort = Number.isFinite(p.sort) ? Math.round(p.sort!) : was.sort;
      const hidden = p.hidden === undefined ? was.hidden : Boolean(p.hidden);
      await client.query(
        `INSERT INTO access.page (scope, key, module_key, name, icon, sort, hidden, href, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (scope, key) DO UPDATE SET module_key = EXCLUDED.module_key, name = EXCLUDED.name, icon = EXCLUDED.icon,
           sort = EXCLUDED.sort, hidden = EXCLUDED.hidden, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [scope, was.key, module, name, icon, sort, hidden, was.href, by],
      );
    }
  });
  return layoutOf(scope);
}

/** A link Basu adds to a scope's menu — another page of Basu, or anywhere. Opened, like any page, by the roles given it. */
export async function addLink(scope: Scope, input: { name: string; href: string; module?: string; icon?: string; by: string }): Promise<LayoutPage> {
  const name = checkedLabel(input.name, 'a link');
  const href = input.href?.trim() ?? '';
  if (!/^(\/[^\s]*|https:\/\/[^\s]+)$/.test(href) || href.length > 500) throw new AccessError('BAD_INPUT', 'a link is a path on Basu or an https address');
  const layout = await layoutOf(scope);
  const module = input.module && layout.modules.some((m) => m.key === input.module) ? input.module : TOP;
  const sort = Math.max(0, ...layout.pages.filter((p) => p.module === module).map((p) => p.sort)) + 10;
  const key = freshKey('link');
  const icon = checkedIcon(input.icon, 'link');
  await getPool().query(
    'INSERT INTO access.page (scope, key, module_key, name, icon, sort, hidden, href, updated_by) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8)',
    [scope, key, module, name, icon, sort, href, input.by],
  );
  return { key, module, name, icon, sort, hidden: false, href };
}

export async function removeLink(scope: Scope, key: string): Promise<void> {
  const { rowCount } = await getPool().query('DELETE FROM access.page WHERE scope = $1 AND key = $2 AND href IS NOT NULL', [scope, key]);
  if (!rowCount) throw new AccessError('NOT_FOUND', 'no such link');
  // No role opens a link that is gone.
  await getPool().query('UPDATE access.role SET permissions = array_remove(permissions, $2) WHERE scope = $1', [scope, `${scope}.${key}`]);
}
