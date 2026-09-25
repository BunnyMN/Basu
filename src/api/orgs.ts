import type { FastifyInstance, FastifyReply } from 'fastify';
import { accountByContact, contactsFor, displayNamesFor, requirePhone } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import {
  ORG_ROLES,
  OrgError,
  addMember,
  can,
  membersOf,
  orgById,
  orgsOf,
  registerOrg,
  removeMember,
  roleIn,
  setRole,
  updateOrg,
  type OrgRole,
  type Organization,
} from '../platform/org/index.js';
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

export const ROLE_WORD: Record<OrgRole, string> = {
  owner: 'эзэн',
  manager: 'менежер',
  staff: 'ажилтан',
  accountant: 'нягтлан',
};

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
    const [names, contacts] = await Promise.all([displayNamesFor(ids), contactsFor(ids)]);
    const seesContacts = can(mine.role, 'members');
    return reply.send({
      org: shapeOrg(org),
      role: mine.role,
      may: {
        members: can(mine.role, 'members'),
        managers: can(mine.role, 'managers'),
        profile: can(mine.role, 'profile'),
      },
      members: members.map((m) => {
        const c = contacts.get(m.guestId);
        const contact = c?.email ?? c?.phone ?? null;
        return {
          guest_id: m.guestId,
          name: names.get(m.guestId) ?? null,
          contact: seesContacts || m.guestId === me ? contact : masked(contact),
          role: m.role,
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
      const role = await roleIn(request.params.id, request.guestId!);
      if (!can(role, 'members')) return orgRefusal(reply, new OrgError('FORBIDDEN', 'cannot add people here'));
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
      if (!body.guest_id || !ORG_ROLES.includes(body.role as OrgRole)) {
        return badRequest(reply, 'Хүн, эрхээ сонгоно уу.', 'guest_id and role are required');
      }
      try {
        await addMember({
          orgId: request.params.id,
          guestId: body.guest_id,
          role: body.role as OrgRole,
          by: request.guestId!,
          now: ctx.clock.now(),
        });
        const org = await orgById(request.params.id);
        await enqueue(ctx, {
          guestId: body.guest_id,
          template: 'org.member',
          title: org?.name ?? 'Байгууллага',
          body: `Таныг «${org?.name ?? ''}» байгууллагад ${ROLE_WORD[body.role as OrgRole]}-аар нэмлээ.`,
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
      const role = request.body?.role as OrgRole;
      if (!ORG_ROLES.includes(role)) return badRequest(reply, 'Эрхээ сонгоно уу.', 'role is required');
      try {
        await setRole({ orgId: request.params.id, guestId: request.params.guestId, role, by: request.guestId! });
        return reply.send({ guest_id: request.params.guestId, role });
      } catch (error) {
        return orgRefusal(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string; guestId: string } }>('/v1/orgs/:id/members/:guestId', guarded, async (request, reply) => {
    try {
      await removeMember({ orgId: request.params.id, guestId: request.params.guestId, by: request.guestId! });
      return reply.status(204).send();
    } catch (error) {
      return orgRefusal(reply, error);
    }
  });
}
