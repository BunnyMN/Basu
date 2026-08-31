import type { EpochMinute } from './time.js';
import type { StationCode } from './types.js';

/** A half-open [from, to) interval of kitchen minutes on one lane. */
export interface LaneInterval {
  from: EpochMinute;
  to: EpochMinute;
}

/**
 * Slot limits cap how many *orders* a 15-minute window may take. They do not
 * stop three windows' tickets from all wanting the grill at 12:23, because
 * ETA drift moves fire times around. This ledger is the second guard: it
 * knows, minute by minute, how many lanes of every station are already spoken
 * for.
 *
 * Kept deliberately dumb and synchronous so the planner can probe it dozens of
 * times while searching for a feasible minute.
 */
export interface LoadLedger {
  /** Would these lane intervals still fit inside the station's capacity? */
  fits(station: StationCode, intervals: LaneInterval[], capacity: number): boolean;
  occupy(orderId: string, station: StationCode, intervals: LaneInterval[]): void;
  /** Called on READY, CANCELLED or a re-plan. Safe to call for unknown ids. */
  release(orderId: string): void;
  occupancy(station: StationCode, minute: EpochMinute): number;
}

export class InMemoryStationLoad implements LoadLedger {
  /** station -> minute -> lanes occupied */
  readonly #buckets = new Map<StationCode, Map<EpochMinute, number>>();
  /** orderId -> the exact (station, minute) cells it holds, for exact release */
  readonly #held = new Map<string, Array<[StationCode, EpochMinute]>>();

  fits(station: StationCode, intervals: LaneInterval[], capacity: number): boolean {
    if (capacity <= 0) return false;
    const wanted = new Map<EpochMinute, number>();
    for (const iv of intervals) {
      for (let m = iv.from; m < iv.to; m++) {
        wanted.set(m, (wanted.get(m) ?? 0) + 1);
      }
    }
    const bucket = this.#buckets.get(station);
    for (const [minute, need] of wanted) {
      const used = bucket?.get(minute) ?? 0;
      if (used + need > capacity) return false;
    }
    return true;
  }

  occupy(orderId: string, station: StationCode, intervals: LaneInterval[]): void {
    let bucket = this.#buckets.get(station);
    if (!bucket) {
      bucket = new Map();
      this.#buckets.set(station, bucket);
    }
    const cells = this.#held.get(orderId) ?? [];
    for (const iv of intervals) {
      for (let m = iv.from; m < iv.to; m++) {
        bucket.set(m, (bucket.get(m) ?? 0) + 1);
        cells.push([station, m]);
      }
    }
    this.#held.set(orderId, cells);
  }

  release(orderId: string): void {
    const cells = this.#held.get(orderId);
    if (!cells) return;
    for (const [station, minute] of cells) {
      const bucket = this.#buckets.get(station);
      if (!bucket) continue;
      const next = (bucket.get(minute) ?? 0) - 1;
      if (next > 0) bucket.set(minute, next);
      else bucket.delete(minute);
    }
    this.#held.delete(orderId);
  }

  occupancy(station: StationCode, minute: EpochMinute): number {
    return this.#buckets.get(station)?.get(minute) ?? 0;
  }

  /** Test/ops helper: how many orders currently hold anything. */
  get size(): number {
    return this.#held.size;
  }
}

/** Used when capacity is not being modelled — every minute is free. */
export const unlimitedLoad: LoadLedger = {
  fits: () => true,
  occupy: () => {},
  release: () => {},
  occupancy: () => 0,
};
