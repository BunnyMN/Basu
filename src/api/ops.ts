import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CANCEL_REASONS,
  allOrders,
  approveSettlement,
  approveSupplier,
  cancelIdesh,
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
import { grantsOf, linksOf, roleOf, type Grants, type RoleShape } from '../platform/access/index.js';
import { shapeOrder, shapeSettlement } from './shapes.js';
import { overviewAt } from './overview.js';
import { closeGuest, guestFile, guestSearch } from './guests.js';
import { registerDineDesk } from './dineDesk.js';
import { registerMoneyDesk } from './moneyDesk.js';
import { registerPromotionsDesk } from './promotionsDesk.js';
import { registerSystemDesk } from './systemDesk.js';
import { registerAccessDesk } from './accessDesk.js';
import { revokeSession } from '../platform/identity/index.js';
import { mode } from '../mode.js';
import { badRequest, forbidden, sendError, signInAgain, unauthorized } from './errors.js';
import {
  deskRoleExists,
  linkByProof,
  listMembers,
  mayHandle,
  memberForAccount,
  seatAccount,
  seatsOfAccounts,
  setMemberActive,
  setMemberRole,
  type DeskActor,
  type Member,
  type Role,
} from '../ops/index.js';
import { accountByContact, contactsFor, findGuests, guestCard, profileOf, resolveSession } from '../platform/identity/index.js';
import { addMinutes } from '../domain/time.js';
import { enqueue } from '../platform/notify/index.js';
import { approveOrg, declineOrg, listOrgs, membersOf, orgById } from '../platform/org/index.js';
import { orgRefusal, shapeOrg } from './orgs.js';
import type { Ctx } from '../ports.js';

/**
 * Ops: the few people at Basu who sign contracts and move money.
 *
 * They sign in like anybody — Google, a code by email, a password — and
 * what makes the session ops is that the account holds a seat on the desk's
 * own list, with a role: given by an admin to an account chosen from Basu's
 * users, or named by an address the account proved. Every action is
 * recorded under that member. A session lives sixty days, for the website
 * and the app; the desk takes only one signed in within the last
 * `DESK_SESSION_HOURS`, so a sign-in left on some machine is not a desk
 * left open for two months. The shared `OPS_TOKEN` of the first weeks is
 * kept only for the demo, where a walkthrough needs a desk without a phone;
 * in production it opens nothing.
 */

/**
 * How long ago a desk seat's session may have been signed in. Past it the
 * desk answers SIGN_IN_AGAIN and the dashboard shows its door; the same
 * session still opens everything else it opened.
 */
export const DESK_SESSION_HOURS = 12;

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
 *
 * `stale` is an account that has a seat, on a session signed in longer ago
 * than the desk takes: no seat for it until the person signs in again. An
 * account without a seat is never stale — its sessions are the website's
 * and the app's, and live their sixty days.
 */
export async function deskSeatFor(
  ctx: Ctx,
  token: string | undefined,
): Promise<{ guestId: string | null; seat: DeskSeat | null; stale: boolean }> {
  if (!token) return { guestId: null, seat: null, stale: false };
  const links = await linksOf('desk');
  const shared = opsToken();
  if (shared && same(token, shared)) {
    const role = (await roleOf('desk', 'admin')) ?? DEMO_ROLE;
    return {
      guestId: null,
      seat: { id: 'demo', name: 'Демо', role: 'admin', roleName: role.name, locked: true, phone: null, email: null, grants: grantsOf({ ...role, locked: true }, links) },
      stale: false,
    };
  }
  const session = await resolveSession(ctx, token);
  if (!session) return { guestId: null, seat: null, stale: false };
  const { guestId } = session;
  const member = await seatOf(guestId);
  const role = member?.active ? await roleOf('desk', member.role) : null;
  if (!member?.active || !role) return { guestId, seat: null, stale: false };
  if (addMinutes(session.signedInAt, DESK_SESSION_HOURS * 60) <= ctx.clock.now()) return { guestId, seat: null, stale: true };
  return {
    guestId,
    stale: false,
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
  listings: s.listings,
});


export async function registerOpsRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  opts: { dev: boolean },
): Promise<void> {
  const requireOps: Guard = async (request, reply) => {
    const { guestId, seat, stale } = await deskSeatFor(ctx, bearer(request));
    if (stale) return signInAgain(reply);
    if (!seat) return unauthorized(reply);
    request.ops = seat;
    request.grants = seat.grants;
    // The account behind the seat — none for the demo's shared secret.
    if (guestId) request.guestId = guestId;
    return undefined;
  };

  /**
   * Anybody signed in — the dashboard's front room, before a seat. Somebody
   * who has a seat is at the desk's door here too, and the desk wants their
   * sign-in recent.
   */
  const requireAccount: Guard = async (request, reply) => {
    const { guestId, stale } = await deskSeatFor(ctx, bearer(request));
    if (stale) return signInAgain(reply);
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

  /** Whoever is changing a seat, as `ops/` weighs them: what their seat opens, and which seat and account are theirs. */
  const actor = (request: FastifyRequest): DeskActor => ({
    grants: request.grants!,
    locked: request.ops!.locked,
    seatId: request.ops!.id,
    account: request.guestId ?? null,
  });

  /**
   * Whether this seat may seat somebody in that desk role: the role opens
   * nothing the seat does not hold, and only somebody in the locked admin
   * role seats an admin. Whoever may manage members may not make themselves
   * — or a friend — more than they are. Asked again inside every change,
   * of the role the seat leaves as well as the one it gets.
   */
  const mayGive = (request: FastifyRequest, key: string): Promise<boolean> => mayHandle(actor(request), key);
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

  /**
   * Who is signed in, and whether they sit at the desk. Nobody asks for a
   * seat: an admin gives one, to an account chosen from Basu's users.
   */
  app.get('/v1/ops/whoami', { preHandler: requireAccount, config: limit }, async (request) => {
    const guestId = request.guestId!;
    const [profile, member] = await Promise.all([profileOf(guestId), seatOf(guestId)]);
    return {
      account: {
        id: guestId,
        name: profile?.displayName ?? null,
        email: profile?.email ?? null,
        phone: profile?.phone ?? null,
      },
      member: member?.active ? { id: member.id, name: member.name, role: member.role, phone: member.phone, email: member.email } : null,
    };
  });

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
   * Basu's users, for choosing whom to seat: found by name, phone or email,
   * the newest first, each with the seat it holds already. Only for whoever
   * may seat people — the list is the desk's, not the public's.
   */
  app.get<{ Querystring: { q?: string } }>('/v1/ops/people', desk('desk.members:manage'), async (request) => {
    const found = (await findGuests(String(request.query.q ?? '').slice(0, 100), 30)).filter((g) => !g.closedAt);
    const seats = await seatsOfAccounts(found.map((g) => g.id));
    return {
      people: found.map((g) => {
        const seat = seats.get(g.id);
        return { id: g.id, name: g.name, phone: g.phone, email: g.email, member: seat ? { id: seat.id, role: seat.role, active: seat.active } : null };
      }),
    };
  });

  /** Tell the person their seat is there — in the app, and by email where they have one. */
  const tellSeated = (guestId: string, member: Member, roleName: string) =>
    enqueue(ctx, {
      guestId,
      template: 'ops.seat',
      title: 'Basu ops эрх олголоо',
      body: `Танд Basu ops-ийн «${roleName}» эрх олголоо. basu.burzai.cloud/dashboard-д нэвтэрнэ үү.`,
      channel: 'push',
      subject: 'ops_member',
      subjectId: member.id,
      dedupeKey: `ops_seat:${member.id}:${ctx.clock.now().getTime()}`,
    });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * A seat for somebody already on Basu: the admin chooses the account from
   * Basu's users and gives it a role, and it sits at once. Nobody applies
   * for the desk, and nobody's address is typed in. Somebody at the desk
   * already is refused — a role is changed in the table — and so is the
   * chooser's own account.
   *
   * The seat is found, and named, by what the account has proved: its email,
   * which somebody vouched for, and its number only when an SMS code reached
   * it. The number a password sign-up merely typed is a name to show for an
   * account that gave none, and nothing more.
   */
  app.post<{ Body: { guest_id?: string; role?: string } }>('/v1/ops/members', desk('desk.members:manage'), async (request, reply) => {
    const body = request.body ?? {};
    const role = String(body.role ?? '');
    if (!body.guest_id || !UUID.test(body.guest_id)) return badRequest(reply, 'Хэрэглэгчээ сонгоно уу.', 'guest_id is required');
    if (!(await deskRoleExists(role))) return badRequest(reply, 'Эрх буруу байна.', `no such role: ${role}`);
    if (!(await mayGive(request, role))) return beyond(reply);
    const card = await guestCard(body.guest_id);
    if (!card || card.closedAt) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message_mn: 'Ийм хэрэглэгч олдсонгүй.', message_en: 'no such open account' } });
    }
    const proved = (await contactsFor([card.id])).get(card.id);
    try {
      const member = await seatAccount(
        {
          guestId: card.id,
          name: card.name?.trim() || card.email || card.phone || '',
          email: proved?.email ?? null,
          phone: proved?.phoneVerified ? proved.phone : null,
          role,
        },
        actor(request),
      );
      await recordAudit({ who: who(request), action: 'member.grant', targetKind: 'member', targetId: member.id, note: `${member.name} · ${member.role}` });
      await tellSeated(card.id, member, (await roleOf('desk', member.role))?.name ?? member.role);
      return reply.status(201).send(shapeMember(member));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Another role for somebody already at the desk — never your own, never
   * out of or into a role beyond what you hold, and never the last admin's.
   */
  app.post<{ Params: { id: string }; Body: { role?: string } }>('/v1/ops/members/:id/role', desk('desk.members:manage'), async (request, reply) => {
    const role = request.body?.role as Role | undefined;
    if (!role || !(await deskRoleExists(role))) return badRequest(reply, 'Эрх буруу байна.', `no such role: ${request.body?.role}`);
    if (request.params.id === request.ops!.id) return badRequest(reply, 'Өөрийн эрхийг өөрчлөх боломжгүй.', 'cannot change your own role');
    try {
      const member = await setMemberRole(request.params.id, role, actor(request));
      await recordAudit({ who: who(request), action: 'member.role', targetKind: 'member', targetId: member.id, note: `${member.name} · ${member.role}` });
      return reply.send(shapeMember(member));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * A seat off, or on again: for whoever may hand out the role it holds,
   * either way — never your own off, and never the last active admin. Off
   * closes the desk to it and nothing else; see `setMemberActive`.
   */
  app.post<{ Params: { id: string }; Body: { active?: boolean } }>('/v1/ops/members/:id/active', desk('desk.members:manage'), async (request, reply) => {
    if (typeof request.body?.active !== 'boolean') return badRequest(reply, 'active: true эсвэл false.', 'active must be a boolean');
    if (request.params.id === request.ops!.id && !request.body.active) return badRequest(reply, 'Өөрийгөө хаах боломжгүй.', 'cannot deactivate yourself');
    try {
      await setMemberActive(request.params.id, request.body.active, actor(request));
      await recordAudit({ who: who(request), action: request.body.active ? 'member.activate' : 'member.deactivate', targetKind: 'member', targetId: request.params.id });
      return reply.send({ id: request.params.id, active: request.body.active });
    } catch (error) {
      return sendError(reply, error);
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
      return reply.status(201).send({ id, owner: { id: owner.guestId, name: owner.name, phone: owner.phone, email: owner.email } });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/approve', desk('desk.suppliers:manage'), async (request, reply) => {
    try {
      await approveSupplier(ctx, request.params.id);
      return reply.send({ state: 'contracted' });
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
  registerPromotionsDesk(app, ctx, { desk, who });
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
  if (!opts.dev) return;

  /** The demo's ops secret, so a walkthrough can approve somebody. */
  app.get('/dev/ops-token', async (_request, reply) => {
    const token = opsToken();
    if (!token) return sendError(reply, new IdeshError('OPS_CLOSED', 'OPS_TOKEN is not configured'));
    return reply.send({ token });
  });
}
