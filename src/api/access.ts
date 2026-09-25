import type { FastifyInstance, FastifyRequest } from 'fastify';
import { supplierOfOrg } from '../idesh/index.js';
import { requestOf } from '../ops/index.js';
import {
  DESK_ROLES,
  DESK_ROLE_WORD,
  MODULE_WORD,
  ORG_ROLES,
  ORG_ROLE_WORD,
  catalogue,
  deskGrants,
  deskMenu,
  deskRoleHas,
  meMenu,
  modulesOf,
  orgGrants,
  orgMenu,
  orgRoleHas,
  type Grants,
  type MenuGroup,
  type OrgModule,
  type Permission,
} from '../platform/access/index.js';
import { profileOf } from '../platform/identity/index.js';
import { orgById, orgsOf, roleIn, type OrgRole, type OrgState } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';
import { unauthorized } from './errors.js';
import { limits } from './hardening.js';
import { deskSeatFor } from './ops.js';

/**
 * What a signed-in person sits in, and what each seat lets them open.
 *
 * The dashboard's first question. The answer is a list of workspaces — the
 * person's own corner, Basu's desk if they sit at it, and every business
 * they belong to — each with the permissions it grants and the menu those
 * permissions draw. The page renders that and nothing else, and the route
 * behind every page checks the same permission again: hiding a page is a
 * courtesy, refusing it is the rule.
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
  /** Why the desk said no, for a business it turned down. */
  decline_reason?: string | null;
  modules?: OrgModule[];
  supplier?: { id: string; state: string; active: boolean } | null;
  /** The desk member this seat is, for the desk's own pages. */
  seat?: { id: string; name: string };
  permissions: Permission[];
  menu: MenuGroup[];
}

const STATE_WORD: Record<OrgState, string> = {
  applied: 'Хүлээгдэж байна',
  active: 'Идэвхтэй',
  declined: 'Татгалзсан',
  suspended: 'Түр хаасан',
};

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

const workspace = (w: Omit<Workspace, 'permissions'> & { grants: Grants }): Workspace => {
  const { grants, ...rest } = w;
  return { ...rest, permissions: grants.list() };
};

export async function registerAccessRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const limit = { config: { rateLimit: limits().ops } };

  app.get('/v1/access', limit, async (request, reply) => {
    const { guestId, seat } = await deskSeatFor(ctx, bearer(request));
    if (!guestId && !seat) return unauthorized(reply);

    const workspaces: Workspace[] = [];
    if (seat) {
      const grants = deskGrants(seat.role);
      workspaces.push(
        workspace({
          id: 'desk',
          kind: 'desk',
          name: 'Basu',
          sub: `Ops · ${DESK_ROLE_WORD[seat.role]}`,
          role: seat.role,
          role_label: DESK_ROLE_WORD[seat.role],
          seat: { id: seat.id, name: seat.name },
          grants,
          menu: deskMenu(grants),
        }),
      );
    }
    if (!guestId) return { account: null, workspaces, desk_request: null };

    const [profile, memberships, asked] = await Promise.all([profileOf(guestId), orgsOf(guestId), requestOf(guestId)]);
    for (const { org, role } of memberships) {
      const modules = modulesOf(org);
      const active = org.state === 'active';
      const grants = active ? orgGrants(role, modules) : orgGrants(null, []);
      const supplier = org.supplier && active ? await supplierOfOrg(org.id) : null;
      const what = modules.map((m) => MODULE_WORD[m]).join(', ');
      workspaces.push(
        workspace({
          id: org.id,
          kind: 'org',
          name: org.name,
          // Waiting or turned down, the state is the news; the kind is on the page.
          sub: active ? `${what} · ${ORG_ROLE_WORD[role]}` : STATE_WORD[org.state],
          role,
          role_label: ORG_ROLE_WORD[role],
          state: org.state,
          decline_reason: org.declineReason,
          modules,
          supplier: supplier ? { id: supplier.id, state: supplier.state, active: supplier.active } : null,
          grants,
          menu: orgMenu(grants, { orgId: org.id, modules, active }),
        }),
      );
    }
    const name = profile?.displayName ?? null;
    workspaces.unshift(
      workspace({
        id: 'me',
        kind: 'me',
        name: name ?? profile?.email ?? profile?.phone ?? 'Миний бүртгэл',
        sub: 'Миний бүртгэл',
        role: null,
        role_label: null,
        grants: orgGrants(null, []),
        menu: meMenu(orgGrants(null, [])),
      }),
    );
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
   * Who may do what, laid out as a table: every permission of the desk or of
   * a business, and the roles that hold it. The rules are no secret — an
   * owner should read them before handing somebody a role — so anybody
   * signed in may ask. With `org`, a business's table has only the modules
   * that business runs, and says which role the asker holds there.
   */
  app.get<{ Querystring: { scope?: string; org?: string } }>('/v1/access/roles', limit, async (request, reply) => {
    const { guestId, seat } = await deskSeatFor(ctx, bearer(request));
    if (!guestId && !seat) return unauthorized(reply);
    if (request.query.scope === 'desk') {
      return {
        scope: 'desk',
        yours: seat?.role ?? null,
        roles: DESK_ROLES.map((r) => ({ key: r, label: DESK_ROLE_WORD[r] })),
        permissions: catalogue('desk').map((p) => ({ ...p, roles: DESK_ROLES.filter((r) => deskRoleHas(r, p.key)) })),
      };
    }
    let modules: OrgModule[] | undefined;
    let yours: OrgRole | null = null;
    const orgId = request.query.org;
    if (orgId && guestId && /^[0-9a-f-]{36}$/i.test(orgId)) {
      const org = await orgById(orgId);
      yours = org ? await roleIn(orgId, guestId) : null;
      if (org && yours) modules = modulesOf(org);
    }
    return {
      scope: 'org',
      yours,
      modules: modules ?? ['idesh', 'dine'],
      roles: ORG_ROLES.map((r) => ({ key: r, label: ORG_ROLE_WORD[r] })),
      permissions: catalogue('org', modules).map((p) => ({ ...p, roles: ORG_ROLES.filter((r) => orgRoleHas(r, p.key)) })),
    };
  });
}
