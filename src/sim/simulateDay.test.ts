import { describe, expect, it } from 'vitest';
import { measure } from './report.js';
import { simulateDay, type SimResult } from './simulateDay.js';

/**
 * Two kinds of assertion live here, and the difference matters.
 *
 * The invariants are laws: firing twice, overrunning a station, or walking an
 * illegal transition are bugs no configuration excuses, so they are checked
 * across seeds and under deliberate abuse.
 *
 * The baselines are the current shape of the engine. They are deliberately
 * loose — they exist to catch a regression, not to freeze a number we have not
 * earned yet. Real prep times from the онбординг stopwatch will move them.
 */

function invariants(result: SimResult, label: string) {
  const m = measure(result);
  expect(m.doubleFires, `${label}: a ticket was fired more than once`).toBe(0);
  expect(result.overloads.slice(0, 3), `${label}: station ran past its lanes`).toEqual([]);
  expect(result.illegalTransitions.slice(0, 3), `${label}: illegal state move`).toEqual([]);

  for (const order of result.orders) {
    if (order.firedAt) {
      expect(order.readyAt ?? order.firedAt, `${label}: ready before fire`).toBeInstanceOf(Date);
      if (order.readyAt) {
        expect(order.readyAt.getTime()).toBeGreaterThanOrEqual(order.firedAt.getTime());
      }
    }
    // Nothing cooks for a guest who was never committed to.
    if (!order.firedAt) {
      expect(order.readyAt, `${label}: ${order.id} became ready without firing`).toBeUndefined();
    }
  }
}

describe('a simulated lunch service', () => {
  it('holds its invariants across seeds', () => {
    for (const seed of [1, 20260902, 777, 31337, 900001]) {
      invariants(simulateDay({ seed }), `seed ${seed}`);
    }
  });

  it('holds them when every guest goes silent', () => {
    // No push, no taps, no geofence: the degraded L1 mode from the failure
    // ladder. Accuracy suffers; correctness must not.
    invariants(simulateDay({ signalDropRate: 1 }), 'no signals');
  });

  it('holds them when the kitchen is deliberately oversold', () => {
    invariants(simulateDay({ maxOrdersPerSlot: 12, ordersPerRestaurant: 90 }), 'oversold');
  });

  it('holds them when almost nobody turns up on time', () => {
    invariants(simulateDay({ lateRate: 0.7, noShowRate: 0.25 }), 'chaotic arrivals');
  });

  it('never lets a station exceed its lanes, however hard it is pushed', () => {
    const result = simulateDay({ maxOrdersPerSlot: 20, ordersPerRestaurant: 120, restaurants: 3 });
    expect(result.overloads).toEqual([]);
  });

  it('refuses work rather than promising badly when oversold', () => {
    const easy = measure(simulateDay({ maxOrdersPerSlot: 2 }));
    const hard = measure(simulateDay({ maxOrdersPerSlot: 12 }));
    // The pressure valve is HELD, and it has to actually open under load.
    expect(hard.heldShare).toBeGreaterThan(easy.heldShare);
  });

  it('is deterministic for a given seed', () => {
    const a = measure(simulateDay({ seed: 42 }));
    const b = measure(simulateDay({ seed: 42 }));
    expect(a).toEqual(b);
  });
});

describe('current baselines', () => {
  const m = measure(simulateDay());

  it('fires almost every ticket that has a guest behind it', () => {
    expect(m.fired / m.orders).toBeGreaterThan(0.9);
    expect(m.stranded / m.orders).toBeLessThan(0.05);
  });

  it('lands the food within three minutes of the guest more often than not', () => {
    expect(m.accuracy.p50).toBeLessThanOrEqual(3);
    expect(m.accuracy.withinThree).toBeGreaterThan(0.5);
  });

  it('keeps the seated guest waiting under the promise', () => {
    expect(m.ttfb.underThree).toBeGreaterThan(0.6);
  });

  it('does not lean on the chef to rescue it', () => {
    expect(m.rescueShare).toBeLessThan(0.12);
  });
});
