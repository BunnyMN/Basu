/**
 * The life of an идэш, as a table.
 *
 * Fewer states than a lunch, because nothing here is timed to the minute:
 * the guest pays, the supplier slaughters, the meat is ready, it travels or
 * it does not, it is handed over. The one line that matters is the same as
 * dine's — PREPARING is the refund boundary, the way FIRED is — and every
 * cancel button, countdown and line of copy reads from that one predicate.
 */
export const IDESH_STATES = [
  'DRAFT',
  'PAID',
  'PREPARING',
  'READY',
  'DISPATCHED',
  'HANDED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
] as const;

export type IdeshState = (typeof IDESH_STATES)[number];

const ALLOWED: Record<IdeshState, readonly IdeshState[]> = {
  DRAFT: ['PAID', 'CANCELLED'],
  PAID: ['PREPARING', 'CANCELLED'],
  // Past this line the animal has been slaughtered and the guest's money stops
  // moving back. The supplier can still cancel — a carcass that failed the vet
  // is theirs to answer for, and the guest is refunded in full.
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['DISPATCHED', 'HANDED', 'CANCELLED'],
  DISPATCHED: ['HANDED', 'CANCELLED'],
  HANDED: ['CLOSED'],
  CANCELLED: ['REFUNDED', 'CLOSED'],
  REFUNDED: ['CLOSED'],
  CLOSED: [],
};

/** What the launcher asks for: everything of the guest's still going on. */
export const LIVE_STATES: readonly IdeshState[] = [
  'PAID',
  'PREPARING',
  'READY',
  'DISPATCHED',
  'HANDED',
];

/** What the supplier's board draws — the ones with a job still to do. */
export const BOARD_STATES: readonly IdeshState[] = ['PAID', 'PREPARING', 'READY', 'DISPATCHED'];

export function canTransition(from: IdeshState, to: IdeshState): boolean {
  return ALLOWED[from].includes(to);
}

export function nextStates(from: IdeshState): readonly IdeshState[] {
  return ALLOWED[from];
}

/** Before the supplier has started, cancelling costs the guest nothing. */
export function isFreeToCancel(state: IdeshState): boolean {
  return state === 'DRAFT' || state === 'PAID';
}

/** Has the supplier committed an animal to this order? */
export function isCommitted(state: IdeshState): boolean {
  return state === 'PREPARING' || state === 'READY' || state === 'DISPATCHED' || state === 'HANDED';
}

export function isLive(state: IdeshState): boolean {
  return LIVE_STATES.includes(state);
}
