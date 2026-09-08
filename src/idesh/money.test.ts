import { describe, expect, it } from 'vitest';
import { commissionOf, noShowFrom, reasonProblem, splitRefund } from './money.js';

/** The three numbers from CONTEXT.md, exercised as arithmetic. */
describe('what comes back when an идэш is cancelled', () => {
  const sheep = { meatMnt: 460_000, deliveryFeeMnt: 25_000 };

  it('everything, before the animal is slaughtered — whatever the reason', () => {
    for (const reason of ['guest_asked', 'vet', 'cannot_fulfil'] as const) {
      expect(splitRefund({ state: 'PAID', reason, ...sheep })).toEqual({ refundMnt: 485_000, forfeitMnt: 0 });
    }
  });

  it('everything, after slaughter, when the supplier is at fault', () => {
    expect(splitRefund({ state: 'READY', reason: 'vet', ...sheep })).toEqual({ refundMnt: 485_000, forfeitMnt: 0 });
    expect(splitRefund({ state: 'DISPATCHED', reason: 'cannot_fulfil', ...sheep })).toEqual({
      refundMnt: 485_000,
      forfeitMnt: 0,
    });
  });

  it('a tenth of the meat stays, after slaughter, when the guest changed their mind or did not come', () => {
    for (const reason of ['guest_asked', 'no_show', 'unreachable'] as const) {
      expect(splitRefund({ state: 'PREPARING', reason, ...sheep })).toEqual({
        refundMnt: 485_000 - 46_000,
        forfeitMnt: 46_000,
      });
    }
    // Never of the delivery fee: no delivery happened.
    expect(splitRefund({ state: 'READY', reason: 'no_show', meatMnt: 100_000, deliveryFeeMnt: 30_000 })).toEqual({
      refundMnt: 120_000,
      forfeitMnt: 10_000,
    });
  });
});

describe('Basu’s share', () => {
  it('is a rounded percentage of the meat price', () => {
    expect(commissionOf(460_000, 2)).toBe(9_200);
    expect(commissionOf(14_500 * 15, 2)).toBe(4_350);
    expect(commissionOf(333_333, 2)).toBe(6_667);
    expect(commissionOf(100_000, 0)).toBe(0);
  });
});

describe('when a guest may be called absent', () => {
  const ready = new Date('2026-09-05T10:00:00+08:00');

  it('is three days after the later of the meat being ready and the guest’s own day', () => {
    expect(noShowFrom(ready, '2026-09-03').toISOString()).toBe(new Date('2026-09-08T10:00:00+08:00').toISOString());
    expect(noShowFrom(ready, '2026-09-12').getDate()).toBe(15);
  });

  it('only for a ready pickup, and only then', () => {
    const base = { reason: 'no_show' as const, receive: 'pickup' as const, receiveOn: '2026-09-03', readyAt: ready };
    expect(reasonProblem({ ...base, state: 'PAID', now: new Date('2026-09-20') })).toMatch(/бэлэн болсон/);
    expect(reasonProblem({ ...base, state: 'READY', receive: 'delivery', now: new Date('2026-09-20') })).toMatch(
      /өөрөө авах/,
    );
    expect(reasonProblem({ ...base, state: 'READY', now: new Date('2026-09-07T10:00:00+08:00') })).toMatch(/9-р сарын 8/);
    expect(reasonProblem({ ...base, state: 'READY', now: new Date('2026-09-08T10:00:00+08:00') })).toBeNull();
  });

  it('«хаяг дээр холбогдоогүй» is for a ready delivery; the rest need no timing', () => {
    const ok = { readyAt: ready, receiveOn: '2026-09-03', now: new Date('2026-09-06') };
    expect(reasonProblem({ ...ok, state: 'PAID', reason: 'unreachable', receive: 'delivery' })).toMatch(/бэлэн/);
    expect(reasonProblem({ ...ok, state: 'DISPATCHED', reason: 'unreachable', receive: 'delivery' })).toBeNull();
    expect(reasonProblem({ ...ok, state: 'READY', reason: 'unreachable', receive: 'pickup' })).toMatch(/хүргэлт/);
    expect(reasonProblem({ ...ok, state: 'PAID', reason: 'guest_asked', receive: 'pickup' })).toBeNull();
    expect(reasonProblem({ ...ok, state: 'PAID', reason: 'draft_expired', receive: 'pickup' })).toMatch(/биш/);
  });
});
