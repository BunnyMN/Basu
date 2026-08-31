import '../env.js';
import { closePool } from '../db/pool.js';
import { systemClock } from '../domain/time.js';
import { DEMO_START, DemoClock } from '../demoClock.js';
import { buildServer } from '../api/server.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';

/**
 * The API process. The scheduler runs separately — see src/entry/scheduler.ts
 * and the note there about why its failure is the dangerous one.
 *
 * Providers are still the fakes; swapping in QPay, the PosAPI and an SMS
 * gateway is a change to this file and the implementations in `src/ports.ts`,
 * nothing deeper.
 */
const dev = process.env['NODE_ENV'] !== 'production';

const ctx: Ctx = {
  // In development the clock is a control, so a whole lunch service can be
  // walked through at four in the afternoon. Production gets the real one.
  clock: dev ? new DemoClock() : systemClock,
  payments: new FakePaymentProvider(),
  tax: new FakeTaxProvider(),
  notifier: new FakeNotifier(),
};

if (dev && ctx.clock instanceof DemoClock) ctx.clock.setTo(DEMO_START);

const app = await buildServer(ctx, { logger: false, dev });
const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

console.log(`  Зочин   http://localhost:${port}/`);
console.log(`  Тогооч  http://localhost:${port}/kds`);
if (dev) console.log(`  Демо цаг удирдах боломжтой — хуудасны дээд талд.`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(closePool).then(() => process.exit(0));
  });
}
