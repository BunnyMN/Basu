import { getPool, type Db } from '../db/pool.js';
import { IdeshError } from './errors.js';
import type { Unit } from './pricing.js';

/**
 * What a supplier offers.
 *
 * The supplier owns the listing from their own screen — twenty sheep becoming
 * fifteen sold is a fact only they know, and having ops edit a number on the
 * phone is how a listing ends up promising an animal that was eaten in
 * October. Ops registers the supplier; the supplier runs the stall.
 */

export type Kind = 'sheep' | 'goat' | 'beef' | 'horse';

export const KINDS: readonly Kind[] = ['sheep', 'goat', 'beef', 'horse'];
export const UNITS: readonly Unit[] = ['whole', 'kg'];

export interface Listing {
  id: string;
  supplier: { id: string; name: string; contracted: boolean; pickupAddress: string };
  kind: Kind;
  unit: Unit;
  title: string;
  note: string | null;
  priceMnt: number;
  approxKg: number | null;
  minQty: number;
  quantity: number;
  sold: number;
  remaining: number;
  origin: string;
  /** `YYYY-MM-DD` */
  readyFrom: string;
  delivers: boolean;
  deliveryFeeMnt: number;
  active: boolean;
}

interface ListingRow {
  id: string;
  supplier_id: string;
  supplier: string;
  contracted: boolean;
  pickup_address: string;
  kind: Kind;
  unit: Unit;
  title: string;
  note: string | null;
  price_mnt: number;
  approx_kg: number | null;
  min_qty: number;
  quantity: number;
  sold: number;
  origin: string;
  ready_from: string;
  delivers: boolean;
  delivery_fee_mnt: number;
  active: boolean;
}

const SELECT = `
  SELECT l.id, l.supplier_id, s.name AS supplier, s.state = 'contracted' AS contracted,
         s.pickup_address, l.kind, l.unit, l.title, l.note, l.price_mnt, l.approx_kg,
         l.min_qty, l.quantity, l.sold, l.origin, to_char(l.ready_from, 'YYYY-MM-DD') AS ready_from,
         l.delivers, l.delivery_fee_mnt, l.active
    FROM idesh.listing l
    JOIN idesh.supplier s ON s.id = l.supplier_id`;

function shape(r: ListingRow): Listing {
  return {
    id: r.id,
    supplier: {
      id: r.supplier_id,
      name: r.supplier,
      contracted: r.contracted,
      pickupAddress: r.pickup_address,
    },
    kind: r.kind,
    unit: r.unit,
    title: r.title,
    note: r.note,
    priceMnt: r.price_mnt,
    approxKg: r.approx_kg === null ? null : Number(r.approx_kg),
    minQty: r.min_qty,
    quantity: r.quantity,
    sold: r.sold,
    remaining: Math.max(0, r.quantity - r.sold),
    origin: r.origin,
    readyFrom: r.ready_from,
    delivers: r.delivers,
    deliveryFeeMnt: r.delivery_fee_mnt,
    active: r.active,
  };
}

/**
 * What a guest sees: everything still on offer, soonest first. A listing that
 * has sold out stays on the page marked so, rather than vanishing — a page
 * that shrinks as people buy from it looks broken, not popular.
 */
export async function openListings(db: Db = getPool()): Promise<Listing[]> {
  const { rows } = await db.query<ListingRow>(
    `${SELECT}
      WHERE l.active AND s.active AND s.state = 'contracted'
      ORDER BY l.ready_from, l.kind, l.price_mnt`,
  );
  return rows.map(shape);
}

export async function listingById(id: string, db: Db = getPool()): Promise<Listing | null> {
  const { rows } = await db.query<ListingRow>(`${SELECT} WHERE l.id = $1`, [id]);
  const row = rows[0];
  return row ? shape(row) : null;
}

/** The supplier's own stall, sold-out and paused ones included. */
export async function listingsOf(supplierId: string, db: Db = getPool()): Promise<Listing[]> {
  const { rows } = await db.query<ListingRow>(
    `${SELECT} WHERE l.supplier_id = $1 ORDER BY l.active DESC, l.ready_from, l.created_at`,
    [supplierId],
  );
  return rows.map(shape);
}

export interface ListingInput {
  kind: Kind;
  unit: Unit;
  title: string;
  note?: string | null;
  priceMnt: number;
  approxKg?: number | null;
  minQty?: number;
  quantity: number;
  origin: string;
  readyFrom: string;
  delivers?: boolean;
  deliveryFeeMnt?: number;
}

function validate(input: ListingInput): void {
  if (!KINDS.includes(input.kind)) throw new IdeshError('WRONG_STATE', `unknown kind ${input.kind}`);
  if (!UNITS.includes(input.unit)) throw new IdeshError('WRONG_STATE', `unknown unit ${input.unit}`);
  if (!input.title?.trim()) throw new IdeshError('WRONG_STATE', 'a listing needs a title');
  if (!input.origin?.trim()) throw new IdeshError('WRONG_STATE', 'a listing needs an origin');
  if (!Number.isInteger(input.priceMnt) || input.priceMnt <= 0) {
    throw new IdeshError('WRONG_STATE', 'price has to be a positive whole number of tugriks');
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new IdeshError('WRONG_STATE', 'quantity has to be a whole number');
  }
  if (input.unit === 'whole' && !(Number(input.approxKg) > 0)) {
    throw new IdeshError('WRONG_STATE', 'a whole animal needs an approximate weight');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.readyFrom)) {
    throw new IdeshError('BAD_DATE', 'ready_from must be YYYY-MM-DD');
  }
}

export async function createListing(
  supplierId: string,
  input: ListingInput,
  at: Date,
  db: Db = getPool(),
): Promise<Listing> {
  validate(input);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.listing
       (supplier_id, kind, unit, title, note, price_mnt, approx_kg, min_qty, quantity,
        origin, ready_from, delivers, delivery_fee_mnt, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $14)
     RETURNING id`,
    [
      supplierId,
      input.kind,
      input.unit,
      input.title.trim(),
      input.note?.trim() || null,
      input.priceMnt,
      input.unit === 'whole' ? input.approxKg : (input.approxKg ?? null),
      input.minQty ?? 1,
      input.quantity,
      input.origin.trim(),
      input.readyFrom,
      input.delivers ?? true,
      input.deliveryFeeMnt ?? 0,
      at,
    ],
  );
  return (await listingById(rows[0]!.id, db))!;
}

export interface ListingPatch {
  priceMnt?: number;
  quantity?: number;
  active?: boolean;
  delivers?: boolean;
  deliveryFeeMnt?: number;
  readyFrom?: string;
  note?: string | null;
  title?: string;
}

/**
 * The supplier changes their mind. Quantity can only go down as far as what is
 * already sold — the CHECK enforces it and this reads the outcome.
 */
export async function updateListing(
  supplierId: string,
  listingId: string,
  patch: ListingPatch,
  at: Date,
  db: Db = getPool(),
): Promise<Listing> {
  if (patch.priceMnt !== undefined && (!Number.isInteger(patch.priceMnt) || patch.priceMnt <= 0)) {
    throw new IdeshError('WRONG_STATE', 'price has to be a positive whole number of tugriks');
  }
  if (patch.quantity !== undefined && (!Number.isInteger(patch.quantity) || patch.quantity < 0)) {
    throw new IdeshError('WRONG_STATE', 'quantity has to be a whole number');
  }
  if (patch.readyFrom !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.readyFrom)) {
    throw new IdeshError('BAD_DATE', 'ready_from must be YYYY-MM-DD');
  }

  let updated;
  try {
    updated = await db.query<{ id: string }>(
      `UPDATE idesh.listing
          SET price_mnt        = COALESCE($3, price_mnt),
              quantity         = COALESCE($4, quantity),
              active           = COALESCE($5, active),
              delivers         = COALESCE($6, delivers),
              delivery_fee_mnt = COALESCE($7, delivery_fee_mnt),
              ready_from       = COALESCE($8::date, ready_from),
              note             = CASE WHEN $9::boolean THEN $10 ELSE note END,
              title            = COALESCE($11, title),
              updated_at       = $12
        WHERE id = $1 AND supplier_id = $2
        RETURNING id`,
      [
        listingId,
        supplierId,
        patch.priceMnt ?? null,
        patch.quantity ?? null,
        patch.active ?? null,
        patch.delivers ?? null,
        patch.deliveryFeeMnt ?? null,
        patch.readyFrom ?? null,
        patch.note !== undefined,
        patch.note ?? null,
        patch.title?.trim() || null,
        at,
      ],
    );
  } catch (error) {
    // `sold <= quantity` said no: the supplier is trying to un-sell something.
    if ((error as { code?: string }).code === '23514') {
      throw new IdeshError('WRONG_STATE', 'quantity cannot drop below what is already sold');
    }
    throw error;
  }
  if (!updated.rows[0]) throw new IdeshError('NOT_FOUND', 'no such listing here');
  return (await listingById(listingId, db))!;
}
