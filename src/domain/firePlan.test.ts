import { describe, expect, it } from 'vitest';
import { computeFirePlan } from './firePlan.js';
import { InMemoryStationLoad } from './load.js';
import { at, line, PILOT_KITCHEN } from './fixtures.js';
import { fromEpochMinute, hhmm } from './time.js';
import type { FirePlan } from './types.js';

function plan(decision: ReturnType<typeof computeFirePlan>): FirePlan {
  if (decision.kind !== 'plan') {
    throw new Error(`expected a plan, got held (${decision.reason})`);
  }
  return decision;
}

const clock = (t: string) => at(t);

describe('computeFirePlan', () => {
  it('fires one dish exactly its prep time before the food is due', () => {
    const p = plan(
      computeFirePlan({
        lines: [line('tsuivan')],
        seatAt: at('12:30'),
        now: clock('11:40'),
        kitchen: PILOT_KITCHEN,
      }),
    );

    // ready = seat + 1 plating minute; fire = ready - 9 minutes of wok
    expect(hhmm(fromEpochMinute(p.readyAt))).toBe('12:31');
    expect(hhmm(fromEpochMinute(p.fireAt))).toBe('12:22');
    expect(p.orderPrepMinutes).toBe(9);
    expect(p.ttfbMinutes).toBe(1);
    expect(p.violations).toEqual([]);
  });

  it('reproduces the worked example from the spec (ticket №1043)', () => {
    // Банштай шөл ×2 (soup 6), Хуушуур ×6 (grill 7), Салат ×1 (cold 3)
    const p = plan(
      computeFirePlan({
        lines: [line('soup_bansh', 2), line('khuushuur', 6), line('salad')],
        seatAt: at('12:40'),
        now: clock('12:00'),
        kitchen: PILOT_KITCHEN,
      }),
    );

    expect(hhmm(fromEpochMinute(p.readyAt))).toBe('12:41');
    expect(p.orderPrepMinutes).toBe(7); // max(6, 7, 3) — not 16
    expect(hhmm(fromEpochMinute(p.fireAt))).toBe('12:34');
    expect(p.violations).toEqual([]);
  });

  it('runs stations in parallel rather than summing them', () => {
    const parallel = plan(
      computeFirePlan({
        lines: [line('steak'), line('soup_guril'), line('salad')],
        seatAt: at('12:30'),
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
      }),
    );
    // 12 + 4 + 3 = 19 if summed; the grill's 12 is the real answer
    expect(parallel.orderPrepMinutes).toBe(12);
  });

  it('lands every line at the same minute when lanes are free', () => {
    const p = plan(
      computeFirePlan({
        lines: [line('khuushuur'), line('fries')], // both grill, 2 lanes
        seatAt: at('12:30'),
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
      }),
    );

    expect(p.orderPrepMinutes).toBe(7);
    for (const scheduled of p.lines) {
      expect(scheduled.endAt).toBe(p.readyAt);
      expect(scheduled.waitMinutes).toBe(0);
    }
    expect(p.violations).toEqual([]);
  });

  it('cooks the most fragile line last when a station has to serialise', () => {
    const singleLaneGrill = {
      ...PILOT_KITCHEN,
      stations: {
        ...PILOT_KITCHEN.stations,
        grill: { code: 'grill', displayName: 'Шарах', parallelLanes: 1 },
      },
    };

    const p = plan(
      computeFirePlan({
        lines: [line('khuushuur'), line('steak')], // hold 2 and hold 3
        seatAt: at('12:30'),
        now: clock('11:00'),
        kitchen: singleLaneGrill,
      }),
    );

    expect(p.orderPrepMinutes).toBe(19); // 12 + 7 on one lane
    const last = p.lines.find((s) => s.waitMinutes === 0);
    expect(last?.line.name).toBe('Хуушуур'); // tolerance 2 — must not sit

    // The steak is the one that suffers, and we say so rather than hide it.
    expect(p.violations).toHaveLength(1);
    expect(p.violations[0]?.line.name).toBe('Стейк');
    expect(p.violations[0]?.waitMinutes).toBe(7);
  });

  it('leaves an uncontended station on its ideal minute', () => {
    const ledger = new InMemoryStationLoad();
    const seatAt = at('12:30');

    for (const id of ['a', 'b']) {
      expect(
        computeFirePlan({
          lines: [line('steak')],
          seatAt,
          now: clock('11:00'),
          kitchen: PILOT_KITCHEN,
          ledger,
          orderId: id,
        }).kind,
      ).toBe('plan');
    }

    // The grill is now full, but this ticket only needs the soup lane.
    const soupOnly = plan(
      computeFirePlan({
        lines: [line('soup_guril')],
        seatAt,
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'c',
      }),
    );
    expect(soupOnly.shiftMinutes).toBe(0);
  });

  it('slides early into a free gap when the food can take the wait', () => {
    const ledger = new InMemoryStationLoad();

    // Soup has a single lane. This ticket books 12:31–12:37 on it.
    plan(
      computeFirePlan({
        lines: [line('soup_bansh')],
        seatAt: at('12:36'),
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'a',
      }),
    );

    // Ideal for this one is 12:30–12:34, which collides. Гурилтай шөл holds
    // for 15 minutes, so the planner is free to cook it three minutes early.
    const early = plan(
      computeFirePlan({
        lines: [line('soup_guril')],
        seatAt: at('12:33'),
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'b',
      }),
    );

    expect(early.shiftMinutes).toBe(-3);
    expect(hhmm(fromEpochMinute(early.fireAt))).toBe('12:27');
    expect(early.ttfbMinutes).toBe(0); // food is plated before the guest sits
    expect(early.violations).toEqual([]);
  });

  it('pushes late, inside the TTFB budget, when it cannot go early', () => {
    const ledger = new InMemoryStationLoad();
    const seatAt = at('12:30');

    // Both grill lanes booked 12:26–12:31.
    for (const id of ['a', 'b']) {
      plan(
        computeFirePlan({
          lines: [line('fries')],
          seatAt,
          now: clock('11:00'),
          kitchen: PILOT_KITCHEN,
          ledger,
          orderId: id,
        }),
      );
    }

    // Шарсан төмс only holds 2 minutes, so sliding early is not an option.
    const late = plan(
      computeFirePlan({
        lines: [line('fries')],
        seatAt: at('12:33'),
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'c',
      }),
    );

    expect(late.shiftMinutes).toBe(2);
    expect(hhmm(fromEpochMinute(late.fireAt))).toBe('12:31');
    expect(late.ttfbMinutes).toBe(3); // the guest waits, but inside the promise
    expect(late.violations).toEqual([]);
  });

  it('holds the ticket instead of promising a plan it cannot keep', () => {
    const ledger = new InMemoryStationLoad();
    const seatAt = at('12:30');

    // Fill both grill lanes with long steaks, then ask for one more steak.
    for (const id of ['a', 'b']) {
      computeFirePlan({
        lines: [line('steak')],
        seatAt,
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: id,
      });
    }

    const third = computeFirePlan({
      lines: [line('steak')], // hold tolerance 3 — barely any room to slide
      seatAt,
      now: clock('11:00'),
      kitchen: PILOT_KITCHEN,
      ledger,
      orderId: 'c',
    });

    expect(third.kind).toBe('held');
    if (third.kind === 'held') expect(third.reason).toBe('NO_FEASIBLE_SLOT');
  });

  it('never schedules a fire in the past and reports how late it is', () => {
    const p = plan(
      computeFirePlan({
        lines: [line('tsuivan')],
        seatAt: at('12:30'),
        now: clock('12:28'), // ideal fire was 12:22 — six minutes gone
        kitchen: PILOT_KITCHEN,
      }),
    );

    expect(hhmm(fromEpochMinute(p.fireAt))).toBe('12:28');
    expect(p.lateByMinutes).toBe(6);
    expect(p.fireAt).toBeGreaterThanOrEqual(p.seatAt - 2);
  });

  it('holds an order whose station the restaurant has not configured', () => {
    const noGrill = {
      ...PILOT_KITCHEN,
      stations: {
        ...PILOT_KITCHEN.stations,
        grill: { code: 'grill', displayName: 'Шарах', parallelLanes: 0 },
      },
    };

    const decision = computeFirePlan({
      lines: [line('khuushuur')],
      seatAt: at('12:30'),
      now: clock('11:00'),
      kitchen: noGrill,
    });

    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.reason).toBe('STATION_SATURATED');
      expect(decision.station).toBe('grill');
    }
  });

  it('refuses an empty ticket', () => {
    const decision = computeFirePlan({
      lines: [],
      seatAt: at('12:30'),
      now: clock('11:00'),
      kitchen: PILOT_KITCHEN,
    });
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') expect(decision.reason).toBe('NO_LINES');
  });

  it('releases a ticket’s lanes back to the kitchen', () => {
    const ledger = new InMemoryStationLoad();
    const seatAt = at('12:30');

    for (const id of ['a', 'b']) {
      computeFirePlan({
        lines: [line('steak')],
        seatAt,
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: id,
      });
    }
    expect(
      computeFirePlan({
        lines: [line('steak')],
        seatAt,
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'c',
      }).kind,
    ).toBe('held');

    ledger.release('a');

    expect(
      computeFirePlan({
        lines: [line('steak')],
        seatAt,
        now: clock('11:00'),
        kitchen: PILOT_KITCHEN,
        ledger,
        orderId: 'd',
      }).kind,
    ).toBe('plan');
  });
});
