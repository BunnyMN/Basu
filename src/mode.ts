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
 *
 * The demo is more than a clock: it mounts `/dev`, which signs anybody in as
 * anybody and hands out the desk's admin secret. So it is never a fallback.
 * A mode is read in any case and without the blanks around it; only `demo`
 * is the demo; and a value that is neither is refused rather than guessed —
 * `production ` with a space, or `Production`, used to fall through to the
 * demo on any server that had not also set NODE_ENV.
 */
export type Mode = 'demo' | 'production';

export function mode(): Mode {
  const raw = process.env['BASU_MODE'];
  const named = raw?.trim().toLowerCase();
  if (named === 'demo' || named === 'production') return named;
  if (named) {
    throw new Error(`BASU_MODE is ${JSON.stringify(raw)}, which is neither demo nor production — refusing to guess`);
  }
  // Unset means a developer running locally, where the demo clock is the point.
  return process.env['NODE_ENV']?.trim().toLowerCase() === 'production' ? 'production' : 'demo';
}

/**
 * The mode a process starts in — or no start at all. A value that names
 * neither mode stops the process here, before it listens or ticks, with the
 * reason on one line of its log.
 */
export function modeOrExit(name: string): Mode {
  try {
    return mode();
  } catch (error) {
    console.error(`[${name}] ${(error as Error).message}`);
    process.exit(1);
  }
}

export function buildClock(): Clock {
  if (mode() === 'production') return systemClock;
  const clock = new DemoClock();
  clock.setTo(DEMO_START);
  return clock;
}
