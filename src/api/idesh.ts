import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  applicationOf,
  applySupplier,
  boardFor,
  cancelIdesh,
  createIdesh,
  createListing,
  createSupplierCode,
  dayOf,
  detailFor,
  IdeshError,
  KINDS,
  listingById,
  listingsOf,
  listSuppliers,
  liveFor,
  markDispatched,
  markHanded,
  markReady,
  openListings,
  ownedByGuest,
  ownedBySupplier,
  pairSupplier,
  payIdesh,
  resolveSupplierDevice,
  startPreparing,
  UNITS,
  unpairedCodes,
  updateListing,
  type IdeshDetail,
  type IdeshSummary,
  type Kind,
  type Listing,
  type ListingInput,
  type ListingPatch,
  type Receive,
  type Unit,
  CANCEL_REASONS,
  setRefundAccount,
  settlementsOf,
  type CancelReason,
  supplierOf,
  type SupplierRole,
  homeOf,
  ordersOf,
  orderForSupplier,
  supplierById,
  updateSupplierProfile,
  type SupplierOrder,
  type OrderScope,
  bankWouldChange,
  ownerOf,
} from '../idesh/index.js';
import { badRequest, forbidden, sendError, unauthorized } from './errors.js';
import { confirmPassword, contactsFor, resolveGuest } from '../platform/identity/index.js';
import { enqueue } from '../platform/notify/index.js';
import { LONE_OWNER_PERMISSIONS, SCREEN_PERMISSIONS, grants, headRoles, type Grants } from '../platform/access/index.js';
import { accessIn, membersOf } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';
import { limits } from './hardening.js';
import { shapeOrder, shapeSettlement, shapeSummary } from './shapes.js';
import { holds, need, needAny } from './guards.js';

/**
 * Өвлийн идэш over HTTP: the guest's side under /v1/idesh, the supplier's
 * under /v1/supplier.
 *
 * Thin, like the rest of the API. Every route parses, names who is calling,
 * checks the thing is theirs, and hands off to `src/idesh`. Nothing here
 * decides anything about animals or money.
 *
 * Mounted from its own file, and none of it mentions a restaurant: when the
 * vertical becomes its own service this is the file that moves.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Who is acting at a supplier, and with which role — a paired screen acts
     * as a manager. `person` is the account when it is a person, not a screen.
     */
    supplierDevice?: { deviceId: string; supplierId: string; role: SupplierRole; person?: string; orgId?: string | null };
  }
}

/**
 * Which business a person means, when they work at more than one: the
 * dashboard sends the organisation it has open. Anything that is not an id
 * is no answer, and the person's own first business is meant.
 */
const ORG_HEADER = 'x-basu-org';
function orgOf(request: FastifyRequest): string | null {
  const sent = request.headers[ORG_HEADER];
  const value = Array.isArray(sent) ? sent[0] : sent;
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

const shapeListing = (l: Listing) => ({
  id: l.id,
  supplier: {
    id: l.supplier.id,
    name: l.supplier.name,
    contracted: l.supplier.contracted,
    pickup_address: l.supplier.pickupAddress,
  },
  kind: l.kind,
  unit: l.unit,
  title: l.title,
  note: l.note,
  price_mnt: l.priceMnt,
  approx_kg: l.approxKg,
  min_qty: l.minQty,
  quantity: l.quantity,
  sold: l.sold,
  remaining: l.remaining,
  origin: l.origin,
  ready_from: l.readyFrom,
  delivers: l.delivers,
  delivery_fee_mnt: l.deliveryFeeMnt,
  active: l.active,
});


const shapeDetail = (o: IdeshDetail) => ({
  ...shapeSummary(o),
  origin: o.origin,
  unit_price_mnt: o.unitPriceMnt,
  delivery_fee_mnt: o.deliveryFeeMnt,
  address: o.address,
  address_phone: o.addressPhone,
  address_lat: o.addressLat,
  address_lon: o.addressLon,
  supplier_phone: o.supplierPhone,
  pickup_address: o.pickupAddress,
  pickup_lat: o.pickupLat,
  pickup_lon: o.pickupLon,
  preparing_at: o.preparingAt?.toISOString() ?? null,
  ready_at: o.readyAt?.toISOString() ?? null,
  dispatched_at: o.dispatchedAt?.toISOString() ?? null,
  handed_at: o.handedAt?.toISOString() ?? null,
  cancel_reason: o.cancelReason,
  refund_mnt: o.refundMnt,
  forfeit_mnt: o.forfeitMnt,
  refund: o.refund
    ? {
        state: o.refund.state,
        amount_mnt: o.refund.amountMnt,
        bank_name: o.refund.bank?.bankName ?? null,
        bank_account: o.refund.bank?.bankAccount ?? null,
        bank_holder: o.refund.bank?.bankHolder ?? null,
        paid_at: o.refund.paidAt?.toISOString() ?? null,
      }
    : null,
  receipt: o.receipt,
});

/** The JSON the supplier's page sends for a listing, checked field by field. */
function readListing(body: Record<string, unknown>): ListingInput | string {
  const kind = body['kind'];
  const unit = body['unit'];
  if (!KINDS.includes(kind as Kind)) return 'kind must be one of sheep, goat, beef, horse';
  if (!UNITS.includes(unit as Unit)) return 'unit must be whole or kg';
  if (typeof body['title'] !== 'string' || !body['title'].trim()) return 'title is required';
  if (typeof body['origin'] !== 'string' || !body['origin'].trim()) return 'origin is required';
  if (typeof body['ready_from'] !== 'string') return 'ready_from is required';
  const input: ListingInput = {
    kind: kind as Kind,
    unit: unit as Unit,
    title: body['title'],
    priceMnt: Number(body['price_mnt']),
    quantity: Number(body['quantity']),
    origin: body['origin'],
    readyFrom: body['ready_from'],
  };
  if (typeof body['note'] === 'string') input.note = body['note'];
  if (body['approx_kg'] !== undefined && body['approx_kg'] !== null) {
    input.approxKg = Number(body['approx_kg']);
  }
  if (body['min_qty'] !== undefined) input.minQty = Number(body['min_qty']);
  if (typeof body['delivers'] === 'boolean') input.delivers = body['delivers'];
  if (body['delivery_fee_mnt'] !== undefined) input.deliveryFeeMnt = Number(body['delivery_fee_mnt']);
  return input;
}

function readPatch(body: Record<string, unknown>): ListingPatch {
  const patch: ListingPatch = {};
  if (body['price_mnt'] !== undefined) patch.priceMnt = Number(body['price_mnt']);
  if (body['quantity'] !== undefined) patch.quantity = Number(body['quantity']);
  if (typeof body['active'] === 'boolean') patch.active = body['active'];
  if (typeof body['delivers'] === 'boolean') patch.delivers = body['delivers'];
  if (body['delivery_fee_mnt'] !== undefined) patch.deliveryFeeMnt = Number(body['delivery_fee_mnt']);
  if (typeof body['ready_from'] === 'string') patch.readyFrom = body['ready_from'];
  if (body['note'] !== undefined) patch.note = body['note'] === null ? null : String(body['note']);
  if (typeof body['title'] === 'string') patch.title = body['title'];
  return patch;
}

export async function registerIdeshRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  opts: { requireGuest: Guard; dev: boolean },
): Promise<void> {
  const guarded = { preHandler: opts.requireGuest };

  /**
   * Two ways onto the supplier's side: a screen paired by code, or the
   * person whose phone the supplier is, signed in like any guest. Both land
   * on the same routes and the same ownership checks; the actor string tells
   * them apart in the order's events.
   */
  /**
   * What a person may do at a supplier: what their role opens at its
   * business, as Basu wrote the role. A supplier from before there were
   * businesses is its one owner's, every supplier page.
   */
  const supplierGrants = async (guestId: string, orgId: string | null): Promise<Grants | null> => {
    if (!orgId) return grants(LONE_OWNER_PERMISSIONS);
    return (await accessIn(orgId, guestId))?.grants ?? null;
  };

  const requireSupplier = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    if (!token) return unauthorized(reply);
    const device = await resolveSupplierDevice(ctx, token);
    if (device) {
      // A screen on the counter does the day's work, as a manager would —
      // never the bank, which takes a person's password.
      request.supplierDevice = { ...device, role: 'screen' };
      request.grants = grants(SCREEN_PERMISSIONS);
      return undefined;
    }
    const guestId = await resolveGuest(ctx, token);
    if (!guestId) return unauthorized(reply);
    const asked = orgOf(request);
    const mine = await supplierOf(guestId, { orgId: asked });
    if (!mine || mine.state !== 'contracted') {
      // Signed in, and asking for a business that is not theirs: a refusal, not a sign-out.
      return asked ? forbidden(reply, 'not a member of that supplier') : unauthorized(reply);
    }
    const held = await supplierGrants(guestId, mine.orgId);
    if (!held) return asked ? forbidden(reply, 'not a member of that supplier') : unauthorized(reply);
    const actor = mine.role === 'owner' ? `owner:${guestId}` : `member:${guestId}`;
    request.supplierDevice = { deviceId: actor, supplierId: mine.id, role: mine.role, person: guestId, orgId: mine.orgId };
    request.grants = held;
    return undefined;
  };
  /**
   * A supplier route: somebody who works there, holding the permission the
   * route names — staff take orders and write listings, an accountant reads
   * the money, only an owner or a manager changes the details. The table is
   * `platform/access`'s.
   */
  const asSupplierMay = (permission: string) => ({ preHandler: [requireSupplier, need(permission)] });
  /** A supplier route two pages read from: either opens it. */
  const asSupplierMayAny = (...permissions: string[]) => ({ preHandler: [requireSupplier, needAny(...permissions)] });
  /** What a seat without the money sees of an amount that is the supplier's own: nothing. */
  const moneyFor = (request: FastifyRequest, value: number | null | undefined) => (holds(request, 'org.idesh.money') ? value ?? null : null);

  /* ── browsing — no sign-in, the way the restaurant list works ─────── */

  app.get('/v1/idesh/listings', async () => ({
    today: dayOf(ctx.clock.now()),
    listings: (await openListings()).map(shapeListing),
  }));

  app.get<{ Params: { id: string } }>('/v1/idesh/listings/:id', async (request, reply) => {
    const listing = await listingById(request.params.id);
    if (!listing) return sendError(reply, new IdeshError('NOT_FOUND', 'no such listing'));
    return reply.send({ today: dayOf(ctx.clock.now()), listing: shapeListing(listing) });
  });

  /* ── the guest ─────────────────────────────────────────────────── */

  /** Everything of this guest's still going on — what the launcher draws. */
  app.get('/v1/idesh', guarded, async (request) => ({
    orders: (await liveFor(request.guestId!)).map(shapeSummary),
  }));

  app.post<{
    Body: {
      listing_id?: string;
      qty?: number;
      receive?: Receive;
      receive_on?: string;
      address?: string;
      address_phone?: string;
      address_lat?: number;
      address_lon?: number;
    };
  }>('/v1/idesh', guarded, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.listing_id || !body.receive_on || (body.receive !== 'delivery' && body.receive !== 'pickup')) {
      return badRequest(
        reply,
        'Зар, хүлээн авах арга, өдрөө сонгоно уу.',
        'listing_id, receive and receive_on are required',
      );
    }
    try {
      const created = await createIdesh(ctx, {
        listingId: body.listing_id,
        guestId: request.guestId!,
        qty: Number(body.qty ?? 1),
        receive: body.receive,
        receiveOn: body.receive_on,
        address: body.address,
        addressPhone: body.address_phone,
        addressLat: typeof body.address_lat === 'number' ? body.address_lat : undefined,
        addressLon: typeof body.address_lon === 'number' ? body.address_lon : undefined,
      });
      return reply.status(201).send({
        id: created.orderId,
        code: created.code,
        state: 'DRAFT',
        total_mnt: created.totalMnt,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/v1/idesh/:id', guarded, async (request, reply) => {
    const detail = await detailFor(request.guestId!, request.params.id);
    if (!detail) return sendError(reply, new IdeshError('NOT_FOUND', 'no such order'));
    return reply.send(shapeDetail(detail));
  });

  app.post<{ Params: { id: string } }>('/v1/idesh/:id/pay', guarded, async (request, reply) => {
    if (!(await ownedByGuest(request.params.id, request.guestId!))) {
      return forbidden(reply, 'not your order');
    }
    try {
      await payIdesh(ctx, request.params.id);
      return reply.send({ state: 'PAID' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // There is no `/v1/idesh/:id/cancel` for a guest, on purpose. Money that
  // has moved does not come back at the press of a button; the guest rings
  // the supplier, and the supplier cancels from their own screen.

  /** Where the refund goes: the guest's own bank account, in their words. */
  app.post<{ Params: { id: string }; Body: { bank_name?: string; bank_account?: string; bank_holder?: string; password?: string } }>(
    '/v1/idesh/:id/refund-account',
    guarded,
    async (request, reply) => {
      if (!(await ownedByGuest(request.params.id, request.guestId!))) {
        return forbidden(reply, 'not your order');
      }
      const body = request.body ?? {};
      if (!body.bank_name?.trim() || !body.bank_account?.trim() || !body.bank_holder?.trim()) {
        return badRequest(reply, 'Банк, дансны дугаар, эзэмшигчийн нэрээ оруулна уу.', 'bank, account and holder are required');
      }
      try {
        // Money leaving for an account somebody typed is the one thing a
        // stolen phone would do here, so the person types their password
        // again. It used to be a code by SMS, which needed a gateway the
        // server may not have; a password needs nothing but the person.
        if (!body.password) {
          return sendError(reply, new IdeshError('PASSWORD_REQUIRED', 'the account is confirmed with the password'));
        }
        if (!(await confirmPassword(request.guestId!, body.password))) {
          return sendError(reply, new IdeshError('BAD_PASSWORD', 'that is not the password on this account'));
        }
        await setRefundAccount(request.params.id, request.guestId!, {
          bankName: body.bank_name,
          bankAccount: body.bank_account,
          bankHolder: body.bank_holder,
        });
        await enqueue(ctx, {
          guestId: request.guestId!,
          subject: 'idesh',
          subjectId: request.params.id,
          template: 'idesh.refund_account',
          channel: 'sms',
          dedupeKey: `idesh:${request.params.id}:refund-account:${Date.now()}`,
          title: 'Буцаалтын данс',
          body: `Basu: буцаалт авах данс бүртгэгдлээ — ${body.bank_name.trim()} …${body.bank_account.replace(/\s+/g, '').slice(-4)}. Та биш бол Basu-д хэлнэ үү.`,
        });
        const detail = await detailFor(request.guestId!, request.params.id);
        return reply.send(detail ? shapeDetail(detail) : { ok: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── becoming a supplier ───────────────────────────────────────── */

  /**
   * Ask. The guest is signed in — the phone on the application is the
   * account's own, or, for an account made without one, the number typed
   * here — and ops answers from their own page.
   */
  app.post<{
    Body: {
      name?: string;
      phone?: string;
      tin?: string;
      address?: string;
      about?: string;
      lat?: number;
      lon?: number;
      bank_name?: string;
      bank_account?: string;
      bank_holder?: string;
    };
  }>('/v1/supplier/apply', guarded, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.address?.trim()) {
      return badRequest(reply, 'Нэр, авах цэгээ оруулна уу.', 'name and address are required');
    }
    try {
      const id = await applySupplier(ctx, {
        guestId: request.guestId!,
        name: body.name,
        phone: body.phone ?? null,
        merchantTin: body.tin?.trim() || null,
        pickupAddress: body.address,
        about: body.about ?? null,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lon: typeof body.lon === 'number' ? body.lon : null,
        bankName: body.bank_name,
        bankAccount: body.bank_account,
        bankHolder: body.bank_holder,
      });
      return reply.status(201).send({ id, state: 'applied' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Where the guest's application stands — and the code, once there is one. */
  app.get('/v1/supplier/application', guarded, async (request) => {
    const application = await applicationOf(ctx, request.guestId!);
    return {
      application: application
        ? {
            id: application.id,
            name: application.name,
            state: application.state,
            applied_at: application.appliedAt?.toISOString() ?? null,
            decided_at: application.decidedAt?.toISOString() ?? null,
            decline_reason: application.declineReason,
            pairing_code: application.pairingCode,
            paired: application.paired,
          }
        : null,
    };
  });

  /* ── the supplier ──────────────────────────────────────────────── */

  app.post<{ Body: { pairing_code?: string } }>('/v1/supplier/pair', { config: { rateLimit: limits().pair } }, async (request, reply) => {
    const code = request.body?.pairing_code;
    if (!code) return badRequest(reply, 'Холбох код оруулна уу.', 'pairing_code is required');
    try {
      const session = await pairSupplier(ctx, code);
      return reply.send({
        token: session.token,
        device_id: session.deviceId,
        supplier_id: session.supplierId,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * The screen, in one call: the orders with a job still to do, and the
   * stall itself. A poll rather than a socket, for the tablet's reasons.
   */
  const screen = async (supplierId: string | null) => {
    const board = await boardFor(supplierId);
    const listings = supplierId ? (await listingsOf(supplierId)).map(shapeListing) : [];
    const lane = (tickets: typeof board.lanes.paid) =>
      tickets.map((t) => ({
        ...shapeSummary(t),
        guest: t.guest,
        guest_phone: t.guestPhone,
        address: t.address,
        address_phone: t.addressPhone,
        address_lat: t.addressLat,
        address_lon: t.addressLon,
        delivery_fee_mnt: t.deliveryFeeMnt,
        ready_at: t.readyAt?.toISOString() ?? null,
        no_show_from: t.noShowFrom?.toISOString() ?? null,
        payout_mnt: t.payoutMnt,
      }));
    return {
      today: dayOf(ctx.clock.now()),
      supplier: board.supplier,
      lanes: {
        paid: lane(board.lanes.paid),
        preparing: lane(board.lanes.preparing),
        ready: lane(board.lanes.ready),
        dispatched: lane(board.lanes.dispatched),
      },
      listings,
    };
  };

  /**
   * Who this seat is at the supplier and what it may do — a person with a
   * role, or a screen on the counter. What the supplier's page asks before
   * it draws a tab or a button; the routes behind them ask again.
   */
  app.get('/v1/supplier/seat', { preHandler: requireSupplier }, async (request) => {
    const seat = request.supplierDevice!;
    const row = await supplierById(seat.supplierId);
    return {
      supplier: { id: seat.supplierId, name: row?.name ?? null },
      org_id: seat.orgId ?? null,
      role: seat.role,
      screen: !seat.person,
      permissions: request.grants!.list(),
    };
  });

  app.get('/v1/supplier/board', asSupplierMay('org.idesh.today'), async (request) => {
    const board = await screen(request.supplierDevice!.supplierId);
    if (holds(request, 'org.idesh.money')) return board;
    // What the supplier keeps of each order is the money; the staff at the counter see the order.
    const blind = (tickets: typeof board.lanes.paid) => tickets.map((t) => ({ ...t, payout_mnt: null }));
    const { paid, preparing, ready, dispatched } = board.lanes;
    return { ...board, lanes: { paid: blind(paid), preparing: blind(preparing), ready: blind(ready), dispatched: blind(dispatched) } };
  });

  /* ── the supplier as a person ──────────────────────────────────── */

  /**
   * Does this guest work at a supplier, as what, and what may they do there?
   * What the launcher asks before drawing the tile, and what the supplier's
   * page asks before drawing its tabs.
   */
  app.get('/v1/supplier/me', guarded, async (request) => {
    const mine = await supplierOf(request.guestId!, { orgId: orgOf(request) });
    return {
      supplier: mine
        ? {
            id: mine.id,
            name: mine.name,
            state: mine.state,
            role: mine.role,
            org_id: mine.orgId,
            permissions: mine.state === 'contracted' ? (await supplierGrants(request.guestId!, mine.orgId))?.list() ?? [] : [],
          }
        : null,
    };
  });


  /** The numbers the supplier opens the app to. The money in them only for a seat that holds the money. */
  app.get('/v1/supplier/home', asSupplierMayAny('org.idesh.today', 'org.idesh.orders'), async (request) => {
    const home = await homeOf(request.supplierDevice!.supplierId, ctx.clock.now());
    return {
      today: home.today,
      lanes: home.lanes,
      due_today: home.dueToday,
      overdue: home.overdue,
      season: {
        handed: home.season.handed,
        cancelled: home.season.cancelled,
        revenue_mnt: moneyFor(request, home.season.revenueMnt),
        payout_mnt: moneyFor(request, home.season.payoutMnt),
        forfeit_mnt: moneyFor(request, home.season.forfeitMnt),
        by_kind: home.season.byKind,
      },
    };
  });

  /** Every order, or the live ones, or the finished ones — searched by what is in front of the person. */
  /** An order as this seat may read it: what the supplier keeps of it is the money. */
  const orderFor = (request: FastifyRequest, o: SupplierOrder) => {
    const shaped = shapeOrder(o);
    return { ...shaped, payout_mnt: moneyFor(request, shaped.payout_mnt) };
  };

  app.get<{ Querystring: { scope?: string; q?: string } }>('/v1/supplier/orders', asSupplierMay('org.idesh.orders'), async (request) => {
    const raw = request.query.scope;
    const scope: OrderScope = raw === 'live' || raw === 'done' ? raw : 'all';
    const orders = await ordersOf(request.supplierDevice!.supplierId, { scope, q: request.query.q ?? '' });
    return { scope, orders: orders.map((o) => orderFor(request, o)) };
  });

  app.get<{ Params: { id: string } }>('/v1/supplier/orders/:id', asSupplierMay('org.idesh.orders'), async (request, reply) => {
    const found = await orderForSupplier(request.supplierDevice!.supplierId, request.params.id);
    if (!found) return sendError(reply, new IdeshError('NOT_FOUND', 'no such order of yours'));
    return reply.send({
      order: orderFor(request, found.order),
      events: found.events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.at.toISOString() })),
    });
  });

  const shapeProfile = (s: NonNullable<Awaited<ReturnType<typeof supplierById>>>) => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    merchant_tin: s.merchantTin,
    pickup_address: s.pickupAddress,
    about: s.about,
    lat: s.lat,
    lon: s.lon,
    state: s.state,
    contracted_at: s.contractedAt?.toISOString() ?? null,
    commission_pct: s.commissionPct,
    bank_name: s.bankName,
    bank_account: s.bankAccount,
    bank_holder: s.bankHolder,
    bank_verified: s.bankVerified,
  });

  /** The profile as this seat may read it: where the money goes, and at what rate, is the money's. */
  const profileFor = (request: FastifyRequest, row: NonNullable<Awaited<ReturnType<typeof supplierById>>>) => {
    const shaped = shapeProfile(row);
    if (holds(request, 'org.idesh.money')) return shaped;
    return { ...shaped, commission_pct: null, bank_name: null, bank_account: null, bank_holder: null, bank_verified: null };
  };

  app.get('/v1/supplier/profile', asSupplierMay('org.idesh.profile'), async (request, reply) => {
    const row = await supplierById(request.supplierDevice!.supplierId);
    if (!row) return sendError(reply, new IdeshError('NOT_FOUND', 'no such supplier'));
    return reply.send(profileFor(request, row));
  });

  /**
   * Where the money goes is the one field a stolen phone would change, so
   * changing it takes the owner's password again, and the owner is told.
   * Finance then checks the account against the contract before anything is
   * paid to it.
   */
  app.patch<{
    Body: { name?: string; address?: string; about?: string | null; lat?: number | null; lon?: number | null; bank_name?: string; bank_account?: string; bank_holder?: string; password?: string };
  }>('/v1/supplier/profile', asSupplierMay('org.idesh.profile:edit'), async (request, reply) => {
    const body = request.body ?? {};
    const supplierId = request.supplierDevice!.supplierId;
    try {
      const bank = { bankName: body.bank_name, bankAccount: body.bank_account, bankHolder: body.bank_holder };
      const changing = (bank.bankName !== undefined || bank.bankAccount !== undefined || bank.bankHolder !== undefined) && (await bankWouldChange(supplierId, bank));
      if (changing) {
        // Where the money goes is an owner's alone to change, and the owner
        // pressing the button proves it is them with their own password —
        // whichever owner they are, and never a screen on the counter.
        const person = request.supplierDevice!.person;
        if (!holds(request, 'org.idesh.profile:bank') || !person) {
          return forbidden(reply, 'only an owner changes where the money goes');
        }
        if (!body.password) {
          return sendError(reply, new IdeshError('PASSWORD_REQUIRED', 'changing the account takes the password'));
        }
        if (!(await confirmPassword(person, body.password))) {
          return sendError(reply, new IdeshError('BAD_PASSWORD', 'that is not the password on this account'));
        }
      }
      const { bankChanged } = await updateSupplierProfile(supplierId, {
        name: body.name,
        pickupAddress: body.address,
        about: body.about,
        lat: typeof body.lat === 'number' ? body.lat : body.lat === null ? null : undefined,
        lon: typeof body.lon === 'number' ? body.lon : body.lon === null ? null : undefined,
        bankName: body.bank_name,
        bankAccount: body.bank_account,
        bankHolder: body.bank_holder,
      });
      const row = await supplierById(supplierId);
      if (bankChanged && row) {
        // Every owner hears of it — the one who registered the business and
        // any it has now — so a change nobody meant is caught by somebody.
        const orgId = request.supplierDevice!.orgId;
        const heads = await headRoles();
        const owners = new Set<string>(orgId ? (await membersOf(orgId)).filter((m) => heads.includes(m.role)).map((m) => m.guestId) : []);
        const registered = await ownerOf(supplierId);
        if (registered) owners.add(registered);
        const stamp = ctx.clock.now().getTime();
        for (const owner of owners) {
          await enqueue(ctx, {
            guestId: owner,
            subject: 'idesh',
            subjectId: supplierId,
            template: 'supplier.bank',
            channel: 'sms',
            dedupeKey: `supplier:${supplierId}:bank:${owner}:${stamp}`,
            title: 'Данс солигдлоо',
            body: `Basu: олголтын данс солигдлоо — ${row.bankName ?? ''} …${(row.bankAccount ?? '').slice(-4)}. Та биш бол яаралтай Basu-д хэлнэ үү. Санхүү баталгаажуулах хүртэл олголт хийгдэхгүй.`,
          });
        }
      }
      return reply.send(row ? profileFor(request, row) : { ok: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** The supplier's money: their rate, what they are owed, what was sent. */
  app.get('/v1/supplier/money', asSupplierMay('org.idesh.money'), async (request) => {
    const supplierId = request.supplierDevice!.supplierId;
    const me = (await listSuppliers()).find((s) => s.id === supplierId);
    return {
      commission_pct: me?.commissionPct ?? null,
      bank_name: me?.bankName ?? null,
      bank_account: me?.bankAccount ?? null,
      bank_holder: me?.bankHolder ?? null,
      settlements: (await settlementsOf(supplierId)).map(shapeSettlement),
    };
  });

  /**
   * Every supplier action shares the same steps: check the order is theirs,
   * run it, translate any failure. Written once so a new button cannot skip
   * the ownership check.
   */
  const act = async (
    action: string,
    orderId: string,
    actor: string,
    body: { reason?: string } | undefined,
  ) => {
    switch (action) {
      case 'prepare':
        await startPreparing(ctx, orderId, actor);
        return { state: 'PREPARING' };
      case 'ready':
        await markReady(ctx, orderId, actor);
        return { state: 'READY' };
      case 'dispatch':
        await markDispatched(ctx, orderId, actor);
        return { state: 'DISPATCHED' };
      case 'hand':
        await markHanded(ctx, orderId, actor);
        return { state: 'HANDED' };
      case 'cancel': {
        // The reason is not a note; it decides the money. No reason, no cancel.
        const reason = body?.reason;
        if (!reason || !(CANCEL_REASONS as readonly string[]).includes(reason)) {
          throw new IdeshError('BAD_REASON', 'шалтгаанаа сонгоно уу');
        }
        const split = await cancelIdesh(ctx, orderId, { actor, role: 'supplier' }, reason as CancelReason);
        return { state: 'CANCELLED', refund_mnt: split.refundMnt, forfeit_mnt: split.forfeitMnt };
      }
      default:
        return null;
    }
  };

  app.post<{ Params: { id: string; action: string }; Body: { reason?: string } }>(
    '/v1/supplier/orders/:id/:action',
    asSupplierMay('org.idesh.orders:act'),
    async (request, reply) => {
      const device = request.supplierDevice!;
      if (!(await ownedBySupplier(request.params.id, device.supplierId))) {
        return forbidden(reply, 'that order belongs to another supplier');
      }
      try {
        const result = await act(
          request.params.action,
          request.params.id,
          `supplier:${device.deviceId}`,
          request.body,
        );
        if (!result) return badRequest(reply, 'Ийм үйлдэл алга.', `unknown action ${request.params.action}`);
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get('/v1/supplier/listings', asSupplierMay('org.idesh.stall'), async (request) => ({
    listings: (await listingsOf(request.supplierDevice!.supplierId)).map(shapeListing),
  }));

  app.post<{ Body: Record<string, unknown> }>(
    '/v1/supplier/listings',
    asSupplierMay('org.idesh.stall:edit'),
    async (request, reply) => {
      const input = readListing(request.body ?? {});
      if (typeof input === 'string') return badRequest(reply, 'Зарын мэдээлэл дутуу байна.', input);
      try {
        const listing = await createListing(
          request.supplierDevice!.supplierId,
          input,
          ctx.clock.now(),
        );
        return reply.status(201).send({ listing: shapeListing(listing) });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/v1/supplier/listings/:id',
    asSupplierMay('org.idesh.stall:edit'),
    async (request, reply) => {
      try {
        const listing = await updateListing(
          request.supplierDevice!.supplierId,
          request.params.id,
          readPatch(request.body ?? {}),
          ctx.clock.now(),
        );
        return reply.send({ listing: shapeListing(listing) });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── development only ──────────────────────────────────────────── */

  if (!opts.dev) return;

  /** The codes the seed minted, so the supplier screen can self-pair. */
  app.get('/dev/supplier-codes', async () => ({
    devices: (await unpairedCodes()).map((d) => ({
      code: d.code,
      name: d.name,
      supplier_id: d.supplierId,
    })),
  }));

  /** The screens a walkthrough may open: contracted suppliers only. An
      applicant has no screen yet — that is what the ops page decides. */
  app.get('/dev/suppliers', async () => ({
    suppliers: (await listSuppliers())
      .filter((s) => s.state === 'contracted')
      .map((s) => ({ id: s.id, name: s.name, watched: s.watched })),
  }));

  /** Hand this browser a screen for a supplier, no code typing. */
  app.post<{ Body: { supplier_id?: string } }>('/dev/supplier-token', async (request, reply) => {
    const supplierId = request.body?.supplier_id;
    if (!supplierId) return badRequest(reply, 'Нийлүүлэгч заана уу.', 'supplier_id required');
    try {
      const code = await createSupplierCode(ctx, supplierId, 'Демо дэлгэц', 60);
      const session = await pairSupplier(ctx, code);
      return reply.send({ token: session.token, supplier_id: session.supplierId });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Every supplier's board at once, for the walkthrough. */
  app.get('/dev/supplier/board', async () => screen(null));

  app.post<{ Params: { id: string; action: string }; Body: { reason?: string } }>(
    '/dev/supplier/orders/:id/:action',
    async (request, reply) => {
      try {
        const result = await act(request.params.action, request.params.id, 'supplier:demo', request.body);
        if (!result) return badRequest(reply, 'Ийм үйлдэл алга.', `unknown action ${request.params.action}`);
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
