import '../env.js';
import { closePool } from '../db/pool.js';
import { systemClock } from '../domain/time.js';
import { run } from '../scheduler/runner.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';

/**
 * The scheduler runs as its own process, separate from the API.
 *
 * Not for scale — one instance handles far more than fifteen restaurants — but
 * because its failure is the quiet one. An API outage shows the guest an error;
 * this going down means nothing happens at all and a table sits waiting. It
 * gets its own deploy and its own alert for that reason.
 *
 * The providers below are still the fakes. Swapping in QPay, the PosAPI and an
 * SMS gateway is a change to this file and nothing else.
 */
const ctx: Ctx = {
  clock: systemClock,
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
