/**
 * Time is the whole product, so it is never read from a global.
 *
 * Rule from the spec (Галлах хөдөлгүүр §14): no module calls `Date.now()`
 * directly. Everything takes a `Clock`. That is what makes a full lunch
 * service replayable in a few hundred milliseconds inside a test.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock the test harness drives by hand. */
export class VirtualClock implements Clock {
  #ms: number;

  constructor(start: Date | string | number) {
    this.#ms = typeof start === 'number' ? start : new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** Move forward. Never backwards — a clock that rewinds hides real bugs. */
  advanceMinutes(m: number): void {
    if (m < 0) throw new Error('VirtualClock cannot go backwards');
    this.#ms += m * 60_000;
  }

  advanceSeconds(s: number): void {
    if (s < 0) throw new Error('VirtualClock cannot go backwards');
    this.#ms += s * 1000;
  }

  set(at: Date | string): void {
    const next = new Date(at).getTime();
    if (next < this.#ms) throw new Error('VirtualClock cannot go backwards');
    this.#ms = next;
  }
}

/* ── minute arithmetic ─────────────────────────────────────────────────
 * The engine reasons in whole minutes because that is the resolution a
 * kitchen actually works at, and because integer minutes make the
 * scheduling search exhaustive and exact instead of floating-point fuzzy.
 * Seconds only matter for the scheduler's own lateness metric.
 */

export type EpochMinute = number;

/**
 * Floor, not round. The minute you are in is the minute you are in: at 12:25:30
 * rounding would call it 12:26, and a fire the planner has just decided is
 * already late would be scheduled a minute into the future — where the next
 * tick would push it again, forever. Flooring makes "now" mean now.
 */
export function toEpochMinute(d: Date): EpochMinute {
  return Math.floor(d.getTime() / 60_000);
}

export function fromEpochMinute(m: EpochMinute): Date {
  return new Date(m * 60_000);
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

export function diffMinutes(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

export function diffSeconds(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 1000;
}

/** `12:34` in the restaurant's zone — for logs, tickets and test failures. */
export function hhmm(d: Date, timeZone = 'Asia/Ulaanbaatar'): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(d);
}
