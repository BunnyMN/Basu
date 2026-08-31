import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { getPool } from '../db/pool.js';
import { hhmm } from '../domain/time.js';
import { isFreeToCancel } from '../domain/states.js';
import type { SignalType } from '../domain/eta.js';
import {
  createPairingCode,
  isRestaurantOnline,
  pairDevice,
  requestOtp,
  resolveDevice,
  resolveGuest,
  verifyOtp,
} from '../services/auth.js';
import {
  acceptOrder,
  cancelOrder,
  checkIn,
  createOrder,
  fireNow,
  holdFor,
  markReady,
  markServed,
  OrderError,
  payOrder,
  recordSignal,
  rejectOrder,
} from '../services/orders.js';
import { enqueueNotification } from '../services/notifications.js';
import { badRequest, forbidden, sendError, unauthorized } from './errors.js';
import { registerMapRoutes } from './tiles.js';
import { registerDishRoutes } from './dishes.js';
import { registerRouteRoutes } from './route.js';
import type { Ctx } from '../ports.js';

/**
 * The HTTP surface.
 *
 * Thin on purpose: every route parses input, names who is calling, and hands
 * off to `src/services`. Nothing here decides anything about food or money, so
 * the same behaviour is reachable from the simulator and the tests without a
 * server running.
 */

declare module 'fastify' {
  interface FastifyRequest {
    guestId?: string;
    device?: { deviceId: string; restaurantId: string };
  }
}

/**
 * How long a phone might plausibly still be retrying the same request.
 * Older than this and the same key means a new intention, not a repeat.
 */
const IDEMPOTENCY_TTL_HOURS = 24;

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

export interface ServerOptions {
  logger?: boolean;
  /**
   * Mounts the two demo pages and the clock controls they need. Never on in
   * production: it would let anyone move the kitchen's idea of time.
   */
  dev?: boolean;
}

export async function buildServer(ctx: Ctx, options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const db = getPool();

  // Tiles and glyphs, same-origin. See src/api/tiles.ts for why they are
  // proxied rather than fetched straight from the tile host.
  await registerMapRoutes(app);
  // Illustrations for the menu, drawn on demand. See src/api/dishes.ts.
  await registerDishRoutes(app);
  // How far the walk is, and how long it takes. See src/api/route.ts.
  await registerRouteRoutes(app);

  /* ── who is calling ─────────────────────────────────────────────── */

  const requireGuest = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    const guestId = token ? await resolveGuest(ctx, token) : null;
    if (!guestId) return unauthorized(reply);
    request.guestId = guestId;
    return undefined;
  };

  const requireDevice = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    const device = token ? await resolveDevice(ctx, token) : null;
    if (!device) return unauthorized(reply);
    request.device = device;
    return undefined;
  };

  /** A guest may only ever touch their own order. */
  const ownedByGuest = async (orderId: string, guestId: string): Promise<boolean> => {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM dining_order WHERE id = $1 AND guest_id = $2',
      [orderId, guestId],
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  /** …and a tablet only its own restaurant's tickets. */
  const ownedByRestaurant = async (orderId: string, restaurantId: string): Promise<boolean> => {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM dining_order WHERE id = $1 AND restaurant_id = $2',
      [orderId, restaurantId],
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  /**
   * Idempotency, because a phone on a patchy connection retries and a guest
   * double-taps. Same key, same answer — never a second order.
   *
   * Kept in Postgres rather than in this process: two API instances behind one
   * address do not share memory, and a retry landing on the other one would
   * order lunch twice, which is precisely what the key is for.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    const key = request.headers['idempotency-key'];
    // Only successful responses are remembered. The key exists to stop a
    // retried request buying lunch twice — not to make a failure permanent.
    // Caching a 401 would mean a client that signs in and tries again gets
    // handed the same rejection forever.
    if (typeof key !== 'string' || request.method !== 'POST' || reply.statusCode >= 400) {
      return payload;
    }
    await db
      .query(
        `INSERT INTO idempotency_key (key, status, content_type, body, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
        [
          key,
          reply.statusCode,
          reply.getHeader('content-type') ?? null,
          typeof payload === 'string' ? payload : JSON.stringify(payload),
          ctx.clock.now(),
        ],
      )
      .catch(() => {});
    return payload;
  });

  app.addHook('preHandler', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || request.method !== 'POST') return undefined;

    const { rows } = await db.query<{ status: number; content_type: string | null; body: string }>(
      `SELECT status, content_type, body FROM idempotency_key
        WHERE key = $1 AND created_at > $2::timestamptz - make_interval(hours => $3)`,
      [key, ctx.clock.now(), IDEMPOTENCY_TTL_HOURS],
    );
    const hit = rows[0];
    if (!hit) return undefined;

    reply.header('idempotent-replay', 'true');
    // The content type travels with the body. Without it the replay went out
    // as text/plain and a client parsing by content-type got a string where
    // the first attempt had given it an object.
    if (hit.content_type) reply.header('content-type', hit.content_type);
    return reply.status(hit.status).send(hit.body);
  });

  /* ── health ─────────────────────────────────────────────────────── */

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, at: ctx.clock.now().toISOString() };
  });

  /* ── auth ───────────────────────────────────────────────────────── */

  app.post<{ Body: { phone?: string } }>('/v1/auth/otp', async (request, reply) => {
    const phone = request.body?.phone;
    if (!phone || !/^\+976\d{8}$/.test(phone)) {
      return badRequest(reply, 'Утасны дугаараа шалгана уу.', 'phone must be +976XXXXXXXX');
    }
    try {
      const { code } = await requestOtp(ctx, phone);
      // The code goes out by SMS and is never returned in the response body.
      await ctx.notifier.send({
        channel: 'sms',
        to: phone,
        template: 'auth.otp',
        body: `Таны код: ${code}`,
      });
      return reply.status(202).send({ sent: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: { phone?: string; code?: string } }>(
    '/v1/auth/verify',
    async (request, reply) => {
      const { phone, code } = request.body ?? {};
      if (!phone || !code) {
        return badRequest(reply, 'Утас, кодоо оруулна уу.', 'phone and code are required');
      }
      try {
        const session = await verifyOtp(ctx, phone, code);
        return reply.send({
          token: session.token,
          guest_id: session.guestId,
          expires_at: session.expiresAt.toISOString(),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── browsing ───────────────────────────────────────────────────── */

  app.get('/v1/restaurants', async () => {
    const { rows } = await db.query(
      `SELECT id, name, travel_minutes, lat, lon FROM restaurant WHERE active ORDER BY name`,
    );
    const out = [];
    for (const r of rows as Array<{
      id: string;
      name: string;
      travel_minutes: number;
      lat: number | null;
      lon: number | null;
    }>) {
      out.push({
        id: r.id,
        name: r.name,
        walk_minutes: r.travel_minutes,
        lat: r.lat === null ? null : Number(r.lat),
        lon: r.lon === null ? null : Number(r.lon),
        // A kitchen nobody is watching cannot take an order (§08).
        accepting_orders: await isRestaurantOnline(ctx, r.id),
      });
    }
    return { restaurants: out };
  });

  app.get<{ Params: { id: string } }>('/v1/restaurants/:id/menu', async (request) => {
    const { rows } = await db.query(
      `SELECT m.id, m.name, m.price_mnt, m.prep_minutes, m.image_url, m.description,
              s.display_name AS station,
              (m.sold_out_until IS NOT NULL) AS sold_out
         FROM menu_item m JOIN station s ON s.id = m.station_id
        WHERE m.restaurant_id = $1 AND m.active AND m.preorder_enabled
        ORDER BY m.price_mnt DESC, m.name`,
      [request.params.id],
    );
    return { items: rows };
  });

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/v1/restaurants/:id/slots',
    async (request) => {
      const { rows } = await db.query(
        `SELECT starts_at, max_orders, taken_orders, closed
           FROM slot
          WHERE restaurant_id = $1
            AND starts_at::date = COALESCE($2::date, $3::timestamptz::date)
          ORDER BY starts_at`,
        [request.params.id, request.query.date ?? null, ctx.clock.now()],
      );
      return {
        slots: (rows as Array<{
          starts_at: Date;
          max_orders: number;
          taken_orders: number;
          closed: boolean;
        }>).map((s) => ({
          starts_at: s.starts_at.toISOString(),
          label: hhmm(s.starts_at),
          available: !s.closed && s.taken_orders < s.max_orders,
          remaining: Math.max(0, s.max_orders - s.taken_orders),
        })),
      };
    },
  );

  /* ── ordering ───────────────────────────────────────────────────── */

  app.post<{
    Body: {
      restaurant_id?: string;
      slot_starts_at?: string;
      party_size?: number;
      items?: Array<{ menu_item_id: string; qty: number; notes?: string }>;
    };
  }>('/v1/orders', { preHandler: requireGuest }, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.restaurant_id || !body.slot_starts_at || !body.items?.length) {
      return badRequest(
        reply,
        'Ресторан, цаг, хоолоо сонгоно уу.',
        'restaurant_id, slot_starts_at and items are required',
      );
    }
    if (!(await isRestaurantOnline(ctx, body.restaurant_id))) {
      return reply.status(503).send({
        error: {
          code: 'RESTAURANT_OFFLINE',
          message_mn: 'Энэ ресторан одоогоор захиалга авахгүй байна.',
          message_en: 'the restaurant is offline',
        },
      });
    }

    try {
      const created = await createOrder(ctx, {
        restaurantId: body.restaurant_id,
        guestId: request.guestId!,
        slotStartsAt: new Date(body.slot_starts_at),
        partySize: body.party_size ?? 1,
        items: (body.items ?? []).map((i) => ({
          menuItemId: i.menu_item_id,
          qty: i.qty,
          ...(i.notes !== undefined ? { notes: i.notes } : {}),
        })),
      });
      return reply.status(201).send({
        id: created.orderId,
        code: created.code,
        state: 'DRAFT',
        total_mnt: created.totalMnt,
        // The guest has ten minutes to pay before the table goes back.
        hold_expires_at: new Date(ctx.clock.now().getTime() + 10 * 60_000).toISOString(),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/v1/orders/:id/pay',
    { preHandler: requireGuest },
    async (request, reply) => {
      if (!(await ownedByGuest(request.params.id, request.guestId!))) {
        return forbidden(reply, 'not your order');
      }
      try {
        await payOrder(ctx, request.params.id);
        return reply.send({ state: 'PLACED' });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { type?: SignalType } }>(
    '/v1/orders/:id/signal',
    { preHandler: requireGuest },
    async (request, reply) => {
      const type = request.body?.type;
      const allowed: SignalType[] = ['on_my_way', 'delay_10', 'geofence_800', 'geofence_300', 'app_open'];
      if (!type || !allowed.includes(type)) {
        return badRequest(reply, 'Дохио танигдсангүй.', `type must be one of ${allowed.join(', ')}`);
      }
      if (!(await ownedByGuest(request.params.id, request.guestId!))) {
        return forbidden(reply, 'not your order');
      }
      await recordSignal(ctx, request.params.id, type);
      return reply.status(202).send({ recorded: type });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/orders/:id/cancel',
    { preHandler: requireGuest },
    async (request, reply) => {
      if (!(await ownedByGuest(request.params.id, request.guestId!))) {
        return forbidden(reply, 'not your order');
      }
      try {
        await cancelOrder(ctx, request.params.id, `guest:${request.guestId}`);
        return reply.send({ state: 'REFUNDED', refunded: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/orders/:id',
    { preHandler: requireGuest },
    async (request, reply) => {
      const { rows } = await db.query(
        `SELECT o.id, o.code, o.state, o.slot_starts_at, o.fire_at, o.ready_at,
                o.seated_at, o.total_mnt, t.code AS table_code,
                e.qr_payload, e.lottery
           FROM dining_order o
           LEFT JOIN table_hold h ON h.order_id = o.id AND h.released_at IS NULL
           LEFT JOIN dining_table t ON t.id = h.table_id
           LEFT JOIN payment p ON p.order_id = o.id AND p.state = 'captured'
           LEFT JOIN ebarimt_receipt e ON e.payment_id = p.id AND e.state = 'issued'
          WHERE o.id = $1 AND o.guest_id = $2`,
        [request.params.id, request.guestId],
      );
      const order = rows[0] as
        | {
            id: string;
            code: string;
            state: string;
            slot_starts_at: Date;
            fire_at: Date | null;
            ready_at: Date | null;
            seated_at: Date | null;
            total_mnt: number;
            table_code: string | null;
            qr_payload: string | null;
            lottery: string | null;
          }
        | undefined;
      if (!order) return sendError(reply, new OrderError('NOT_FOUND', 'no such order'));

      return reply.send({
        id: order.id,
        code: order.code,
        state: order.state,
        table: order.table_code,
        total_mnt: order.total_mnt,
        slot_starts_at: order.slot_starts_at.toISOString(),
        fire_at: order.fire_at?.toISOString() ?? null,
        ready_at: order.ready_at?.toISOString() ?? null,
        // The one line that prevents most disputes: say when it stops being free.
        free_cancel_until: isFreeToCancel(order.state as never)
          ? (order.fire_at?.toISOString() ?? null)
          : null,
        can_cancel: isFreeToCancel(order.state as never),
        receipt: order.qr_payload ? { qr: order.qr_payload, lottery: order.lottery } : null,
      });
    },
  );

  /* ── the kitchen ────────────────────────────────────────────────── */

  app.post<{ Body: { pairing_code?: string } }>('/v1/kds/pair', async (request, reply) => {
    const code = request.body?.pairing_code;
    if (!code) return badRequest(reply, 'Холбох код оруулна уу.', 'pairing_code is required');
    try {
      const session = await pairDevice(ctx, code);
      return reply.send({
        token: session.token,
        device_id: session.deviceId,
        restaurant_id: session.restaurantId,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * The three columns the tablet draws, in one call.
   *
   * Deliberately a poll rather than a socket for v1: a tablet that reloads gets
   * the truth, and there is no replay window to get wrong. The websocket
   * gateway can subscribe to the same outbox topic later without changing this.
   *
   * `restaurantId` of null means every kitchen, which only the demo asks for —
   * see the note on /dev/kds/tickets.
   */
  const board = async (restaurantId: string | null) => {
    // Which kitchen this is. A chef needs to see at a glance that they are on
    // the right board — an unnamed empty board looks the same whether nothing
    // has been ordered or the tablet is watching somebody else's kitchen.
    const named = restaurantId
      ? await db.query<{ name: string }>('SELECT name FROM restaurant WHERE id = $1', [
          restaurantId,
        ])
      : null;
    const watching = named?.rows[0]?.name ?? null;

    const { rows } = await db.query(
      `SELECT o.id, o.code, o.state, o.party_size, o.slot_starts_at, o.fire_at,
              o.ready_at, o.eta_at, o.seated_at, o.order_prep_minutes,
              g.name AS guest_name, t.code AS table_code, r.name AS restaurant,
              COALESCE(
                json_agg(json_build_object('name', l.name, 'qty', l.qty,
                                           'station', l.station_code, 'image', mi.image_url)
                         ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL),
                '[]'
              ) AS lines
         FROM dining_order o
         JOIN guest g ON g.id = o.guest_id
         JOIN restaurant r ON r.id = o.restaurant_id
         LEFT JOIN order_line l ON l.order_id = o.id AND l.cancelled_at IS NULL
         LEFT JOIN menu_item mi ON mi.id = l.menu_item_id
         LEFT JOIN table_hold h ON h.order_id = o.id AND h.released_at IS NULL
         LEFT JOIN dining_table t ON t.id = h.table_id
        WHERE ($1::uuid IS NULL OR o.restaurant_id = $1::uuid)
          AND o.state IN ('PLACED','ACCEPTED','SCHEDULED','ARMED','HELD','FIRED','COOKING','READY')
        GROUP BY o.id, g.name, t.code, r.name
        ORDER BY COALESCE(o.fire_at, o.slot_starts_at)`,
      [restaurantId],
    );

    const now = ctx.clock.now();
    const lanes = { incoming: [] as unknown[], cooking: [] as unknown[], ready: [] as unknown[] };

    for (const row of rows as Array<Record<string, never> & {
      id: string;
      code: string;
      state: string;
      party_size: number;
      slot_starts_at: Date;
      fire_at: Date | null;
      ready_at: Date | null;
      seated_at: Date | null;
      guest_name: string | null;
      table_code: string | null;
      restaurant: string;
      lines: Array<{ name: string; qty: number }>;
    }>) {
      const ticket = {
        id: row.id,
        code: row.code,
        state: row.state,
        party_size: row.party_size,
        guest: row.guest_name,
        table: row.table_code,
        restaurant: row.restaurant,
        seated: row.seated_at !== null,
        lines: row.lines,
        // Minutes, signed: negative means this ticket is already late.
        countdown_minutes:
          row.fire_at !== null
            ? Math.round((row.fire_at.getTime() - now.getTime()) / 60_000)
            : null,
        due_at: hhmm(row.fire_at ?? row.slot_starts_at),
        // HELD is not an error state to hide — it is the kitchen being asked to
        // decide, and it has to look different on the screen.
        needs_attention: row.state === 'HELD',
      };

      if (row.state === 'READY') lanes.ready.push(ticket);
      else if (row.state === 'FIRED' || row.state === 'COOKING') lanes.cooking.push(ticket);
      else lanes.incoming.push(ticket);
    }

    return { now: hhmm(now), watching, lanes };
  };

  app.get('/v1/kds/tickets', { preHandler: requireDevice }, async (request) =>
    board(request.device!.restaurantId),
  );

  /**
   * Every tablet action shares the same three steps: check the ticket is this
   * restaurant's, run it, translate any failure. Written once so a new button
   * cannot accidentally skip the ownership check.
   */
  const kdsAction = <T,>(
    path: string,
    handler: (orderId: string, body: T | undefined, request: FastifyRequest) => Promise<unknown>,
  ) => {
    app.post<{ Params: { id: string }; Body: T }>(
      path,
      { preHandler: requireDevice },
      async (request, reply) => {
        if (!(await ownedByRestaurant(request.params.id, request.device!.restaurantId))) {
          return forbidden(reply, 'that ticket belongs to another restaurant');
        }
        try {
          const body = request.body as T | undefined;
          const result = await handler(request.params.id, body, request);
          return reply.send(result ?? { ok: true });
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  };

  kdsAction<undefined>('/v1/kds/tickets/:id/accept', async (orderId, _body, request) => {
    await acceptOrder(ctx, orderId, `kds:${request.device!.deviceId}`);
    return { state: 'SCHEDULED' };
  });

  kdsAction<{ reason?: string }>('/v1/kds/tickets/:id/reject', async (orderId, body) => {
    await rejectOrder(ctx, orderId, body?.reason ?? 'no reason given');
    return { state: 'REFUNDED' };
  });

  kdsAction<undefined>('/v1/kds/tickets/:id/fire-now', async (orderId, _body, request) => {
    await fireNow(ctx, orderId, `kds:${request.device!.deviceId}`);
    return { state: 'FIRED' };
  });

  kdsAction<{ minutes?: number }>('/v1/kds/tickets/:id/hold', async (orderId, body) => {
    await holdFor(ctx, orderId, body?.minutes ?? 5);
    return { ok: true };
  });

  kdsAction<undefined>('/v1/kds/tickets/:id/ready', async (orderId, _body, request) => {
    await markReady(ctx, orderId, `kds:${request.device!.deviceId}`);
    return { state: 'READY' };
  });

  kdsAction<undefined>('/v1/kds/tickets/:id/served', async (orderId, _body, request) => {
    await markServed(ctx, orderId, `kds:${request.device!.deviceId}`);
    return { state: 'SERVED' };
  });

  /** 86 — the dish is gone. Pulled from the menu immediately. */
  app.post<{ Params: { itemId: string }; Body: { until?: string } }>(
    '/v1/kds/menu/:itemId/86',
    { preHandler: requireDevice },
    async (request, reply) => {
      const until = request.body?.until
        ? new Date(request.body.until)
        : new Date(ctx.clock.now().getTime() + 4 * 60 * 60_000);
      const { rowCount } = await db.query(
        `UPDATE menu_item SET sold_out_until = $3
          WHERE id = $1 AND restaurant_id = $2`,
        [request.params.itemId, request.device!.restaurantId, until],
      );
      if (!rowCount) return forbidden(reply, 'that item belongs to another restaurant');
      return reply.send({ sold_out_until: until.toISOString() });
    },
  );

  app.post<{ Params: { code: string } }>(
    '/v1/checkin/:code',
    { preHandler: requireDevice },
    async (request, reply) => {
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM dining_order WHERE code = $1 AND restaurant_id = $2',
        [request.params.code, request.device!.restaurantId],
      );
      const order = rows[0];
      if (!order) return sendError(reply, new OrderError('NOT_FOUND', 'no such order here'));
      await checkIn(ctx, order.id);
      return reply.send({ seated: true, order_id: order.id });
    },
  );

  /* ── ops ────────────────────────────────────────────────────────── */

  app.post<{ Body: { restaurant_id?: string; label?: string } }>(
    '/v1/ops/devices',
    async (request, reply) => {
      const { restaurant_id: restaurantId, label } = request.body ?? {};
      if (!restaurantId) return badRequest(reply, 'Ресторан заана уу.', 'restaurant_id required');
      const code = await createPairingCode(ctx, restaurantId, label ?? 'Гал тогооны таблет');
      return reply.status(201).send({ pairing_code: code, expires_in_minutes: 10 });
    },
  );

  /** What the lunchtime watch actually looks at: three numbers. */
  app.get('/v1/ops/health', async () => {
    const { rows } = await db.query<{
      held: number;
      late: number;
      offline: number;
      cooking: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM dining_order WHERE state = 'HELD') AS held,
         (SELECT count(*)::int FROM fire_job
           WHERE state = 'pending' AND run_at < $1::timestamptz - interval '2 minutes') AS late,
         (SELECT count(*)::int FROM restaurant r WHERE r.active AND NOT EXISTS (
            SELECT 1 FROM kds_device d
             WHERE d.restaurant_id = r.id AND d.revoked_at IS NULL
               AND d.last_seen_at > $1::timestamptz - interval '90 seconds')) AS offline,
         (SELECT count(*)::int FROM dining_order WHERE state IN ('FIRED','COOKING')) AS cooking`,
      [ctx.clock.now()],
    );
    return rows[0];
  });

  /* ── development only ───────────────────────────────────────────── */

  if (options.dev) await mountDevRoutes(app, ctx, board);

  void enqueueNotification;
  return app;
}

/**
 * The demo surface: the two pages, and the ability to move the clock.
 *
 * Lunch runs 11:30–14:00 and the gap between firing and seating is fifteen
 * minutes, so watching the product work in real time means either eating lunch
 * at the right hour or waiting around. Being able to jump to 12:14 and step
 * forward a minute at a time is what makes the whole thing demonstrable.
 */
async function mountDevRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  /** The same board `/v1/kds/tickets` serves, but for every kitchen at once. */
  board: (restaurantId: string | null) => Promise<unknown>,
): Promise<void> {
  const staticPlugin = await import('@fastify/static');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  await app.register(staticPlugin.default, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'web'),
    prefix: '/',
  });

  app.get('/kds', (_request, reply) => reply.sendFile('kds.html'));
  app.get('/ops', (_request, reply) => reply.sendFile('ops.html'));

  const clock = ctx.clock as { setTo?: (v: string) => void; advanceMinutes?: (m: number) => void };

  app.get('/dev/clock', async () => ({
    now: ctx.clock.now().toISOString(),
    label: hhmm(ctx.clock.now()),
    controllable: typeof clock.setTo === 'function',
  }));

  app.post<{ Body: { to?: string; advance?: number } }>('/dev/clock', async (request, reply) => {
    if (typeof clock.setTo !== 'function') {
      return badRequest(reply, 'Цаг удирдах боломжгүй.', 'clock is not controllable');
    }
    if (request.body?.to) clock.setTo(request.body.to);
    if (typeof request.body?.advance === 'number') clock.advanceMinutes?.(request.body.advance);
    return reply.send({ now: ctx.clock.now().toISOString(), label: hhmm(ctx.clock.now()) });
  });

  /**
   * Demo shortcut: sign in without waiting for an SMS.
   *
   * The real OTP path is what the tests exercise; this exists so a person
   * clicking through does not need a phone in their hand.
   */
  app.post<{ Body: { phone?: string } }>('/dev/login', async (request, reply) => {
    const phone = request.body?.phone ?? '+97699001122';
    try {
      // Straight to a session. Going through the OTP path would put a
      // walkthrough behind the three-codes-an-hour limit, which exists to stop
      // somebody running up an SMS bill and has nothing to say about a demo.
      const { startSession } = await import('../services/auth.js');
      const session = await startSession(ctx, phone);
      return reply.send({ token: session.token, guest_id: session.guestId, phone });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** The pairing codes the seed just printed, so the tablet can self-pair. */
  app.get('/dev/pairing-codes', async () => {
    const { rows } = await getPool().query(
      `SELECT d.pairing_code AS code, r.name, r.id AS restaurant_id
         FROM kds_device d JOIN restaurant r ON r.id = d.restaurant_id
        WHERE d.paired_at IS NULL AND d.pairing_code IS NOT NULL
        ORDER BY r.name`,
    );
    return { devices: rows };
  });

  /**
   * Every kitchen's board on one screen.
   *
   * A tablet sees its own restaurant and nothing else — that isolation is the
   * point of the token and `/v1/kds/tickets` keeps it. But a walkthrough moves
   * between ten venues, and orders placed at nine of them would be invisible on
   * a screen paired to the tenth. So the demo gets a view across all of them,
   * with each ticket labelled by kitchen.
   *
   * It lives under /dev for the same reason the clock control does: this whole
   * surface exists only in demo mode, and none of it is reachable in production.
   */
  app.get('/dev/kds/tickets', async () => board(null));

  /** The same tablet actions, without needing that restaurant's own token. */
  app.post<{ Params: { id: string; action: string }; Body: { minutes?: number; reason?: string } }>(
    '/dev/kds/tickets/:id/:action',
    async (request, reply) => {
      const { id, action } = request.params;
      const body = request.body ?? {};
      try {
        switch (action) {
          case 'accept':
            await acceptOrder(ctx, id, 'kds:demo');
            break;
          case 'reject':
            await rejectOrder(ctx, id, body.reason ?? 'demo');
            break;
          case 'fire-now':
            await fireNow(ctx, id, 'kds:demo');
            break;
          case 'hold':
            await holdFor(ctx, id, body.minutes ?? 5);
            break;
          case 'ready':
            await markReady(ctx, id, 'kds:demo');
            break;
          case 'served':
            await markServed(ctx, id, 'kds:demo');
            break;
          default:
            return badRequest(reply, 'Ийм үйлдэл алга.', `unknown action ${action}`);
        }
        return reply.send({ ok: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** Every restaurant, and whether a tablet is currently watching it. */
  app.get('/dev/venues', async () => {
    const { rows } = await getPool().query(
      `SELECT r.id, r.name,
              EXISTS (SELECT 1 FROM kds_device d
                       WHERE d.restaurant_id = r.id AND d.revoked_at IS NULL
                         AND d.paired_at IS NOT NULL) AS watched
         FROM restaurant r WHERE r.active ORDER BY r.name`,
    );
    return { venues: rows };
  });

  /**
   * Hand this browser a tablet for a restaurant, no code typing.
   *
   * The real flow is a manager reading an eight-digit code off a screen, and
   * that is what the tests exercise. But the demo clock jumps hours, codes
   * expire, and someone walking through the product should not be locked out
   * of the kitchen because they pressed "12:21 гал" first.
   */
  app.post<{ Body: { restaurant_id?: string } }>('/dev/kds-token', async (request, reply) => {
    const restaurantId = request.body?.restaurant_id;
    if (!restaurantId) return badRequest(reply, 'Ресторан заана уу.', 'restaurant_id required');
    const { createPairingCode, pairDevice } = await import('../services/auth.js');
    const code = await createPairingCode(ctx, restaurantId, 'Демо таблет', 60);
    const session = await pairDevice(ctx, code);
    return reply.send({ token: session.token, restaurant_id: session.restaurantId });
  });

  /** Run one scheduler pass on demand, so a page can step time forward. */
  app.post('/dev/tick', async () => {
    const { tick } = await import('../scheduler/runner.js');
    return tick(ctx, { spacingMs: 0 });
  });

  /** Everything the ops console needs, in one call. */
  app.get('/dev/orders', async () => {
    const { rows } = await getPool().query(
      `SELECT o.code, o.state, r.name AS restaurant, o.slot_starts_at, o.fire_at,
              o.ready_at, o.seated_at, o.fired_by, o.fire_mode, o.eta_confidence,
              o.order_prep_minutes, o.total_mnt
         FROM dining_order o JOIN restaurant r ON r.id = o.restaurant_id
        ORDER BY o.created_at DESC LIMIT 50`,
    );
    return { orders: rows };
  });
}
