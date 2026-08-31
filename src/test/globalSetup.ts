/**
 * Rebuild the test schema once per run, before any worker starts. Migrations
 * are cheap and a from-scratch schema is the only way a failing test tells you
 * about your code rather than about yesterday's leftovers.
 */
export async function setup(): Promise<void> {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/basu_test';

  const { migrate, reset } = await import('../db/migrate.js');
  const { closePool } = await import('../db/pool.js');
  await reset();
  await migrate();
  await closePool();
}
