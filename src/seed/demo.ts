import '../env.js';
import { closePool, getPool } from '../db/pool.js';
import { PILOT_KITCHEN, PILOT_MENU } from '../domain/fixtures.js';
import { DEMO_START, DemoClock } from '../demoClock.js';
import { createPairingCode, pairDevice } from '../services/auth.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';

/**
 * A pilot lunch service you can click through.
 *
 * Three restaurants rather than one, because a guest browsing a single-venue
 * app tells you nothing about whether the list reads well, and because the
 * cross-restaurant isolation is easier to see than to take on trust.
 */

const VENUES = [
  { name: 'Модерн Номадс', tin: '1234567', travel: 5 },
  { name: 'Хаан Буузны Газар', tin: '2345678', travel: 8 },
  { name: 'Ногоон Байшин', tin: '3456789', travel: 10 },
];

const SERVICE = ['11:30', '11:45', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30'];

/** Deliberately low. The simulator showed 5 per slot buries a two-lane grill. */
const MAX_ORDERS_PER_SLOT = 3;

function todayAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${parts}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

/** The demo clock jumps hours; codes have to outlive that. */
const PAIRING_TTL_MINUTES = 8 * 60;

export async function seedDemo(): Promise<{
  pairingCodes: Array<{ name: string; code: string }>;
  paired: string;
}> {
  const db = getPool();
  // Same instant the API boots to, so the pairing codes below are still live
  // when someone types one into a tablet.
  const clock = new DemoClock();
  clock.setTo(DEMO_START);
  const ctx: Ctx = {
    clock,
    payments: new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier: new FakeNotifier(),
  };

  // Wipe first: a demo you cannot re-run is a demo that rots.
  await db.query(`
    TRUNCATE outbox, notification, ebarimt_receipt, payment, order_event, fire_job,
             arrival_signal, table_hold, order_line, station_reservation, dining_order,
             slot, dining_table, menu_item, station, trust_profile, guest_session,
             guest, kds_device, otp_challenge, restaurant
    RESTART IDENTITY CASCADE
  `);

  const pairingCodes: Array<{ name: string; code: string }> = [];

  for (const venue of VENUES) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO restaurant (name, plating_buffer_min, travel_minutes, ebarimt_merchant_tin)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [venue.name, PILOT_KITCHEN.platingBufferMinutes, venue.travel, venue.tin],
    );
    const restaurantId = rows[0]!.id;

    const stationIds: Record<string, string> = {};
    for (const station of Object.values(PILOT_KITCHEN.stations)) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO station (restaurant_id, code, display_name, parallel_lanes)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [restaurantId, station.code, station.displayName, station.parallelLanes],
      );
      stationIds[station.code] = res.rows[0]!.id;
    }

    for (const item of Object.values(PILOT_MENU)) {
      await db.query(
        `INSERT INTO menu_item
           (restaurant_id, station_id, name, price_mnt, prep_minutes,
            hold_tolerance_minutes, preorder_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          restaurantId,
          stationIds[item.station],
          item.name,
          item.priceMnt,
          item.prepMinutes,
          item.holdToleranceMinutes,
        ],
      );
    }

    for (let i = 1; i <= 10; i++) {
      await db.query(
        `INSERT INTO dining_table (restaurant_id, code, seats) VALUES ($1, $2, $3)`,
        [restaurantId, `T${i}`, i <= 6 ? 4 : 2],
      );
    }

    for (const label of SERVICE) {
      const startsAt = todayAt(label);
      await db.query(
        `INSERT INTO slot (restaurant_id, starts_at, ends_at, max_orders, max_covers)
         VALUES ($1, $2::timestamptz, $2::timestamptz + interval '15 minutes', $3, $4)
         ON CONFLICT (restaurant_id, starts_at) DO NOTHING`,
        [restaurantId, startsAt, MAX_ORDERS_PER_SLOT, MAX_ORDERS_PER_SLOT * 4],
      );
    }

    const code = await createPairingCode(
      ctx,
      restaurantId,
      'Гал тогооны таблет',
      PAIRING_TTL_MINUTES,
    );
    pairingCodes.push({ name: venue.name, code });
  }

  // One venue opens for service straight away. A guest list where every
  // restaurant is shut is technically correct and completely useless as a
  // starting point — and the second and third stay dark, which is what makes
  // "this kitchen is not watching" visible rather than theoretical.
  const first = pairingCodes[0]!;
  await pairDevice(ctx, first.code);

  return { pairingCodes: pairingCodes.slice(1), paired: first.name };
}

const isEntrypoint = process.argv[1]?.endsWith('demo.ts');
if (isEntrypoint) {
  try {
    const { pairingCodes, paired } = await seedDemo();
    console.log('Демо өгөгдөл бэлэн.\n');
    console.log(`  ${paired} — таблет холбогдсон, захиалга авч байна.`);
    console.log('  Бусад нь хаалттай (тогооч харахгүй бол захиалга явуулахгүй).\n');
    console.log('Хүсвэл өөр ресторан холбох код:');
    for (const { name, code } of pairingCodes) {
      console.log(`  ${name.padEnd(24)} ${code}`);
    }
    console.log('\n  Зочин:  http://localhost:3000/');
    console.log('  Тогооч: http://localhost:3000/kds');
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
