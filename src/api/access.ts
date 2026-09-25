import type { FastifyInstance, FastifyRequest } from 'fastify';
import { supplierOfOrg } from '../idesh/index.js';
import { requestOf } from '../ops/index.js';
import {
  PAGES,
  TOP,
  buildMenu,
  layoutOf,
  orgCeiling,
  rolesForOrg,
  rolesOf,
  type Layout,
  type MenuGroup,
  type Role,
  type Scope,
} from '../platform/access/index.js';
import { profileOf } from '../platform/identity/index.js';
import { orgById, roleIn, seatsOf, type OrgState } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';
import { unauthorized } from './errors.js';
import { limits } from './hardening.js';
import { deskSeatFor } from './ops.js';

/**
 * What a signed-in person sits in, and what each seat lets them open.
 *
 * The dashboard's first question. The answer is a list of workspaces — the
 * person's own corner, Basu's desk if they sit at it, and every business
 * they belong to — each with the permissions its role opens and the menu
 * those draw, laid out in modules as Basu arranged them. The page renders
 * that and nothing else, and the route behind every page checks the same
 * permission again: hiding a page is a courtesy, refusing it is the rule.
 */

interface Workspace {
  id: string;
  kind: 'me' | 'desk' | 'org';
  name: string;
  /** One line under the name: what the place is and what the person is in it. */
  sub: string;
  role: string | null;
  role_label: string | null;
  state?: OrgState;
  decline_reason?: string | null;
  kinds?: { supplier: boolean; restaurant: boolean };
  supplier?: { id: string; state: string; active: boolean } | null;
  /** The desk member this seat is, for the desk's own pages. */
  seat?: { id: string; name: string };
  permissions: string[];
  menu: MenuGroup[];
}

const STATE_WORD: Record<OrgState, string> = {
  applied: 'Хүлээгдэж байна',
  active: 'Идэвхтэй',
  declined: 'Татгалзсан',
  suspended: 'Түр хаасан',
};

/** A person's own corner: always there, whatever else they sit in. Nobody's role decides it. */
const ME_MENU: MenuGroup[] = [
  {
    key: TOP,
    label: null,
    icon: 'overview',
    items: [
      { key: 'home', label: 'Нүүр', icon: 'overview' },
      { key: 'profile', label: 'Профайл', icon: 'person' },
    ],
  },
];

/** A business still waiting for the desk, or turned down: its front page, which says so, and nothing else. */
const WAITING_MENU: MenuGroup[] = [{ key: TOP, label: null, icon: 'overview', items: [{ key: 'home', label: 'Нүүр', icon: 'overview' }] }];

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

const kindWords = (k: { supplier: boolean; restaurant: boolean }) =>
  [k.supplier && 'Нийлүүлэгч', k.restaurant && 'Ресторан'].filter(Boolean).join(', ');

/**
 * The table of who may do what: the pages of a scope as Basu laid them out,
 * each with what can be done on it, and the roles with what each opens.
 * `only`, when given, keeps to those permissions — a business's kind.
 */
export function matrix(scope: Scope, layout: Layout, roles: Role[], only?: Set<string>) {
  const specs = new Map(PAGES[scope].map((p) => [p.key, p]));
  const visible = layout.pages.filter((p) => !only || only.has(`${scope}.${p.key}`)).sort((a, b) => a.sort - b.sort);
  return {
    modules: layout.modules
      .filter((m) => visible.some((p) => p.module === m.key))
      .map((m) => ({ key: m.key, name: m.key === TOP ? 'Үндсэн' : m.name, icon: m.icon })),
    pages: visible.map((p) => ({
      key: p.key,
      module: p.module,
      name: p.name,
      icon: p.icon,
      hidden: p.hidden,
      link: p.href,
      kind: specs.get(p.key)?.kind ?? null,
      permission: `${scope}.${p.key}`,
      actions: Object.entries(specs.get(p.key)?.actions ?? {}).map(([key, label]) => ({ key, label, permission: `${scope}.${p.key}:${key}` })),
    })),
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      locked: r.locked,
      head: r.head,
      everyone: r.everyone,
      builtin: r.builtin,
      // A locked role opens everything; there is no list to show.
      permissions: r.locked ? null : r.permissions.filter((p) => !only || only.has(p)),
    })),
  };
}

export async function registerAccessRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const limit = { config: { rateLimit: limits().ops } };

  app.get('/v1/access', limit, async (request, reply) => {
    const { guestId, seat } = await deskSeatFor(ctx, bearer(request));
    if (!guestId && !seat) return unauthorized(reply);

    const workspaces: Workspace[] = [];
    if (seat) {
      workspaces.push({
        id: 'desk',
        kind: 'desk',
        name: 'Basu',
        sub: `Ops · ${seat.roleName}`,
        role: seat.role,
        role_label: seat.roleName,
        seat: { id: seat.id, name: seat.name },
        permissions: seat.grants.list(),
        menu: buildMenu('desk', await layoutOf('desk'), seat.grants),
      });
    }
    if (!guestId) return { account: null, workspaces, desk_request: null };

    const [profile, seats, asked, orgLayout] = await Promise.all([profileOf(guestId), seatsOf(guestId), requestOf(guestId), layoutOf('org')]);
    for (const { org, role, roleKey, grants } of seats) {
      const active = org.state === 'active';
      const supplier = org.supplier && active ? await supplierOfOrg(org.id) : null;
      const roleName = role?.name ?? roleKey;
      workspaces.push({
        id: org.id,
        kind: 'org',
        name: org.name,
        sub: active ? `${kindWords(org)} · ${roleName}` : STATE_WORD[org.state],
        role: roleKey,
        role_label: roleName,
        state: org.state,
        decline_reason: org.declineReason,
        kinds: { supplier: org.supplier, restaurant: org.restaurant },
        supplier: supplier ? { id: supplier.id, state: supplier.state, active: supplier.active } : null,
        permissions: grants.list(),
        menu: active ? buildMenu('org', orgLayout, grants, { orgId: org.id }) : WAITING_MENU,
      });
    }
    const name = profile?.displayName ?? null;
    workspaces.unshift({
      id: 'me',
      kind: 'me',
      name: name ?? profile?.email ?? profile?.phone ?? 'Миний бүртгэл',
      sub: 'Миний бүртгэл',
      role: null,
      role_label: null,
      permissions: [],
      menu: ME_MENU,
    });
    return {
      account: { id: guestId, name, email: profile?.email ?? null, phone: profile?.phone ?? null },
      workspaces,
      desk_request: asked
        ? {
            id: asked.id,
            name: asked.name,
            role: asked.role,
            note: asked.note,
            state: asked.state,
            created_at: asked.createdAt.toISOString(),
            decline_reason: asked.declineReason,
          }
        : null,
    };
  });

  /**
   * Who may do what, laid out as a table. The rules are no secret — an owner
   * should read them before handing somebody a role, and anybody asking for
   * a seat at the desk should see what each seat opens — so anybody signed in
   * may ask. With `org`, a business's table has only its own roles and the
   * pages that run at a business of its kind, and says which role the asker
   * holds there.
   */
  app.get<{ Querystring: { scope?: string; org?: string } }>('/v1/access/roles', limit, async (request, reply) => {
    const { guestId, seat } = await deskSeatFor(ctx, bearer(request));
    if (!guestId && !seat) return unauthorized(reply);
    if (request.query.scope === 'desk') {
      const layout = await layoutOf('desk');
      const shown = new Set(layout.pages.filter((p) => !p.hidden).flatMap((p) => [`desk.${p.key}`]));
      const table = matrix('desk', { ...layout, pages: layout.pages.filter((p) => shown.has(`desk.${p.key}`)) }, await rolesOf('desk'));
      return { scope: 'desk', yours: seat?.role ?? null, ...table };
    }
    const orgId = request.query.org;
    if (orgId && guestId && /^[0-9a-f-]{36}$/i.test(orgId)) {
      const org = await orgById(orgId);
      const yours = org ? await roleIn(orgId, guestId) : null;
      if (org && yours) {
        const layout = await layoutOf('org');
        const only = orgCeiling(org);
        for (const p of layout.pages) if (p.href) only.add(`org.${p.key}`);
        const shown = { ...layout, pages: layout.pages.filter((p) => !p.hidden) };
        return { scope: 'org', yours, kinds: { supplier: org.supplier, restaurant: org.restaurant }, ...matrix('org', shown, await rolesForOrg(org.id), only) };
      }
    }
    const layout = await layoutOf('org');
    return { scope: 'org', yours: null, ...matrix('org', { ...layout, pages: layout.pages.filter((p) => !p.hidden) }, await rolesOf('org')) };
  });
}
