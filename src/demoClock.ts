import type { Clock } from './domain/time.js';

/**
 * A clock you can push around.
 *
 * Lunch service happens between 11:30 and 14:00, which makes the product
 * impossible to demonstrate at four in the afternoon and impossible to watch
 * end to end at any hour — the interesting gap between firing and seating is
 * fifteen minutes of real waiting. So in development the clock is an object
 * that can be jumped forward, and the UI exposes it.
 *
 * In production this is never constructed: `src/entry/*` uses `systemClock`.
 */
/**
 * Where the demo day starts. Shared, because the seed mints pairing codes with
 * a ten-minute life and the API jumps the clock at boot — mint them against
 * one time and check them against another and they are stale before anyone
 * types them.
 */
export const DEMO_START = '11:40';

export class DemoClock implements Clock {
  #offsetMs = 0;
  #speed = 1;
  #anchor = Date.now();

  now(): Date {
    const elapsed = (Date.now() - this.#anchor) * this.#speed;
    return new Date(this.#anchor + elapsed + this.#offsetMs);
  }

  /** Jump to a wall-clock time today, in the restaurant's zone. */
  setTo(hhmm: string, timeZone = 'Asia/Ulaanbaatar'): void {
    const [h, m] = hhmm.split(':').map(Number);
    const real = new Date();
    // Build "today at hh:mm" in the target zone by measuring the zone's offset.
    const probe = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(real);
    const part = (type: string) => Number(probe.find((p) => p.type === type)?.value ?? 0);
    const zoneNow = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
    const zoneOffset = zoneNow - real.getTime() + real.getTimezoneOffset() * 0;
    const target =
      Date.UTC(part('year'), part('month') - 1, part('day'), h ?? 12, m ?? 0) - zoneOffset;

    this.#anchor = Date.now();
    this.#offsetMs = target - this.#anchor;
  }

  advanceMinutes(minutes: number): void {
    this.#offsetMs += minutes * 60_000;
  }

  /** 60 makes one real second a simulated minute. */
  setSpeed(multiplier: number): void {
    const current = this.now().getTime();
    this.#anchor = Date.now();
    this.#offsetMs = current - this.#anchor;
    this.#speed = multiplier;
  }

  get speed(): number {
    return this.#speed;
  }

  reset(): void {
    this.#anchor = Date.now();
    this.#offsetMs = 0;
    this.#speed = 1;
  }
}
