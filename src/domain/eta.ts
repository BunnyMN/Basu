import { addMinutes, diffMinutes } from './time.js';
import type { FireMode, TrustTier } from './types.js';

/**
 * Four signals, none of them trustworthy alone (Гал тавих мөч §09).
 *
 * The rule the whole module exists to enforce: a recent thing the guest did on
 * purpose always beats a passive sensor. Geofence is a hint, a tap is evidence.
 */
export type SignalType =
  | 'slot'
  | 'on_my_way'
  | 'delay_10'
  | 'geofence_800'
  | 'geofence_300'
  | 'app_open'
  | 'checkin';

export interface ArrivalSignal {
  type: SignalType;
  at: Date;
}

interface SignalSpec {
  confidence: number;
  /** How long the signal still says something true. */
  ttlMinutes: number;
}

const SPEC: Record<SignalType, SignalSpec> = {
  slot: { confidence: 0.55, ttlMinutes: Number.POSITIVE_INFINITY },
  on_my_way: { confidence: 0.9, ttlMinutes: 20 },
  delay_10: { confidence: 0.9, ttlMinutes: 20 },
  geofence_800: { confidence: 0.75, ttlMinutes: 12 },
  geofence_300: { confidence: 0.88, ttlMinutes: 6 },
  app_open: { confidence: 0, ttlMinutes: 5 },
  checkin: { confidence: 1, ttlMinutes: Number.POSITIVE_INFINITY },
};

/** Two high-confidence signals this far apart mean we do not really know. */
const DISAGREEMENT_MINUTES = 5;
const DISAGREEMENT_PENALTY = 0.25;
const APP_OPEN_BONUS = 0.05;

/** The guest cannot be seated before the table is held, or endlessly after. */
const EARLIEST_BEFORE_SLOT = 3;
const LATEST_AFTER_SLOT = 25;

export interface EtaInput {
  signals: ArrivalSignal[];
  slotStartsAt: Date;
  now: Date;
  /** Walking minutes from the tower to this restaurant — set per venue. */
  travelMinutes: number;
}

export interface EtaPrediction {
  seatAt: Date;
  confidence: number;
  /** Which signal the prediction is actually resting on. */
  basis: SignalType;
  seated: boolean;
}

/**
 * Fold the signals in time order, then take the most confident one that has
 * not expired. Folding first matters only for `delay_10`, which is relative:
 * two taps of "10 more minutes" have to mean twenty.
 */
export function predictSeatTime(input: EtaInput): EtaPrediction {
  const { slotStartsAt, now, travelMinutes } = input;
  const ordered = [...input.signals].sort((a, b) => a.at.getTime() - b.at.getTime());

  let running = slotStartsAt;
  const resolved: Array<{ signal: ArrivalSignal; eta: Date }> = [
    { signal: { type: 'slot', at: slotStartsAt }, eta: slotStartsAt },
  ];

  for (const signal of ordered) {
    let eta: Date;
    switch (signal.type) {
      case 'slot':
        continue; // already seeded
      case 'on_my_way':
        eta = addMinutes(signal.at, travelMinutes);
        break;
      case 'geofence_800':
        eta = addMinutes(signal.at, 8);
        break;
      case 'geofence_300':
        eta = addMinutes(signal.at, 3);
        break;
      case 'delay_10':
        eta = addMinutes(signal.at > running ? signal.at : running, 10);
        break;
      case 'checkin':
        eta = signal.at;
        break;
      case 'app_open':
        continue; // never moves the estimate, only the confidence
    }
    running = eta;
    resolved.push({ signal, eta });
  }

  const checkedIn = ordered.find((s) => s.type === 'checkin');
  if (checkedIn) {
    return { seatAt: checkedIn.at, confidence: 1, basis: 'checkin', seated: true };
  }

  const active = resolved.filter(({ signal }) => {
    const { ttlMinutes } = SPEC[signal.type];
    return diffMinutes(now, signal.at) <= ttlMinutes;
  });

  // Most confident wins; the newest breaks a tie.
  let best = active[0]!;
  for (const candidate of active) {
    const a = SPEC[candidate.signal.type].confidence;
    const b = SPEC[best.signal.type].confidence;
    if (a > b || (a === b && candidate.signal.at > best.signal.at)) best = candidate;
  }

  let confidence = SPEC[best.signal.type].confidence;

  // If another signal we would also have believed disagrees, say so by
  // dropping confidence rather than by silently picking one of them.
  const rivals = active.filter(
    ({ signal, eta }) =>
      signal !== best.signal &&
      SPEC[signal.type].confidence >= 0.75 &&
      Math.abs(diffMinutes(eta, best.eta)) > DISAGREEMENT_MINUTES,
  );
  if (rivals.length > 0) confidence -= DISAGREEMENT_PENALTY;

  const appOpen = ordered.some(
    (s) => s.type === 'app_open' && diffMinutes(now, s.at) <= SPEC.app_open.ttlMinutes,
  );
  if (appOpen) confidence += APP_OPEN_BONUS;

  confidence = Math.min(1, Math.max(0, confidence));

  const floor = addMinutes(slotStartsAt, -EARLIEST_BEFORE_SLOT);
  const ceiling = addMinutes(slotStartsAt, LATEST_AFTER_SLOT);
  const clamped = best.eta < floor ? floor : best.eta > ceiling ? ceiling : best.eta;

  return { seatAt: clamped, confidence, basis: best.signal.type, seated: false };
}

/**
 * Both gates have to open. A trusted regular still gets asked when we cannot
 * tell where they are, and a perfect ETA does not buy a brand new guest an
 * automatic fire.
 */
export function decideFireMode(confidence: number, tier: TrustTier): FireMode {
  if (tier === 'BLOCKED') return 'MANUAL';
  if (confidence < 0.6) return 'MANUAL';
  if (tier === 'AUTO' && confidence >= 0.85) return 'AUTO';
  return 'CONFIRM';
}

/** True when the change is worth waking the kitchen for (§09: 5-minute rule). */
export function shouldReplan(currentSeatAt: Date, nextSeatAt: Date): boolean {
  return Math.abs(diffMinutes(nextSeatAt, currentSeatAt)) >= 5;
}
