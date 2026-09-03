import { getPool, type Db } from '../db/pool.js';
import { PILOT_KITCHEN, PILOT_MENU } from '../domain/fixtures.js';
import type { OrderState } from '../domain/types.js';

let seq = 0;

export interface SeededRestaurant {
  restaurantId: string;
  stationIds: Record<string, string>;
  menuIds: Record<string, string>;
  tableIds: string[];
}

/**
 * Wipe the mutable tables between tests. Reference data is re-seeded per test.
 *
 * `otp_challenge` has to be named explicitly: it references nothing, so CASCADE
 * never reaches it, and codes left over from an earlier test silently trip the
 * per-phone hourly rate limit in the next one.
 */
export async function truncateAll(db: Db = getPool()): Promise<void> {
  await db.query(`
    TRUNCATE outbox, idempotency_key,
             notify.message, notify.device, notify.preference,
             ledger.ebarimt_receipt, ledger.payment, ledger.topup, ledger.entry, ledger.transfer,
             dine.order_event, dine.fire_job, dine.arrival_signal, dine.table_hold,
             dine.order_line, dine.station_reservation, dine.dish_review, dine.order_review,
             dine.dining_order, dine.slot, dine.dining_table, dine.menu_item, dine.station,
             dine.trust_profile, dine.kds_device, dine.restaurant,
             identity.profile, identity.guest_session, identity.guest, identity.otp_challenge
    RESTART IDENTITY CASCADE
  `);
  // The house accounts are reference data the migration created; only the
  // guests' wallets are test residue.
  await db.query(`DELETE FROM ledger.account WHERE kind = 'guest'`);
}

export async function seedRestaurant(db: Db = getPool()): Promise<SeededRestaurant> {
  // Around the Shangri-La towers, nudged apart per venue so two seeded
  // restaurants never land on the same pixel.
  const nth = ++seq;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO dine.restaurant (name, plating_buffer_min, travel_minutes, lat, lon)
     VALUES ($1, $2, 7, $3, $4) RETURNING id`,
    [
      `Модерн Номадс ${nth}`,
      PILOT_KITCHEN.platingBufferMinutes,
      47.9138 + (nth % 10) * 0.001,
      106.9165 + (nth % 10) * 0.001,
    ],
  );
  const restaurantId = rows[0]!.id;

  const stationIds: Record<string, string> = {};
  for (const station of Object.values(PILOT_KITCHEN.stations)) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dine.station (restaurant_id, code, display_name, parallel_lanes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [restaurantId, station.code, station.displayName, station.parallelLanes],
    );
    stationIds[station.code] = res.rows[0]!.id;
  }

  const menuIds: Record<string, string> = {};
  for (const item of Object.values(PILOT_MENU)) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dine.menu_item
         (restaurant_id, station_id, name, price_mnt, prep_minutes,
          hold_tolerance_minutes, preorder_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
      [
        restaurantId,
        stationIds[item.station],
        item.name,
        item.priceMnt,
        item.prepMinutes,
        item.holdToleranceMinutes,
      ],
    );
    menuIds[item.id] = res.rows[0]!.id;
  }

  const tableIds: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dine.dining_table (restaurant_id, code, seats) VALUES ($1, $2, 4) RETURNING id`,
      [restaurantId, `T${i}`],
    );
    tableIds.push(res.rows[0]!.id);
  }

  return { restaurantId, stationIds, menuIds, tableIds };
}

export async function seedGuest(
  db: Db = getPool(),
  tier: 'NEW' | 'AUTO' | 'CONFIRM' | 'BLOCKED' = 'AUTO',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO identity.guest (phone_e164, name) VALUES ($1, $2) RETURNING id`,
    [`+9769900${String(++seq).padStart(4, '0')}`, 'Тест зочин'],
  );
  const guestId = rows[0]!.id;
  await db.query(`INSERT INTO dine.trust_profile (guest_id, tier) VALUES ($1, $2)`, [guestId, tier]);
  return guestId;
}

export interface SeedOrderOptions {
  restaurantId: string;
  guestId: string;
  state?: OrderState;
  slotStartsAt: Date;
  readyAt?: Date;
  partySize?: number;
}

export async function seedOrder(
  opts: SeedOrderOptions,
  db: Db = getPool(),
): Promise<{ orderId: string; code: string }> {
  const code = String(1000 + ++seq);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO dine.dining_order
       (code, restaurant_id, guest_id, state, party_size, slot_starts_at, ready_at, total_mnt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 18000) RETURNING id`,
    [
      code,
      opts.restaurantId,
      opts.guestId,
      opts.state ?? 'SCHEDULED',
      opts.partySize ?? 2,
      opts.slotStartsAt,
      opts.readyAt ?? null,
    ],
  );
  return { orderId: rows[0]!.id, code };
}
