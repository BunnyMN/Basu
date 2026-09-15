import '../env.js';
import { closePool } from '../db/pool.js';
import { mode } from '../mode.js';
import { buildServer } from '../api/server.js';
import { buildProviders } from './providers.js';

/**
 * The API process. The scheduler runs separately — see src/entry/scheduler.ts
 * and the note there about why its failure is the dangerous one.
 *
 * Providers come from `providers.ts`, the same ones the scheduler gets: APNs
 * when its credentials are in the environment, the fakes for everything that
 * has no adapter yet (QPay, the PosAPI, SMS).
 */
const running = mode();

const ctx = buildProviders((line) => console.log(line.replace('[providers]', '[api]')));

const app = await buildServer(ctx, { logger: false, dev: running === 'demo', trustProxy: running === 'production' });
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
