import type { OrderState } from './types.js';

/**
 * The transition table is the contract every writer in the system obeys.
 * Keeping it here — rather than as scattered `if` statements — is what lets
 * the scheduler do its one conditional UPDATE and know it is safe.
 */
const ALLOWED: Record<OrderState, readonly OrderState[]> = {
  DRAFT: ['PLACED', 'CANCELLED'],
  PLACED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['ARMED', 'HELD', 'FIRED', 'RESLOTTED', 'CANCELLED'],
  ARMED: ['FIRED', 'HELD', 'RESLOTTED', 'NO_SHOW', 'CANCELLED'],
  HELD: ['FIRED', 'RESLOTTED', 'NO_SHOW', 'CANCELLED'],
  RESLOTTED: ['SCHEDULED', 'CANCELLED'],
  // Past this line the ingredients are spent and money stops moving back.
  FIRED: ['COOKING', 'NO_SHOW'],
  COOKING: ['READY', 'NO_SHOW'],
  READY: ['SERVED', 'NO_SHOW'],
  SERVED: ['CLOSED'],
  NO_SHOW: ['CLOSED'],
  REJECTED: ['REFUNDED'],
  CANCELLED: ['REFUNDED', 'CLOSED'],
  REFUNDED: ['CLOSED'],
  CLOSED: [],
};

/** States the scheduler is allowed to fire out of. */
export const FIREABLE_STATES: readonly OrderState[] = ['SCHEDULED', 'ARMED', 'HELD'];

export const TERMINAL_STATES: readonly OrderState[] = ['CLOSED'];

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}

export function nextStates(from: OrderState): readonly OrderState[] {
  return ALLOWED[from];
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`illegal order transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * FIRED is the refund boundary. Everything the guest sees about cancelling —
 * the countdown, the button, the copy — reads from this one predicate.
 */
export function isFreeToCancel(state: OrderState): boolean {
  return (
    state === 'DRAFT' ||
    state === 'PLACED' ||
    state === 'ACCEPTED' ||
    state === 'SCHEDULED' ||
    state === 'ARMED' ||
    state === 'HELD' ||
    state === 'RESLOTTED'
  );
}

/** Has the kitchen committed ingredients to this ticket? */
export function isCommitted(state: OrderState): boolean {
  return state === 'FIRED' || state === 'COOKING' || state === 'READY' || state === 'SERVED';
}

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.includes(state);
}
