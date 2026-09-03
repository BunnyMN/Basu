import { getPool, tx, type Db } from '../db/pool.js';
import { appendEvent } from '../db/events.js';
import { OrderError } from './orders.js';
import type { Ctx } from '../ports.js';
import { displayNamesFor } from '../platform/identity/index.js';

/**
 * What the guest thought.
 *
 * Only a guest who actually ate can leave one — the review is attached to a
 * served order, not to a person and a restaurant. That is the whole reason a
 * rating here is worth more than one on a site anybody can post to.
 */

/** Reviewable once the food has been handed over, and not before. */
const REVIEWABLE = ['SERVED', 'CLOSED'];

export interface ReviewInput {
  stars: number;
  /** The product's own metric, kept separate from whether the food was good. */
  onTime?: boolean;
  comment?: string;
  dishes?: Array<{ menuItemId: string; stars: number }>;
}

export interface Review {
  stars: number;
  onTime: boolean | null;
  comment: string | null;
  dishes: Array<{ menuItemId: string; stars: number }>;
}

function validStars(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
}

export async function leaveReview(
  ctx: Ctx,
  orderId: string,
  guestId: string,
  input: ReviewInput,
): Promise<Review> {
  if (!validStars(input.stars)) {
    throw new OrderError('WRONG_STATE', 'stars must be a whole number from 1 to 5');
  }

  const now = ctx.clock.now();

  return tx(async (client) => {
    const { rows } = await client.query<{ state: string; restaurant_id: string }>(
      'SELECT state, restaurant_id FROM dine.dining_order WHERE id = $1 AND guest_id = $2',
      [orderId, guestId],
    );
    const order = rows[0];
    if (!order) throw new OrderError('NOT_FOUND', 'no such order');
    if (!REVIEWABLE.includes(order.state)) {
      throw new OrderError('WRONG_STATE', `cannot review an order in ${order.state}`);
    }

    // Upsert rather than insert-once: a guest is allowed to change their mind,
    // and a form that silently refuses the second attempt teaches nothing.
    await client.query(
      `INSERT INTO dine.order_review
         (order_id, guest_id, restaurant_id, stars, on_time, comment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (order_id) DO UPDATE
         SET stars = EXCLUDED.stars, on_time = EXCLUDED.on_time,
             comment = EXCLUDED.comment, updated_at = EXCLUDED.updated_at`,
      [
        orderId,
        guestId,
        order.restaurant_id,
        input.stars,
        input.onTime ?? null,
        input.comment?.trim() ? input.comment.trim().slice(0, 500) : null,
        now,
      ],
    );

    // Only dishes that were on this ticket. Rating something you did not order
    // is either a mistake or an attempt to move an average.
    const { rows: ordered } = await client.query<{ menu_item_id: string }>(
      'SELECT DISTINCT menu_item_id FROM dine.order_line WHERE order_id = $1',
      [orderId],
    );
    const allowed = new Set(ordered.map((r) => r.menu_item_id));

    await client.query('DELETE FROM dine.dish_review WHERE order_id = $1', [orderId]);
    for (const dish of input.dishes ?? []) {
      if (!allowed.has(dish.menuItemId) || !validStars(dish.stars)) continue;
      await client.query(
        `INSERT INTO dine.dish_review (order_id, menu_item_id, stars, created_at)
         VALUES ($1, $2, $3, $4)`,
        [orderId, dish.menuItemId, dish.stars, now],
      );
    }

    await appendEvent(client, orderId, 'REVIEWED', `guest:${guestId}`, {
      stars: input.stars,
      onTime: input.onTime ?? null,
      hasComment: Boolean(input.comment?.trim()),
      dishes: (input.dishes ?? []).length,
    });

    return readReview(client, orderId);
  });
}

export async function readReview(db: Db, orderId: string): Promise<Review> {
  const { rows } = await db.query<{
    stars: number;
    on_time: boolean | null;
    comment: string | null;
  }>('SELECT stars, on_time, comment FROM dine.order_review WHERE order_id = $1', [orderId]);
  const review = rows[0];
  if (!review) throw new OrderError('NOT_FOUND', 'no review on that order');

  const { rows: dishes } = await db.query<{ menu_item_id: string; stars: number }>(
    'SELECT menu_item_id, stars FROM dine.dish_review WHERE order_id = $1',
    [orderId],
  );

  return {
    stars: review.stars,
    onTime: review.on_time,
    comment: review.comment,
    dishes: dishes.map((d) => ({ menuItemId: d.menu_item_id, stars: d.stars })),
  };
}

/** Null when nobody has reviewed this order yet, which is the common case. */
export async function findReview(db: Db, orderId: string): Promise<Review | null> {
  return readReview(db, orderId).catch(() => null);
}

export interface PublicComment {
  stars: number;
  comment: string;
  onTime: boolean | null;
  at: string;
  /** First name only. A lunch review does not need to identify anybody. */
  by: string;
}

/**
 * The comments a restaurant's page shows.
 *
 * Averages are computed on read. At pilot scale that is a few hundred rows and
 * a stored counter would be one more thing to keep true; the day it matters,
 * it becomes a materialised view and nothing above here changes.
 */
export async function recentComments(
  db: Db,
  restaurantId: string,
  limit = 8,
): Promise<PublicComment[]> {
  const { rows } = await db.query<{
    stars: number;
    comment: string;
    on_time: boolean | null;
    created_at: Date;
    guest_id: string;
  }>(
    `SELECT v.stars, v.comment, v.on_time, v.created_at, v.guest_id
       FROM dine.order_review v
      WHERE v.restaurant_id = $1 AND v.comment IS NOT NULL
      ORDER BY v.created_at DESC
      LIMIT $2`,
    [restaurantId, limit],
  );

  // Never the phone number, and not our rule to make: identity decides what a
  // person is called in public, so every surface calls them the same thing.
  const names = await displayNamesFor(rows.map((r) => r.guest_id));

  return rows.map((r) => ({
    stars: r.stars,
    comment: r.comment,
    onTime: r.on_time,
    at: r.created_at.toISOString(),
    by: names.get(r.guest_id) ?? '···',
  }));
}

export interface Rating {
  stars: number;
  count: number;
  /** Share of reviews that said the food arrived on time. */
  onTimeShare: number | null;
}

export async function restaurantRatings(db: Db = getPool()): Promise<Map<string, Rating>> {
  const { rows } = await db.query<{
    restaurant_id: string;
    avg: string;
    n: number;
    on_time: number;
    asked: number;
  }>(
    `SELECT restaurant_id, avg(stars)::numeric(3,2) AS avg, count(*)::int AS n,
            count(*) FILTER (WHERE on_time)::int AS on_time,
            count(*) FILTER (WHERE on_time IS NOT NULL)::int AS asked
       FROM dine.order_review GROUP BY restaurant_id`,
  );
  return new Map(
    rows.map((r) => [
      r.restaurant_id,
      {
        stars: Number(r.avg),
        count: r.n,
        onTimeShare: r.asked > 0 ? r.on_time / r.asked : null,
      },
    ]),
  );
}

export async function dishRatings(db: Db, restaurantId: string): Promise<Map<string, Rating>> {
  const { rows } = await db.query<{ menu_item_id: string; avg: string; n: number }>(
    `SELECT d.menu_item_id, avg(d.stars)::numeric(3,2) AS avg, count(*)::int AS n
       FROM dine.dish_review d JOIN dine.menu_item m ON m.id = d.menu_item_id
      WHERE m.restaurant_id = $1
      GROUP BY d.menu_item_id`,
    [restaurantId],
  );
  return new Map(
    rows.map((r) => [r.menu_item_id, { stars: Number(r.avg), count: r.n, onTimeShare: null }]),
  );
}
