import { getPool } from '../db/pool.js';
import { periodsOf } from '../domain/time.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import { restaurantRatings, type Rating } from './reviews.js';

/**
 * Lunch, as the desk reads it.
 *
 * Read models for the ops desk: every restaurant with its tablets and its
 * day, every order with who it is for, one order's whole story, a menu with
 * the items that are switched off, and what people said. Writes stay in
 * `orders.ts`, `devices.ts` and the two small toggles below.
 */

export interface DeskDevice {
  id: string;
  label: string | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  /** Still waiting to be typed into a tablet. */
  pairingCode: string | null;
  pairingExpiresAt: Date | null;
  online: boolean;
}

export interface DeskRestaurant {
  id: string;
  name: string;
  active: boolean;
  autoAccept: boolean;
  slotMinutes: number;
  travelMinutes: number;
  merchantTin: string | null;
  devices: DeskDevice[];
  online: boolean;
  menu: { total: number; active: number; soldOut: number };
  today: { placed: number; live: number; held: number; salesMnt: number };
  rating: Rating | null;
}

const LIVE = `('PLACED','ACCEPTED','SCHEDULED','ARMED','HELD','FIRED','COOKING','READY','SERVED')`;

export async function restaurantsForDesk(now: Date): Promise<DeskRestaurant[]> {
  const db = getPool();
  const { today, end } = periodsOf(now);
  const [{ rows }, { rows: devices }, ratings] = await Promise.all([
    db.query<Record<string, string | number | boolean | null>>(
      `SELECT r.id, r.name, r.active, r.auto_accept, r.slot_minutes, r.travel_minutes, r.ebarimt_merchant_tin,
              (SELECT count(*)::int FROM dine.menu_item m WHERE m.restaurant_id = r.id) AS menu_total,
              (SELECT count(*)::int FROM dine.menu_item m WHERE m.restaurant_id = r.id AND m.active) AS menu_active,
              (SELECT count(*)::int FROM dine.menu_item m WHERE m.restaurant_id = r.id AND m.active AND m.sold_out_until IS NOT NULL) AS menu_sold_out,
              (SELECT count(*)::int FROM dine.dining_order o WHERE o.restaurant_id = r.id AND o.state <> 'DRAFT' AND o.created_at >= $1 AND o.created_at < $2) AS placed,
              (SELECT count(*)::int FROM dine.dining_order o WHERE o.restaurant_id = r.id AND o.state IN ${LIVE}) AS live,
              (SELECT count(*)::int FROM dine.dining_order o WHERE o.restaurant_id = r.id AND o.state = 'HELD') AS held,
              (SELECT COALESCE(sum(o.total_mnt), 0) FROM dine.dining_order o WHERE o.restaurant_id = r.id
                 AND o.state NOT IN ('DRAFT','REJECTED','CANCELLED','REFUNDED') AND o.created_at >= $1 AND o.created_at < $2) AS sales
         FROM dine.restaurant r
        ORDER BY r.active DESC, r.name`,
      [today, end],
    ),
    db.query<{
      id: string;
      restaurant_id: string;
      label: string | null;
      paired_at: Date | null;
      last_seen_at: Date | null;
      pairing_code: string | null;
      pairing_expires_at: Date | null;
    }>(
      `SELECT id, restaurant_id, label, paired_at, last_seen_at, pairing_code, pairing_expires_at
         FROM dine.kds_device
        WHERE revoked_at IS NULL AND (paired_at IS NOT NULL OR pairing_expires_at > $1)
        ORDER BY paired_at DESC NULLS FIRST, created_at DESC`,
      [now],
    ),
    restaurantRatings(db),
  ]);
  const fresh = new Date(now.getTime() - 90 * 1000);
  const byRestaurant = new Map<string, DeskDevice[]>();
  for (const d of devices) {
    const list = byRestaurant.get(d.restaurant_id) ?? [];
    list.push({
      id: d.id,
      label: d.label,
      pairedAt: d.paired_at,
      lastSeenAt: d.last_seen_at,
      pairingCode: d.paired_at ? null : d.pairing_code,
      pairingExpiresAt: d.paired_at ? null : d.pairing_expires_at,
      online: d.last_seen_at !== null && d.last_seen_at > fresh,
    });
    byRestaurant.set(d.restaurant_id, list);
  }
  return rows.map((r) => {
    const own = byRestaurant.get(String(r['id'])) ?? [];
    return {
      id: String(r['id']),
      name: String(r['name']),
      active: Boolean(r['active']),
      autoAccept: Boolean(r['auto_accept']),
      slotMinutes: Number(r['slot_minutes']),
      travelMinutes: Number(r['travel_minutes']),
      merchantTin: r['ebarimt_merchant_tin'] === null ? null : String(r['ebarimt_merchant_tin']),
      devices: own,
      online: own.some((d) => d.online),
      menu: { total: Number(r['menu_total']), active: Number(r['menu_active']), soldOut: Number(r['menu_sold_out']) },
      today: { placed: Number(r['placed']), live: Number(r['live']), held: Number(r['held']), salesMnt: Number(r['sales']) },
      rating: ratings.get(String(r['id'])) ?? null,
    };
  });
}

export async function setRestaurantActive(restaurantId: string, active: boolean): Promise<boolean> {
  const { rowCount } = await getPool().query('UPDATE dine.restaurant SET active = $2 WHERE id = $1', [restaurantId, active]);
  return (rowCount ?? 0) > 0;
}

/* ── the menu ── */

export interface DeskMenuItem {
  id: string;
  name: string;
  station: string;
  priceMnt: number;
  prepMinutes: number;
  active: boolean;
  preorder: boolean;
  soldOutUntil: Date | null;
  imageUrl: string | null;
}

export async function menuForDesk(restaurantId: string): Promise<DeskMenuItem[]> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    station: string;
    price_mnt: string;
    prep_minutes: string;
    active: boolean;
    preorder_enabled: boolean;
    sold_out_until: Date | null;
    image_url: string | null;
  }>(
    `SELECT m.id, m.name, s.display_name AS station, m.price_mnt, m.prep_minutes, m.active, m.preorder_enabled, m.sold_out_until, m.image_url
       FROM dine.menu_item m JOIN dine.station s ON s.id = m.station_id
      WHERE m.restaurant_id = $1
      ORDER BY m.active DESC, m.price_mnt DESC, m.name`,
    [restaurantId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    station: r.station,
    priceMnt: Number(r.price_mnt),
    prepMinutes: Number(r.prep_minutes),
    active: r.active,
    preorder: r.preorder_enabled,
    soldOutUntil: r.sold_out_until,
    imageUrl: r.image_url,
  }));
}

export async function setMenuItemActive(itemId: string, active: boolean): Promise<boolean> {
  const { rowCount } = await getPool().query('UPDATE dine.menu_item SET active = $2 WHERE id = $1', [itemId, active]);
  return (rowCount ?? 0) > 0;
}

/* ── the orders ── */

export type DineScope = 'live' | 'done' | 'all';

export interface DineOrderFilter {
  scope?: DineScope | undefined;
  restaurantId?: string | undefined;
  /** `YYYY-MM-DD` — the lunch's day. */
  day?: string | undefined;
  q?: string | undefined;
}

export interface DeskDineOrder {
  id: string;
  code: string;
  state: string;
  restaurant: { id: string; name: string };
  guestId: string;
  guest: string | null;
  guestPhone: string | null;
  partySize: number;
  totalMnt: number;
  slotStartsAt: Date;
  fireAt: Date | null;
  readyAt: Date | null;
  seatedAt: Date | null;
  fireMode: string | null;
  /** Fire job that should have run by now and has not. */
  late: boolean;
  createdAt: Date;
}

const SCOPES: Record<DineScope, string> = {
  live: LIVE,
  done: `('CLOSED','REJECTED','NO_SHOW','CANCELLED','REFUNDED')`,
  all: `('PLACED','ACCEPTED','SCHEDULED','ARMED','HELD','FIRED','COOKING','READY','SERVED','CLOSED','REJECTED','NO_SHOW','CANCELLED','REFUNDED')`,
};

export async function dineOrdersForDesk(filter: DineOrderFilter, now: Date): Promise<DeskDineOrder[]> {
  const { rows } = await getPool().query<{
    id: string;
    code: string;
    state: string;
    restaurant_id: string;
    restaurant: string;
    guest_id: string;
    party_size: number;
    total_mnt: string;
    slot_starts_at: Date;
    fire_at: Date | null;
    ready_at: Date | null;
    seated_at: Date | null;
    fire_mode: string | null;
    late: boolean;
    created_at: Date;
  }>(
    `SELECT o.id, o.code, o.state, o.restaurant_id, r.name AS restaurant, o.guest_id, o.party_size, o.total_mnt,
            o.slot_starts_at, o.fire_at, o.ready_at, o.seated_at, o.fire_mode, o.created_at,
            EXISTS (SELECT 1 FROM dine.fire_job j WHERE j.order_id = o.id AND j.state = 'pending'
                      AND j.run_at < $4::timestamptz - interval '2 minutes') AS late
       FROM dine.dining_order o
       JOIN dine.restaurant r ON r.id = o.restaurant_id
      WHERE o.state IN ${SCOPES[filter.scope ?? 'live']}
        AND ($1::uuid IS NULL OR o.restaurant_id = $1::uuid)
        AND ($2::date IS NULL OR (o.slot_starts_at AT TIME ZONE 'Asia/Ulaanbaatar')::date = $2::date)
        AND ($3::text = '' OR o.code ILIKE '%' || $3 || '%')
      ORDER BY o.slot_starts_at DESC, o.created_at DESC
      LIMIT 500`,
    [filter.restaurantId ?? null, filter.day ?? null, '', now],
  );
  const ids = rows.map((r) => r.guest_id);
  const [names, contacts] = await Promise.all([displayNamesFor(ids), contactsFor(ids)]);
  const all = rows.map((r) => ({
    id: r.id,
    code: r.code,
    state: r.state,
    restaurant: { id: r.restaurant_id, name: r.restaurant },
    guestId: r.guest_id,
    guest: names.get(r.guest_id) ?? null,
    guestPhone: contacts.get(r.guest_id)?.phone ?? null,
    partySize: r.party_size,
    totalMnt: Number(r.total_mnt),
    slotStartsAt: r.slot_starts_at,
    fireAt: r.fire_at,
    readyAt: r.ready_at,
    seatedAt: r.seated_at,
    fireMode: r.fire_mode,
    late: r.late,
    createdAt: r.created_at,
  }));
  // The search runs after the fetch: two of the things a person searches by
  // live in identity, which is a module and not a join.
  const q = (filter.q ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return all;
  const digits = q.replace(/\D/g, '');
  return all.filter(
    (o) =>
      o.code.toLowerCase().includes(q) ||
      o.restaurant.name.toLowerCase().replace(/\s+/g, '').includes(q) ||
      (o.guest ?? '').toLowerCase().replace(/\s+/g, '').includes(q) ||
      (digits.length >= 4 && (o.guestPhone ?? '').includes(digits)),
  );
}

export interface DineOrderFile {
  order: DeskDineOrder & { etaAt: Date | null; firedAt: Date | null; servedAt: Date | null; closedAt: Date | null; table: string | null };
  lines: Array<{ name: string; qty: number; unitPriceMnt: number; station: string | null; notes: string | null; cancelled: boolean }>;
  events: Array<{ seq: number; type: string; actor: string | null; payload: unknown; at: Date }>;
  review: { stars: number; onTime: boolean | null; comment: string | null; at: Date } | null;
}

export async function dineOrderFile(orderId: string, now: Date): Promise<DineOrderFile | null> {
  const db = getPool();
  const { rows } = await db.query<{
    id: string;
    code: string;
    state: string;
    restaurant_id: string;
    restaurant: string;
    guest_id: string;
    party_size: number;
    total_mnt: string;
    slot_starts_at: Date;
    fire_at: Date | null;
    ready_at: Date | null;
    seated_at: Date | null;
    fire_mode: string | null;
    eta_at: Date | null;
    fired_at: Date | null;
    served_at: Date | null;
    closed_at: Date | null;
    created_at: Date;
    table_code: string | null;
    late: boolean;
  }>(
    `SELECT o.id, o.code, o.state, o.restaurant_id, r.name AS restaurant, o.guest_id, o.party_size, o.total_mnt,
            o.slot_starts_at, o.fire_at, o.ready_at, o.seated_at, o.fire_mode, o.eta_at, o.fired_at, o.served_at, o.closed_at, o.created_at,
            t.code AS table_code,
            EXISTS (SELECT 1 FROM dine.fire_job j WHERE j.order_id = o.id AND j.state = 'pending'
                      AND j.run_at < $2::timestamptz - interval '2 minutes') AS late
       FROM dine.dining_order o
       JOIN dine.restaurant r ON r.id = o.restaurant_id
       LEFT JOIN dine.table_hold h ON h.order_id = o.id AND h.released_at IS NULL
       LEFT JOIN dine.dining_table t ON t.id = h.table_id
      WHERE o.id = $1`,
    [orderId, now],
  );
  const r = rows[0];
  if (!r) return null;
  const [names, contacts, { rows: lines }, { rows: events }, { rows: reviews }] = await Promise.all([
    displayNamesFor([r.guest_id]),
    contactsFor([r.guest_id]),
    db.query<{ name: string; qty: number; unit_price_mnt: string; station_code: string | null; notes: string | null; cancelled_at: Date | null }>(
      'SELECT name, qty, unit_price_mnt, station_code, notes, cancelled_at FROM dine.order_line WHERE order_id = $1 ORDER BY name',
      [orderId],
    ),
    db.query<{ seq: number; type: string; actor: string | null; payload: unknown; created_at: Date }>(
      'SELECT seq, type, actor, payload, created_at FROM dine.order_event WHERE order_id = $1 ORDER BY seq',
      [orderId],
    ),
    db.query<{ stars: number; on_time: boolean | null; comment: string | null; created_at: Date }>(
      'SELECT stars, on_time, comment, created_at FROM dine.order_review WHERE order_id = $1',
      [orderId],
    ),
  ]);
  const review = reviews[0];
  return {
    order: {
      id: r.id,
      code: r.code,
      state: r.state,
      restaurant: { id: r.restaurant_id, name: r.restaurant },
      guestId: r.guest_id,
      guest: names.get(r.guest_id) ?? null,
      guestPhone: contacts.get(r.guest_id)?.phone ?? null,
      partySize: r.party_size,
      totalMnt: Number(r.total_mnt),
      slotStartsAt: r.slot_starts_at,
      fireAt: r.fire_at,
      readyAt: r.ready_at,
      seatedAt: r.seated_at,
      fireMode: r.fire_mode,
      late: r.late,
      createdAt: r.created_at,
      etaAt: r.eta_at,
      firedAt: r.fired_at,
      servedAt: r.served_at,
      closedAt: r.closed_at,
      table: r.table_code,
    },
    lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPriceMnt: Number(l.unit_price_mnt), station: l.station_code, notes: l.notes, cancelled: l.cancelled_at !== null })),
    events: events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.created_at })),
    review: review ? { stars: review.stars, onTime: review.on_time, comment: review.comment, at: review.created_at } : null,
  };
}

/* ── what people said ── */

export interface DeskReview {
  orderId: string;
  orderCode: string;
  restaurant: { id: string; name: string };
  guest: string | null;
  stars: number;
  onTime: boolean | null;
  comment: string | null;
  at: Date;
}

export async function reviewsForDesk(restaurantId: string | undefined, limit = 100): Promise<DeskReview[]> {
  const { rows } = await getPool().query<{
    order_id: string;
    code: string;
    restaurant_id: string;
    restaurant: string;
    guest_id: string;
    stars: number;
    on_time: boolean | null;
    comment: string | null;
    created_at: Date;
  }>(
    `SELECT v.order_id, o.code, v.restaurant_id, r.name AS restaurant, v.guest_id, v.stars, v.on_time, v.comment, v.created_at
       FROM dine.order_review v
       JOIN dine.dining_order o ON o.id = v.order_id
       JOIN dine.restaurant r ON r.id = v.restaurant_id
      WHERE $1::uuid IS NULL OR v.restaurant_id = $1::uuid
      ORDER BY v.created_at DESC
      LIMIT $2`,
    [restaurantId ?? null, limit],
  );
  const names = await displayNamesFor(rows.map((r) => r.guest_id));
  return rows.map((r) => ({
    orderId: r.order_id,
    orderCode: r.code,
    restaurant: { id: r.restaurant_id, name: r.restaurant },
    guest: names.get(r.guest_id) ?? null,
    stars: r.stars,
    onTime: r.on_time,
    comment: r.comment,
    at: r.created_at,
  }));
}
