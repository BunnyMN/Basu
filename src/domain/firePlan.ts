import { toEpochMinute, type EpochMinute } from './time.js';
import { unlimitedLoad, type LaneInterval, type LoadLedger } from './load.js';
import type {
  FireDecision,
  HoldViolation,
  KitchenConfig,
  OrderLine,
  ScheduledLine,
  StationCode,
} from './types.js';

/**
 * When the kitchen is full we may fire early — the food then sits, so the
 * slack is bounded by every line's hold tolerance — or late, which makes the
 * guest wait. This caps the late direction; TTFB is the product's one promise.
 */
const DEFAULT_TTFB_BUDGET_MINUTES = 2;

/** Never fire more than this far ahead even if the food could take it. */
const DEFAULT_MAX_EARLY_MINUTES = 15;

export interface FirePlanInput {
  lines: OrderLine[];
  /** When we predict the guest sits down (§04 ETA fusion feeds this). */
  seatAt: Date;
  now: Date;
  kitchen: KitchenConfig;
  /** Omit to plan without capacity constraints. */
  ledger?: LoadLedger;
  /** Needed only so the ledger can attribute the reservation. */
  orderId?: string;
  ttfbBudgetMinutes?: number;
  maxEarlyMinutes?: number;
}

interface Lane {
  index: number;
  loadMinutes: number;
  lines: OrderLine[];
}

interface PackedStation {
  station: StationCode;
  capacity: number;
  lanes: Lane[];
}

/**
 * Longest-processing-time-first bin packing across the station's free lanes.
 *
 * LPT is a heuristic, not an optimum — it can be a third worse than perfect in
 * theory. That is the wrong thing to optimise: a measured `prep_time` carries
 * about ±2 minutes of error on its own, so a cleverer packer would be
 * polishing noise.
 */
function packStation(lines: OrderLine[], capacity: number): Lane[] {
  const lanes: Lane[] = Array.from({ length: capacity }, (_, index) => ({
    index,
    loadMinutes: 0,
    lines: [],
  }));

  for (const line of [...lines].sort((a, b) => b.prepMinutes - a.prepMinutes)) {
    let target = lanes[0]!;
    for (const lane of lanes) if (lane.loadMinutes < target.loadMinutes) target = lane;
    target.loadMinutes += line.prepMinutes;
    target.lines.push(line);
  }

  // Order inside a lane matters: whatever cooks last never sits. So the most
  // fragile line goes last and waits zero, and the sturdy шөл absorbs the wait.
  for (const lane of lanes) {
    lane.lines.sort((a, b) => b.holdToleranceMinutes - a.holdToleranceMinutes);
  }

  return lanes.filter((lane) => lane.lines.length > 0);
}

/** Lay a packed lane out backwards from the landing minute. */
function layOutLane(lane: Lane, landAt: EpochMinute, station: StationCode): ScheduledLine[] {
  const out: ScheduledLine[] = [];
  let cursor = landAt - lane.loadMinutes;
  for (let i = 0; i < lane.lines.length; i++) {
    const line = lane.lines[i]!;
    // Everything queued behind this line is time it spends plated and waiting.
    let wait = 0;
    for (let j = i + 1; j < lane.lines.length; j++) wait += lane.lines[j]!.prepMinutes;
    out.push({
      line,
      station,
      lane: lane.index,
      startAt: cursor,
      endAt: cursor + line.prepMinutes,
      waitMinutes: wait,
    });
    cursor += line.prepMinutes;
  }
  return out;
}

/**
 * The core of the product: given what was ordered, when the guest arrives and
 * how busy the kitchen already is, decide the single minute the kitchen starts.
 *
 * Returns a `held` decision rather than a bad plan when the kitchen cannot take
 * the ticket. Refusing is a feature — a cold хуушуур costs a restaurant.
 */
export function computeFirePlan(input: FirePlanInput): FireDecision {
  const {
    lines,
    kitchen,
    ledger = unlimitedLoad,
    orderId = 'unassigned',
    ttfbBudgetMinutes = DEFAULT_TTFB_BUDGET_MINUTES,
    maxEarlyMinutes = DEFAULT_MAX_EARLY_MINUTES,
  } = input;

  const seatAt = toEpochMinute(input.seatAt);
  const nowMin = toEpochMinute(input.now);
  const readyIdeal = seatAt + kitchen.platingBufferMinutes;

  if (lines.length === 0) {
    return { kind: 'held', reason: 'NO_LINES', seatAt, readyAt: readyIdeal };
  }

  /* 1. Group by station and pack each station's free lanes. */
  const byStation = new Map<StationCode, OrderLine[]>();
  for (const line of lines) {
    const bucket = byStation.get(line.station);
    if (bucket) bucket.push(line);
    else byStation.set(line.station, [line]);
  }

  const packed: PackedStation[] = [];
  for (const [station, stationLines] of byStation) {
    const config = kitchen.stations[station];
    const capacity = config?.parallelLanes ?? 0;
    if (capacity <= 0) {
      return { kind: 'held', reason: 'STATION_SATURATED', station, seatAt, readyAt: readyIdeal };
    }
    packed.push({ station, capacity, lanes: packStation(stationLines, capacity) });
  }

  /* 2. Stations run in parallel, so the ticket takes as long as its longest
   *    lane — never the sum. This is the number people get wrong by hand. */
  let orderPrepMinutes = 0;
  for (const station of packed) {
    for (const lane of station.lanes) {
      if (lane.loadMinutes > orderPrepMinutes) orderPrepMinutes = lane.loadMinutes;
    }
  }

  const fireIdeal = readyIdeal - orderPrepMinutes;

  /* 3. How far may the plan slide? Early is bounded by the least slack any
   *    line has left after its in-lane wait; late is bounded by TTFB. */
  const layoutAt = (shift: number): ScheduledLine[] => {
    const out: ScheduledLine[] = [];
    for (const station of packed) {
      for (const lane of station.lanes) {
        out.push(...layOutLane(lane, readyIdeal + shift, station.station));
      }
    }
    return out;
  };

  const baseline = layoutAt(0);
  let earlySlack = maxEarlyMinutes;
  for (const scheduled of baseline) {
    const slack = scheduled.line.holdToleranceMinutes - scheduled.waitMinutes;
    if (slack < earlySlack) earlySlack = slack;
  }
  const earlyLimit = Math.max(0, earlySlack);

  /* 4. We can never fire into the past. `minShift` is how far the wall clock
   *    forces us forward — negative while there is still time in hand, which
   *    is the normal case and must not be mistaken for lateness. */
  const minShift = nowMin - fireIdeal;
  const lateByMinutes = Math.max(0, minShift);

  const preference: number[] = [];
  for (let s = 0; s >= -earlyLimit; s--) preference.push(s);
  for (let s = 1; s <= ttfbBudgetMinutes; s++) preference.push(s);

  let candidates = preference.filter((s) => s >= minShift);
  if (candidates.length === 0) candidates = [lateByMinutes];

  /* 5. First candidate the kitchen can actually absorb wins. */
  for (const shift of candidates) {
    const scheduled = layoutAt(shift);
    const intervalsByStation = new Map<StationCode, LaneInterval[]>();
    for (const s of scheduled) {
      const list = intervalsByStation.get(s.station);
      const iv: LaneInterval = { from: s.startAt, to: s.endAt };
      if (list) list.push(iv);
      else intervalsByStation.set(s.station, [iv]);
    }

    let roomEverywhere = true;
    for (const station of packed) {
      const intervals = intervalsByStation.get(station.station) ?? [];
      if (!ledger.fits(station.station, intervals, station.capacity)) {
        roomEverywhere = false;
        break;
      }
    }
    if (!roomEverywhere) continue;

    for (const [station, intervals] of intervalsByStation) {
      ledger.occupy(orderId, station, intervals);
    }

    // Sliding early makes every line wait that much longer than in baseline.
    const extraWait = shift < 0 ? -shift : 0;
    const violations: HoldViolation[] = [];
    for (const s of scheduled) {
      const wait = s.waitMinutes + extraWait;
      if (wait > s.line.holdToleranceMinutes) {
        violations.push({
          line: s.line,
          waitMinutes: wait,
          toleranceMinutes: s.line.holdToleranceMinutes,
        });
      }
    }

    const readyAt = readyIdeal + shift;
    return {
      kind: 'plan',
      fireAt: fireIdeal + shift,
      readyAt,
      seatAt,
      orderPrepMinutes,
      shiftMinutes: shift,
      ttfbMinutes: Math.max(0, readyAt - seatAt),
      lateByMinutes,
      lines: scheduled,
      violations,
    };
  }

  return { kind: 'held', reason: 'NO_FEASIBLE_SLOT', seatAt, readyAt: readyIdeal };
}
