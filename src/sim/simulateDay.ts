import { computeFirePlan } from '../domain/firePlan.js';
import { decideFireMode, predictSeatTime, shouldReplan, type ArrivalSignal } from '../domain/eta.js';
import { InMemoryStationLoad } from '../domain/load.js';
import { assertTransition } from '../domain/states.js';
import { PILOT_KITCHEN, PILOT_MENU, at, line } from '../domain/fixtures.js';
import { VirtualClock, addMinutes, diffMinutes, hhmm, toEpochMinute } from '../domain/time.js';
import type { FireMode, FirePlan, OrderLine, OrderState, TrustTier } from '../domain/types.js';
import { Rng } from './rng.js';

/**
 * A whole lunch service, minute by minute, with no database and no network.
 *
 * This is the harness the technical spec calls the most valuable test we have:
 * the fire engine only misbehaves under load and drift, and neither shows up in
 * a unit test. Three hours of service replay in a few milliseconds, so it can
 * run on every commit and still be the thing that catches the real bugs.
 */

export interface SimConfig {
  seed: number;
  restaurants: number;
  ordersPerRestaurant: number;
  /** `bunched` puts 70% of arrivals in the 12:00–12:30 crush, which is real. */
  arrivalSpread: 'bunched' | 'even';
  noShowRate: number;
  /** Share of guests who turn up meaningfully after the slot they booked. */
  lateRate: number;
  /** Share of guests who emit no arrival signal at all — no push, no tap. */
  signalDropRate: number;
  /** Cap per 15-minute slot, per restaurant (see §07 of the product spec). */
  maxOrdersPerSlot: number;
  day: string;
}

export const DEFAULT_SIM: SimConfig = {
  seed: 20260902,
  restaurants: 15,
  ordersPerRestaurant: 40,
  arrivalSpread: 'bunched',
  noShowRate: 0.05,
  lateRate: 0.18,
  signalDropRate: 0.3,
  maxOrdersPerSlot: 3,
  day: '2026-09-02',
};

const SERVICE_SLOTS = [
  '11:30', '11:45', '12:00', '12:15', '12:30',
  '12:45', '13:00', '13:15', '13:30', '13:45',
] as const;

const CRUSH = new Set(['12:00', '12:15', '12:30']);

const MENU_IDS = Object.keys(PILOT_MENU) as Array<keyof typeof PILOT_MENU>;

/**
 * What a Ulaanbaatar lunch board actually sells: soup and цуйван carry the
 * day, steak is an outlier. Sampling the menu uniformly made the grill 43% of
 * all lines, which is not a kitchen anyone runs.
 */
const MENU_WEIGHTS: Record<string, number> = {
  soup_guril: 18,
  soup_bansh: 16,
  salad: 12,
  tsuivan: 24,
  khuushuur: 16,
  fries: 10,
  steak: 4,
};

interface SimRestaurant {
  id: string;
  ledger: InMemoryStationLoad;
  travelMinutes: number;
  slotTaken: Map<string, number>;
}

export interface SimOrder {
  id: string;
  restaurantId: string;
  lines: OrderLine[];
  slotStartsAt: Date;
  /** null means the guest never turns up. */
  trueArrivalAt: Date | null;
  tier: TrustTier;
  emitsSignals: boolean;

  state: OrderState;
  signals: ArrivalSignal[];
  plan?: FirePlan;
  mode: FireMode;
  confidence: number;

  armedAt?: Date;
  /** Will this guest answer the T−15 message at all? */
  answersArm: boolean;
  armReplyDelay: number;
  armReplied: boolean;
  firedAt?: Date;
  firedBy?: 'auto' | 'confirm' | 'manual' | 'rescue';
  fireCount: number;
  readyAt?: Date;
  seatedAt?: Date;
  replans: number;
  heldMinutes: number;
  ledgerHeld: boolean;
}

export interface SimResult {
  config: SimConfig;
  orders: SimOrder[];
  /** Every FIRED transition, for the exactly-once invariant. */
  fireLog: Array<{ orderId: string; at: Date; by: string }>;
  /** station load samples that exceeded capacity — must stay empty. */
  overloads: Array<{ restaurantId: string; station: string; minute: number; used: number }>;
  illegalTransitions: string[];
}

function slotWeightsFor(spread: SimConfig['arrivalSpread']): number[] {
  return SERVICE_SLOTS.map((s) => (spread === 'bunched' && CRUSH.has(s) ? 7 : 1));
}

function buildOrderLines(rng: Rng): OrderLine[] {
  const count = rng.weighted([1, 2, 3], [42, 43, 15]);
  const weights = MENU_IDS.map((id) => MENU_WEIGHTS[id] ?? 1);
  const chosen = new Set<keyof typeof PILOT_MENU>();
  let guard = 0;
  while (chosen.size < count && guard++ < 40) chosen.add(rng.weighted(MENU_IDS, weights));
  return [...chosen].map((id) => line(id, rng.int(1, 3)));
}

export function simulateDay(overrides: Partial<SimConfig> = {}): SimResult {
  const config = { ...DEFAULT_SIM, ...overrides };
  const rng = new Rng(config.seed);
  const clock = new VirtualClock(at('11:00', config.day));

  const restaurants: SimRestaurant[] = Array.from({ length: config.restaurants }, (_, i) => ({
    id: `r${i + 1}`,
    ledger: new InMemoryStationLoad(),
    travelMinutes: rng.int(4, 10),
    slotTaken: new Map(),
  }));

  const orders: SimOrder[] = [];
  const fireLog: SimResult['fireLog'] = [];
  const overloads: SimResult['overloads'] = [];
  const illegalTransitions: string[] = [];
  const weights = slotWeightsFor(config.arrivalSpread);

  /* ── booking, all of it before service opens ─────────────────────── */
  for (const restaurant of restaurants) {
    for (let n = 0; n < config.ordersPerRestaurant; n++) {
      // Respect the slot cap the way the booking API does: walk forward until
      // something has room, and drop the order if the whole day is full.
      const first = SERVICE_SLOTS.indexOf(rng.weighted(SERVICE_SLOTS, weights));
      let slotLabel: string | undefined;
      for (let step = 0; step < SERVICE_SLOTS.length; step++) {
        const candidate = SERVICE_SLOTS[(first + step) % SERVICE_SLOTS.length]!;
        if ((restaurant.slotTaken.get(candidate) ?? 0) < config.maxOrdersPerSlot) {
          slotLabel = candidate;
          break;
        }
      }
      if (!slotLabel) continue;
      restaurant.slotTaken.set(slotLabel, (restaurant.slotTaken.get(slotLabel) ?? 0) + 1);

      const slotStartsAt = at(slotLabel, config.day);
      const noShow = rng.chance(config.noShowRate);
      const late = !noShow && rng.chance(config.lateRate);
      // The slot is a capacity bucket, but the guest picked a time and means
      // it. Spreading them across the window was a modelling error: it made the
      // food look chronically early when the real problem is that four people
      // all chose 12:00.
      const trueArrivalAt = noShow
        ? null
        : addMinutes(slotStartsAt, late ? rng.int(5, 25) : rng.int(-3, 3));

      orders.push({
        id: `${restaurant.id}-o${n + 1}`,
        restaurantId: restaurant.id,
        lines: buildOrderLines(rng),
        slotStartsAt,
        trueArrivalAt,
        tier: rng.weighted<TrustTier>(['AUTO', 'NEW', 'CONFIRM'], [60, 32, 8]),
        emitsSignals: !rng.chance(config.signalDropRate),
        // Of the guests reachable at all, most answer «Та замд гарсан уу?».
        answersArm: rng.chance(0.78),
        armReplyDelay: rng.int(0, 3),
        armReplied: false,
        state: 'SCHEDULED',
        signals: [],
        mode: 'CONFIRM',
        confidence: 0.55,
        fireCount: 0,
        replans: 0,
        heldMinutes: 0,
        ledgerHeld: false,
      });
    }
  }

  const byId = new Map(restaurants.map((r) => [r.id, r]));

  /** Returns false when the transition was rejected, so callers can stop. */
  const move = (order: SimOrder, next: OrderState): boolean => {
    try {
      assertTransition(order.state, next);
    } catch (error) {
      illegalTransitions.push(`${order.id}: ${(error as Error).message}`);
      return false;
    }
    order.state = next;
    return true;
  };

  /**
   * Re-reading the signals costs nothing, so the fire mode is refreshed every
   * minute. Only the plan — which reserves kitchen lanes — waits for a
   * meaningful ETA move. Tying the two together was a bug: a guest could tap
   * «Хөдөллөө», gain us all the confidence in the world, and still be stuck in
   * manual because their ETA had not shifted five minutes.
   */
  const refreshMode = (order: SimOrder, now: Date) => {
    const restaurant = byId.get(order.restaurantId)!;
    const prediction = predictSeatTime({
      signals: order.signals,
      slotStartsAt: order.slotStartsAt,
      now,
      travelMinutes: restaurant.travelMinutes,
    });
    order.confidence = prediction.confidence;
    order.mode = decideFireMode(prediction.confidence, order.tier);
    return prediction;
  };

  const replan = (order: SimOrder, now: Date): void => {
    const restaurant = byId.get(order.restaurantId)!;
    if (order.ledgerHeld) {
      restaurant.ledger.release(order.id);
      order.ledgerHeld = false;
    }

    const prediction = refreshMode(order, now);

    const decision = computeFirePlan({
      lines: order.lines,
      seatAt: prediction.seatAt,
      now,
      kitchen: PILOT_KITCHEN,
      ledger: restaurant.ledger,
      orderId: order.id,
    });

    if (decision.kind === 'plan') {
      order.plan = decision;
      order.ledgerHeld = true;
      // A HELD ticket that finds room again simply becomes fireable from HELD;
      // there is no need to walk it back through SCHEDULED.
    } else {
      delete order.plan;
      order.heldMinutes++;
      if (order.state === 'SCHEDULED' || order.state === 'ARMED') move(order, 'HELD');
    }
    order.replans++;
  };

  /* ── the service, one minute at a time ───────────────────────────── */
  const endOfService = at('14:45', config.day);

  while (clock.now() <= endOfService) {
    const now = clock.now();
    const nowMin = toEpochMinute(now);

    for (const order of orders) {
      const restaurant = byId.get(order.restaurantId)!;

      /* the reply to «Та замд гарсан уу?» — the signal the fire decision is
         actually built on, and the reason arming exists at all */
      if (
        order.armedAt &&
        !order.armReplied &&
        order.emitsSignals &&
        order.answersArm &&
        order.trueArrivalAt &&
        diffMinutes(now, order.armedAt) >= order.armReplyDelay
      ) {
        order.armReplied = true;
        const minutesLate = diffMinutes(order.trueArrivalAt, order.slotStartsAt);
        order.signals.push({ type: minutesLate > 6 ? 'delay_10' : 'on_my_way', at: now });
      }

      /* signals the guest emits on their way in */
      if (order.emitsSignals && order.trueArrivalAt) {
        const minutesOut = diffMinutes(order.trueArrivalAt, now);
        const emit = (type: ArrivalSignal['type']) => {
          if (!order.signals.some((s) => s.type === type)) {
            order.signals.push({ type, at: now });
          }
        };
        if (Math.round(minutesOut) === restaurant.travelMinutes) emit('on_my_way');
        if (Math.round(minutesOut) === 8) emit('geofence_800');
        if (Math.round(minutesOut) === 3) emit('geofence_300');
      }

      switch (order.state) {
        case 'SCHEDULED': {
          if (!order.plan) replan(order, now);
          // T−15: ask the guest where they are. A ticket the kitchen just put
          // on hold is no longer SCHEDULED, so it is not armed either.
          if (
            order.state === 'SCHEDULED' &&
            !order.armedAt &&
            diffMinutes(order.slotStartsAt, now) <= 15
          ) {
            order.armedAt = now;
            move(order, 'ARMED');
          }
          break;
        }

        case 'ARMED':
        case 'HELD': {
          if (!order.plan) {
            replan(order, now);
          } else {
            const prediction = refreshMode(order, now);
            const plannedSeat = new Date(order.plan.seatAt * 60_000);
            if (shouldReplan(plannedSeat, prediction.seatAt)) replan(order, now);
          }

          const plan = order.plan;
          if (!plan) {
            // Still no room. Once the guest is half an hour past their slot and
            // has not appeared, stop holding the kitchen for them.
            if (!order.seatedAt && diffMinutes(now, order.slotStartsAt) > 30) {
              move(order, 'NO_SHOW');
            }
            break;
          }

          const due = nowMin >= plan.fireAt;
          if (!due) break;

          // AUTO fires itself. CONFIRM needs the guest to have said something
          // since we armed. MANUAL is the chef, who is human about the minute.
          const guestAcked = order.signals.some(
            (s) => order.armedAt !== undefined && s.at >= order.armedAt,
          );
          const chefOffset = order.id.length % 3; // stable per order, 0..2
          let fire: SimOrder['firedBy'] | undefined;
          if (order.mode === 'AUTO') fire = 'auto';
          else if (order.mode === 'CONFIRM' && guestAcked) fire = 'confirm';
          else if (nowMin >= plan.fireAt + chefOffset) fire = 'manual';
          // The guest is already sitting with no food. Counted separately: this
          // is not the chef exercising judgement, it is the system having missed.
          if (order.seatedAt) fire = 'rescue';

          if (fire && move(order, 'FIRED')) {
            order.firedAt = now;
            order.firedBy = fire;
            order.fireCount++;
            fireLog.push({ orderId: order.id, at: now, by: fire });
            move(order, 'COOKING');
          }
          break;
        }

        case 'COOKING': {
          const plan = order.plan!;
          if (nowMin >= toEpochMinute(order.firedAt!) + plan.orderPrepMinutes) {
            move(order, 'READY');
            order.readyAt = now;
            restaurant.ledger.release(order.id);
            order.ledgerHeld = false;
          }
          break;
        }

        case 'READY': {
          if (order.seatedAt) move(order, 'SERVED');
          else if (diffMinutes(now, order.slotStartsAt) > 30) move(order, 'NO_SHOW');
          break;
        }

        default:
          break;
      }

      /* the guest actually walking in is independent of all of the above */
      if (
        !order.seatedAt &&
        order.trueArrivalAt &&
        now >= order.trueArrivalAt &&
        order.state !== 'NO_SHOW'
      ) {
        order.seatedAt = now;
        order.signals.push({ type: 'checkin', at: now });
      }
    }

    /* capacity invariant, sampled every minute against every station */
    for (const restaurant of restaurants) {
      for (const station of Object.values(PILOT_KITCHEN.stations)) {
        const used = restaurant.ledger.occupancy(station.code, nowMin);
        if (used > station.parallelLanes) {
          overloads.push({
            restaurantId: restaurant.id,
            station: station.code,
            minute: nowMin,
            used,
          });
        }
      }
    }

    clock.advanceMinutes(1);
  }

  return { config, orders, fireLog, overloads, illegalTransitions };
}

/** Human-readable clock for report lines. */
export const fmt = hhmm;
