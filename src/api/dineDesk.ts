import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { IdeshError, recordAudit } from '../idesh/index.js';
import type { Ctx } from '../ports.js';
import { createPairingCode, revokeDevice } from '../services/devices.js';
import { cancelOrder, markNoShow } from '../services/orders.js';
import {
  dineOrderFile,
  dineOrdersForDesk,
  menuForDesk,
  restaurantsForDesk,
  reviewsForDesk,
  setMenuItemActive,
  setRestaurantActive,
  type DeskDineOrder,
  type DineScope,
} from '../services/deskDine.js';
import { badRequest, sendError } from './errors.js';

/**
 * The lunch side of the desk.
 *
 * Restaurants and their tablets, the day's orders, one order's story, the
 * menu with what is switched off, and what people said. Every change is
 * recorded under the member who made it, like everything else at the desk.
 */

export interface DeskGuards {
  asOps: RouteShorthandOptions;
  asRunner: RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const shapeOrder = (o: DeskDineOrder) => ({
  id: o.id,
  code: o.code,
  state: o.state,
  restaurant: o.restaurant,
  guest_id: o.guestId,
  guest: o.guest,
  guest_phone: o.guestPhone,
  party_size: o.partySize,
  total_mnt: o.totalMnt,
  slot_starts_at: o.slotStartsAt.toISOString(),
  fire_at: iso(o.fireAt),
  ready_at: iso(o.readyAt),
  seated_at: iso(o.seatedAt),
  fire_mode: o.fireMode,
  late: o.late,
  created_at: o.createdAt.toISOString(),
});

export function registerDineDesk(app: FastifyInstance, ctx: Ctx, { asOps, asRunner, who }: DeskGuards): void {
  app.get('/v1/ops/dine/restaurants', asOps, async () => ({
    restaurants: (await restaurantsForDesk(ctx.clock.now())).map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      auto_accept: r.autoAccept,
      slot_minutes: r.slotMinutes,
      travel_minutes: r.travelMinutes,
      merchant_tin: r.merchantTin,
      online: r.online,
      devices: r.devices.map((d) => ({
        id: d.id,
        label: d.label,
        paired_at: iso(d.pairedAt),
        last_seen_at: iso(d.lastSeenAt),
        pairing_code: d.pairingCode,
        pairing_expires_at: iso(d.pairingExpiresAt),
        online: d.online,
      })),
      menu: { total: r.menu.total, active: r.menu.active, sold_out: r.menu.soldOut },
      today: { placed: r.today.placed, live: r.today.live, held: r.today.held, sales_mnt: r.today.salesMnt },
      rating: r.rating ? { stars: r.rating.stars, count: r.rating.count, on_time_share: r.rating.onTimeShare } : null,
    })),
  }));

  app.post<{ Params: { id: string }; Body: { active?: boolean; note?: string } }>(
    '/v1/ops/dine/restaurants/:id/active',
    asRunner,
    async (request, reply) => {
      const active = request.body?.active;
      if (typeof active !== 'boolean') return badRequest(reply, 'active: true эсвэл false.', 'active must be a boolean');
      if (!(await setRestaurantActive(request.params.id, active))) return sendError(reply, new IdeshError('NOT_FOUND', 'no such restaurant'));
      await recordAudit({ who: who(request), action: active ? 'restaurant.activate' : 'restaurant.suspend', targetKind: 'restaurant', targetId: request.params.id, note: request.body?.note ?? null });
      return reply.send({ id: request.params.id, active });
    },
  );

  /** A code for a new tablet, good for ten minutes. */
  app.post<{ Params: { id: string }; Body: { label?: string } }>('/v1/ops/dine/restaurants/:id/devices', asRunner, async (request, reply) => {
    const label = request.body?.label?.trim() || 'Гал тогооны таблет';
    const code = await createPairingCode(ctx, request.params.id, label);
    await recordAudit({ who: who(request), action: 'device.pair_code', targetKind: 'restaurant', targetId: request.params.id, note: label });
    return reply.status(201).send({ pairing_code: code, expires_in_minutes: 10 });
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/dine/devices/:id/revoke', asRunner, async (request, reply) => {
    await revokeDevice(request.params.id, ctx.clock.now());
    await recordAudit({ who: who(request), action: 'device.revoke', targetKind: 'device', targetId: request.params.id, note: request.body?.note ?? null });
    return reply.send({ id: request.params.id, revoked: true });
  });

  app.get<{ Params: { id: string } }>('/v1/ops/dine/restaurants/:id/menu', asOps, async (request) => ({
    items: (await menuForDesk(request.params.id)).map((m) => ({
      id: m.id,
      name: m.name,
      station: m.station,
      price_mnt: m.priceMnt,
      prep_minutes: m.prepMinutes,
      active: m.active,
      preorder: m.preorder,
      sold_out_until: iso(m.soldOutUntil),
      image_url: m.imageUrl,
    })),
  }));

  app.post<{ Params: { id: string }; Body: { active?: boolean; note?: string } }>('/v1/ops/dine/menu/:id/active', asRunner, async (request, reply) => {
    const active = request.body?.active;
    if (typeof active !== 'boolean') return badRequest(reply, 'active: true эсвэл false.', 'active must be a boolean');
    if (!(await setMenuItemActive(request.params.id, active))) return sendError(reply, new IdeshError('NOT_FOUND', 'no such menu item'));
    await recordAudit({ who: who(request), action: active ? 'menu.show' : 'menu.hide', targetKind: 'menu_item', targetId: request.params.id, note: request.body?.note ?? null });
    return reply.send({ id: request.params.id, active });
  });

  app.get<{ Querystring: { scope?: string; restaurant?: string; day?: string; q?: string } }>('/v1/ops/dine/orders', asOps, async (request) => {
    const scope = (['live', 'done', 'all'] as const).includes(request.query.scope as DineScope) ? (request.query.scope as DineScope) : 'live';
    const orders = await dineOrdersForDesk(
      { scope, restaurantId: request.query.restaurant || undefined, day: request.query.day || undefined, q: request.query.q },
      ctx.clock.now(),
    );
    return { orders: orders.map(shapeOrder) };
  });

  app.get<{ Params: { id: string } }>('/v1/ops/dine/orders/:id', asOps, async (request, reply) => {
    const file = await dineOrderFile(request.params.id, ctx.clock.now());
    if (!file) return sendError(reply, new IdeshError('NOT_FOUND', 'no such order'));
    return reply.send({
      order: {
        ...shapeOrder(file.order),
        eta_at: iso(file.order.etaAt),
        fired_at: iso(file.order.firedAt),
        served_at: iso(file.order.servedAt),
        closed_at: iso(file.order.closedAt),
        table: file.order.table,
      },
      lines: file.lines.map((l) => ({ name: l.name, qty: l.qty, unit_price_mnt: l.unitPriceMnt, station: l.station, notes: l.notes, cancelled: l.cancelled })),
      events: file.events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.at.toISOString() })),
      review: file.review ? { stars: file.review.stars, on_time: file.review.onTime, comment: file.review.comment, at: file.review.at.toISOString() } : null,
    });
  });

  /** Cancelling for a guest who rang: only while it is still free to, and the money goes back the way it came. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/dine/orders/:id/cancel', asRunner, async (request, reply) => {
    const note = request.body?.note?.trim();
    if (!note) return badRequest(reply, 'Шалтгаан бичнэ үү.', 'note required');
    try {
      const result = await cancelOrder(ctx, request.params.id, who(request));
      await recordAudit({ who: who(request), action: 'order.cancel', targetKind: 'order', targetId: request.params.id, note });
      return reply.send({ state: 'CANCELLED', refunded: result.refunded });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** The table was held and nobody came; the kitchen rang the desk. */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/v1/ops/dine/orders/:id/no-show', asRunner, async (request, reply) => {
    try {
      await markNoShow(ctx, request.params.id);
      await recordAudit({ who: who(request), action: 'order.no_show', targetKind: 'order', targetId: request.params.id, note: request.body?.note ?? null });
      const file = await dineOrderFile(request.params.id, ctx.clock.now());
      return reply.send({ state: file?.order.state ?? 'NO_SHOW' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { restaurant?: string } }>('/v1/ops/dine/reviews', asOps, async (request) => ({
    reviews: (await reviewsForDesk(request.query.restaurant || undefined)).map((v) => ({
      order_id: v.orderId,
      order_code: v.orderCode,
      restaurant: v.restaurant,
      guest: v.guest,
      stars: v.stars,
      on_time: v.onTime,
      comment: v.comment,
      at: v.at.toISOString(),
    })),
  }));
}
