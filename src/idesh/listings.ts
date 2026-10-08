import { getPool, type Db } from '../db/pool.js';
import { CERT_COLUMNS, factsOf, usableCertificate, type CertificateFacts, type CertificateState } from './certificates.js';
import { STYLES, offerOf, type BreakdownOffer, type Style } from './breakdown.js';
import { IdeshError } from './errors.js';
import { photoIds } from './photos.js';
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
  /** The tier a supplier has paid for, while it holds; null for an ordinary listing. */
  tier: Tier | null;
  /** When that tier stops holding. */
  tierUntil: Date | null;
  /** The veterinary certificate the meat came with, once the supplier has put one on. */
  certificateId: string | null;
  certificate: CertificateFacts | null;
  /** Задаргаа: the ways this supplier will take the animal apart, and what cutting it small costs. Nothing offered asks the guest nothing. */
  breakdown: BreakdownOffer;
  /** The supplier's own photographs of it, by id, the cover first. None, and it wears an example picture (`photo`). */
  photos: string[];
  /**
   * Its place among its supplier's listings of the same animal, oldest first.
   * The pages turn it into one of the example photographs, so two listings on
   * one stall do not wear the same picture — and one listing always wears its own.
   */
  photo: number;
}

/** What a supplier can pay for, highest last. */
export type Tier = 'featured' | 'vip';
export const TIERS: readonly Tier[] = ['featured', 'vip'];

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
  tier: Tier | null;
  tier_until: Date | null;
  certificate_id: string | null;
  breakdown_styles: string[];
  cut_fee_mnt: number;
  photos: string[];
  photo: number;
  cert_number: string | null;
  cert_issuer: string | null;
  cert_issued_on: string | null;
  cert_state: CertificateState | null;
  cert_origin_aimag: string | null;
  cert_origin_soum: string | null;
  cert_tests: { disease: string }[] | null;
}

/**
 * A listing, and the tier it holds at `$1`: the highest paid promotion whose
 * time covers that moment, and the latest it runs to. Every query below puts
 * the moment first, so the clock is the caller's — the demo's, or a test's.
 */
/** A listing `l`'s place among its supplier's listings of the same animal — see `Listing.photo`. */
export const PHOTO_PLACE = `(SELECT count(*)::int FROM idesh.listing x WHERE x.supplier_id = l.supplier_id AND x.kind = l.kind AND (x.created_at, x.id) < (l.created_at, l.id)) AS photo`;

const SELECT = `
  SELECT l.id, l.supplier_id, s.name AS supplier, s.state = 'contracted' AS contracted,
         s.pickup_address, l.kind, l.unit, l.title, l.note, l.price_mnt, l.approx_kg,
         l.min_qty, l.quantity, l.sold, l.origin, to_char(l.ready_from, 'YYYY-MM-DD') AS ready_from,
         l.delivers, l.delivery_fee_mnt, l.active, p.tier, p.ends_at AS tier_until,
         l.certificate_id, l.breakdown_styles, l.cut_fee_mnt, ${CERT_COLUMNS},
         ${photoIds('l.id')} AS photos,
         ${PHOTO_PLACE}
    FROM idesh.listing l
    JOIN idesh.supplier s ON s.id = l.supplier_id
    LEFT JOIN idesh.certificate c ON c.id = l.certificate_id
    LEFT JOIN LATERAL (
      SELECT tier, ends_at FROM idesh.promotion
       WHERE listing_id = l.id AND state = 'active' AND starts_at <= $1 AND ends_at > $1
       ORDER BY (tier = 'vip') DESC, ends_at DESC
       LIMIT 1
    ) p ON true`;

/** VIP first, featured next, the rest after: the order a guest is shown. */
const TIER_FIRST = `CASE p.tier WHEN 'vip' THEN 0 WHEN 'featured' THEN 1 ELSE 2 END`;

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
    tier: r.tier,
    tierUntil: r.tier ? r.tier_until : null,
    certificateId: r.certificate_id,
    certificate: factsOf(r),
    breakdown: {
      styles: STYLES.filter((s: Style) => r.breakdown_styles.includes(s)),
      cutFeeMnt: Number(r.cut_fee_mnt),
    },
    photos: r.photos,
    photo: r.photo,
  };
}

/**
 * What a guest sees: everything still on offer, soonest first. A listing that
 * has sold out stays on the page marked so, rather than vanishing — a page
 * that shrinks as people buy from it looks broken, not popular. Meat under a
 * certificate the desk found false is not on offer at all.
 */
export async function openListings(at: Date = new Date(), db: Db = getPool()): Promise<Listing[]> {
  const { rows } = await db.query<ListingRow>(
    `${SELECT}
      WHERE l.active AND s.active AND s.state = 'contracted'
        AND c.state IS DISTINCT FROM 'false'
      ORDER BY ${TIER_FIRST}, l.ready_from, l.kind, l.price_mnt`,
    [at],
  );
  return rows.map(shape);
}

export async function listingById(id: string, at: Date = new Date(), db: Db = getPool()): Promise<Listing | null> {
  const { rows } = await db.query<ListingRow>(`${SELECT} WHERE l.id = $2`, [at, id]);
  const row = rows[0];
  return row ? shape(row) : null;
}

/** The supplier's own stall, sold-out and paused ones included. */
export async function listingsOf(supplierId: string, at: Date = new Date(), db: Db = getPool()): Promise<Listing[]> {
  const { rows } = await db.query<ListingRow>(
    `${SELECT} WHERE l.supplier_id = $2 ORDER BY l.active DESC, l.ready_from, l.created_at`,
    [at, supplierId],
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
  /** Required for meat by the kilogram: it is already slaughtered, and came with one. */
  certificateId?: string | null;
  /** Задаргаа: the styles offered — see `breakdown.ts`. A whole animal's only. */
  breakdownStyles?: string[];
  /** Per head, for cutting small. */
  cutFeeMnt?: number;
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
  if (input.unit === 'kg' && !input.certificateId) {
    throw new IdeshError('NEEDS_CERTIFICATE', 'meat by the kilogram is listed with its veterinary certificate');
  }
  if (input.certificateId) await usableCertificate(supplierId, input.certificateId, db);
  const offer = offerOf({ kind: input.kind, unit: input.unit, styles: input.breakdownStyles, cutFeeMnt: input.cutFeeMnt });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.listing
       (supplier_id, kind, unit, title, note, price_mnt, approx_kg, min_qty, quantity,
        origin, ready_from, delivers, delivery_fee_mnt, created_at, updated_at, certificate_id,
        breakdown_styles, cut_fee_mnt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $14, $15, $16::text[], $17)
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
      input.certificateId ?? null,
      offer.styles,
      offer.cutFeeMnt,
    ],
  );
  return (await listingById(rows[0]!.id, at, db))!;
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
  /** The next shipment's certificate. One is replaced, never taken off. */
  certificateId?: string;
  /** Задаргаа: the whole set of styles offered from now on. Orders already made keep what they chose. */
  breakdownStyles?: string[];
  cutFeeMnt?: number;
}

/**
 * The supplier changes their mind. Quantity can only go down as far as what is
 * already sold — the CHECK enforces it and this reads the outcome.
 */
/** Ops hides a listing from every guest, whoever's it is. The supplier sees it as switched off. */
export async function hideListing(listingId: string, at: Date, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query('UPDATE idesh.listing SET active = false, updated_at = $2 WHERE id = $1', [
    listingId,
    at,
  ]);
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such listing');
}

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
  if (patch.certificateId !== undefined) await usableCertificate(supplierId, patch.certificateId, db);

  // The offer is judged whole, against the animal it is for: a fee outlives
  // neither the cutting it was for nor a change the page did not mention.
  let offer: BreakdownOffer | null = null;
  if (patch.breakdownStyles !== undefined || patch.cutFeeMnt !== undefined) {
    const { rows } = await db.query<{ kind: Kind; unit: Unit; breakdown_styles: string[]; cut_fee_mnt: number }>(
      'SELECT kind, unit, breakdown_styles, cut_fee_mnt FROM idesh.listing WHERE id = $1 AND supplier_id = $2',
      [listingId, supplierId],
    );
    const now = rows[0];
    if (!now) throw new IdeshError('NOT_FOUND', 'no such listing here');
    const styles = patch.breakdownStyles ?? now.breakdown_styles;
    offer = offerOf({
      kind: now.kind,
      unit: now.unit,
      styles,
      cutFeeMnt: patch.cutFeeMnt ?? (styles.includes('cut') ? Number(now.cut_fee_mnt) : 0),
    });
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
              certificate_id   = COALESCE($13, certificate_id),
              breakdown_styles = COALESCE($14::text[], breakdown_styles),
              cut_fee_mnt      = COALESCE($15, cut_fee_mnt),
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
        patch.certificateId ?? null,
        offer ? offer.styles : null,
        offer ? offer.cutFeeMnt : null,
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
  return (await listingById(listingId, at, db))!;
}
