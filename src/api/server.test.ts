import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { at, PILOT_MENU } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { createPairingCode } from '../services/auth.js';
import { tick } from '../scheduler/runner.js';
import {
  FakeNotifier,
  FakePaymentProvider,
  FakeTaxProvider,
  type Ctx,
} from '../ports.js';
import { seedRestaurant, truncateAll, type SeededRestaurant } from '../test/seed.js';

/**
 * The HTTP surface, driven the way a phone and a tablet drive it.
 *
 * The isolation tests here matter most. Cross-tenant leaks are the kind of bug
 * that is invisible in manual testing — everything works when you only have one
 * restaurant open — and catastrophic in production.
 */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let venue: SeededRestaurant;

const pool = () => getPool();

/** Sign in the way the PWA does: ask for a code, read the SMS, verify. */
async function signIn(phone = '+97699001122'): Promise<string> {
  const asked = await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  expect(asked.statusCode).toBe(202);

  const sms = notifier.of('auth.otp').at(-1);
  const code = /(\d{6})/.exec(sms?.body ?? '')?.[1];
  expect(code, 'the OTP should have gone out by SMS').toBeTruthy();

  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { phone, code },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

async function pairTablet(restaurantId: string): Promise<string> {
  const code = await createPairingCode(ctx, restaurantId, 'Гал тогоо');
  const paired = await app.inject({
    method: 'POST',
    url: '/v1/kds/pair',
    payload: { pairing_code: code },
  });
  expect(paired.statusCode).toBe(200);
  return paired.json().token as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function placeAndPay(
  guestToken: string,
  restaurantId: string,
  menuId: string,
  slot = '12:30',
): Promise<{ id: string; code: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: auth(guestToken),
    payload: {
      restaurant_id: restaurantId,
      slot_starts_at: at(slot).toISOString(),
      party_size: 2,
      items: [{ menu_item_id: menuId, qty: 2 }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const order = created.json();

  const paid = await app.inject({
    method: 'POST',
    url: `/v1/orders/${order.id}/pay`,
    headers: auth(guestToken),
  });
  expect(paid.statusCode, paid.body).toBe(200);
  return { id: order.id, code: order.code };
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = {
    clock,
    payments: new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier,
  };
  app = await buildServer(ctx);
  venue = await seedRestaurant();
  await pool().query(
    `INSERT INTO slot (restaurant_id, starts_at, ends_at, max_orders, max_covers)
     VALUES ($1, $2::timestamptz, $2::timestamptz + interval '15 minutes', 3, 12)`,
    [venue.restaurantId, at('12:30')],
  );
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('signing in', () => {
  it('sends a code by SMS and never puts it in the response', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      payload: { phone: '+97699001122' },
    });
    expect(asked.json()).toEqual({ sent: true });
    expect(asked.body).not.toMatch(/\d{6}/);
    expect(notifier.of('auth.otp')).toHaveLength(1);
  });

  it('rejects a malformed number before touching the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      payload: { phone: '99001122' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message_mn).toMatch(/Утасны дугаараа/);
  });

  it('refuses a wrong code and stops guessing after three tries', async () => {
    await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone: '+97699001133' } });

    for (let i = 0; i < 3; i++) {
      const attempt = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: { phone: '+97699001133', code: '000000' },
      });
      expect(attempt.statusCode).toBe(400);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { phone: '+97699001133', code: '000000' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('caps how many codes one number can ask for', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone: '+97699001144' } });
    }
    const fourth = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      payload: { phone: '+97699001144' },
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.retry_after).toBe(3600);
  });
});

describe('ordering over HTTP', () => {
  it('turns a browse into a paid order', async () => {
    const guest = await signIn();
    await pairTablet(venue.restaurantId); // the kitchen has to be watching

    const restaurants = await app.inject({ method: 'GET', url: '/v1/restaurants' });
    expect(restaurants.json().restaurants[0].accepting_orders).toBe(true);

    const menu = await app.inject({
      method: 'GET',
      url: `/v1/restaurants/${venue.restaurantId}/menu`,
    });
    const items = menu.json().items as Array<{ id: string; name: string }>;
    expect(items.length).toBeGreaterThan(0);

    const slots = await app.inject({
      method: 'GET',
      url: `/v1/restaurants/${venue.restaurantId}/slots?date=2026-09-02`,
    });
    const slot = slots.json().slots.find((s: { label: string }) => s.label === '12:30');
    expect(slot).toMatchObject({ available: true, remaining: 3 });

    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);

    const view = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: auth(guest),
    });
    expect(view.json()).toMatchObject({
      code: order.code,
      state: 'PLACED',
      can_cancel: true,
      total_mnt: PILOT_MENU.tsuivan!.priceMnt * 2,
    });
    expect(view.json().table).toMatch(/^T\d$/);
  });

  it('turns away an order for a restaurant with no tablet watching', async () => {
    const guest = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(guest),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('RESTAURANT_OFFLINE');
  });

  it('explains a full slot in Mongolian rather than failing opaquely', async () => {
    const guest = await signIn();
    await pairTablet(venue.restaurantId);
    for (let i = 0; i < 3; i++) {
      await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);
    }

    const fourth = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(guest),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
      },
    });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toMatchObject({
      code: 'SLOT_FULL',
      message_mn: expect.stringContaining('дүүрсэн'),
    });
  });

  it('creates one order however many times a flaky phone retries', async () => {
    const guest = await signIn();
    await pairTablet(venue.restaurantId);

    const payload = {
      restaurant_id: venue.restaurantId,
      slot_starts_at: at('12:30').toISOString(),
      party_size: 2,
      items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
    };
    const headers = { ...auth(guest), 'idempotency-key': 'phone-retry-1' };

    const first = await app.inject({ method: 'POST', url: '/v1/orders', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/orders', headers, payload });

    expect(first.json().id).toBe(second.json().id);
    expect(second.headers['idempotent-replay']).toBe('true');

    const { rows } = await pool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM dining_order',
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('lets a client retry a failed call with the same idempotency key', async () => {
    await pairTablet(venue.restaurantId);
    const payload = {
      restaurant_id: venue.restaurantId,
      slot_starts_at: at('12:30').toISOString(),
      party_size: 2,
      items: [{ menu_item_id: venue.menuIds['tsuivan'], qty: 1 }],
    };
    const key = { 'idempotency-key': 'retry-after-auth' };

    // A stored session that has expired: the call fails before it does anything.
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: 'Bearer long-dead-token', ...key },
      payload,
    });
    expect(rejected.statusCode).toBe(401);

    // Signing in and trying again must work. Remembering the rejection would
    // make the key a permanent tombstone rather than a duplicate guard.
    const guest = await signIn();
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth(guest), ...key },
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.headers['idempotent-replay']).toBeUndefined();
  });

  it('stops accepting a cancellation once the food is on the stove', async () => {
    const guest = await signIn();
    const tablet = await pairTablet(venue.restaurantId);
    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);

    await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/accept`,
      headers: auth(tablet),
    });

    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });

    const tooLate = await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: auth(guest),
    });
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error).toMatchObject({
      code: 'TOO_LATE_TO_CANCEL',
      message_mn: expect.stringContaining('гал дээр гарсан'),
    });

    const view = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: auth(guest),
    });
    expect(view.json().can_cancel).toBe(false);
    expect(view.json().free_cancel_until).toBeNull();
  });
});

describe('the kitchen display', () => {
  it('sorts live tickets into the three columns the chef reads', async () => {
    const guest = await signIn();
    const tablet = await pairTablet(venue.restaurantId);
    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);

    const incoming = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(tablet),
    });
    expect(incoming.json().lanes.incoming).toHaveLength(1);
    expect(incoming.json().lanes.incoming[0]).toMatchObject({
      code: order.code,
      state: 'PLACED',
      lines: [{ name: 'Цуйван', qty: 2 }],
    });

    await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/accept`,
      headers: auth(tablet),
    });

    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });

    const cooking = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(tablet),
    });
    expect(cooking.json().lanes.cooking).toHaveLength(1);

    await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/ready`,
      headers: auth(tablet),
    });
    const ready = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(tablet),
    });
    expect(ready.json().lanes.ready).toHaveLength(1);
    expect(ready.json().lanes.cooking).toHaveLength(0);
  });

  it('lets the chef fire early and keeps the credit for it', async () => {
    const guest = await signIn();
    const tablet = await pairTablet(venue.restaurantId);
    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);

    await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/accept`,
      headers: auth(tablet),
    });

    clock.set(at('12:18'));
    const fired = await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/fire-now`,
      headers: auth(tablet),
    });
    expect(fired.statusCode).toBe(200);

    clock.set(at('12:22'));
    expect((await tick(ctx, { spacingMs: 0 })).fired).toBe(0);

    const { rows } = await pool().query<{ fired_by: string }>(
      'SELECT fired_by FROM dining_order WHERE id = $1',
      [order.id],
    );
    expect(rows[0]!.fired_by).toMatch(/^kds:/);
  });

  it('pulls an 86d dish out of the menu immediately', async () => {
    const tablet = await pairTablet(venue.restaurantId);
    const itemId = venue.menuIds['khuushuur']!;

    await app.inject({
      method: 'POST',
      url: `/v1/kds/menu/${itemId}/86`,
      headers: auth(tablet),
      payload: {},
    });

    const guest = await signIn();
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth(guest),
      payload: {
        restaurant_id: venue.restaurantId,
        slot_starts_at: at('12:30').toISOString(),
        party_size: 2,
        items: [{ menu_item_id: itemId, qty: 1 }],
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ITEM_SOLD_OUT');
  });
});

describe('nobody sees what is not theirs', () => {
  it('turns away a caller with no token', async () => {
    for (const url of ['/v1/orders/any', '/v1/kds/tickets']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('will not let one guest read another guest’s order', async () => {
    const alice = await signIn('+97699001111');
    await pairTablet(venue.restaurantId);
    const order = await placeAndPay(alice, venue.restaurantId, venue.menuIds['tsuivan']!);

    const mallory = await signIn('+97699002222');
    const peek = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: auth(mallory),
    });
    // Not "forbidden" — a 403 would confirm the order exists.
    expect(peek.statusCode).toBe(404);

    const meddle = await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: auth(mallory),
    });
    expect(meddle.statusCode).toBe(403);

    const { rows } = await pool().query<{ state: string }>(
      'SELECT state FROM dining_order WHERE id = $1',
      [order.id],
    );
    expect(rows[0]!.state).toBe('PLACED');
  });

  it('will not let one restaurant see or touch another’s tickets', async () => {
    const guest = await signIn();
    const ourTablet = await pairTablet(venue.restaurantId);
    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);

    const rival = await seedRestaurant();
    const rivalTablet = await pairTablet(rival.restaurantId);

    const theirBoard = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(rivalTablet),
    });
    expect(theirBoard.json().lanes.incoming).toHaveLength(0);

    for (const action of ['accept', 'fire-now', 'ready', 'reject']) {
      const attempt = await app.inject({
        method: 'POST',
        url: `/v1/kds/tickets/${order.id}/${action}`,
        headers: auth(rivalTablet),
        payload: {},
      });
      expect(attempt.statusCode, action).toBe(403);
    }

    // Our own tablet is unaffected.
    const ours = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(ourTablet),
    });
    expect(ours.json().lanes.incoming).toHaveLength(1);
  });

  it('will not let a tablet 86 another restaurant’s menu', async () => {
    const rival = await seedRestaurant();
    const rivalTablet = await pairTablet(rival.restaurantId);

    const attempt = await app.inject({
      method: 'POST',
      url: `/v1/kds/menu/${venue.menuIds['khuushuur']}/86`,
      headers: auth(rivalTablet),
      payload: {},
    });
    expect(attempt.statusCode).toBe(403);

    const { rows } = await pool().query<{ sold_out_until: Date | null }>(
      'SELECT sold_out_until FROM menu_item WHERE id = $1',
      [venue.menuIds['khuushuur']],
    );
    expect(rows[0]!.sold_out_until).toBeNull();
  });

  it('refuses a guest token where a device token is required, and the reverse', async () => {
    const guest = await signIn();
    const tablet = await pairTablet(venue.restaurantId);

    const asGuest = await app.inject({
      method: 'GET',
      url: '/v1/kds/tickets',
      headers: auth(guest),
    });
    expect(asGuest.statusCode).toBe(401);

    const asTablet = await app.inject({
      method: 'GET',
      url: '/v1/orders/00000000-0000-0000-0000-000000000000',
      headers: auth(tablet),
    });
    expect(asTablet.statusCode).toBe(401);
  });

  it('stops a revoked tablet dead', async () => {
    const tablet = await pairTablet(venue.restaurantId);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/kds/tickets', headers: auth(tablet) }))
        .statusCode,
    ).toBe(200);

    await pool().query(`UPDATE kds_device SET revoked_at = now(), token_hash = NULL`);

    expect(
      (await app.inject({ method: 'GET', url: '/v1/kds/tickets', headers: auth(tablet) }))
        .statusCode,
    ).toBe(401);
  });

  it('burns a pairing code after one use', async () => {
    const code = await createPairingCode(ctx, venue.restaurantId, 'Таблет');
    const first = await app.inject({
      method: 'POST',
      url: '/v1/kds/pair',
      payload: { pairing_code: code },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/kds/pair',
      payload: { pairing_code: code },
    });
    expect(second.statusCode).toBe(400);
  });
});

describe('the lunchtime watch', () => {
  it('reports the three numbers ops actually looks at', async () => {
    const guest = await signIn();
    const tablet = await pairTablet(venue.restaurantId);
    const order = await placeAndPay(guest, venue.restaurantId, venue.menuIds['tsuivan']!);
    await app.inject({
      method: 'POST',
      url: `/v1/kds/tickets/${order.id}/accept`,
      headers: auth(tablet),
    });

    clock.set(at('12:22'));
    await tick(ctx, { spacingMs: 0 });
    // A real tablet is polling its board every few seconds; that poll is what
    // records the heartbeat, so make one before asking whether it is alive.
    await app.inject({ method: 'GET', url: '/v1/kds/tickets', headers: auth(tablet) });

    const health = await app.inject({ method: 'GET', url: '/v1/ops/health' });
    expect(health.json()).toEqual({ held: 0, late: 0, offline: 0, cooking: 1 });
  });

  it('counts a restaurant nobody is watching as offline', async () => {
    await seedRestaurant(); // never paired
    const health = await app.inject({ method: 'GET', url: '/v1/ops/health' });
    expect(health.json().offline).toBeGreaterThan(0);
  });
});

describe('the map', () => {
  /** The vector-tile layers the style asks for by name. */
  const NEEDED = ['water', 'landuse', 'transportation', 'building', 'place', 'poi'];

  it('serves a tile the browser can actually read', async () => {
    const response = await app.inject({ method: 'GET', url: '/tiles/14/13057/5700' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('protobuf');

    // The upstream sends plain protobuf and fetch decodes anything it does
    // compress, so claiming an encoding here would have the browser try to
    // gunzip plain bytes — every tile silently discarded, map drawn empty.
    expect(response.headers['content-encoding']).toBeUndefined();

    const body = response.rawPayload;
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 2).toString('hex')).not.toBe('1f8b'); // not gzip

    // And it holds the layers the style names. A tile that parses but carries
    // a different schema draws nothing, which looks identical to this bug.
    const layers = mvtLayerNames(body);
    for (const name of NEEDED) expect(layers, name).toContain(name);
  });

  it('serves label glyphs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/fonts/Noto%20Sans%20Regular/0-255.pbf',
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.length).toBeGreaterThan(1000);
  });

  it('turns away anything that is not a tile path', async () => {
    for (const url of ['/tiles/14/13057/../../etc', '/tiles/abc/1/1', '/fonts/../../etc/passwd']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });

  it('gives every restaurant a coordinate the map can place', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/restaurants' });
    for (const venue of response.json().restaurants as Array<{ lat: number; lon: number }>) {
      // Ulaanbaatar, generously bounded. The schema enforces this too.
      expect(venue.lat).toBeGreaterThan(47.7);
      expect(venue.lat).toBeLessThan(48.1);
      expect(venue.lon).toBeGreaterThan(106.6);
      expect(venue.lon).toBeLessThan(107.3);
    }
  });
});

/** Layer names inside a Mapbox Vector Tile: Tile.layers[].name. */
function mvtLayerNames(buffer: Buffer): string[] {
  const names: string[] = [];
  const varint = (at: number): [number, number] => {
    let result = 0;
    let shift = 0;
    let i = at;
    for (;;) {
      const byte = buffer[i++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [result, i];
      shift += 7;
    }
  };

  let i = 0;
  while (i < buffer.length) {
    const [key, afterKey] = varint(i);
    i = afterKey;
    const field = key >> 3;
    const wire = key & 7;
    if (wire !== 2) {
      if (wire === 0) [, i] = varint(i);
      else break;
      continue;
    }
    const [length, afterLength] = varint(i);
    const chunk = buffer.subarray(afterLength, afterLength + length);
    i = afterLength + length;
    if (field !== 3) continue;

    // Inside a Layer, name is field 1.
    let j = 0;
    while (j < chunk.length) {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = chunk[j++]!;
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      const innerWire = result & 7;
      if (innerWire !== 2) break;
      let len = 0;
      shift = 0;
      for (;;) {
        const byte = chunk[j++]!;
        len |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      const value = chunk.subarray(j, j + len);
      j += len;
      if (result >> 3 === 1) {
        names.push(value.toString('utf8'));
        break;
      }
    }
  }
  return names;
}
