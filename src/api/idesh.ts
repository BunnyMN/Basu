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
} from '../idesh/index.js';
import { badRequest, forbidden, sendError, unauthorized } from './errors.js';
import type { Ctx } from '../ports.js';

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
    supplierDevice?: { deviceId: string; supplierId: string };
  }
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

const shapeSummary = (o: IdeshSummary) => ({
  id: o.id,
  code: o.code,
  state: o.state,
  supplier: o.supplier,
  kind: o.kind,
  unit: o.unit,
  title: o.title,
  qty: o.qty,
  total_mnt: o.totalMnt,
  receive: o.receive,
  receive_on: o.receiveOn,
  paid_at: o.paidAt?.toISOString() ?? null,
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
  can_cancel: o.canCancel,
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

  const requireSupplier = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    const device = token ? await resolveSupplierDevice(ctx, token) : null;
    if (!device) return unauthorized(reply);
    request.supplierDevice = device;
    return undefined;
  };
  const asSupplier = { preHandler: requireSupplier };

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

  app.post<{ Params: { id: string } }>('/v1/idesh/:id/cancel', guarded, async (request, reply) => {
    if (!(await ownedByGuest(request.params.id, request.guestId!))) {
      return forbidden(reply, 'not your order');
    }
    try {
      const { refunded } = await cancelIdesh(ctx, request.params.id, {
        actor: `guest:${request.guestId}`,
        role: 'guest',
      });
      return reply.send({ state: refunded ? 'REFUNDED' : 'CANCELLED', refunded });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ── becoming a supplier ───────────────────────────────────────── */

  /**
   * Ask. The guest is signed in — the phone on the application is the one
   * they proved by OTP, never one typed into a box — and ops answers from
   * their own page.
   */
  app.post<{
    Body: { name?: string; tin?: string; address?: string; about?: string; lat?: number; lon?: number };
  }>('/v1/supplier/apply', guarded, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.address?.trim()) {
      return badRequest(reply, 'Нэр, авах цэгээ оруулна уу.', 'name and address are required');
    }
    try {
      const id = await applySupplier(ctx, {
        guestId: request.guestId!,
        name: body.name,
        merchantTin: body.tin?.trim() || null,
        pickupAddress: body.address,
        about: body.about ?? null,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lon: typeof body.lon === 'number' ? body.lon : null,
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

  app.post<{ Body: { pairing_code?: string } }>('/v1/supplier/pair', async (request, reply) => {
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
        address: t.address,
        address_phone: t.addressPhone,
        address_lat: t.addressLat,
        address_lon: t.addressLon,
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

  app.get('/v1/supplier/board', asSupplier, async (request) =>
    screen(request.supplierDevice!.supplierId),
  );

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
        const { refunded } = await cancelIdesh(
          ctx,
          orderId,
          { actor, role: 'supplier' },
          body?.reason ?? 'supplier cancelled',
        );
        return { state: refunded ? 'REFUNDED' : 'CANCELLED', refunded };
      }
      default:
        return null;
    }
  };

  app.post<{ Params: { id: string; action: string }; Body: { reason?: string } }>(
    '/v1/supplier/orders/:id/:action',
    asSupplier,
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

  app.get('/v1/supplier/listings', asSupplier, async (request) => ({
    listings: (await listingsOf(request.supplierDevice!.supplierId)).map(shapeListing),
  }));

  app.post<{ Body: Record<string, unknown> }>(
    '/v1/supplier/listings',
    asSupplier,
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
    asSupplier,
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
