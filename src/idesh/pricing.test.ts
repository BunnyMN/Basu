import { describe, expect, it } from 'vitest';
import { IdeshError } from './errors.js';
import { dayOf, quote, type Offer } from './pricing.js';
import { canTransition, isCommitted, isLive, nextStates } from './states.js';
import { dayLabel } from './orders.js';

/**
 * The arithmetic and the state table, with no database in the room.
 *
 * A whole sheep at a fixed price, meat by the kilo with a minimum, a delivery
 * fee that only applies to a delivery — these are the numbers a guest is
 * charged, and they must be right before any of the plumbing is.
 */

const sheep: Offer = {
  unit: 'whole',
  priceMnt: 460_000,
  minQty: 1,
  quantity: 20,
  sold: 3,
  delivers: true,
  deliveryFeeMnt: 25_000,
  readyFrom: '2026-10-14',
};

const beefByKg: Offer = {
  unit: 'kg',
  priceMnt: 13_500,
  minQty: 20,
  quantity: 600,
  sold: 580,
  delivers: false,
  deliveryFeeMnt: 0,
  readyFrom: '2026-10-20',
};

const TODAY = '2026-10-01';

describe('what an идэш costs', () => {
  it('charges the listed price per head, plus the fee only when delivered', () => {
    const delivered = quote(sheep, { qty: 1, receive: 'delivery', receiveOn: '2026-10-15' }, TODAY);
    expect(delivered.totalMnt).toBe(460_000 + 25_000);
    expect(delivered.deliveryFeeMnt).toBe(25_000);

    const collected = quote(sheep, { qty: 2, receive: 'pickup', receiveOn: '2026-10-15' }, TODAY);
    expect(collected.totalMnt).toBe(920_000);
    expect(collected.deliveryFeeMnt).toBe(0);
  });

  it('sells meat by the kilogram, from the minimum up', () => {
    const twenty = quote(beefByKg, { qty: 20, receive: 'pickup', receiveOn: '2026-10-20' }, TODAY);
    expect(twenty.totalMnt).toBe(270_000);

    expect(() =>
      quote(beefByKg, { qty: 15, receive: 'pickup', receiveOn: '2026-10-20' }, TODAY),
    ).toThrow(expect.objectContaining({ code: 'TOO_FEW' }));
  });

  it('refuses what is not there', () => {
    // 20 kg left on the co-op's listing; 21 is one too many.
    expect(() =>
      quote(beefByKg, { qty: 21, receive: 'pickup', receiveOn: '2026-10-20' }, TODAY),
    ).toThrow(expect.objectContaining({ code: 'SOLD_OUT' }));
    expect(() =>
      quote({ ...sheep, sold: 20 }, { qty: 1, receive: 'pickup', receiveOn: '2026-10-15' }, TODAY),
    ).toThrow(expect.objectContaining({ code: 'SOLD_OUT' }));
  });

  it('will not promise a delivery the supplier does not make', () => {
    expect(() =>
      quote(beefByKg, { qty: 20, receive: 'delivery', receiveOn: '2026-10-20' }, TODAY),
    ).toThrow(expect.objectContaining({ code: 'NO_DELIVERY' }));
  });

  it('will not promise a day before the meat exists, or one already gone', () => {
    const early = () => quote(sheep, { qty: 1, receive: 'pickup', receiveOn: '2026-10-13' }, TODAY);
    expect(early).toThrow(expect.objectContaining({ code: 'BAD_DATE' }));

    const past = () => quote(sheep, { qty: 1, receive: 'pickup', receiveOn: '2026-10-15' }, '2026-10-16');
    expect(past).toThrow(expect.objectContaining({ code: 'BAD_DATE' }));

    const garbled = () => quote(sheep, { qty: 1, receive: 'pickup', receiveOn: '15/10/2026' }, TODAY);
    expect(garbled).toThrow(expect.objectContaining({ code: 'BAD_DATE' }));
  });

  it('wants a whole positive number of animals', () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) {
      expect(() => quote(sheep, { qty, receive: 'pickup', receiveOn: '2026-10-15' }, TODAY)).toThrow(
        IdeshError,
      );
    }
  });

  it('reads a calendar day in Ulaanbaatar, not in UTC', () => {
    // 23:30 UTC on the 1st is already the 2nd in Ulaanbaatar (+08:00).
    expect(dayOf(new Date('2026-10-01T23:30:00Z'))).toBe('2026-10-02');
    expect(dayOf(new Date('2026-10-01T03:30:00Z'))).toBe('2026-10-01');
  });

  it('says the day the way a message does', () => {
    expect(dayLabel('2026-11-03')).toBe('11-р сарын 3');
    expect(dayLabel('2026-10-14')).toBe('10-р сарын 14');
  });
});

describe('the life of an идэш', () => {
  it('counts the animal as committed from the moment the supplier starts', () => {
    expect(isCommitted('DRAFT')).toBe(false);
    expect(isCommitted('PAID')).toBe(false);
    // The animal is slaughtered — a cancel from here on does not put it back.
    expect(isCommitted('PREPARING')).toBe(true);
    expect(isCommitted('READY')).toBe(true);
    expect(isCommitted('DISPATCHED')).toBe(true);
  });

  it('lets the supplier cancel right up to the handover', () => {
    for (const from of ['PAID', 'PREPARING', 'READY', 'DISPATCHED'] as const) {
      expect(canTransition(from, 'CANCELLED'), from).toBe(true);
    }
    expect(canTransition('HANDED', 'CANCELLED')).toBe(false);
    expect(canTransition('CLOSED', 'CANCELLED')).toBe(false);
  });

  it('only walks forward', () => {
    expect(canTransition('DRAFT', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'READY')).toBe(true);
    expect(canTransition('READY', 'DISPATCHED')).toBe(true);
    expect(canTransition('READY', 'HANDED')).toBe(true);
    expect(canTransition('DISPATCHED', 'HANDED')).toBe(true);
    expect(canTransition('HANDED', 'CLOSED')).toBe(true);

    expect(canTransition('PAID', 'DRAFT')).toBe(false);
    expect(canTransition('READY', 'PREPARING')).toBe(false);
    expect(canTransition('DRAFT', 'PREPARING')).toBe(false);
    expect(nextStates('CLOSED')).toEqual([]);
  });

  it('knows what is still going on', () => {
    expect(isLive('PAID')).toBe(true);
    expect(isLive('HANDED')).toBe(true);
    expect(isLive('DRAFT')).toBe(false);
    expect(isLive('REFUNDED')).toBe(false);
    expect(isCommitted('PREPARING')).toBe(true);
    expect(isCommitted('PAID')).toBe(false);
  });
});
