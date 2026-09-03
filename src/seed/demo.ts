import '../env.js';
import { closePool, getPool } from '../db/pool.js';
import { DEMO_START, DemoClock } from '../demoClock.js';
import { createPairingCode, pairDevice } from '../services/devices.js';
import { startSession, updateProfile } from '../platform/identity/index.js';
import { settleTopup, startTopup } from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { DISHES, STATIONS, VENUES } from './catalogue.js';
import { seedHistory } from './history.js';

/**
 * A pilot lunch service you can click through.
 *
 * Ten venues rather than one, because a guest browsing a single-restaurant app
 * tells you nothing about whether the map reads well — and because each kitchen
 * here has a different bottleneck, so the fire planner visibly behaves
 * differently at each. See src/seed/catalogue.ts.
 */

const SERVICE = ['11:30', '11:45', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30'];

/** Deliberately low. The simulator showed 5 per slot buries a two-lane grill. */
const MAX_ORDERS_PER_SLOT = 3;

/** The demo clock jumps hours; pairing codes have to outlive that. */
const PAIRING_TTL_MINUTES = 8 * 60;

function todayAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${parts}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

export async function seedDemo(): Promise<{
  pairingCodes: Array<{ name: string; code: string }>;
  paired: string;
  venues: number;
  dishes: number;
  reviews: number;
  walletMnt: number;
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

  const pairingCodes: Array<{ name: string; code: string }> = [];
  const venueIds = new Map<string, string>();
  let dishes = 0;

  for (const venue of VENUES) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO dine.restaurant
         (name, plating_buffer_min, travel_minutes, ebarimt_merchant_tin, lat, lon)
       VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
      [venue.name, venue.travel, venue.tin, venue.lat, venue.lon],
    );
    const restaurantId = rows[0]!.id;
    venueIds.set(venue.name, restaurantId);

    // Only the stations this kitchen actually has. A venue with no grill
    // cannot be asked to fire something grilled, and the planner says so.
    const stationIds: Record<string, string> = {};
    for (const [code, lanes] of Object.entries(venue.lanes)) {
      const station = await db.query<{ id: string }>(
        `INSERT INTO dine.station (restaurant_id, code, display_name, parallel_lanes)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [restaurantId, code, STATIONS[code as keyof typeof STATIONS], lanes],
      );
      stationIds[code] = station.rows[0]!.id;
    }

    for (const key of venue.menu) {
      const dish = DISHES[key];
      if (!dish) throw new Error(`${venue.name}: unknown dish ${String(key)}`);
      const stationId = stationIds[dish.station];
      if (!stationId) {
        throw new Error(`${venue.name} serves ${dish.name} but has no ${dish.station} station`);
      }
      await db.query(
        `INSERT INTO dine.menu_item
           (restaurant_id, station_id, name, price_mnt, prep_minutes,
            hold_tolerance_minutes, preorder_enabled, image_url, description)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)`,
        [
          restaurantId,
          stationId,
          dish.name,
          dish.price,
          dish.prep,
          dish.hold,
          `/dishes/${dish.slug}.svg`,
          dish.note ?? null,
        ],
      );
      dishes++;
    }

    for (let i = 1; i <= 10; i++) {
      await db.query(
        `INSERT INTO dine.dining_table (restaurant_id, code, seats) VALUES ($1, $2, $3)`,
        [restaurantId, `T${i}`, i <= 6 ? 4 : 2],
      );
    }

    for (const label of SERVICE) {
      const startsAt = todayAt(label);
      await db.query(
        `INSERT INTO dine.slot (restaurant_id, starts_at, ends_at, max_orders, max_covers)
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

  // One venue has its tablet on from the start, so the kitchen screen has
  // something to show. In demo mode the rest take orders anyway: the
  // is-anyone-watching guard is production behaviour, and here it only turns
  // a walkthrough into a puzzle.
  const first = pairingCodes[0]!;
  await pairDevice(ctx, first.code);

  // Yesterday's lunches and what people thought of them. A map of ten venues
  // all reading "үнэлгээ алга" shows the shape of the feature and none of
  // its point.
  const history = await seedHistory(db, venueIds);

  // The platform half of the demo. Wallet, profile and inbox are the three
  // screens a walkthrough opens first, and all three are unreadable empty:
  // a balance of nothing and a list of nothing show the layout and none of
  // the behaviour.
  const wallet = await seedPlatform(ctx);

  return {
    pairingCodes: pairingCodes.slice(1),
    paired: first.name,
    venues: VENUES.length,
    dishes,
    reviews: history.reviews,
    walletMnt: wallet,
  };
}

/** The demo guest: a name, money in the wallet, and something in the inbox. */
const DEMO_PHONE = '+97699001122';
const DEMO_BALANCE_MNT = 50_000;

async function seedPlatform(ctx: Ctx): Promise<number> {
  const { guestId } = await startSession(ctx, DEMO_PHONE);
  await updateProfile(guestId, { displayName: 'Батаа', locale: 'mn' }, ctx.clock.now());

  const topup = await startTopup(ctx, { guestId, amountMnt: DEMO_BALANCE_MNT });
  const balanceMnt = await settleTopup(ctx, topup.topupId);

  await enqueue(ctx, {
    guestId,
    template: 'welcome',
    title: 'Basu-д тавтай морил',
    body: 'Түрийвчээ цэнэглээд, хоолоо урьдчилж захиалаарай.',
    channel: 'push',
    dedupeKey: `welcome:${guestId}`,
  });

  return balanceMnt;
}

/** True when this file was run directly — same answer as .ts or compiled .js. */
const isEntrypoint = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const stem = (s: string) => s.split('/').pop()!.replace(/\.[cm]?[jt]s$/, '');
  return stem(import.meta.url) === stem(invoked);
})();

if (isEntrypoint) {
  try {
    const { pairingCodes, paired, venues, dishes, reviews, walletMnt } = await seedDemo();
    const base = process.env['BASU_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3000}`;

    console.log(
      `Демо өгөгдөл бэлэн — ${venues} ресторан, ${dishes} хоол, ${reviews} үнэлгээ.\n`,
    );
    console.log(`  ${paired} — таблет холбогдсон.`);
    console.log(`  Демо зочин ${DEMO_PHONE} — түрийвчинд ${walletMnt.toLocaleString('mn-MN')}₮.`);
    console.log('  Бусад нь демо горимд бас захиалга авна.\n');
    console.log('Өөр ресторанны таблет холбох код:');
    for (const { name, code } of pairingCodes) {
      console.log(`  ${name.padEnd(24)} ${code}`);
    }
    console.log(`\n  Зочин:  ${base}/`);
    console.log(`  Тогооч: ${base}/kds`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
