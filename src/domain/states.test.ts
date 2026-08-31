import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  FIREABLE_STATES,
  IllegalTransitionError,
  isCommitted,
  isFreeToCancel,
  nextStates,
} from './states.js';
import { ORDER_STATES, type OrderState } from './types.js';

describe('order state machine', () => {
  it('walks the happy path end to end', () => {
    const path: OrderState[] = [
      'DRAFT',
      'PLACED',
      'ACCEPTED',
      'SCHEDULED',
      'ARMED',
      'FIRED',
      'COOKING',
      'READY',
      'SERVED',
      'CLOSED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('never lets a fired ticket walk back to a refundable state', () => {
    for (const state of ['FIRED', 'COOKING', 'READY', 'SERVED'] as OrderState[]) {
      expect(isFreeToCancel(state)).toBe(false);
      expect(isCommitted(state)).toBe(true);
      expect(canTransition(state, 'CANCELLED')).toBe(false);
      expect(canTransition(state, 'REFUNDED')).toBe(false);
    }
  });

  it('lets every pre-fire state be cancelled for free', () => {
    for (const state of FIREABLE_STATES) {
      expect(isFreeToCancel(state)).toBe(true);
      expect(canTransition(state, 'CANCELLED')).toBe(true);
    }
  });

  it('only fires out of the three states the scheduler knows about', () => {
    const fireable = ORDER_STATES.filter((s) => canTransition(s, 'FIRED'));
    expect([...fireable].sort()).toEqual([...FIREABLE_STATES].sort());
  });

  it('has no route out of CLOSED', () => {
    expect(nextStates('CLOSED')).toEqual([]);
  });

  it('lets every state reach CLOSED eventually', () => {
    const seen = new Set<OrderState>();
    const stack: OrderState[] = ['DRAFT'];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (seen.has(state)) continue;
      seen.add(state);
      stack.push(...nextStates(state));
    }
    for (const state of ORDER_STATES) {
      expect(seen.has(state), `${state} is unreachable from DRAFT`).toBe(true);
    }
  });

  it('names the offending pair when a writer gets it wrong', () => {
    expect(() => assertTransition('READY', 'DRAFT')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('READY', 'DRAFT')).toThrow(/READY → DRAFT/);
  });
});
