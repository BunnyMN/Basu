import type { FastifyInstance, FastifyReply } from 'fastify';
import { accountByContact, contactsFor, displayNamesFor, requirePhone } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import {
  OrgError,
  accessIn,
  addMember,
  logOf,
  membersOf,
  orgById,
  orgsOf,
  registerOrg,
  removeMember,
  setRole,
  updateOrg,
  type Organization,
} from '../platform/org/index.js';
import { NO_GRANTS, linksOf, mayHandOut, rolesForOrg, rolesOf, type Grants, type Role } from '../platform/access/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';
import type { Guard } from './hardening.js';

/**
 * A person's businesses, from their side.
 *
 * Anybody signed in may register a restaurant or a supplier; they are its
 * owner, and Basu's desk approves it. Once it is active, its owner and
 * managers bring in the people who work there — by the phone or the address
 * that person signs in to Basu with — each with a role.
 */

/** A role's name, as a person reads it in a sentence: «менежер», or whatever Basu called one it made. */
export async function roleWord(key: string): Promise<string> {
  const role = (await rolesOf('org')).find((r) => r.key === key);
  return role ? role.name.toLowerCase() : key;
}

export const shapeOrg = (o: Organization) => ({
  id: o.id,
  name: o.name,
  restaurant: o.restaurant,
  supplier: o.supplier,
  phone: o.phone,
  address: o.address,
  lat: o.lat,
  lon: o.lon,
  tin: o.tin,
  about: o.about,
  state: o.state,
  created_at: o.createdAt.toISOString(),
  decided_at: o.decidedAt?.toISOString() ?? null,
  decline_reason: o.declineReason,
});

/** An organisation's refusal, in the words the person reads. */
export function orgRefusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof OrgError)) return sendError(reply, error);
  const words: Record<OrgError['code'], [number, string]> = {
    NOT_FOUND: [404, 'Олдсонгүй.'],
    FORBIDDEN: [403, 'Танд энэ үйлдлийг хийх эрх алга.'],
    ALREADY_MEMBER: [409, 'Энэ хүн аль хэдийн байгууллагад байна.'],
    LAST_OWNER: [409, 'Байгууллага дор хаяж нэг эзэнтэй байх ёстой.'],
    NOT_PENDING: [409, 'Энэ хүсэлтэд аль хэдийн хариулсан байна.'],
    BAD_INPUT: [400, 'Мэдээллээ шалгана уу.'],
    NO_SUCH_ROLE: [400, 'Энэ байгууллагад ийм үүрэг алга.'],
  };
  const [status, mn] = words[error.code];
  return reply.status(status).send({ error: { code: error.code, message_mn: mn, message_en: error.message } });
}

/** Shown to somebody who is not the owner or a manager: enough to tell who is who. */
const masked = (contact: string | null): string | null => {
  if (!contact) return null;
  if (contact.includes('@')) {
    const [box, domain] = contact.split('@');
    return `${box!.slice(0, 2)}···@${domain}`;
  }
  return `···${contact.slice(-4)}`;
};

export async function registerOrgRoutes(app: FastifyInstance, ctx: Ctx, requireGuest: Guard): Promise<void> {
  const guarded = { preHandler: requireGuest };

  /** What this person may do in that organisation — nothing unless it is active and they are in it. */
  const grantsIn = async (orgId: string, guestId: string): Promise<{ org: Organization | null; role: Role | null; grants: Grants }> => {
    const seat = await accessIn(orgId, guestId);
    return seat ? { org: seat.org, role: seat.role, grants: seat.grants } : { org: await orgById(orgId), role: null, grants: NO_GRANTS };
  };

  /** A role as the business's own pages read it, with whether this person may hand it out. */
  const shapeRole = (r: Role, assignable: boolean) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    head: r.head,
    assignable,
  });

  /** Register a business. The owner is whoever registers it; the desk says yes. */
  app.post<{
    Body: {
      name?: string;
      restaurant?: boolean;
      supplier?: boolean;
      phone?: string;
      address?: string;
      lat?: number;
      lon?: number;
      tin?: string;
      about?: string;
    };
  }>('/v1/orgs', guarded, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.restaurant && !body.supplier) {
      return badRequest(reply, 'Ресторан, нийлүүлэгч хоёрын аль нэгийг сонгоно уу.', 'restaurant or supplier');
    }
    if (!body.phone?.trim() || !body.address?.trim()) {
      return badRequest(reply, 'Холбогдох утас, хаягаа оруулна уу.', 'phone and address are required');
    }
    try {
      const org = await registerOrg({
        guestId: request.guestId!,
        name: body.name ?? '',
        restaurant: Boolean(body.restaurant),
        supplier: Boolean(body.supplier),
        phone: requirePhone(body.phone),
        address: body.address,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lon: typeof body.lon === 'number' ? body.lon : null,
        tin: body.tin ?? null,
        about: body.about ?? null,
        now: ctx.clock.now(),
      });
      return reply.status(201).send({ ...shapeOrg(org), role: 'owner' });
    } catch (error) {
      return orgRefusal(reply, error);
    }
  });

  /** The businesses this person belongs to, and what they are in each. */
  app.get('/v1/orgs/mine', guarded, async (request) => ({
    orgs: (await orgsOf(request.guestId!)).map(({ org, role }) => ({ ...shapeOrg(org), role })),
  }));

  /** One business: its details, and who works there. */
  app.get<{ Params: { id: string } }>('/v1/orgs/:id', guarded, async (request, reply) => {
    const me = request.guestId!;
    const org = await orgById(request.params.id);
    const mine = (await orgsOf(me)).find((m) => m.org.id === request.params.id);
    if (!org || !mine) return orgRefusal(reply, new OrgError('NOT_FOUND', 'no such organisation of yours'));
    const members = await membersOf(org.id);
    const ids = members.map((m) => m.guestId);
    const [names, contacts, open, links, seat] = await Promise.all([
      displayNamesFor(ids),
      contactsFor(ids),
      rolesForOrg(org.id),
      linksOf('org'),
      accessIn(org.id, me),
    ]);
    // A business still waiting grants nothing yet; its registrant sees who is in it.
    const grants = seat?.grants ?? NO_GRANTS;
    const seesContacts = grants.has('org.team:manage');
    const named = new Map((await rolesOf('org')).map((r) => [r.key, r.name]));
    return reply.send({
      org: shapeOrg(org),
      role: mine.role,
      role_name: named.get(mine.role) ?? mine.role,
      permissions: grants.list(),
      may: {
        members: grants.has('org.team:manage'),
        managers: grants.has('org.team:heads'),
        profile: grants.has('org.profile:edit'),
      },
      // The roles this business may hand out, and which of them this person may give.
      roles: open.map((r) => shapeRole(r, org.state === 'active' && mayHandOut(grants, r, org, links))),
      members: members.map((m) => {
        const c = contacts.get(m.guestId);
        const contact = c?.email ?? c?.phone ?? null;
        const role = open.find((r) => r.key === m.role);
        return {
          guest_id: m.guestId,
          name: names.get(m.guestId) ?? null,
          contact: seesContacts || m.guestId === me ? contact : masked(contact),
          role: m.role,
          role_name: named.get(m.role) ?? m.role,
          // Whether this person may change or take out this member: they may hand out the member's role.
          manageable: m.guestId !== me && org.state === 'active' && Boolean(role ? mayHandOut(grants, role, org, links) : grants.has('org.team:heads')),
          added_at: m.addedAt.toISOString(),
          you: m.guestId === me,
        };
      }),
    });
  });

  /** Change the business's details: its owner or a manager. */
  app.patch<{ Params: { id: string }; Body: { name?: string; phone?: string; address?: string; tin?: string; about?: string } }>(
    '/v1/orgs/:id',
    guarded,
    async (request, reply) => {
      const body = request.body ?? {};
      try {
        const org = await updateOrg({
          orgId: request.params.id,
          by: request.guestId!,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone.trim() ? requirePhone(body.phone) : null } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.tin !== undefined ? { tin: body.tin } : {}),
          ...(body.about !== undefined ? { about: body.about } : {}),
        });
        return reply.send(shapeOrg(org));
      } catch (error) {
        return orgRefusal(reply, error);
      }
    },
  );

  /**
   * Find the person to bring in, by exactly the phone or the address they
   * sign in to Basu with — shown by name, so the manager can see it is the
   * right person before adding them. Only for those who may add people.
   */
  app.get<{ Params: { id: string }; Querystring: { contact?: string } }>(
    '/v1/orgs/:id/lookup',
    guarded,
    async (request, reply) => {
      const { grants } = await grantsIn(request.params.id, request.guestId!);
      if (!grants.has('org.team:manage')) return orgRefusal(reply, new OrgError('FORBIDDEN', 'cannot add people here'));
      const found = await accountByContact(request.query.contact ?? '').catch(() => null);
      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message_mn: 'Ийм утас, имэйлтэй бүртгэл олдсонгүй. Тэр хүн эхлээд Basu-д нэг удаа нэвтэрсэн байх ёстой.',
            message_en: 'no account signs in with that',
          },
        });
      }
      return reply.send({ guest_id: found.guestId, name: found.name, contact: found.email ?? found.phone });
    },
  );

  app.post<{ Params: { id: string }; Body: { guest_id?: string; role?: string } }>(
    '/v1/orgs/:id/members',
    guarded,
    async (request, reply) => {
      const body = request.body ?? {};
      if (!body.guest_id || typeof body.role !== 'string' || !body.role) {
        return badRequest(reply, 'Хүн, эрхээ сонгоно уу.', 'guest_id and role are required');
      }
      try {
        await addMember({
          orgId: request.params.id,
          guestId: body.guest_id,
          role: body.role,
          by: request.guestId!,
          now: ctx.clock.now(),
        });
        const org = await orgById(request.params.id);
        await enqueue(ctx, {
          guestId: body.guest_id,
          template: 'org.member',
          title: org?.name ?? 'Байгууллага',
          body: `Таныг «${org?.name ?? ''}» байгууллагад нэмлээ — үүрэг: ${await roleWord(body.role)}.`,
          channel: 'push',
          subject: 'org',
          subjectId: request.params.id,
          dedupeKey: `org:${request.params.id}:member:${body.guest_id}:${ctx.clock.now().getTime()}`,
        });
        return reply.status(201).send({ guest_id: body.guest_id, role: body.role });
      } catch (error) {
        return orgRefusal(reply, error);
      }
    },
  );

  app.patch<{ Params: { id: string; guestId: string }; Body: { role?: string } }>(
    '/v1/orgs/:id/members/:guestId',
    guarded,
    async (request, reply) => {
      const role = request.body?.role;
      if (typeof role !== 'string' || !role) return badRequest(reply, 'Эрхээ сонгоно уу.', 'role is required');
      try {
        await setRole({ orgId: request.params.id, guestId: request.params.guestId, role, by: request.guestId!, now: ctx.clock.now() });
        return reply.send({ guest_id: request.params.guestId, role });
      } catch (error) {
        return orgRefusal(reply, error);
      }
    },
  );

  /**
   * Who gave whom which role, newest first — for the owner and the managers,
   * who answer for who can see the money.
   */
  app.get<{ Params: { id: string } }>('/v1/orgs/:id/log', guarded, async (request, reply) => {
    const { grants } = await grantsIn(request.params.id, request.guestId!);
    if (!grants.has('org.log')) return orgRefusal(reply, new OrgError('FORBIDDEN', 'the record is the owner’s and the managers’'));
    const entries = await logOf(request.params.id, 100);
    const ids = [...new Set(entries.flatMap((e) => [e.byGuest, e.guestId]).filter((x): x is string => Boolean(x)))];
    const names = await displayNamesFor(ids);
    const named = new Map((await rolesOf('org')).map((r) => [r.key, r.name]));
    return reply.send({
      log: entries.map((e) => ({
        id: e.id,
        action: e.action,
        by: e.byDesk ? `Basu · ${e.byDesk.replace(/^ops:/, '')}` : e.byGuest ? names.get(e.byGuest) ?? null : null,
        who: e.guestId ? names.get(e.guestId) ?? null : null,
        role: e.role,
        was: e.was,
        role_name: e.roleName ?? named.get(e.role ?? '') ?? e.role,
        was_name: e.wasName ?? named.get(e.was ?? '') ?? e.was,
        at: e.at.toISOString(),
      })),
    });
  });

  app.delete<{ Params: { id: string; guestId: string } }>('/v1/orgs/:id/members/:guestId', guarded, async (request, reply) => {
    try {
      await removeMember({ orgId: request.params.id, guestId: request.params.guestId, by: request.guestId!, now: ctx.clock.now() });
      return reply.status(204).send();
    } catch (error) {
      return orgRefusal(reply, error);
    }
  });
}
