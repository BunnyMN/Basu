import { getPool } from '../db/pool.js';
import { mode } from '../mode.js';
import type { Grants } from '../platform/access/index.js';
import { accessIn, orgsOf } from '../platform/org/index.js';
import type { Ctx } from '../ports.js';

/**
 * The kitchen: who may run a restaurant's orders, and whether anybody is.
 *
 * A restaurant belongs to a business (`dine.restaurant.org_id`), and its
 * kitchen is run by the people with a role there — the cook on the tablet by
 * the pass and the manager on a phone are the same kind of seat: a person,
 * signed in with their own account, doing what their role allows. No screen
 * is let in by a code, and none acts as anybody.
 */

/** A kitchen counts as watching this long after its orders were last open. */
export const KITCHEN_STALE_SECONDS = 90;

export interface KitchenSeat {
  restaurantId: string;
  restaurantName: string;
  orgId: string;
  /** What this person's role at the restaurant's business allows. */
  grants: Grants;
}

/**
 * The restaurant this person works a kitchen at — the business the page
 * named, or their first restaurant — and what their role there allows. Null
 * for somebody at no active restaurant business.
 */
export async function kitchenOf(guestId: string, orgId: string | null): Promise<KitchenSeat | null> {
  const orgs = (await orgsOf(guestId)).filter(
    (m) => m.org.state === 'active' && m.org.restaurant && (!orgId || m.org.id === orgId),
  );
  if (!orgs.length) return null;
  const { rows } = await getPool().query<{ id: string; name: string; org_id: string }>(
    'SELECT id, name, org_id FROM dine.restaurant WHERE org_id = ANY($1::uuid[])',
    [orgs.map((m) => m.org.id)],
  );
  for (const { org } of orgs) {
    const restaurant = rows.find((r) => r.org_id === org.id);
    if (!restaurant) continue;
    const seat = await accessIn(org.id, guestId);
    if (seat) return { restaurantId: restaurant.id, restaurantName: restaurant.name, orgId: org.id, grants: seat.grants };
  }
  return null;
}

/** The business a restaurant belongs to — its people run the kitchen. */
export async function setRestaurantOrg(restaurantId: string, orgId: string): Promise<void> {
  await getPool().query('UPDATE dine.restaurant SET org_id = $2 WHERE id = $1', [restaurantId, orgId]);
}

/**
 * Somebody at this restaurant has its orders open. Every call the kitchen
 * page makes says so, so whether a kitchen is watching needs no separate
 * ping and cannot drift from what is really on the screen.
 */
export async function seeKitchen(restaurantId: string, at: Date): Promise<void> {
  await getPool().query('UPDATE dine.restaurant SET kitchen_seen_at = $2 WHERE id = $1', [restaurantId, at]);
}

/**
 * A restaurant nobody is watching cannot be sent new orders.
 *
 * In production this is load-bearing: taking money for food when nobody has
 * the kitchen open to cook it is the worst thing the system can do. In demo
 * mode it is only in the way — the point of the demo is to walk the ordering
 * flow, and needing a second tab open before the first one works turns a
 * guard into a puzzle.
 */
export async function isRestaurantOnline(
  ctx: Ctx,
  restaurantId: string,
  staleSeconds = KITCHEN_STALE_SECONDS,
): Promise<boolean> {
  if (mode() === 'demo') return true;
  const { rows } = await getPool().query<{ online: boolean }>(
    `SELECT COALESCE(kitchen_seen_at > $2::timestamptz - make_interval(secs => $3), false) AS online
       FROM dine.restaurant WHERE id = $1`,
    [restaurantId, ctx.clock.now(), staleSeconds],
  );
  return rows[0]?.online ?? false;
}
