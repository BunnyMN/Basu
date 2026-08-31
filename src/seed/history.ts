import type { Db } from '../db/pool.js';
import { Rng } from '../sim/rng.js';
import { DISHES, VENUES } from './catalogue.js';

/**
 * Yesterday's lunches, so the app has something to say about a restaurant.
 *
 * An empty rating is honest but useless to look at: a guest choosing between
 * ten venues on a map wants to know what the last people to eat there thought,
 * and a demo where every venue reads "үнэлгээ алга" demonstrates the shape of
 * the feature and none of its point.
 *
 * These are closed orders with reviews attached, not free-floating ratings —
 * the same route a real review takes, so the averages, the comments and the
 * per-dish scores are computed from exactly what production would hold.
 */

/** Seeded, so the demo reads the same tomorrow as it does today. */
const SEED = 424_242;

interface Voice {
  stars: number;
  onTime: boolean;
  comment: string | null;
}

/**
 * What people actually say about lunch: mostly short, mostly kind, and the
 * complaints are about time rather than taste — which is the thing this
 * product is for.
 */
const VOICES: Voice[] = [
  { stars: 5, onTime: true, comment: 'Сууталгүй бэлэн байсан. Ийм байх ёстой.' },
  { stars: 5, onTime: true, comment: 'Ширээндээ суутал хоол ирлээ. Гайхмаар.' },
  { stars: 5, onTime: true, comment: null },
  { stars: 4, onTime: true, comment: 'Амттай, халуун. Дахиад захиална.' },
  { stars: 4, onTime: true, comment: null },
  { stars: 4, onTime: true, comment: 'Үнийн хувьд гайгүй. Хурдан.' },
  { stars: 4, onTime: false, comment: 'Хоол сайхан, гэхдээ 5 минут хүлээсэн.' },
  { stars: 3, onTime: true, comment: 'Дунд зэрэг. Салат нь илүү байлаа.' },
  { stars: 3, onTime: false, comment: 'Цагтаа ирээгүй, хоол нь хүйтэвтэр.' },
  { stars: 5, onTime: true, comment: 'Ажлын завсарлагаанд яг таарч байна.' },
  { stars: 4, onTime: true, comment: 'Ширээ бэлэн байсан нь таалагдлаа.' },
  { stars: 2, onTime: false, comment: 'Удлаа. Завсарлага дуусах шахсан.' },
  { stars: 5, onTime: true, comment: null },
  { stars: 4, onTime: true, comment: 'Хэмжээ нь боломжийн. Цайг нь сайшаав.' },
];

const NAMES = [
  'Батаа',
  'Сарнай',
  'Ганаа',
  'Мөнх',
  'Оюун',
  'Ганбат',
  'Алтан',
  'Дулмаа',
  'Тэмүүлэн',
  'Нарантуяа',
  'Энхжин',
  'Golden',
];

export interface SeededHistory {
  orders: number;
  reviews: number;
}

export async function seedHistory(db: Db, venueIds: Map<string, string>): Promise<SeededHistory> {
  const rng = new Rng(SEED);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // A pool of guests who have eaten before. Reused across venues, the way a
  // tower's lunch crowd is: the same faces at different counters.
  const guests: string[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO guest (phone_e164, name) VALUES ($1, $2)
       ON CONFLICT (phone_e164) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`+9769${String(500_000 + i).padStart(7, '0')}`, NAMES[i]],
    );
    const id = rows[0]!.id;
    await db.query(
      `INSERT INTO trust_profile (guest_id, tier, completed_visits)
       VALUES ($1, 'AUTO', 4) ON CONFLICT (guest_id) DO NOTHING`,
      [id],
    );
    guests.push(id);
  }

  let orders = 0;
  let reviews = 0;
  let code = 900;

  for (const venue of VENUES) {
    const restaurantId = venueIds.get(venue.name);
    if (!restaurantId) continue;

    // Enough to make an average mean something, not so many that the list of
    // comments becomes a wall.
    const howMany = rng.int(4, 9);

    const { rows: menu } = await db.query<{ id: string; name: string }>(
      'SELECT id, name FROM menu_item WHERE restaurant_id = $1',
      [restaurantId],
    );
    if (menu.length === 0) continue;

    for (let n = 0; n < howMany; n++) {
      const guestId = rng.pick(guests);
      const voice = rng.pick(VOICES);

      // A lunch at some plausible hour yesterday, closed out afterwards.
      const seatedAt = new Date(yesterday);
      seatedAt.setHours(11, 45 + rng.int(0, 105), 0, 0);
      const firedAt = new Date(seatedAt.getTime() - 8 * 60_000);
      const readyAt = new Date(seatedAt.getTime() + (voice.onTime ? 60_000 : 7 * 60_000));

      const dish = rng.pick(menu);
      const priced = DISHES[
        Object.keys(DISHES).find((k) => DISHES[k]!.name === dish.name) ?? ''
      ];
      const total = (priced?.price ?? 12_000) * rng.int(1, 2);

      const { rows: made } = await db.query<{ id: string }>(
        `INSERT INTO dining_order
           (code, restaurant_id, guest_id, state, party_size, slot_starts_at,
            fire_at, ready_at, fired_at, fired_by, cooked_ready_at, seated_at,
            served_at, closed_at, total_mnt, created_at, updated_at)
         VALUES ($1, $2, $3, 'CLOSED', $4, $5, $6, $7, $6, 'system:scheduler',
                 $7, $8, $7, $7, $9, $10, $7)
         RETURNING id`,
        [
          String(++code),
          restaurantId,
          guestId,
          rng.int(1, 3),
          seatedAt,
          firedAt,
          readyAt,
          seatedAt,
          total,
          new Date(seatedAt.getTime() - 50 * 60_000),
        ],
      );
      const orderId = made[0]!.id;
      orders++;

      await db.query(
        `INSERT INTO order_line
           (order_id, menu_item_id, qty, name, unit_price_mnt, prep_minutes,
            hold_tolerance_minutes, station_code)
         SELECT $1, m.id, 1, m.name, m.price_mnt, m.prep_minutes,
                m.hold_tolerance_minutes, s.code
           FROM menu_item m JOIN station s ON s.id = m.station_id
          WHERE m.id = $2`,
        [orderId, dish.id],
      );

      // Not everybody reviews. Four in five is generous but not implausible
      // for a prompt that appears the moment the food lands.
      if (!rng.chance(0.8)) continue;

      await db.query(
        `INSERT INTO order_review
           (order_id, guest_id, restaurant_id, stars, on_time, comment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [orderId, guestId, restaurantId, voice.stars, voice.onTime, voice.comment, readyAt],
      );
      reviews++;

      // A dish score usually tracks the visit but not always — somebody can
      // like the place and be unimpressed by what they happened to order.
      const dishStars = Math.min(5, Math.max(1, voice.stars + rng.int(-1, 1)));
      await db.query(
        `INSERT INTO dish_review (order_id, menu_item_id, stars, created_at)
         VALUES ($1, $2, $3, $4)`,
        [orderId, dish.id, dishStars, readyAt],
      );
    }
  }

  return { orders, reviews };
}
