import '../env.js';
import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres carries the fire queue as well as the data, so that a state change
 * and the job that acts on it commit together. That is worth one connection
 * pool and no message broker at this size.
 */

// Money is bigint. node-postgres hands back strings for int8 by default, which
// is right for arbitrary bigints — but every amount here fits in a double many
// times over, so parse it and keep call sites free of coercion noise.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set — copy .env.example to .env');
  return url;
}

export function getPool(): pg.Pool {
  pool ??= new Pool({ connectionString: databaseUrl(), max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Run `fn` inside a transaction. The scheduler depends on this being a real
 * BEGIN/COMMIT on a single client — a pooled query per statement would let two
 * workers interleave and the conditional UPDATE would stop protecting anything.
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
