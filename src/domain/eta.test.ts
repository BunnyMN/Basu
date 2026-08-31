import { describe, expect, it } from 'vitest';
import { decideFireMode, predictSeatTime, shouldReplan, type ArrivalSignal } from './eta.js';
import { at } from './fixtures.js';
import { hhmm } from './time.js';

const base = { slotStartsAt: at('12:30'), travelMinutes: 7 };

describe('predictSeatTime', () => {
  it('falls back to the booked slot when nothing else has happened', () => {
    const p = predictSeatTime({ ...base, signals: [], now: at('12:00') });
    expect(hhmm(p.seatAt)).toBe('12:30');
    expect(p.basis).toBe('slot');
    expect(p.confidence).toBeCloseTo(0.55);
  });

  it('believes a tap over the booking', () => {
    const signals: ArrivalSignal[] = [{ type: 'on_my_way', at: at('12:20') }];
    const p = predictSeatTime({ ...base, signals, now: at('12:21') });
    expect(hhmm(p.seatAt)).toBe('12:27'); // 12:20 + 7 minutes on foot
    expect(p.basis).toBe('on_my_way');
    expect(p.confidence).toBeCloseTo(0.9);
  });

  it('lets a close geofence sharpen the estimate', () => {
    const signals: ArrivalSignal[] = [{ type: 'geofence_300', at: at('12:26') }];
    const p = predictSeatTime({ ...base, signals, now: at('12:27') });
    expect(hhmm(p.seatAt)).toBe('12:29');
    expect(p.confidence).toBeCloseTo(0.88);
  });

  it('stops trusting a geofence once it has gone stale', () => {
    const signals: ArrivalSignal[] = [{ type: 'geofence_300', at: at('12:05') }];
    const p = predictSeatTime({ ...base, signals, now: at('12:20') }); // ttl 6 min
    expect(p.basis).toBe('slot');
    expect(hhmm(p.seatAt)).toBe('12:30');
  });

  it('adds up repeated delay taps instead of collapsing them', () => {
    const signals: ArrivalSignal[] = [
      { type: 'delay_10', at: at('12:15') },
      { type: 'delay_10', at: at('12:20') },
    ];
    const p = predictSeatTime({ ...base, signals, now: at('12:21') });
    expect(hhmm(p.seatAt)).toBe('12:50');
  });

  it('drops confidence when two trustworthy signals disagree', () => {
    const signals: ArrivalSignal[] = [
      { type: 'on_my_way', at: at('12:24') }, // implies 12:31
      { type: 'geofence_800', at: at('12:25') }, // implies 12:33
    ];
    const near = predictSeatTime({ ...base, signals, now: at('12:26') });
    expect(near.confidence).toBeCloseTo(0.9); // 2 minutes apart — no argument

    const conflicting: ArrivalSignal[] = [
      { type: 'on_my_way', at: at('12:10') }, // implies 12:17
      { type: 'geofence_800', at: at('12:20') }, // implies 12:28
    ];
    const far = predictSeatTime({ ...base, signals: conflicting, now: at('12:21') });
    expect(far.confidence).toBeCloseTo(0.65); // 0.9 - 0.25
  });

  it('treats an app open as reassurance, never as a new estimate', () => {
    const signals: ArrivalSignal[] = [{ type: 'app_open', at: at('12:19') }];
    const p = predictSeatTime({ ...base, signals, now: at('12:20') });
    expect(hhmm(p.seatAt)).toBe('12:30');
    expect(p.confidence).toBeCloseTo(0.6); // 0.55 + 0.05
  });

  it('will not seat a guest before the table is even held', () => {
    const signals: ArrivalSignal[] = [{ type: 'on_my_way', at: at('11:50') }];
    const p = predictSeatTime({ ...base, signals, now: at('11:51') });
    expect(hhmm(p.seatAt)).toBe('12:27'); // clamped to slot - 3
  });

  it('caps how late the estimate may drift', () => {
    const signals: ArrivalSignal[] = [
      { type: 'delay_10', at: at('12:25') },
      { type: 'delay_10', at: at('12:30') },
      { type: 'delay_10', at: at('12:35') },
      { type: 'delay_10', at: at('12:40') },
    ];
    const p = predictSeatTime({ ...base, signals, now: at('12:41') });
    expect(hhmm(p.seatAt)).toBe('12:55'); // slot + 25, not 13:10
  });

  it('treats a check-in as the end of guessing', () => {
    const signals: ArrivalSignal[] = [
      { type: 'delay_10', at: at('12:20') },
      { type: 'checkin', at: at('12:28') },
    ];
    const p = predictSeatTime({ ...base, signals, now: at('12:29') });
    expect(p.seated).toBe(true);
    expect(p.confidence).toBe(1);
    expect(hhmm(p.seatAt)).toBe('12:28');
  });
});

describe('decideFireMode', () => {
  it('needs both a trusted guest and a confident estimate', () => {
    expect(decideFireMode(0.9, 'AUTO')).toBe('AUTO');
    expect(decideFireMode(0.9, 'NEW')).toBe('CONFIRM');
    expect(decideFireMode(0.7, 'AUTO')).toBe('CONFIRM');
    expect(decideFireMode(0.55, 'AUTO')).toBe('MANUAL');
    expect(decideFireMode(1, 'BLOCKED')).toBe('MANUAL');
  });
});

describe('shouldReplan', () => {
  it('ignores drift the kitchen would not act on', () => {
    expect(shouldReplan(at('12:30'), at('12:33'))).toBe(false);
    expect(shouldReplan(at('12:30'), at('12:35'))).toBe(true);
    expect(shouldReplan(at('12:30'), at('12:24'))).toBe(true);
  });
});
