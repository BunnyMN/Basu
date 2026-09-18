import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CANCEL_REASONS,
  allOrders,
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
} from '../idesh/index.js';
import { limits } from './hardening.js';
import { shapeOrder, shapeSettlement } from './shapes.js';
import { overviewAt } from './overview.js';
import { closeGuest, guestFile, guestSearch } from './guests.js';
import { registerDineDesk } from './dineDesk.js';
import { registerMoneyDesk } from './moneyDesk.js';
import { revokeSession } from '../platform/identity/index.js';
import { mode } from '../mode.js';
import { badRequest, forbidden, sendError, unauthorized } from './errors.js';
import { listMembers, memberByPhone, setMemberActive, upsertMember, type Member, type Role } from '../ops/index.js';
import { contactsFor, resolveGuest } from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';

/**
 * Ops: the few people at Basu who sign contracts and move money.
 *
 * They sign in like anybody — phone and a one-time code — and what makes
 * the session ops is that the phone is a member's, on the desk's own list,
 * with a role. Every action is recorded under that member. The shared
 * `OPS_TOKEN` of the first weeks is kept only for the demo, where a
 * walkthrough needs a desk without a phone; in production it opens nothing.
 */

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module 'fastify' {
  interface FastifyRequest {
    ops?: { id: string; name: string; role: Role; phone: string | null };
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

/** What each role may do. Admin may do all of it. */
const MAY: Record<string, readonly Role[]> = {
  look: ['admin', 'finance', 'ops', 'viewer'],
  run: ['admin', 'ops'],
  money: ['admin', 'finance'],
  members: ['admin'],
};

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
    const sent = bearer(request);
    if (!sent) return unauthorized(reply);
    const shared = opsToken();
    if (shared && same(sent, shared)) {
      request.ops = { id: 'demo', name: 'Демо', role: 'admin', phone: null };
      return undefined;
    }
    const guestId = await resolveGuest(ctx, sent);
    if (!guestId) return unauthorized(reply);
    const phone = (await contactsFor([guestId])).get(guestId)?.phone;
    const member = phone ? await memberByPhone(phone) : null;
    if (!member?.active) return unauthorized(reply);
    request.ops = { id: member.id, name: member.name, role: member.role, phone: member.phone };
    return undefined;
  };
  /** A route that needs more than a seat at the desk. */
  const may = (what: keyof typeof MAY): Guard => async (request, reply) => {
    if (!request.ops || !MAY[what]!.includes(request.ops.role)) return forbidden(reply, `this needs one of ${MAY[what]!.join(', ')}`);
    return undefined;
  };
  const limit = { rateLimit: limits().ops };
  const asOps = { preHandler: requireOps, config: limit };
  const asRunner = { preHandler: [requireOps, may('run')], config: limit };
  const asFinance = { preHandler: [requireOps, may('money')], config: limit };
  const asAdmin = { preHandler: [requireOps, may('members')], config: limit };

  /** Who is acting, for the record: the member the session belongs to. */
  const who = (request: FastifyRequest) => `ops:${request.ops?.name ?? '?'}`;

  /** Who am I at the desk — what the page asks after signing in. */
  app.get('/v1/ops/me', asOps, async (request) => ({
    member: { id: request.ops!.id, name: request.ops!.name, role: request.ops!.role, phone: request.ops!.phone },
  }));

  /* ── the members, admin only ── */

  const shapeMember = (m: Member) => ({ id: m.id, phone: m.phone, name: m.name, role: m.role, active: m.active, created_at: m.createdAt.toISOString() });

  app.get('/v1/ops/members', asAdmin, async () => ({ members: (await listMembers()).map(shapeMember) }));

  app.post<{ Body: { phone?: string; name?: string; role?: string } }>('/v1/ops/members', asAdmin, async (request, reply) => {
    const body = request.body ?? {};
    try {
      const member = await upsertMember({ phone: body.phone ?? '', name: body.name ?? '', role: (body.role ?? 'ops') as Role });
      await recordAudit({ who: who(request), action: 'member.upsert', targetKind: 'member', targetId: member.id, note: `${member.name} · ${member.role}` });
      return reply.status(201).send(shapeMember(member));
    } catch (error) {
      return badRequest(reply, 'Утас (+976XXXXXXXX), нэр, эрхээ шалгана уу.', (error as Error).message);
    }
  });

  app.post<{ Params: { id: string }; Body: { active?: boolean } }>('/v1/ops/members/:id/active', asAdmin, async (request, reply) => {
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
  app.get('/v1/ops/suppliers', asOps, async () => ({
    suppliers: (await listSuppliers()).map(shape),
  }));

  /** Ops writes a contracted supplier straight in, as the script does. */
  app.post<{
    Body: {
      name?: string;
      phone?: string;
      tin?: string;
      address?: string;
      lat?: number;
      lon?: number;
      bank_name?: string;
      bank_account?: string;
      bank_holder?: string;
    };
  }>('/v1/ops/suppliers', asRunner, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.phone || !body.address?.trim()) {
      return badRequest(reply, 'Нэр, утас, авах цэгээ оруулна уу.', 'name, phone and address are required');
    }
    if (!/^\+976\d{8}$/.test(body.phone)) {
      return badRequest(reply, 'Утас +976XXXXXXXX хэлбэртэй байх ёстой.', 'phone must be +976XXXXXXXX');
    }
    try {
      const id = await registerSupplier({
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

  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/approve', asRunner, async (request, reply) => {
    try {
      const { pairingCode } = await approveSupplier(ctx, request.params.id);
      return reply.send({ state: 'contracted', pairing_code: pairingCode });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/v1/ops/suppliers/:id/decline',
    asRunner,
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
  }>('/v1/ops/suppliers/:id', asFinance, async (request, reply) => {
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
    asOps,
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

  app.get<{ Params: { id: string } }>('/v1/ops/orders/:id', asOps, async (request, reply) => {
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
    asRunner,
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

  registerDineDesk(app, ctx, { asOps, asRunner, who });
  registerMoneyDesk(app, ctx, { asOps, asFinance, who });

  /* ── the guests ── */

  app.get<{ Querystring: { q?: string } }>('/v1/ops/guests', asOps, async (request) => guestSearch(request.query.q ?? ''));

  app.get<{ Params: { id: string } }>('/v1/ops/guests/:id', asOps, async (request, reply) => {
    const file = await guestFile(request.params.id);
    if (!file) return sendError(reply, new IdeshError('NOT_FOUND', 'no such guest'));
    return reply.send(file);
  });

  /** A phone is gone: sign that one out. */
  app.post<{ Params: { id: string; sid: string }; Body: { note?: string } }>(
    '/v1/ops/guests/:id/sessions/:sid/revoke',
    asRunner,
    async (request, reply) => {
      const gone = await revokeSession(request.params.id, request.params.sid, ctx.clock.now());
      if (!gone) return sendError(reply, new IdeshError('NOT_FOUND', 'no such open session'));
      await recordAudit({ who: who(request), action: 'guest.session_revoke', targetKind: 'guest', targetId: request.params.id, note: request.body?.note ?? null });
      return reply.send({ revoked: true });
    },
  );

  /** Closing on somebody's behalf: admin only, a reason required, the same two refusals the app has. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/guests/:id/close', asAdmin, async (request, reply) => {
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
  app.get('/v1/ops/overview', asOps, async () => overviewAt(ctx.clock.now()));

  app.get('/v1/ops/stats', asOps, async () => {
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
  app.get<{ Params: { id: string } }>('/v1/ops/suppliers/:id/listings', asOps, async (request) => ({
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
    asRunner,
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
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/suppliers/:id/bank-verify', asFinance, async (request, reply) => {
    try {
      await verifySupplierBank(request.params.id);
      await recordAudit({ who: who(request), action: 'supplier.bank_verify', targetKind: 'supplier', targetId: request.params.id, note: request.body?.note ?? null });
      const row = (await listSuppliers()).find((s) => s.id === request.params.id);
      return reply.send(row ? shape(row) : { id: request.params.id, bank_verified: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/listings/:id/hide', asRunner, async (request, reply) => {
    try {
      await hideListing(request.params.id, ctx.clock.now());
      await recordAudit({ who: who(request), action: 'listing.hide', targetKind: 'listing', targetId: request.params.id, note: request.body?.note ?? null });
      return reply.send({ id: request.params.id, active: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/ops/audit', asOps, async (request) => ({
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
  app.get('/v1/ops/settlements', asOps, async () => ({
    settlements: (await listSettlements()).map(shapeSettlement),
  }));

  /** «Шилжүүлсэн»: the bank transfer was made by hand; the ledger and the person owed hear of it. */
  app.post<{ Params: { id: string }; Body: { reference?: string } }>(
    '/v1/ops/settlements/:id/paid',
    asFinance,
    async (request, reply) => {
      try {
        const paid = await markSettled(ctx, request.params.id, 'ops', request.body?.reference ?? '');
        return reply.send(shapeSettlement(paid));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** A fresh code — a lost phone, a code that expired unread. */
  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/code', asRunner, async (request, reply) => {
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
