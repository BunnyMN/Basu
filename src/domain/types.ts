import type { EpochMinute } from './time.js';

/* ── kitchen ───────────────────────────────────────────────────────── */

/** Station codes are per-restaurant free text; these are the pilot's four. */
export type StationCode = string;

export interface StationConfig {
  code: StationCode;
  displayName: string;
  /** How many tickets this station can cook at the same time. */
  parallelLanes: number;
}

export interface KitchenConfig {
  stations: Record<StationCode, StationConfig>;
  /** Minutes between the food being plated and it reaching the table. */
  platingBufferMinutes: number;
}

/* ── order ─────────────────────────────────────────────────────────── */

/**
 * One line of a ticket. `prepMinutes` is the time for the *whole line* —
 * six хуушуур go in one pan, so qty does not multiply prep. If a kitchen
 * genuinely batches differently, that belongs in the measured number, not
 * in an arithmetic rule the engine invents.
 */
export interface OrderLine {
  id: string;
  name: string;
  qty: number;
  prepMinutes: number;
  holdToleranceMinutes: number;
  station: StationCode;
}

export const ORDER_STATES = [
  'DRAFT',
  'PLACED',
  'ACCEPTED',
  'SCHEDULED',
  'ARMED',
  'HELD',
  'FIRED',
  'COOKING',
  'READY',
  'SERVED',
  'CLOSED',
  'REJECTED',
  'RESLOTTED',
  'NO_SHOW',
  'CANCELLED',
  'REFUNDED',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type FireMode = 'AUTO' | 'CONFIRM' | 'MANUAL';

export type TrustTier = 'NEW' | 'AUTO' | 'CONFIRM' | 'BLOCKED';

/* ── fire plan ─────────────────────────────────────────────────────── */

/** One line placed on a concrete lane at a concrete minute. */
export interface ScheduledLine {
  line: OrderLine;
  station: StationCode;
  lane: number;
  startAt: EpochMinute;
  endAt: EpochMinute;
  /** Minutes this line will sit plated before the ticket lands. */
  waitMinutes: number;
}

export interface HoldViolation {
  line: OrderLine;
  waitMinutes: number;
  toleranceMinutes: number;
}

export interface FirePlan {
  kind: 'plan';
  fireAt: EpochMinute;
  readyAt: EpochMinute;
  seatAt: EpochMinute;
  /** Longest station lane — stations run in parallel, so not a sum. */
  orderPrepMinutes: number;
  /** How far the plan slid off the ideal to fit the kitchen. -3 = 3 min early. */
  shiftMinutes: number;
  /** Minutes the guest waits at the table. Target < 3. */
  ttfbMinutes: number;
  /** Set when the ideal fire time was already in the past. */
  lateByMinutes: number;
  lines: ScheduledLine[];
  violations: HoldViolation[];
}

export type HeldReason =
  | 'NO_LINES'
  | 'STATION_SATURATED'
  | 'NO_FEASIBLE_SLOT';

export interface FireHold {
  kind: 'held';
  reason: HeldReason;
  station?: StationCode;
  seatAt: EpochMinute;
  readyAt: EpochMinute;
}

export type FireDecision = FirePlan | FireHold;
