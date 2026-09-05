import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Deliberately plain: numbered .sql files, applied once, recorded in a table.
 * Migrations run forward only and each one is expand-only — dropping a column
 * is its own later release, so a rollback never needs to invent data.
 */
export async function migrate(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map(
      (r) => r.name,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return ran;
}

/** Drop everything and rebuild. Development and tests only. */
export async function reset(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('refusing to reset the schema in production');
  }
  await getPool().query(`
    DROP SCHEMA IF EXISTS idesh, dine, notify, ledger, identity CASCADE;
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
  `);
}

/** True when this file was run directly — same answer as .ts or compiled .js. */
const isEntrypoint = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const stem = (s: string) => s.split('/').pop()!.replace(/\.[cm]?[jt]s$/, '');
  return stem(import.meta.url) === stem(invoked);
})();

if (isEntrypoint) {
  const wantsReset = process.argv.includes('--reset');
  try {
    if (wantsReset) {
      await reset();
      console.log('schema dropped');
    }
    const ran = await migrate();
    console.log(ran.length ? `applied: ${ran.join(', ')}` : 'already up to date');
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
