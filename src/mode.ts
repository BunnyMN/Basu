import './env.js';
import { systemClock, type Clock } from './domain/time.js';
import { DEMO_START, DemoClock } from './demoClock.js';

/**
 * Which clock this deployment runs on — decided once, read by every entry point.
 *
 * The two processes must agree. They very nearly did not: the API defaulted to
 * a demo clock while the scheduler always took the system one, so on a server
 * they held different times, and the scheduler fired an 11:40 lunch at 14:13
 * and then wrote the guests off as no-shows. Nothing complained, because
 * neither process could see the other's clock.
 */
export type Mode = 'demo' | 'production';

export function mode(): Mode {
  const raw = process.env['BASU_MODE'];
  if (raw === 'demo' || raw === 'production') return raw;
  // Unset means a developer running locally, where the demo clock is the point.
  return process.env['NODE_ENV'] === 'production' ? 'production' : 'demo';
}

export function buildClock(): Clock {
  if (mode() === 'production') return systemClock;
  const clock = new DemoClock();
  clock.setTo(DEMO_START);
  return clock;
}
