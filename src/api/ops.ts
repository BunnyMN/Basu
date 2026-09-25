import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CANCEL_REASONS,
  allOrders,
  approveSettlement,
  approveSupplier,
  cancelIdesh,
  createSupplierCode,
  declineSupplier,
  hideListing,
  IdeshError,
  listAudit,
  listSettlements,
  listSuppliers,
  listingsOf,
  markHanded,
  markSettled,
  orderForOps,
  recordAudit,
  registerSupplier,
  resendForOps,
  setSupplierActive,
  statsFor,
  updateSupplier,
  verifySupplierBank,
  type CancelReason,
  type IdeshState,
  type OrderScope,
  type SupplierRow,
  type Tally,
  supplierForOrg,
} from '../idesh/index.js';
import { limits } from './hardening.js';
import { need, needAny } from './guards.js';
import { grantsOf, linksOf, mayHandOutDesk, roleOf, type Grants, type RoleShape } from '../platform/access/index.js';
import { shapeOrder, shapeSettlement } from './shapes.js';
import { overviewAt } from './overview.js';
import { closeGuest, guestFile, guestSearch } from './guests.js';
import { registerDineDesk } from './dineDesk.js';
import { registerMoneyDesk } from './moneyDesk.js';
import { registerSystemDesk } from './systemDesk.js';
import { registerAccessDesk } from './accessDesk.js';
import { revokeSession } from '../platform/identity/index.js';
import { mode } from '../mode.js';
import { badRequest, forbidden, sendError, unauthorized } from './errors.js';
import {
  RequestError,
  MemberError,
  deskRoleExists,
  approveRequest,
  declineRequest,
  linkByProof,
  listMembers,
  memberForAccount,
  pendingRequests,
  requestAccess,
  requestOf,
  setMemberActive,
  setMemberRole,
  upsertMember,
  type AccessRequest,
  type Member,
  type Role,
} from '../ops/index.js';
import { accountByContact, contactsFor, profileOf, resolveGuest } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import { approveOrg, declineOrg, listOrgs, membersOf, orgById } from '../platform/org/index.js';
import { orgRefusal, shapeOrg } from './orgs.js';
import type { Ctx } from '../ports.js';

/**
 * Ops: the few people at Basu who sign contracts and move money.
 *
 * They sign in like anybody — Google, a code by email, a password — and
 * what makes the session ops is that the account holds a seat on the desk's
 * own list, with a role: asked for by the person and granted by an admin, or
 * named by an address the account proved. Every action is recorded under
 * that member. The shared
 * `OPS_TOKEN` of the first weeks is kept only for the demo, where a
 * walkthrough needs a desk without a phone; in production it opens nothing.
 */

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module 'fastify' {
  interface FastifyRequest {
    ops?: DeskSeat;
  }
}

let minted: string | null = null;

/** The demo's shared secret, or null when there is none to hand out. */
export function opsToken(): string | null {
  if (mode() === 'production') return null;
  const configured = process.env['OPS_TOKEN']?.trim();
  if (configured) return configured;
  minted ??= randomBytes(18).toString('base64url');
  return minted;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The seat this account sits in, if any. First time at the desk, a seat is
 * taken only with an address the account has proved — an email somebody
 * vouched for, or a number an SMS code reached, that a member is named by.
 * A number merely typed at sign-up is not one.
 */
export async function seatOf(guestId: string): Promise<Member | null> {
  const member = await memberForAccount(guestId);
  if (member) return member;
  const contact = (await contactsFor([guestId])).get(guestId);
  return linkByProof({
    guestId,
    email: contact?.email ?? null,
    phone: contact?.phoneVerified ? contact.phone : null,
  });
}

export interface DeskSeat {
  id: string;
  name: string;
  /** The key of the member's desk role, and its name as Basu wrote it. */
  role: Role;
  roleName: string;
  /** In the locked role — the desk's admin — that opens everything. */
  locked: boolean;
  phone: string | null;
  email: string | null;
  /** What the role opens, from `platform/access`. */
  grants: Grants;
}

/** The desk's admin, as the demo's shared secret sits: locked, everything. */
const DEMO_ROLE: RoleShape = { scope: 'desk', key: 'admin', name: 'Админ', permissions: [], locked: true, head: false };

/**
 * Who a bearer token is at the desk: the demo's shared secret is one admin
 * with no account behind it; anybody else is the active member their
 * account sits as, with what their role opens — or nobody, and nobody too
 * when their role has gone. `guestId` is the account, when there is one.
 */
export async function deskSeatFor(ctx: Ctx, token: string | undefined): Promise<{ guestId: string | null; seat: DeskSeat | null }> {
  if (!token) return { guestId: null, seat: null };
  const links = await linksOf('desk');
  const shared = opsToken();
  if (shared && same(token, shared)) {
    const role = (await roleOf('desk', 'admin')) ?? DEMO_ROLE;
    return {
      guestId: null,
      seat: { id: 'demo', name: 'Демо', role: 'admin', roleName: role.name, locked: true, phone: null, email: null, grants: grantsOf({ ...role, locked: true }, links) },
    };
  }
  const guestId = await resolveGuest(ctx, token);
  if (!guestId) return { guestId: null, seat: null };
  const member = await seatOf(guestId);
  const role = member?.active ? await roleOf('desk', member.role) : null;
  if (!member?.active || !role) return { guestId, seat: null };
  return {
    guestId,
    seat: {
      id: member.id,
      name: member.name,
      role: member.role,
      roleName: role.name,
      locked: role.locked,
      phone: member.phone,
      email: member.email,
      grants: grantsOf(role, links),
    },
  };
}

const shape = (s: SupplierRow) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  merchant_tin: s.merchantTin,
  pickup_address: s.pickupAddress,
  about: s.about,
  lat: s.lat,
  lon: s.lon,
  state: s.state,
  active: s.active,
  applied_at: s.appliedAt?.toISOString() ?? null,
  contracted_at: s.contractedAt?.toISOString() ?? null,
  decline_reason: s.declineReason,
  commission_pct: s.commissionPct,
  bank_name: s.bankName,
  bank_account: s.bankAccount,
  bank_holder: s.bankHolder,
  bank_verified: s.bankVerified,
  bank_changed_at: s.bankChangedAt?.toISOString() ?? null,
  watched: s.watched,
  listings: s.listings,
});


export async function registerOpsRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  opts: { dev: boolean },
): Promise<void> {
  const requireOps: Guard = async (request, reply) => {
    const { seat } = await deskSeatFor(ctx, bearer(request));
    if (!seat) return unauthorized(reply);
    request.ops = seat;
    request.grants = seat.grants;
    return undefined;
  };

  /** Anybody signed in — the dashboard's front room, before a seat. */
  const requireAccount: Guard = async (request, reply) => {
    const sent = bearer(request);
    const guestId = sent ? await resolveGuest(ctx, sent) : null;
    if (!guestId) return unauthorized(reply);
    request.guestId = guestId;
    return undefined;
  };
  const limit = { rateLimit: limits().ops };
  /** Any seat at the desk — who am I. */
  const asOps = { preHandler: requireOps, config: limit };
  /**
   * A desk route: a seat that holds the permission the route names. Which
   * role holds what is `platform/access`'s table, the same one the menu is
   * drawn from.
   */
  const desk = (permission: string) => ({ preHandler: [requireOps, need(permission)], config: limit });
  /** A desk route two pages read from: a seat that holds either page. */
  const deskAny = (...permissions: string[]) => ({ preHandler: [requireOps, needAny(...permissions)], config: limit });

  /** Who is acting, for the record: the member the session belongs to. */
  const who = (request: FastifyRequest) => `ops:${request.ops?.name ?? '?'}`;

  /**
   * Whether this seat may seat somebody in that desk role: the role opens
   * nothing the seat does not hold, and only somebody in the locked admin
   * role seats an admin. Whoever may manage members may not make themselves
   * — or a friend — more than they are.
   */
  const mayGive = async (request: FastifyRequest, key: string): Promise<boolean> => {
    const role = await roleOf('desk', key);
    return Boolean(role && mayHandOutDesk(request.grants!, role, await linksOf('desk'), request.ops!.locked));
  };
  const beyond = (reply: FastifyReply) => forbidden(reply, 'that role opens more than you hold');

  /** Who am I at the desk — what the page asks after signing in. */
  app.get('/v1/ops/me', asOps, async (request) => ({
    member: {
      id: request.ops!.id,
      name: request.ops!.name,
      role: request.ops!.role,
      role_name: request.ops!.roleName,
      phone: request.ops!.phone,
      email: request.ops!.email,
    },
  }));

  /* ── the front room: anybody signed in ── */

  const shapeRequest = (r: AccessRequest) => ({
    id: r.id,
    name: r.name,
    contact: r.contact,
    role: r.role,
    note: r.note,
    state: r.state,
    created_at: r.createdAt.toISOString(),
    decided_at: r.decidedAt?.toISOString() ?? null,
    decline_reason: r.declineReason,
  });

  /**
   * Who is signed in, whether they sit at the desk, and what they asked for.
   * The dashboard's first question: a member gets the desk, anybody else
   * their profile and the way to ask for a seat.
   */
  app.get('/v1/ops/whoami', { preHandler: requireAccount, config: limit }, async (request) => {
    const guestId = request.guestId!;
    const [profile, member, asked] = await Promise.all([profileOf(guestId), seatOf(guestId), requestOf(guestId)]);
    return {
      account: {
        id: guestId,
        name: profile?.displayName ?? null,
        email: profile?.email ?? null,
        phone: profile?.phone ?? null,
      },
      member: member?.active ? { id: member.id, name: member.name, role: member.role, phone: member.phone, email: member.email } : null,
      request: asked ? shapeRequest(asked) : null,
    };
  });

  const requestRefusal = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof RequestError)) return sendError(reply, error);
    const words = {
      ALREADY_MEMBER: [409, 'Та аль хэдийн гишүүн байна.'],
      NOT_PENDING: [409, 'Энэ хүсэлтэд аль хэдийн хариулсан байна.'],
      BAD_REQUEST: [400, 'Нэр, эрхээ шалгана уу.'],
    } as const;
    const [status, mn] = words[error.code];
    return reply.status(status).send({ error: { code: error.code, message_mn: mn, message_en: error.message } });
  };

  /** Ask for a seat, or change the ask while it waits. */
  app.post<{ Body: { name?: string; role?: string; note?: string } }>(
    '/v1/ops/requests',
    { preHandler: requireAccount, config: limit },
    async (request, reply) => {
      const guestId = request.guestId!;
      const body = request.body ?? {};
      const contact = (await contactsFor([guestId])).get(guestId);
      try {
        const asked = await requestAccess({
          guestId,
          name: body.name ?? '',
          contact: contact?.email ?? contact?.phone ?? null,
          role: (body.role ?? 'ops') as Role,
          note: body.note ?? null,
          now: ctx.clock.now(),
        });
        return reply.status(201).send(shapeRequest(asked));
      } catch (error) {
        return requestRefusal(reply, error);
      }
    },
  );

  /* ── businesses: the desk says yes or no ── */

  /** Every organisation, what waits first, with who registered it. */
  app.get('/v1/ops/orgs', desk('desk.orgs'), async () => {
    const orgs = await listOrgs();
    const owners = await contactsFor(orgs.map((o) => o.appliedBy));
    const counts = await Promise.all(orgs.map((o) => membersOf(o.id).then((m) => m.length)));
    return {
      orgs: orgs.map((o, i) => {
        const c = owners.get(o.appliedBy);
        return { ...shapeOrg(o), applicant: c?.email ?? c?.phone ?? null, members: counts[i] };
      }),
    };
  });

  const tellOwner = (guestId: string, id: string, title: string, body: string) =>
    enqueue(ctx, { guestId, template: 'org.decision', title, body, channel: 'push', subject: 'org', subjectId: id, dedupeKey: `org:${id}:decision` });

  /**
   * Yes. The organisation is active; a supplier organisation gets its
   * supplier at once, contracted, owned by whoever registered it.
   */
  app.post<{ Params: { id: string } }>('/v1/ops/orgs/:id/approve', desk('desk.orgs:decide'), async (request, reply) => {
    try {
      const pending = await orgById(request.params.id);
      if (pending?.supplier && pending.state === 'applied' && (!pending.phone || !pending.address)) {
        return badRequest(reply, 'Нийлүүлэгчид утас, хаяг заавал хэрэгтэй.', 'a supplier needs a phone and an address');
      }
      const org = await approveOrg({ id: request.params.id, by: who(request), now: ctx.clock.now() });
      if (org.supplier) {
        await supplierForOrg({
          orgId: org.id,
          ownerId: org.appliedBy,
          name: org.name,
          phone: org.phone!,
          address: org.address!,
          lat: org.lat,
          lon: org.lon,
          tin: org.tin,
          about: org.about,
        });
      }
      await recordAudit({ who: who(request), action: 'org.approve', targetKind: 'org', targetId: org.id, note: org.name });
      await tellOwner(org.appliedBy, org.id, 'Байгууллага батлагдлаа', `«${org.name}» Basu дээр батлагдлаа. basu.burzai.cloud/dashboard-д ажилтнуудаа нэмж болно.`);
      return reply.send(shapeOrg(org));
    } catch (error) {
      return orgRefusal(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/v1/ops/orgs/:id/decline', desk('desk.orgs:decide'), async (request, reply) => {
    try {
      const org = await declineOrg({ id: request.params.id, reason: request.body?.reason ?? null, by: who(request), now: ctx.clock.now() });
      await recordAudit({ who: who(request), action: 'org.decline', targetKind: 'org', targetId: org.id, note: `${org.name}${org.declineReason ? ` · ${org.declineReason}` : ''}` });
      await tellOwner(org.appliedBy, org.id, 'Байгууллагын бүртгэл', `«${org.name}»-ийг батлах боломжгүй байлаа.${org.declineReason ? ` Шалтгаан: ${org.declineReason}.` : ''}`);
      return reply.send(shapeOrg(org));
    } catch (error) {
      return orgRefusal(reply, error);
    }
  });

  /* ── the members, admin only ── */

  app.get('/v1/ops/requests', desk('desk.members'), async () => ({ requests: (await pendingRequests()).map(shapeRequest) }));

  /** Tell the person how it went — in the app, and by email where they have one. */
  const tellRequester = (guestId: string, id: string, title: string, body: string) =>
    enqueue(ctx, { guestId, template: 'ops.request', title, body, channel: 'push', subject: 'ops_request', subjectId: id, dedupeKey: `ops_request:${id}` });

  app.post<{ Params: { id: string }; Body: { role?: string } }>('/v1/ops/requests/:id/approve', desk('desk.members:manage'), async (request, reply) => {
    const role = request.body?.role ? (request.body.role as Role) : null;
    try {
      const waiting = (await pendingRequests()).find((r) => r.id === request.params.id);
      if (waiting && !(await mayGive(request, role ?? waiting.role))) return beyond(reply);
      const contact = waiting ? (await contactsFor([waiting.guestId])).get(waiting.guestId) : undefined;
      const { request: decided, member } = await approveRequest({
        id: request.params.id,
        role,
        by: who(request),
        now: ctx.clock.now(),
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
      });
      await recordAudit({ who: who(request), action: 'member.approve', targetKind: 'member', targetId: member.id, note: `${member.name} · ${member.role}` });
      await tellRequester(decided.guestId, decided.id, 'Ops эрх олголоо', `Таны Basu ops-ийн хүсэлт батлагдлаа (${member.role}). basu.burzai.cloud/dashboard-д нэвтэрнэ үү.`);
      return reply.send({ request: shapeRequest(decided), member: shapeMember(member) });
    } catch (error) {
      return requestRefusal(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/v1/ops/requests/:id/decline', desk('desk.members:manage'), async (request, reply) => {
    try {
      const decided = await declineRequest({ id: request.params.id, reason: request.body?.reason ?? null, by: who(request), now: ctx.clock.now() });
      await recordAudit({ who: who(request), action: 'member.decline', targetKind: 'member', targetId: decided.id, note: `${decided.name}${decided.declineReason ? ` · ${decided.declineReason}` : ''}` });
      await tellRequester(decided.guestId, decided.id, 'Ops эрхийн хүсэлт', `Таны Basu ops-ийн хүсэлтийг батлах боломжгүй байлаа.${decided.declineReason ? ` Шалтгаан: ${decided.declineReason}.` : ''}`);
      return reply.send({ request: shapeRequest(decided) });
    } catch (error) {
      return requestRefusal(reply, error);
    }
  });

  const shapeMember = (m: Member) => ({
    id: m.id,
    phone: m.phone,
    email: m.email,
    name: m.name,
    role: m.role,
    active: m.active,
    // Nobody has come in as this member yet: the address has not signed in.
    joined: m.accounts > 0,
    created_at: m.createdAt.toISOString(),
  });

  app.get('/v1/ops/members', desk('desk.members'), async () => ({ members: (await listMembers()).map(shapeMember) }));

  /**
   * A seat for an email address, before its person has asked: the address
   * proves itself — Google, Apple or a code to that inbox — and the account
   * that proves it sits down. A phone number proves nothing when anybody can
   * type it, so a person who signs in by phone asks for their seat instead.
   */
  app.post<{ Body: { email?: string; name?: string; role?: string } }>('/v1/ops/members', desk('desk.members:manage'), async (request, reply) => {
    const body = request.body ?? {};
    if (!body.email?.trim()) return badRequest(reply, 'Имэйл хаягаа оруулна уу.', 'email is required');
    if (!(await mayGive(request, body.role ?? 'ops'))) return beyond(reply);
    try {
      const member = await upsertMember({ email: body.email, name: body.name ?? '', role: (body.role ?? 'ops') as Role });
      await recordAudit({
        who: who(request),
        action: 'member.upsert',
        targetKind: 'member',
        targetId: member.id,
        note: `${member.name} · ${member.role} · ${member.email ?? ''}`,
      });
      return reply.status(201).send(shapeMember(member));
    } catch (error) {
      return badRequest(reply, 'Имэйл, нэр, эрхээ шалгана уу.', (error as Error).message);
    }
  });

  /** Another role for somebody already at the desk — never your own, and never the last admin's. */
  app.post<{ Params: { id: string }; Body: { role?: string } }>('/v1/ops/members/:id/role', desk('desk.members:manage'), async (request, reply) => {
    const role = request.body?.role as Role | undefined;
    if (!role || !(await deskRoleExists(role))) return badRequest(reply, 'Эрх буруу байна.', `no such role: ${request.body?.role}`);
    if (request.params.id === request.ops!.id) return badRequest(reply, 'Өөрийн эрхийг өөрчлөх боломжгүй.', 'cannot change your own role');
    if (!(await mayGive(request, role))) return beyond(reply);
    // Nor take a seat out of a role that opens more than the seat taking it.
    const current = (await listMembers()).find((m) => m.id === request.params.id);
    if (current && !(await mayGive(request, current.role))) return beyond(reply);
    try {
      const member = await setMemberRole(request.params.id, role);
      await recordAudit({ who: who(request), action: 'member.role', targetKind: 'member', targetId: member.id, note: `${member.name} · ${member.role}` });
      return reply.send(shapeMember(member));
    } catch (error) {
      if (error instanceof MemberError && error.code === 'LAST_ADMIN') {
        return reply.status(409).send({ error: { code: 'LAST_ADMIN', message_mn: 'Ядаж нэг идэвхтэй админ үлдэх ёстой.', message_en: error.message } });
      }
      return sendError(reply, new IdeshError('NOT_FOUND', (error as Error).message));
    }
  });

  app.post<{ Params: { id: string }; Body: { active?: boolean } }>('/v1/ops/members/:id/active', desk('desk.members:manage'), async (request, reply) => {
    if (typeof request.body?.active !== 'boolean') return badRequest(reply, 'active: true эсвэл false.', 'active must be a boolean');
    if (request.params.id === request.ops!.id && !request.body.active) return badRequest(reply, 'Өөрийгөө хаах боломжгүй.', 'cannot deactivate yourself');
    try {
      await setMemberActive(request.params.id, request.body.active);
      await recordAudit({ who: who(request), action: request.body.active ? 'member.activate' : 'member.deactivate', targetKind: 'member', targetId: request.params.id });
      return reply.send({ id: request.params.id, active: request.body.active });
    } catch (error) {
      return sendError(reply, new IdeshError('NOT_FOUND', (error as Error).message));
    }
  });

  /** Everybody who is, or asked to be, a supplier. Applications first. */
  app.get('/v1/ops/suppliers', deskAny('desk.suppliers', 'desk.orders'), async () => ({
    suppliers: (await listSuppliers()).map(shape),
  }));

  /**
   * Ops writes a contracted supplier straight in, as the script does. Its
   * owner is a Basu account that already exists — named by its phone or
   * email, the supplier's phone when not given — and holds the business's
   * owner role from the start; the people who work there come in by that
   * role, as in any business.
   */
  app.post<{
    Body: {
      name?: string;
      phone?: string;
      owner?: string;
      tin?: string;
      address?: string;
      lat?: number;
      lon?: number;
      bank_name?: string;
      bank_account?: string;
      bank_holder?: string;
    };
  }>('/v1/ops/suppliers', desk('desk.suppliers:manage'), async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.phone || !body.address?.trim()) {
      return badRequest(reply, 'Нэр, утас, авах цэгээ оруулна уу.', 'name, phone and address are required');
    }
    if (!/^\+976\d{8}$/.test(body.phone)) {
      return badRequest(reply, 'Утас +976XXXXXXXX хэлбэртэй байх ёстой.', 'phone must be +976XXXXXXXX');
    }
    const owner = await accountByContact(body.owner?.trim() || body.phone);
    if (!owner) {
      return reply.status(400).send({
        error: {
          code: 'NO_ACCOUNT',
          message_mn: 'Эзэмшигч Basu-д бүртгэлгүй байна. Тэр хүн эхлээд Basu-д нэвтэрч бүртгүүлнэ, дараа нь түүний утас эсвэл имэйлээр энд бүртгэнэ.',
          message_en: 'the owner has no Basu account',
        },
      });
    }
    try {
      const id = await registerSupplier({
        ownerId: owner.guestId,
        name: body.name,
        phone: body.phone,
        merchantTin: body.tin?.trim() || null,
        pickupAddress: body.address,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lon: typeof body.lon === 'number' ? body.lon : null,
        bankName: body.bank_name,
        bankAccount: body.bank_account,
        bankHolder: body.bank_holder,
      });
      const code = await createSupplierCode(ctx, id, 'Нийлүүлэгчийн дэлгэц', 24 * 60);
      return reply.status(201).send({ id, pairing_code: code, expires_in_minutes: 24 * 60 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/approve', desk('desk.suppliers:manage'), async (request, reply) => {
    try {
      const { pairingCode } = await approveSupplier(ctx, request.params.id);
      return reply.send({ state: 'contracted', pairing_code: pairingCode });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/v1/ops/suppliers/:id/decline',
    desk('desk.suppliers:manage'),
    async (request, reply) => {
      try {
        await declineSupplier(ctx, request.params.id, request.body?.reason ?? '');
        return reply.send({ state: 'declined' });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** The contract's terms, written in by whoever signed it. */
  app.patch<{
    Params: { id: string };
    Body: { commission_pct?: number; tin?: string; bank_name?: string; bank_account?: string; bank_holder?: string };
  }>('/v1/ops/suppliers/:id', desk('desk.suppliers:terms'), async (request, reply) => {
    const body = request.body ?? {};
    if (body.commission_pct !== undefined && typeof body.commission_pct !== 'number') {
      return badRequest(reply, 'Шимтгэл тоо байх ёстой.', 'commission_pct must be a number');
    }
    try {
      await updateSupplier(request.params.id, {
        commissionPct: body.commission_pct,
        merchantTin: body.tin,
        bankName: body.bank_name,
        bankAccount: body.bank_account,
        bankHolder: body.bank_holder,
      });
      await recordAudit({ who: who(request), action: 'supplier.terms', targetKind: 'supplier', targetId: request.params.id, note: body.commission_pct !== undefined ? `шимтгэл ${body.commission_pct}%` : null });
      const row = (await listSuppliers()).find((s) => s.id === request.params.id);
      return reply.send(row ? shape(row) : { id: request.params.id });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ── every order, through one window ── */

  app.get<{ Querystring: { scope?: string; state?: string; supplier?: string; day?: string; q?: string } }>(
    '/v1/ops/orders',
    desk('desk.orders'),
    async (request) => {
      const raw = request.query.scope;
      const scope: OrderScope = raw === 'live' || raw === 'done' ? raw : 'all';
      const orders = await allOrders({
        scope,
        state: request.query.state ? (request.query.state as IdeshState) : undefined,
        supplierId: request.query.supplier || undefined,
        day: /^\d{4}-\d{2}-\d{2}$/.test(request.query.day ?? '') ? request.query.day : undefined,
        q: request.query.q ?? '',
        limit: 200,
      });
      return { orders: orders.map(shapeOrder) };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/ops/orders/:id', desk('desk.orders'), async (request, reply) => {
    const found = await orderForOps(request.params.id);
    if (!found) return sendError(reply, new IdeshError('NOT_FOUND', 'no such order'));
    return reply.send({
      order: shapeOrder(found.order),
      events: found.events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.at.toISOString() })),
      settlements: found.settlements.map(shapeSettlement),
    });
  });

  /**
   * On somebody's behalf: cancel for a reason, mark handed over, say a
   * message again. Each is the supplier's own action done by ops, recorded
   * in the order's story as ops and in the audit with the note they typed.
   */
  app.post<{ Params: { id: string; action: string }; Body: { reason?: string; note?: string } }>(
    '/v1/ops/orders/:id/:action',
    desk('desk.orders:manage'),
    async (request, reply) => {
      const { id, action } = request.params;
      const body = request.body ?? {};
      const actor = who(request);
      try {
        let result: Record<string, unknown>;
        switch (action) {
          case 'cancel': {
            const reason = body.reason;
            if (!reason || !(CANCEL_REASONS as readonly string[]).includes(reason)) {
              throw new IdeshError('BAD_REASON', 'шалтгаанаа сонгоно уу');
            }
            const split = await cancelIdesh(ctx, id, { actor, role: 'ops' }, reason as CancelReason);
            result = { state: 'CANCELLED', refund_mnt: split.refundMnt, forfeit_mnt: split.forfeitMnt };
            break;
          }
          case 'hand':
            await markHanded(ctx, id, actor);
            result = { state: 'HANDED' };
            break;
          case 'resend':
            result = { state: await resendForOps(ctx, id, actor) };
            break;
          default:
            return badRequest(reply, 'Ийм үйлдэл алга.', `no such action: ${action}`);
        }
        await recordAudit({ who: actor, action: `order.${action}`, targetKind: 'order', targetId: id, note: body.note ?? body.reason ?? null });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  registerDineDesk(app, ctx, { desk, deskAny, who });
  registerMoneyDesk(app, ctx, { desk, who });
  registerSystemDesk(app, ctx, { desk, who });
  registerAccessDesk(app, ctx, { desk, deskAny, who });

  /* ── the guests ── */

  app.get<{ Querystring: { q?: string } }>('/v1/ops/guests', desk('desk.guests'), async (request) => guestSearch(request.query.q ?? ''));

  app.get<{ Params: { id: string } }>('/v1/ops/guests/:id', desk('desk.guests'), async (request, reply) => {
    const file = await guestFile(request.params.id);
    if (!file) return sendError(reply, new IdeshError('NOT_FOUND', 'no such guest'));
    return reply.send(file);
  });

  /** A phone is gone: sign that one out. */
  app.post<{ Params: { id: string; sid: string }; Body: { note?: string } }>(
    '/v1/ops/guests/:id/sessions/:sid/revoke',
    desk('desk.guests:sessions'),
    async (request, reply) => {
      const gone = await revokeSession(request.params.id, request.params.sid, ctx.clock.now());
      if (!gone) return sendError(reply, new IdeshError('NOT_FOUND', 'no such open session'));
      await recordAudit({ who: who(request), action: 'guest.session_revoke', targetKind: 'guest', targetId: request.params.id, note: request.body?.note ?? null });
      return reply.send({ revoked: true });
    },
  );

  /** Closing on somebody's behalf: admin only, a reason required, the same two refusals the app has. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/guests/:id/close', desk('desk.guests:close'), async (request, reply) => {
    const note = request.body?.note?.trim();
    if (!note) return badRequest(reply, 'Шалтгаан бичнэ үү.', 'note required');
    try {
      await closeGuest(request.params.id, ctx.clock.now());
      await recordAudit({ who: who(request), action: 'guest.close', targetKind: 'guest', targetId: request.params.id, note });
      return reply.send({ closed: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ── the numbers ── */

  const shapeTally = (t: Tally) => ({
    paid: t.paid,
    sales_mnt: t.salesMnt,
    handed: t.handed,
    commission_mnt: t.commissionMnt,
    cancelled: t.cancelled,
    supplier_fault: t.supplierFault,
    guest_fault: t.guestFault,
    refund_mnt: t.refundMnt,
    forfeit_mnt: t.forfeitMnt,
  });

  /** The whole house, cut three ways, and what needs somebody today. */
  app.get('/v1/ops/overview', desk('desk.overview'), async () => overviewAt(ctx.clock.now()));

  app.get('/v1/ops/stats', desk('desk.stats'), async () => {
    const stats = await statsFor(ctx.clock.now());
    return {
      today: shapeTally(stats.today),
      week: shapeTally(stats.week),
      season: shapeTally(stats.season),
      suppliers: stats.suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        active: s.active,
        paid: s.paid,
        handed: s.handed,
        cancelled: s.cancelled,
        supplier_fault: s.supplierFault,
        no_shows: s.noShows,
        sales_mnt: s.salesMnt,
        commission_mnt: s.commissionMnt,
        ready_hours: s.readyHours,
      })),
      by_kind: stats.byKind.map((k) => ({ kind: k.kind, unit: k.unit, qty: k.qty, orders: k.orders, sales_mnt: k.salesMnt })),
    };
  });

  /** One supplier's listings, for the desk to look at and, if need be, hide. */
  app.get<{ Params: { id: string } }>('/v1/ops/suppliers/:id/listings', desk('desk.suppliers'), async (request) => ({
    listings: (await listingsOf(request.params.id)).map((l) => ({
      id: l.id,
      kind: l.kind,
      unit: l.unit,
      title: l.title,
      price_mnt: l.priceMnt,
      quantity: l.quantity,
      sold: l.sold,
      active: l.active,
      ready_from: l.readyFrom,
    })),
  }));

  /* ── taking things off the market, and the record of it ── */

  app.post<{ Params: { id: string }; Body: { active?: boolean; note?: string } }>(
    '/v1/ops/suppliers/:id/active',
    desk('desk.suppliers:manage'),
    async (request, reply) => {
      const active = request.body?.active;
      if (typeof active !== 'boolean') return badRequest(reply, 'active: true эсвэл false.', 'active must be a boolean');
      try {
        await setSupplierActive(request.params.id, active);
        await recordAudit({ who: who(request), action: active ? 'supplier.activate' : 'supplier.suspend', targetKind: 'supplier', targetId: request.params.id, note: request.body?.note ?? null });
        const row = (await listSuppliers()).find((s) => s.id === request.params.id);
        return reply.send(row ? shape(row) : { id: request.params.id, active });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** Finance has held the account up against the contract: money may go there now. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/suppliers/:id/bank-verify', desk('desk.suppliers:terms'), async (request, reply) => {
    try {
      await verifySupplierBank(request.params.id);
      await recordAudit({ who: who(request), action: 'supplier.bank_verify', targetKind: 'supplier', targetId: request.params.id, note: request.body?.note ?? null });
      const row = (await listSuppliers()).find((s) => s.id === request.params.id);
      return reply.send(row ? shape(row) : { id: request.params.id, bank_verified: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/listings/:id/hide', desk('desk.suppliers:manage'), async (request, reply) => {
    try {
      await hideListing(request.params.id, ctx.clock.now());
      await recordAudit({ who: who(request), action: 'listing.hide', targetKind: 'listing', targetId: request.params.id, note: request.body?.note ?? null });
      return reply.send({ id: request.params.id, active: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/ops/audit', desk('desk.audit'), async (request) => ({
    audit: (await listAudit({ limit: Math.min(Number(request.query.limit) || 100, 500) })).map((a) => ({
      id: a.id,
      who: a.who,
      action: a.action,
      target_kind: a.targetKind,
      target_id: a.targetId,
      note: a.note,
      at: a.at.toISOString(),
    })),
  }));

  /* ── the list to pay ── */

  /** Everything owed outside, unpaid first. */
  app.get('/v1/ops/settlements', desk('desk.pay'), async () => ({
    settlements: (await listSettlements()).map(shapeSettlement),
  }));

  /** «Батлах»: this one should be paid. The person who presses it may not be the one who pays. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/ops/settlements/:id/approve',
    desk('desk.pay:approve'),
    async (request, reply) => {
      try {
        const released = await approveSettlement(request.params.id, who(request), ctx.clock.now());
        await recordAudit({
          who: who(request),
          action: 'settlement.approve',
          targetKind: 'settlement',
          targetId: request.params.id,
          note: request.body?.note ?? `${released.memo} ${released.amountMnt}₮`,
        });
        return reply.send(shapeSettlement(released));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** «Шилжүүлсэн»: the bank transfer was made by hand; the ledger and the person owed hear of it. */
  app.post<{ Params: { id: string }; Body: { reference?: string } }>(
    '/v1/ops/settlements/:id/paid',
    desk('desk.pay:approve'),
    async (request, reply) => {
      try {
        const paid = await markSettled(ctx, request.params.id, who(request), request.body?.reference ?? '');
        await recordAudit({
          who: who(request),
          action: 'settlement.paid',
          targetKind: 'settlement',
          targetId: request.params.id,
          note: `${paid.memo} ${paid.amountMnt}₮ · ${paid.reference ?? 'лавлахгүй'} · баталсан ${paid.approvedBy ?? '—'}`,
        });
        return reply.send(shapeSettlement(paid));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** A fresh code — a lost phone, a code that expired unread. */
  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/code', desk('desk.suppliers:manage'), async (request, reply) => {
    const known = (await listSuppliers()).find((s) => s.id === request.params.id);
    if (!known || known.state !== 'contracted') {
      return sendError(reply, new IdeshError('NOT_FOUND', 'no contracted supplier under that id'));
    }
    const code = await createSupplierCode(ctx, request.params.id, 'Нийлүүлэгчийн дэлгэц', 24 * 60);
    return reply.send({ pairing_code: code, expires_in_minutes: 24 * 60 });
  });

  if (!opts.dev) return;

  /** The demo's ops secret, so a walkthrough can approve somebody. */
  app.get('/dev/ops-token', async (_request, reply) => {
    const token = opsToken();
    if (!token) return sendError(reply, new IdeshError('OPS_CLOSED', 'OPS_TOKEN is not configured'));
    return reply.send({ token });
  });
}
