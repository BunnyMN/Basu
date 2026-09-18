import { getPool } from '../db/pool.js';

/** One guest's lunches, newest first, for the desk. Drafts never left the phone and are not shown. */
export interface GuestDineOrder {
  id: string;
  code: string;
  state: string;
  restaurant: { id: string; name: string };
  partySize: number;
  totalMnt: number;
  slotStartsAt: Date;
  createdAt: Date;
}

export async function dineOrdersOf(guestId: string, limit = 50): Promise<GuestDineOrder[]> {
  const { rows } = await getPool().query<{
    id: string;
    code: string;
    state: string;
    restaurant_id: string;
    restaurant: string;
    party_size: number;
    total_mnt: string;
    slot_starts_at: Date;
    created_at: Date;
  }>(
    `SELECT o.id, o.code, o.state, o.restaurant_id, r.name AS restaurant, o.party_size, o.total_mnt, o.slot_starts_at, o.created_at
       FROM dine.dining_order o
       JOIN dine.restaurant r ON r.id = o.restaurant_id
      WHERE o.guest_id = $1 AND o.state <> 'DRAFT'
      ORDER BY o.created_at DESC
      LIMIT $2`,
    [guestId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    state: r.state,
    restaurant: { id: r.restaurant_id, name: r.restaurant },
    partySize: r.party_size,
    totalMnt: Number(r.total_mnt),
    slotStartsAt: r.slot_starts_at,
    createdAt: r.created_at,
  }));
}
