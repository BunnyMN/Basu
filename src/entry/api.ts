import '../env.js';
import { closePool } from '../db/pool.js';
import { modeOrExit } from '../mode.js';
import { buildServer } from '../api/server.js';
import { buildProviders } from './providers.js';
import { syncMembersFromEnv } from '../ops/index.js';

/**
 * The API process. The scheduler runs separately — see src/entry/scheduler.ts
 * and the note there about why its failure is the dangerous one.
 *
 * Providers come from `providers.ts`, the same ones the scheduler gets: APNs
 * when its credentials are in the environment, the fakes for everything that
 * has no adapter yet (QPay, the PosAPI, SMS).
 */
const running = modeOrExit('api');

const ctx = buildProviders((line) => console.log(line.replace('[providers]', '[api]')));

// The desk's first members, from the environment. A list that cannot be
// read keeps no server down: it says so — never what the list held, boot
// logs are public — and the desk keeps the members it already has.
try {
  const made = await syncMembersFromEnv(process.env['OPS_MEMBERS'], (line) => console.log(`[api] ${line}`));
  if (made) console.log(`[api] OPS_MEMBERS: ${made} new desk member(s)`);
} catch (error) {
  console.log(`[api] OPS_MEMBERS was not applied (${(error as { code?: string }).code ?? (error as Error).name}); the desk keeps the members it has`);
}
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
