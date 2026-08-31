import '../env.js';
import { closePool } from '../db/pool.js';
import { buildClock, mode } from '../mode.js';
import { run } from '../scheduler/runner.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';

/**
 * The scheduler runs as its own process, separate from the API.
 *
 * Not for scale — one instance handles far more than fifteen restaurants — but
 * because its failure is the quiet one. An API outage shows the guest an error;
 * this going down means nothing happens at all and a table sits waiting. It
 * gets its own deploy and its own alert for that reason.
 */
if (mode() === 'demo') {
  // Two processes cannot each hold their own demo clock: they drift apart, and
  // this one would fire a lunch hours early and then call the guests no-shows.
  // In demo mode ticks come from the API, on the clock the page is driving.
  console.error('[scheduler] demo mode — ticks come from POST /dev/tick, not from here.');
  console.error('[scheduler] set BASU_MODE=production to run on the system clock.');
  process.exit(0);
}

const ctx: Ctx = {
  clock: buildClock(),
  payments: new FakePaymentProvider(),
  tax: new FakeTaxProvider(),
  notifier: new FakeNotifier(),
};

const intervalMs = Number(process.env['SCHEDULER_TICK_MS'] ?? 1000);
const stop = await run(ctx, intervalMs);
console.log(`[scheduler] running, tick ${intervalMs}ms`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[scheduler] ${signal}, draining`);
    stop();
    void closePool().then(() => process.exit(0));
  });
}
