import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line migration 010 drew, kept.
 *
 * Every module owns one Postgres schema and may name tables in that schema and
 * nowhere else. This is the whole enforcement — a grep with an opinion — and it
 * is enough, because the failure it prevents is not subtle: someone in a hurry
 * writes `JOIN identity.guest` from inside dine, it works, and eighteen months
 * later identity cannot be moved into its own service without finding every
 * join anyone ever wrote.
 *
 * When this test fails the fix is never to widen the list. It is to ask the
 * other module for what you need, through its `index.ts`.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = ['identity', 'ledger', 'notify', 'idesh', 'dine'] as const;

/**
 * Fixtures and harnesses are exempt, and named one by one so that the
 * exemption stays a decision rather than a habit. These build and tear down
 * whole databases; pretending they are a module would only mean lying to this
 * test about which one.
 */
const EXEMPT = ['test/', 'seed/', 'sim/', 'db/migrate.ts'];

/** Tables that used to live in public and would silently resolve to nothing. */
const MOVED = [
  'guest', 'otp_challenge', 'guest_session', 'payment', 'ebarimt_receipt',
  'notification', 'restaurant', 'station', 'station_reservation', 'menu_item',
  'slot', 'dining_table', 'trust_profile', 'dining_order', 'order_line',
  'table_hold', 'arrival_signal', 'fire_job', 'order_event', 'order_review',
  'dish_review', 'kds_device',
];

function sources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) out.push(path);
    }
  })(SRC);
  return out;
}

/** Comments talk about other modules all the time. Only code counts. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function owner(file: string): (typeof SCHEMAS)[number] | null {
  for (const schema of SCHEMAS) {
    if (file.startsWith(`platform/${schema}/`)) return schema;
  }
  // The second vertical, beside dine rather than under platform: it owns
  // tables the way dine does, and nothing about lunch.
  if (file.startsWith('idesh/')) return 'idesh';
  return 'dine';
}

describe('module boundaries', () => {
  const files = sources()
    .map((path) => ({ path, rel: relative(SRC, path) }))
    .filter(({ rel }) => !EXEMPT.some((prefix) => rel.startsWith(prefix)));

  it('no module names another module’s tables', () => {
    const trespasses: string[] = [];

    for (const { path, rel } of files) {
      const mine = owner(rel);
      if (!mine) continue;
      const body = code(readFileSync(path, 'utf8'));
      const seen = new Set<string>();
      // Only where SQL can name a table. `ledger.occupy(...)` in the station
      // load code is a local variable, and `guest.notify.cooking` is an outbox
      // topic — neither is a query, and neither is a trespass.
      const sql = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE)\s+(identity|ledger|notify|idesh|dine)\.([a-z_]+)/g;
      for (const match of body.matchAll(sql)) {
        const [, schema, table] = match;
        if (schema !== mine) seen.add(`${schema}.${table}`);
      }
      for (const ref of seen) trespasses.push(`${rel} (owned by ${mine}) → ${ref}`);
    }

    expect(trespasses).toEqual([]);
  });

  it('no query names a table without its schema', () => {
    const bare: string[] = [];
    const pattern = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${MOVED.join('|')})\\b`, 'g');

    for (const { path, rel } of files) {
      const body = code(readFileSync(path, 'utf8'));
      for (const match of body.matchAll(pattern)) bare.push(`${rel}: ${match[0]}`);
    }

    // `search_path` is pinned to public, so these would fail at runtime rather
    // than read the wrong rows — but failing in CI beats failing at lunchtime.
    expect(bare).toEqual([]);
  });

  it('every platform module has one front door', () => {
    for (const schema of ['identity', 'ledger', 'notify']) {
      const index = join(SRC, 'platform', schema, 'index.ts');
      expect(statSync(index).isFile(), `platform/${schema}/index.ts`).toBe(true);
    }
    expect(statSync(join(SRC, 'idesh', 'index.ts')).isFile(), 'idesh/index.ts').toBe(true);
  });

  it('nothing imports past a platform module’s index', () => {
    const reachAround: string[] = [];
    for (const { path, rel } of files) {
      if (rel.startsWith('platform/')) continue;
      const body = readFileSync(path, 'utf8');
      for (const match of body.matchAll(/from '[^']*platform\/(\w+)\/([\w.]+)'/g)) {
        if (match[2] !== 'index.js') reachAround.push(`${rel} → platform/${match[1]}/${match[2]}`);
      }
    }
    expect(reachAround).toEqual([]);
  });

  it('nothing outside idesh imports past its index either', () => {
    // A vertical is held to the platform's rule. The day it is split out, the
    // index is the wire and everything else is somebody else's process.
    const reachAround: string[] = [];
    for (const { path, rel } of files) {
      if (rel.startsWith('idesh/')) continue;
      const body = readFileSync(path, 'utf8');
      for (const match of body.matchAll(/from '[^']*\/idesh\/([\w.]+)'/g)) {
        if (match[1] !== 'index.js') reachAround.push(`${rel} → idesh/${match[1]}`);
      }
    }
    expect(reachAround).toEqual([]);
  });
});
