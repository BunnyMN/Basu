import { getPool, tx, type Db } from '../db/pool.js';
import { displayNamesFor } from '../platform/identity/index.js';
import { accrue, payOut } from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';
import { mode } from '../mode.js';
import { seal, unseal } from '../secret.js';

/**
 * Money the house owes outside, per order, and the list ops works through.
 *
 * A settlement is opened the moment the debt exists — the supplier's share
 * when an order closes, the guest's refund and the supplier's forfeit when
 * one is cancelled — and the ledger sets the amount aside at the same time.
 * Paying it is a person's act: a bank transfer made by hand, then «Шилжүүлсэн»
 * pressed with the bank's reference. When a bank API arrives, only the hand
 * changes.
 */

export type SettlementKind = 'payout' | 'refund';
export type SettlementState = 'needs_account' | 'due' | 'paid';

export interface BankAccount {
  bankName: string;
  bankAccount: string;
  bankHolder: string;
}

export interface Settlement {
  id: string;
  kind: SettlementKind;
  state: SettlementState;
  memo: string;
  orderId: string;
  orderCode: string;
  amountMnt: number;
  supplier: { id: string; name: string } | null;
  guest: { id: string; name: string | null } | null;
  /** Where it goes: the supplier's contract account, or what the guest typed. */
  bank: BankAccount | null;
  /** A supplier's account finance has checked; a guest's own, once typed at their phone. */
  bankVerified: boolean;
  reference: string | null;
  /** Who released it to be paid, and when. Never the person who pays it. */
  approvedBy: string | null;
  approvedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

const payeeOf = (s: { kind: SettlementKind; supplierId: string | null; guestId: string | null }) =>
  s.kind === 'payout' ? `supplier:${s.supplierId}` : `guest:${s.guestId}`;

/**
 * Open the debt and set the money aside. Idempotent per (order, kind): a
 * scheduler that closes the same order twice opens one settlement.
 */
export async function openSettlement(
  input: {
    kind: SettlementKind;
    orderId: string;
    orderCode: string;
    supplierId?: string | null;
    guestId?: string | null;
    amountMnt: number;
    memo: string;
  },
  db: Db = getPool(),
): Promise<{ id: string; accrualId: string } | null> {
  if (input.amountMnt <= 0) return null;
  const payee = payeeOf({
    kind: input.kind,
    supplierId: input.supplierId ?? null,
    guestId: input.guestId ?? null,
  });
  const accrual = await accrue({
    payee,
    amountMnt: input.amountMnt,
    subject: 'idesh',
    subjectId: input.orderId,
    memo: `Идэш · ${input.memo} №${input.orderCode}`,
    idempotencyKey: `idesh:${input.orderId}:${input.kind}:accrual`,
  });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO idesh.settlement
       (kind, order_id, supplier_id, guest_id, amount_mnt, memo, state, ledger_accrual_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (order_id, kind) DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.orderId,
      input.supplierId ?? null,
      input.guestId ?? null,
      input.amountMnt,
      input.memo,
      input.kind === 'refund' ? 'needs_account' : 'due',
      accrual,
    ],
  );
  return rows[0] ? { id: rows[0].id, accrualId: accrual } : null;
}

/** The guest says where their refund goes. Once there is an account, it is due. */
export async function setRefundAccount(
  orderId: string,
  guestId: string,
  bank: BankAccount,
  db: Db = getPool(),
): Promise<void> {
  const name = bank.bankName.trim();
  const account = bank.bankAccount.replace(/\s+/g, '');
  const holder = bank.bankHolder.trim();
  if (name.length < 2) throw new IdeshError('WRONG_STATE', 'a refund needs a bank');
  if (!/^\d{6,20}$/.test(account)) throw new IdeshError('WRONG_STATE', 'an account number is 6 to 20 digits');
  if (holder.length < 2) throw new IdeshError('WRONG_STATE', 'a refund needs the account holder');

  const { rowCount } = await db.query(
    `UPDATE idesh.settlement
        SET bank_name = $3, bank_account = $4, bank_holder = $5,
            state = CASE WHEN state = 'paid' THEN state ELSE 'due' END
      WHERE order_id = $1 AND kind = 'refund' AND guest_id = $2 AND state <> 'paid'`,
    [orderId, guestId, name, seal(account), seal(holder)],
  );
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no refund waiting on this order');
}

interface Row {
  id: string;
  kind: SettlementKind;
  state: SettlementState;
  memo: string;
  order_id: string;
  order_code: string;
  amount_mnt: number;
  supplier_id: string | null;
  supplier_name: string | null;
  guest_id: string | null;
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
  bank_verified: boolean;
  reference: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
}

const SELECT = `
  SELECT t.id, t.kind, t.state, t.memo, t.order_id, o.code AS order_code, t.amount_mnt,
         t.supplier_id, s.name AS supplier_name, t.guest_id,
         COALESCE(t.bank_name, s.bank_name) AS bank_name,
         COALESCE(t.bank_account, s.bank_account) AS bank_account,
         COALESCE(t.bank_holder, s.bank_holder) AS bank_holder,
         (t.kind = 'refund' OR s.bank_verified_at IS NOT NULL) AS bank_verified,
         t.reference, t.approved_by, t.approved_at, t.paid_at, t.created_at
    FROM idesh.settlement t
    JOIN idesh.idesh_order o ON o.id = t.order_id
    LEFT JOIN idesh.supplier s ON s.id = t.supplier_id`;

async function shape(rows: Row[]): Promise<Settlement[]> {
  const names = await displayNamesFor(rows.flatMap((r) => (r.guest_id ? [r.guest_id] : [])));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    memo: r.memo,
    orderId: r.order_id,
    orderCode: r.order_code,
    amountMnt: Number(r.amount_mnt),
    supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name ?? '' } : null,
    guest: r.guest_id ? { id: r.guest_id, name: names.get(r.guest_id) ?? null } : null,
    bank:
      r.bank_name && r.bank_account && r.bank_holder
        ? { bankName: r.bank_name, bankAccount: unseal(r.bank_account)!, bankHolder: unseal(r.bank_holder)! }
        : null,
    bankVerified: r.bank_verified,
    reference: r.reference,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  }));
}

/** Everything unpaid, oldest first, then what was paid lately. For ops. */
export async function listSettlements(db: Db = getPool()): Promise<Settlement[]> {
  const { rows } = await db.query<Row>(
    `${SELECT}
      WHERE t.state <> 'paid' OR t.paid_at > now() - interval '30 days'
      ORDER BY (t.state = 'paid'), t.created_at`,
  );
  return shape(rows);
}

/** One supplier's own money: what is owed to them and what has been sent. */
export async function settlementsOf(supplierId: string, db: Db = getPool()): Promise<Settlement[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} WHERE t.supplier_id = $1 ORDER BY (t.state = 'paid'), t.created_at DESC`,
    [supplierId],
  );
  return shape(rows);
}

/** Everything owed on one order: the guest's refund, the supplier's payout or forfeit. */
export async function settlementsOfOrder(orderId: string, db: Db = getPool()): Promise<Settlement[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE t.order_id = $1 ORDER BY t.created_at`, [orderId]);
  return shape(rows);
}

/** The refund a guest is waiting for on this order, if any. */
export async function refundOf(orderId: string, db: Db = getPool()): Promise<Settlement | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE t.order_id = $1 AND t.kind = 'refund'`, [orderId]);
  return (await shape(rows))[0] ?? null;
}

/**
 * «Батлах»: one member releases the money; another sends it.
 *
 * The desk's own people are the threat this answers — not a stranger. A
 * payout is a bank transfer made by hand, so whoever presses «Шилжүүлсэн»
 * is trusted with both the money and the record of it. Splitting the act in
 * two means a wrong account has to get past two people who each signed for
 * their half, and the row says which half each of them did.
 *
 * Approving is not a promise that the money moved; it is a promise that it
 * should. It can only be given to a settlement that has somewhere to go.
 */
export async function approveSettlement(settlementId: string, by: string, now: Date): Promise<Settlement> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE t.id = $1`, [settlementId]);
  const row = rows[0];
  if (!row) throw new IdeshError('NOT_FOUND', 'no such settlement');
  if (row.state === 'paid') throw new IdeshError('WRONG_STATE', 'already paid');
  if (row.state === 'needs_account' || !row.bank_account) {
    throw new IdeshError('NEEDS_ACCOUNT', 'nowhere to send it yet');
  }
  if (!row.bank_verified) throw new IdeshError('BANK_UNVERIFIED', 'the account has not been checked against the contract');
  // The first approval stands. A second person adds nothing here — their
  // part is to make the transfer, and that is a different button.
  if (row.approved_at && row.approved_by !== by) {
    throw new IdeshError('WRONG_STATE', `already released by ${row.approved_by}`);
  }
  await getPool().query(
    `UPDATE idesh.settlement SET approved_by = $2, approved_at = $3 WHERE id = $1 AND state <> 'paid'`,
    [row.id, by, row.approved_at ?? now],
  );
  const { rows: after } = await getPool().query<Row>(`${SELECT} WHERE t.id = $1`, [settlementId]);
  return (await shape(after))[0]!;
}

/**
 * «Шилжүүлсэн»: ops made the transfer. The ledger pays the payable out, the
 * row remembers who said so and the bank's reference, and the person owed is
 * told. A refund paid is what turns the order REFUNDED.
 */
export async function markSettled(
  ctx: Ctx,
  settlementId: string,
  by: string,
  reference: string,
): Promise<Settlement> {
  const now = ctx.clock.now();
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE t.id = $1`, [settlementId]);
  const row = rows[0];
  if (!row) throw new IdeshError('NOT_FOUND', 'no such settlement');
  if (row.state === 'paid') throw new IdeshError('WRONG_STATE', 'already paid');
  if (row.state === 'needs_account' || !row.bank_account) {
    throw new IdeshError('NEEDS_ACCOUNT', 'nowhere to send it yet');
  }
  if (!row.bank_verified) throw new IdeshError('BANK_UNVERIFIED', 'the account has not been checked against the contract');
  if (!row.approved_at) throw new IdeshError('NOT_APPROVED', 'nobody has released this one yet');
  // The demo desk is one shared identity, so the two halves would be the
  // same person there and the walkthrough could never finish. Production
  // has real members and holds the line.
  if (mode() === 'production' && row.approved_by === by) {
    throw new IdeshError('SAME_PERSON', 'the person who released it cannot also send it');
  }

  const payout = await payOut({
    payee: payeeOf({ kind: row.kind, supplierId: row.supplier_id, guestId: row.guest_id }),
    amountMnt: Number(row.amount_mnt),
    subject: 'idesh',
    subjectId: row.order_id,
    memo: `Идэш · ${row.memo} №${row.order_code} · ${reference.trim() || 'банк'}`,
    idempotencyKey: `idesh:settlement:${row.id}:payout`,
  });

  await tx(async (client) => {
    await client.query(
      `UPDATE idesh.settlement
          SET state = 'paid', paid_at = $2, paid_by = $3, reference = $4, ledger_payout_id = $5
        WHERE id = $1 AND state <> 'paid'`,
      [row.id, now, by, reference.trim() || null, payout],
    );
    if (row.kind === 'refund') {
      await client.query(
        `UPDATE idesh.idesh_order SET state = 'REFUNDED', version = version + 1, updated_at = now()
          WHERE id = $1 AND state = 'CANCELLED'`,
        [row.order_id],
      );
      await client.query(
        `INSERT INTO idesh.order_event (order_id, seq, type, payload, actor)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, 'REFUNDED', $2::jsonb, $3
           FROM idesh.order_event WHERE order_id = $1`,
        [row.order_id, JSON.stringify({ amountMnt: Number(row.amount_mnt), reference }), by],
      );
    }
  });

  const amount = `${Number(row.amount_mnt).toLocaleString('mn-MN')}₮`;
  if (row.kind === 'refund' && row.guest_id) {
    await enqueue(ctx, {
      guestId: row.guest_id,
      subject: 'idesh',
      subjectId: row.order_id,
      template: 'idesh.refunded',
      channel: 'sms',
      title: 'Буцаалт шилжүүллээ',
      body: `Идэш №${row.order_code}: ${amount} ${row.bank_name} дахь данс руу тань шилжүүллээ.`,
    });
  } else if (row.kind === 'payout' && row.supplier_id) {
    const { rows: who } = await getPool().query<{ owner_guest_id: string | null }>(
      'SELECT owner_guest_id FROM idesh.supplier WHERE id = $1',
      [row.supplier_id],
    );
    const guestId = who[0]?.owner_guest_id;
    if (guestId) {
      await enqueue(ctx, {
        guestId,
        subject: 'idesh',
        subjectId: row.order_id,
        template: 'supplier.paid',
        channel: 'sms',
        dedupeKey: `settlement:${row.id}:paid`,
        title: 'Олголт шилжүүллээ',
        body: `Basu: №${row.order_code} — ${row.memo} ${amount} данс руу тань шилжүүллээ.`,
      });
    }
  }

  return (await shape([{ ...row, state: 'paid', paid_at: now, reference }]))[0]!;
}
