import { describe, expect, it } from 'vitest';
import { rankListings, scoreOf, type Rankable, type SupplierRecord } from './ranking.js';

/**
 * The market's own order, without a database: what can be bought first, the
 * paid tiers next, then what Basu can vouch for, suppliers taking turns.
 */
const TODAY = '2026-10-14';

let n = 0;
function listing(supplier: string, more: Partial<Rankable> = {}): Rankable {
  n += 1;
  return {
    id: `l${n}`,
    supplier: { id: supplier },
    tier: null,
    remaining: 5,
    readyFrom: TODAY,
    certificate: null,
    photos: [],
    ...more,
  };
}

const none = new Map<string, SupplierRecord>();
const order = (list: Rankable[], records = none, today = TODAY) => rankListings(list, records, today).map((l) => l.id);
const suppliers = (list: Rankable[], records = none) => rankListings(list, records, TODAY).map((l) => l.supplier.id);

describe('the market’s own order', () => {
  it('puts what can be bought before what has sold out, and a paid tier first among either', () => {
    const plain = listing('a');
    const vip = listing('b', { tier: 'vip' });
    const featured = listing('c', { tier: 'featured' });
    const soldOutVip = listing('d', { tier: 'vip', remaining: 0 });
    expect(order([soldOutVip, plain, featured, vip])).toEqual([vip.id, featured.id, plain.id, soldOutVip.id]);
  });

  it('weighs what Basu can vouch for: a checked certificate, meat ready soon, the supplier’s own photographs', () => {
    const bare = listing('a', { readyFrom: '2026-11-30' });
    const checked = listing('b', { readyFrom: '2026-11-30', certificate: { checked: true } });
    const soon = listing('c', { readyFrom: '2026-10-15' });
    const everything = listing('d', { certificate: { checked: true }, photos: ['p1'] });
    expect(order([bare, checked, soon, everything])).toEqual([everything.id, checked.id, soon.id, bare.id]);
    expect(scoreOf(listing('e', { certificate: { checked: false } }), undefined, TODAY)).toBe(scoreOf(listing('f'), undefined, TODAY) + 1);
  });

  it('lets suppliers take turns: one business with many listings does not fill the screen', () => {
    const many = Array.from({ length: 6 }, () => listing('big', { certificate: { checked: true }, photos: ['p'] }));
    const small = [listing('small'), listing('small')];
    const third = [listing('third')];
    const seen = suppliers([...many, ...small, ...third]);
    // Nobody twice in a row while somebody else still has something to show.
    for (let i = 1; i < 6; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(seen.slice(0, 3).sort()).toEqual(['big', 'small', 'third']);
    expect(seen.slice(-4)).toEqual(['big', 'big', 'big', 'big']);
  });

  it('rewards meat handed over, and sets back a supplier who failed paid orders of late', () => {
    const proven = listing('proven');
    const failing = listing('failing', { certificate: { checked: true } });
    const fresh = listing('fresh');
    const records = new Map<string, SupplierRecord>([
      ['proven', { handed: 5, paidRecently: 5, failedRecently: 0 }],
      ['failing', { handed: 1, paidRecently: 6, failedRecently: 3 }],
    ]);
    expect(order([failing, fresh, proven], records)).toEqual([proven.id, fresh.id, failing.id]);
    // One failure among many orders is bad luck, not a pattern.
    expect(scoreOf(failing, { handed: 1, paidRecently: 20, failedRecently: 1 }, TODAY)).toBeGreaterThan(scoreOf(fresh, undefined, TODAY));
  });

  it('breaks ties by a draw that holds all day and changes the next — never by which was posted last', () => {
    const tied = Array.from({ length: 8 }, (_, i) => listing(`s${i}`));
    const monday = order(tied, none, '2026-10-12');
    expect(order([...tied].reverse(), none, '2026-10-12')).toEqual(monday);
    expect(order(tied, none, '2026-10-13')).not.toEqual(monday);
  });
});
