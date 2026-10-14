import { createHash } from 'node:crypto';

/**
 * The market's own order — «Санал болгох», what a guest sees before they
 * choose another.
 *
 * Not newest first: a supplier would take a listing down and put it up again
 * to stand at the top, and the market would churn under the guest's thumb.
 * Not cheapest first either: a whole sheep and a kilo of beef are not one
 * price to compare, and a race to the bottom is not a market Basu wants.
 *
 * Instead, in this order of weight:
 *
 * 1. What can be bought before what has sold out.
 * 2. A tier a supplier paid for: VIP, then Онцгой, then the rest.
 * 3. Within that, what Basu can vouch for — never what a supplier merely
 *    says: a certificate Basu checked (or one put on, unchecked), meat ready
 *    soon, the supplier's own photographs, a record of meat handed over,
 *    and against it a supplier who failed paid orders of late.
 * 4. Turn about by supplier: no supplier holds two places in a row while
 *    another still has something in the same band, so one business with
 *    seventeen listings does not fill the screen.
 * 5. Ties broken by a draw that changes once a day: fair to the new and the
 *    old over a week, still from one refresh to the next.
 *
 * Pure: the listings and the suppliers' records in, the order out.
 */

export interface Rankable {
  id: string;
  supplier: { id: string };
  tier: 'vip' | 'featured' | null;
  remaining: number;
  /** YYYY-MM-DD, Ulaanbaatar's. */
  readyFrom: string;
  certificate: { checked: boolean } | null;
  photos: readonly string[];
}

/** What a supplier's orders say about them. */
export interface SupplierRecord {
  /** Orders whose meat changed hands, ever. */
  handed: number;
  /** Paid orders of the last 90 days. */
  paidRecently: number;
  /** Of those, cancelled for the supplier's own reason: could not fulfil, failed the vet. */
  failedRecently: number;
}

/** Handed over this many times, a supplier has shown they deliver. */
export const PROVEN_AFTER = 3;

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** The points a listing earns within its band. Each line is a fact Basu holds, not a claim. */
export function scoreOf(listing: Rankable, record: SupplierRecord | undefined, today: string): number {
  let score = 0;
  if (listing.certificate?.checked) score += 2;
  else if (listing.certificate) score += 1;
  const wait = days(today, listing.readyFrom);
  if (wait <= 3) score += 2;
  else if (wait <= 14) score += 1;
  if (listing.photos.length > 0) score += 1;
  if (record && record.handed >= PROVEN_AFTER) score += 1;
  // Two failures, and a fifth of the recent paid orders or more: guests are warned off by the order itself.
  if (record && record.failedRecently >= 2 && record.failedRecently * 5 >= record.paidRecently) score -= 3;
  return score;
}

/** A number for the day's draw: the same all day for one listing, different the next. */
function draw(id: string, today: string): number {
  return createHash('sha256').update(`${today}:${id}`).digest().readUInt32BE(0);
}

const band = (l: Rankable) => (l.remaining > 0 ? 0 : 3) + (l.tier === 'vip' ? 0 : l.tier === 'featured' ? 1 : 2);

export function rankListings<T extends Rankable>(listings: readonly T[], records: ReadonlyMap<string, SupplierRecord>, today: string): T[] {
  const keyed = listings.map((l) => ({ l, band: band(l), score: scoreOf(l, records.get(l.supplier.id), today), draw: draw(l.id, today) }));
  const better = (a: (typeof keyed)[number], b: (typeof keyed)[number]) => b.score - a.score || a.draw - b.draw;

  const out: T[] = [];
  for (const level of [...new Set(keyed.map((k) => k.band))].sort((a, b) => a - b)) {
    // Each supplier's own queue, best first.
    const queues = new Map<string, Array<(typeof keyed)[number]>>();
    for (const k of keyed.filter((x) => x.band === level).sort(better)) {
      const queue = queues.get(k.l.supplier.id) ?? [];
      queue.push(k);
      queues.set(k.l.supplier.id, queue);
    }
    // Round by round: each supplier's best left, the strongest of them first.
    // Within a round every supplier is another; only where two rounds meet
    // could one follow itself, and then the round's next goes first.
    let last: string | null = null;
    while (queues.size > 0) {
      const heads = [...queues.entries()].map(([supplier, queue]) => ({ supplier, k: queue[0]! })).sort((a, b) => better(a.k, b.k));
      if (heads.length > 1 && heads[0]!.supplier === last) [heads[0], heads[1]] = [heads[1]!, heads[0]!];
      for (const { supplier, k } of heads) {
        out.push(k.l);
        last = supplier;
        const queue = queues.get(supplier)!;
        queue.shift();
        if (queue.length === 0) queues.delete(supplier);
      }
    }
  }
  return out;
}
