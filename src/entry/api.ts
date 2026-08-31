import '../env.js';
import { closePool } from '../db/pool.js';
import { buildClock, mode } from '../mode.js';
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
const running = mode();

const ctx: Ctx = {
  clock: buildClock(),
  payments: new FakePaymentProvider(),
  tax: new FakeTaxProvider(),
  notifier: new FakeNotifier(),
};

const app = await buildServer(ctx, { logger: false, dev: running === 'demo' });
const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

console.log(`[api] ${running} mode on :${port}`);
if (running === 'demo') {
  console.log('[api] clock is a control; the scheduler runs from POST /dev/tick');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(closePool).then(() => process.exit(0));
  });
}
