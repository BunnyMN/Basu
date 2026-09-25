import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { recordAudit } from '../idesh/index.js';
import { listMembers, pendingRequests } from '../ops/index.js';
import {
  AccessError,
  ICONS,
  addLink,
  addModule,
  chosenRoles,
  createRole,
  deleteRole,
  layoutOf,
  mayShape,
  removeLink,
  removeModule,
  rolesOf,
  saveLayout,
  setChosenRoles,
  updateRole,
  type Scope,
} from '../platform/access/index.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import { membersOf, noteRolesChanged, orgById, roleCounts, setRole } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';
import { matrix } from './access.js';
import { badRequest, forbidden, sendError } from './errors.js';
import { orgRefusal, shapeOrg } from './orgs.js';

/**
 * Basu's desk decides who may do what.
 *
 * The roles page makes roles, at the desk and for businesses, and gives each
 * the pages and actions it opens; the menu page arranges those pages under
 * modules, names them, orders them, hides them, and adds links; and on a
 * business's own page the desk chooses which roles that business may hand
 * out and may set anybody's role there. Every change is in the desk's record.
 */

export interface AccessGuards {
  desk: (permission: string) => RouteShorthandOptions;
  deskAny: (...permissions: string[]) => RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
}

const NIL = '00000000-0000-0000-0000-000000000000';

function scopeOf(raw: string): Scope | null {
  return raw === 'desk' || raw === 'org' ? raw : null;
}

/** An access refusal, in the words the desk reads. */
function refusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof AccessError)) return sendError(reply, error);
  const words: Record<AccessError['code'], [number, string]> = {
    NOT_FOUND: [404, 'Олдсонгүй.'],
    LOCKED: [409, 'Админ үүрэг бүх зүйлийг нээдэг, засагдахгүй.'],
    BUILTIN: [409, 'Үндсэн үүрэг, модулийг засаж болно, устгахгүй.'],
    BAD_INPUT: [400, 'Мэдээллээ шалгана уу.'],
    NAME_TAKEN: [409, 'Ийм нэртэй үүрэг аль хэдийн байна.'],
    IN_USE: [409, 'Хэрэглэгдэж байгаа тул устгах боломжгүй.'],
    NO_HEAD: [409, 'Байгууллагад дор хаяж нэг «эзэн» төрлийн үүрэг байх ёстой.'],
  };
  const [status, mn] = words[error.code];
  return reply.status(status).send({ error: { code: error.code, message_mn: mn, message_en: error.message } });
}

/** How many hold, or wait for, each role: members and open asks at the desk; members at every business. */
async function usage(scope: Scope): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const add = (key: string | null | undefined) => key && counts.set(key, (counts.get(key) ?? 0) + 1);
  if (scope === 'org') return roleCounts();
  for (const m of await listMembers()) if (m.active) add(m.role);
  for (const r of await pendingRequests()) add(r.role);
  return counts;
}

export function registerAccessDesk(app: FastifyInstance, ctx: Ctx, { desk, deskAny, who }: AccessGuards): void {
  /** A desk role holds only what the person writing it holds — unless they sit in the locked admin role. Business roles are the desk's to write whole. */
  const mayWrite = (request: FastifyRequest, scope: Scope, permissions: unknown): boolean =>
    scope === 'org' || Boolean(request.ops?.locked) || (Array.isArray(permissions) && mayShape(request.grants!, permissions.map(String)));

  /** Everything the roles and menu pages draw for one scope: its modules and pages, the roles, what each opens, who holds each. */
  app.get<{ Params: { scope: string } }>('/v1/ops/access/:scope', deskAny('desk.roles', 'desk.menus'), async (request, reply) => {
    const scope = scopeOf(request.params.scope);
    if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
    const [layout, roles, held] = await Promise.all([layoutOf(scope), rolesOf(scope), usage(scope)]);
    return {
      scope,
      icons: ICONS,
      ...matrix(scope, layout, roles),
      all_modules: layout.modules.map((m) => ({ key: m.key, name: m.name, icon: m.icon, sort: m.sort })),
      usage: Object.fromEntries(roles.map((r) => [r.key, held.get(r.key) ?? 0])),
    };
  });

  app.post<{ Params: { scope: string }; Body: { name?: string; description?: string; permissions?: string[]; everyone?: boolean; head?: boolean } }>(
    '/v1/ops/roles/:scope',
    desk('desk.roles:manage'),
    async (request, reply) => {
      const scope = scopeOf(request.params.scope);
      if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
      const body = request.body ?? {};
      if (!mayWrite(request, scope, body.permissions ?? [])) return forbidden(reply, 'a role cannot open more than its maker holds');
      try {
        const role = await createRole({
          scope,
          name: body.name ?? '',
          description: body.description ?? null,
          permissions: body.permissions ?? [],
          ...(body.everyone !== undefined ? { everyone: body.everyone } : {}),
          ...(body.head !== undefined ? { head: body.head } : {}),
          by: who(request),
        });
        await recordAudit({ who: who(request), action: 'role.create', targetKind: 'role', targetId: NIL, note: `${scope} · ${role.name} · ${role.permissions.length} эрх` });
        return reply.status(201).send({ key: role.key, name: role.name });
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.patch<{ Params: { scope: string; key: string }; Body: { name?: string; description?: string | null; permissions?: string[]; everyone?: boolean; head?: boolean } }>(
    '/v1/ops/roles/:scope/:key',
    desk('desk.roles:manage'),
    async (request, reply) => {
      const scope = scopeOf(request.params.scope);
      if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
      const body = request.body ?? {};
      if (body.permissions !== undefined && !mayWrite(request, scope, body.permissions)) {
        return forbidden(reply, 'a role cannot open more than its maker holds');
      }
      try {
        const role = await updateRole({
          scope,
          key: request.params.key,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
          ...(body.everyone !== undefined ? { everyone: body.everyone } : {}),
          ...(body.head !== undefined ? { head: body.head } : {}),
          by: who(request),
        });
        await recordAudit({ who: who(request), action: 'role.update', targetKind: 'role', targetId: NIL, note: `${scope} · ${role.name} · ${role.permissions.length} эрх` });
        return reply.send({ key: role.key, name: role.name, permissions: role.permissions });
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  /** Remove a role nobody holds or asks for. */
  app.delete<{ Params: { scope: string; key: string } }>('/v1/ops/roles/:scope/:key', desk('desk.roles:manage'), async (request, reply) => {
    const scope = scopeOf(request.params.scope);
    if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
    try {
      const held = (await usage(scope)).get(request.params.key) ?? 0;
      if (held > 0) throw new AccessError('IN_USE', `${held} hold or wait for this role`);
      await deleteRole(scope, request.params.key);
      await recordAudit({ who: who(request), action: 'role.delete', targetKind: 'role', targetId: NIL, note: `${scope} · ${request.params.key}` });
      return reply.status(204).send();
    } catch (error) {
      return refusal(reply, error);
    }
  });

  /* ── the menu ── */

  app.put<{ Params: { scope: string }; Body: { modules?: Array<Record<string, unknown>>; pages?: Array<Record<string, unknown>> } }>(
    '/v1/ops/menus/:scope',
    desk('desk.menus:manage'),
    async (request, reply) => {
      const scope = scopeOf(request.params.scope);
      if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
      try {
        const layout = await saveLayout(scope, request.body ?? {}, who(request));
        await recordAudit({ who: who(request), action: 'menu.save', targetKind: 'menu', targetId: NIL, note: scope });
        return reply.send(layout);
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.post<{ Params: { scope: string }; Body: { name?: string; icon?: string } }>('/v1/ops/menus/:scope/modules', desk('desk.menus:manage'), async (request, reply) => {
    const scope = scopeOf(request.params.scope);
    if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
    try {
      const module = await addModule(scope, { name: request.body?.name ?? '', ...(request.body?.icon ? { icon: request.body.icon } : {}), by: who(request) });
      await recordAudit({ who: who(request), action: 'menu.module', targetKind: 'menu', targetId: NIL, note: `${scope} · ${module.name}` });
      return reply.status(201).send(module);
    } catch (error) {
      return refusal(reply, error);
    }
  });

  app.delete<{ Params: { scope: string; key: string } }>('/v1/ops/menus/:scope/modules/:key', desk('desk.menus:manage'), async (request, reply) => {
    const scope = scopeOf(request.params.scope);
    if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
    try {
      await removeModule(scope, request.params.key);
      await recordAudit({ who: who(request), action: 'menu.module_remove', targetKind: 'menu', targetId: NIL, note: `${scope} · ${request.params.key}` });
      return reply.status(204).send();
    } catch (error) {
      return refusal(reply, error);
    }
  });

  app.post<{ Params: { scope: string }; Body: { name?: string; href?: string; module?: string; icon?: string } }>(
    '/v1/ops/menus/:scope/links',
    desk('desk.menus:manage'),
    async (request, reply) => {
      const scope = scopeOf(request.params.scope);
      if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
      const body = request.body ?? {};
      try {
        const page = await addLink(scope, {
          name: body.name ?? '',
          href: body.href ?? '',
          ...(body.module ? { module: body.module } : {}),
          ...(body.icon ? { icon: body.icon } : {}),
          by: who(request),
        });
        await recordAudit({ who: who(request), action: 'menu.link', targetKind: 'menu', targetId: NIL, note: `${scope} · ${page.name} → ${page.href}` });
        return reply.status(201).send(page);
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.delete<{ Params: { scope: string; key: string } }>('/v1/ops/menus/:scope/links/:key', desk('desk.menus:manage'), async (request, reply) => {
    const scope = scopeOf(request.params.scope);
    if (!scope) return badRequest(reply, 'Хамрах хүрээ буруу.', 'scope is desk or org');
    try {
      await removeLink(scope, request.params.key);
      await recordAudit({ who: who(request), action: 'menu.link_remove', targetKind: 'menu', targetId: NIL, note: `${scope} · ${request.params.key}` });
      return reply.status(204).send();
    } catch (error) {
      return refusal(reply, error);
    }
  });

  /* ── a business: which roles it may hand out, and who holds which ── */

  app.get<{ Params: { id: string } }>('/v1/ops/orgs/:id/access', desk('desk.orgs'), async (request, reply) => {
    const org = await orgById(request.params.id);
    if (!org) return reply.status(404).send({ error: { code: 'NOT_FOUND', message_mn: 'Олдсонгүй.', message_en: 'no such organisation' } });
    const [members, roles, chosen] = await Promise.all([membersOf(org.id), rolesOf('org'), chosenRoles(org.id)]);
    const ids = members.map((m) => m.guestId);
    const [names, contacts] = await Promise.all([displayNamesFor(ids), contactsFor(ids)]);
    const named = new Map(roles.map((r) => [r.key, r.name]));
    return reply.send({
      org: shapeOrg(org),
      roles: roles.map((r) => ({ key: r.key, name: r.name, description: r.description, head: r.head, everyone: r.everyone, open: r.everyone || chosen.includes(r.key) })),
      chosen,
      members: members.map((m) => {
        const c = contacts.get(m.guestId);
        return {
          guest_id: m.guestId,
          name: names.get(m.guestId) ?? null,
          contact: c?.email ?? c?.phone ?? null,
          role: m.role,
          role_name: named.get(m.role) ?? m.role,
          added_at: m.addedAt.toISOString(),
        };
      }),
    });
  });

  /** The roles, beyond those open to every business, that this one may hand out. */
  app.put<{ Params: { id: string }; Body: { keys?: string[] } }>('/v1/ops/orgs/:id/roles', desk('desk.orgs:access'), async (request, reply) => {
    const org = await orgById(request.params.id);
    if (!org) return reply.status(404).send({ error: { code: 'NOT_FOUND', message_mn: 'Олдсонгүй.', message_en: 'no such organisation' } });
    const keys = Array.isArray(request.body?.keys) ? request.body!.keys!.map(String) : [];
    const chosen = await setChosenRoles(org.id, keys, who(request));
    await noteRolesChanged({ orgId: org.id, desk: who(request), at: ctx.clock.now() });
    await recordAudit({ who: who(request), action: 'org.roles', targetKind: 'org', targetId: org.id, note: `${org.name} · ${chosen.join(', ') || 'нэмэлт үүрэггүй'}` });
    return reply.send({ chosen });
  });

  /** The desk sets somebody's role at a business — its head too — from the roles that business may hand out. */
  app.patch<{ Params: { id: string; guestId: string }; Body: { role?: string } }>(
    '/v1/ops/orgs/:id/members/:guestId',
    desk('desk.orgs:access'),
    async (request, reply) => {
      const role = request.body?.role;
      if (typeof role !== 'string' || !role) return badRequest(reply, 'Үүргээ сонгоно уу.', 'role is required');
      try {
        await setRole({ orgId: request.params.id, guestId: request.params.guestId, role, by: who(request), desk: who(request), now: ctx.clock.now() });
        await recordAudit({ who: who(request), action: 'org.member_role', targetKind: 'org', targetId: request.params.id, note: `${request.params.guestId} → ${role}` });
        return reply.send({ guest_id: request.params.guestId, role });
      } catch (error) {
        return orgRefusal(reply, error);
      }
    },
  );
}
