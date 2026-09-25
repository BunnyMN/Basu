import { getPool, type Db } from '../db/pool.js';

/**
 * The record of what a person at ops did to a supplier, a listing, an order
 * or a settlement — with the reason they gave. Append-only; nothing here is
 * ever edited, because its only use is being believed later.
 */

export type AuditTarget = 'supplier' | 'listing' | 'order' | 'settlement' | 'guest' | 'member' | 'restaurant' | 'device' | 'menu_item' | 'receipt' | 'ledger' | 'message' | 'setting' | 'org';

export interface AuditEntry {
  id: number;
  who: string;
  action: string;
  targetKind: AuditTarget;
  targetId: string;
  note: string | null;
  at: Date;
}

export async function recordAudit(
  entry: { who: string; action: string; targetKind: AuditTarget; targetId: string; note?: string | null },
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO idesh.audit (who, action, target_kind, target_id, note) VALUES ($1, $2, $3, $4, $5)`,
    [entry.who, entry.action, entry.targetKind, entry.targetId, entry.note?.trim() || null],
  );
}

/** The latest first. `target` narrows it to one thing's history. */
export async function listAudit(
  opts: { limit?: number; target?: { kind: AuditTarget; id: string } } = {},
  db: Db = getPool(),
): Promise<AuditEntry[]> {
  const { rows } = await db.query<{
    id: number;
    who: string;
    action: string;
    target_kind: AuditTarget;
    target_id: string;
    note: string | null;
    created_at: Date;
  }>(
    `SELECT id, who, action, target_kind, target_id, note, created_at
       FROM idesh.audit
      WHERE ($1::text IS NULL OR (target_kind = $1 AND target_id = $2::uuid))
      ORDER BY id DESC LIMIT $3`,
    [opts.target?.kind ?? null, opts.target?.id ?? null, opts.limit ?? 100],
  );
  return rows.map((r) => ({
    id: r.id,
    who: r.who,
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    note: r.note,
    at: r.created_at,
  }));
}
