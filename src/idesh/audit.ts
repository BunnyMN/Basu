import { getPool, type Db } from '../db/pool.js';

/**
 * The record of what a person at ops did to a supplier, a listing, an order
 * or a settlement — with the reason they gave. Append-only; nothing here is
 * ever edited, because its only use is being believed later.
 */

export type AuditTarget = 'supplier' | 'listing' | 'order' | 'settlement' | 'guest' | 'member' | 'restaurant' | 'device' | 'menu_item' | 'receipt' | 'ledger' | 'message' | 'setting' | 'org' | 'role' | 'menu' | 'promotion' | 'certificate';

/**
 * Who acted, beyond the name `who` writes: the account, the session it came
 * in on — its id, never its token — and the seat it sat in. A name is not
 * unique, and a browser left signed in acts in its owner's; these are what
 * tell such actions apart. All three null for the demo's shared secret,
 * which is nobody's account, and for the lines written before they were.
 */
export interface AuditActor {
  account: string | null;
  session: string | null;
  member: string | null;
}

export interface AuditEntry {
  id: number;
  who: string;
  by: AuditActor;
  action: string;
  targetKind: AuditTarget;
  targetId: string;
  note: string | null;
  at: Date;
}

/** What was done, to what, with the reason given: a line, before who did it is written on. */
export interface AuditLine {
  action: string;
  targetKind: AuditTarget;
  targetId: string;
  note?: string | null;
}

export async function recordAudit(entry: AuditLine & { who: string; by: AuditActor }, db: Db = getPool()): Promise<void> {
  await db.query(
    `INSERT INTO idesh.audit (who, actor_guest, actor_session, actor_member, action, target_kind, target_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.who, entry.by.account, entry.by.session, entry.by.member, entry.action, entry.targetKind, entry.targetId, entry.note?.trim() || null],
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
    actor_guest: string | null;
    actor_session: string | null;
    actor_member: string | null;
    action: string;
    target_kind: AuditTarget;
    target_id: string;
    note: string | null;
    created_at: Date;
  }>(
    `SELECT id, who, actor_guest, actor_session, actor_member, action, target_kind, target_id, note, created_at
       FROM idesh.audit
      WHERE ($1::text IS NULL OR (target_kind = $1 AND target_id = $2::uuid))
      ORDER BY id DESC LIMIT $3`,
    [opts.target?.kind ?? null, opts.target?.id ?? null, opts.limit ?? 100],
  );
  return rows.map((r) => ({
    id: r.id,
    who: r.who,
    by: { account: r.actor_guest, session: r.actor_session, member: r.actor_member },
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    note: r.note,
    at: r.created_at,
  }));
}
