import { getPool, tx, type Db } from '../db/pool.js';
import { collect, settleTopup, startTopup } from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';
import { listingById, type Tier } from './listings.js';

/**
 * A listing a supplier pays to put first.
 *
 * The supplier picks a tier; Basu raises a QPay invoice for the price the
 * desk has set; the tier starts the moment the money arrives, never on the
 * promise of it — a promotion that began before it was paid would be a free
 * one for anybody who closed the bank app. Buying the same tier again while
 * it holds adds its days on after the ones already bought.
 *
 * A price of nothing is the desk giving one away: it starts at once, with no
 * invoice.
 */

export interface Plan {
  tier: Tier;
  days: number;
  priceMnt: number;
}

export type PromotionState = 'pending' | 'active' | 'cancelled';

export interface Promotion {
  id: string;
  listingId: string;
  listingTitle: string;
  supplierId: string;
  tier: Tier;
  days: number;
  priceMnt: number;
  state: PromotionState;
  boughtBy: string;
  topupId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

interface Row {
  id: string;
  listing_id: string;
  title: string;
  supplier_id: string;
  tier: Tier;
  days: number;
  price_mnt: number;
  state: PromotionState;
  bought_by: string;
  topup_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
}

const SELECT = `
  SELECT p.id, p.listing_id, l.title, p.supplier_id, p.tier, p.days, p.price_mnt, p.state,
         p.bought_by, p.topup_id, p.starts_at, p.ends_at, p.paid_at, p.created_at
    FROM idesh.promotion p JOIN idesh.listing l ON l.id = p.listing_id`;

const shape = (r: Row): Promotion => ({
  id: r.id,
  listingId: r.listing_id,
  listingTitle: r.title,
  supplierId: r.supplier_id,
  tier: r.tier,
  days: r.days,
  priceMnt: r.price_mnt,
  state: r.state,
  boughtBy: r.bought_by,
  topupId: r.topup_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  paidAt: r.paid_at,
  createdAt: r.created_at,
});

export const TIER_WORD: Record<Tier, string> = { featured: 'Онцгой', vip: 'VIP' };

async function promotion(id: string, db: Db = getPool()): Promise<Promotion | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/** A supplier's promotions, newest first: what they bought, and what holds. */
export async function promotionsOf(supplierId: string, db: Db = getPool()): Promise<Promotion[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE p.supplier_id = $1 AND p.state <> 'cancelled' ORDER BY p.created_at DESC LIMIT 100`, [supplierId]);
  return rows.map(shape);
}

export interface Started {
  promotion: Promotion;
  /** The QPay invoice to pay, or null when it was free and has started. */
  invoice: { topupId: string; actionUrl: string | null; amountMnt: number } | null;
}

/** Raise the invoice for a tier on one of the supplier's own listings. */
export async function startPromotion(
  ctx: Ctx,
  input: { supplierId: string; listingId: string; plan: Plan; boughtBy: string },
): Promise<Started> {
  const now = ctx.clock.now();
  const listing = await listingById(input.listingId, now);
  if (!listing || listing.supplier.id !== input.supplierId) throw new IdeshError('NOT_FOUND', 'no such listing of yours');
  if (!listing.active || listing.remaining <= 0) throw new IdeshError('NOT_PROMOTABLE', 'a paused or sold-out listing is not put first');
  // A VIP listing is already above everything a featured one would buy.
  if (listing.tier === 'vip' && input.plan.tier === 'featured') throw new IdeshError('NOT_PROMOTABLE', 'already VIP');

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO idesh.promotion (listing_id, supplier_id, tier, days, price_mnt, bought_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.listingId, input.supplierId, input.plan.tier, input.plan.days, input.plan.priceMnt, input.boughtBy, now],
  );
  const id = rows[0]!.id;

  if (input.plan.priceMnt === 0) {
    await activate(ctx, id, null);
    return { promotion: (await promotion(id))!, invoice: null };
  }

  let topup;
  try {
    topup = await startTopup(ctx, { guestId: input.boughtBy, amountMnt: input.plan.priceMnt });
  } catch (error) {
    await getPool().query(`UPDATE idesh.promotion SET state = 'cancelled', ended_note = 'no invoice' WHERE id = $1`, [id]);
    throw error;
  }
  await getPool().query('UPDATE idesh.promotion SET topup_id = $2 WHERE id = $1', [id, topup.topupId]);
  return {
    promotion: (await promotion(id))!,
    invoice: { topupId: topup.topupId, actionUrl: topup.actionUrl ?? null, amountMnt: topup.amountMnt },
  };
}

/**
 * Has the invoice been paid? If so, take the money and start the tier.
 * Idempotent: asked again once active, it answers with what holds.
 */
export async function settlePromotion(ctx: Ctx, supplierId: string, promotionId: string): Promise<Promotion> {
  const found = await promotion(promotionId);
  if (!found || found.supplierId !== supplierId) throw new IdeshError('NOT_FOUND', 'no such promotion of yours');
  if (found.state === 'active') return found;
  if (found.state !== 'pending' || !found.topupId) throw new IdeshError('WRONG_STATE', `promotion is ${found.state}`);

  // Throws NOT_PAID_YET while the person is still in their bank app.
  await settleTopup(ctx, found.topupId);
  const collected = await collect(ctx, {
    guestId: found.boughtBy,
    amountMnt: found.priceMnt,
    subject: 'idesh_promo',
    subjectId: found.id,
    memo: `Зар онцлох · ${TIER_WORD[found.tier]} ${found.days} хоног · ${found.listingTitle}`,
    idempotencyKey: `promo:${found.id}`,
  });
  await activate(ctx, found.id, collected.transferId);
  const done = (await promotion(found.id))!;
  await enqueue(ctx, {
    guestId: done.boughtBy,
    subject: 'idesh',
    subjectId: done.id,
    template: 'supplier.promoted',
    channel: 'push',
    title: `Зар ${TIER_WORD[done.tier]} боллоо`,
    body: `«${done.listingTitle}» ${done.endsAt!.toISOString().slice(0, 10)} хүртэл жагсаалтын дээд хэсэгт гарна.`,
  });
  return done;
}

/** Start the tier now, or after the same tier's days already bought. */
async function activate(ctx: Ctx, id: string, transferId: string | null): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const { rows } = await client.query<{ listing_id: string; tier: Tier; days: number; state: PromotionState }>(
      'SELECT listing_id, tier, days, state FROM idesh.promotion WHERE id = $1 FOR UPDATE',
      [id],
    );
    const p = rows[0];
    if (!p || p.state !== 'pending') return;
    // Serialise buyers of the same listing, so two purchases stack instead of overlapping.
    await client.query('SELECT id FROM idesh.listing WHERE id = $1 FOR UPDATE', [p.listing_id]);
    const { rows: last } = await client.query<{ ends_at: Date | null }>(
      `SELECT max(ends_at) AS ends_at FROM idesh.promotion
        WHERE listing_id = $1 AND tier = $2 AND state = 'active' AND ends_at > $3`,
      [p.listing_id, p.tier, now],
    );
    const from = last[0]?.ends_at && last[0].ends_at > now ? last[0].ends_at : now;
    const ends = new Date(from.getTime() + p.days * 86_400_000);
    await client.query(
      `UPDATE idesh.promotion SET state = 'active', starts_at = $2, ends_at = $3, paid_at = $2, transfer_id = $4 WHERE id = $1`,
      [id, now, ends, transferId],
    );
  });
}

/* ── the desk ─────────────────────────────────────────────────────── */

export interface DeskPromotion extends Promotion {
  supplierName: string;
  endedBy: string | null;
  endedNote: string | null;
}

/** Every purchase, newest first, for the desk: who bought what, and what came of it. */
export async function promotionsForDesk(opts: { limit?: number } = {}, db: Db = getPool()): Promise<DeskPromotion[]> {
  const { rows } = await db.query<Row & { supplier_name: string; ended_by: string | null; ended_note: string | null }>(
    `SELECT p.id, p.listing_id, l.title, p.supplier_id, p.tier, p.days, p.price_mnt, p.state,
            p.bought_by, p.topup_id, p.starts_at, p.ends_at, p.paid_at, p.created_at,
            s.name AS supplier_name, p.ended_by, p.ended_note
       FROM idesh.promotion p
       JOIN idesh.listing l ON l.id = p.listing_id
       JOIN idesh.supplier s ON s.id = p.supplier_id
      ORDER BY p.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(opts.limit ?? 500, 1), 2000)],
  );
  return rows.map((r) => ({ ...shape(r), supplierName: r.supplier_name, endedBy: r.ended_by, endedNote: r.ended_note }));
}

/**
 * The desk takes a promotion off: an unpaid invoice is cancelled, a paid
 * tier stops now. The reason is kept on the row and in the desk's record;
 * any money back is a person's decision, made by hand.
 */
export async function endPromotion(input: { id: string; at: Date; by: string; note: string }, db: Db = getPool()): Promise<Promotion> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE idesh.promotion
        SET state = 'cancelled', ended_by = $3, ended_note = $4,
            ends_at = CASE WHEN ends_at IS NULL THEN NULL ELSE LEAST(ends_at, $2) END
      WHERE id = $1 AND (state = 'pending' OR (state = 'active' AND ends_at > $2))
      RETURNING id`,
    [input.id, input.at, input.by, input.note],
  );
  if (!rows[0]) {
    const found = await promotion(input.id, db);
    if (!found) throw new IdeshError('NOT_FOUND', 'no such promotion');
    throw new IdeshError('WRONG_STATE', 'the promotion has already ended');
  }
  return (await promotion(input.id, db))!;
}
