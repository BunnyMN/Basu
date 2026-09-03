import { getPool, tx } from '../../db/pool.js';
import type { Ctx } from '../../ports.js';
import type { Db } from '../../db/pool.js';

/**
 * The wallet, and the double entry underneath it.
 *
 * There is no balance column. A balance is `SUM(amount_mnt)` over an account's
 * entries and nothing else: it cannot be half-written by a request that died
 * between two statements, cannot drift from the entries that explain it, and
 * reconciles against QPay by construction. Entries are append-only — a mistake
 * is corrected by posting its reverse, which is also what an auditor expects
 * to see.
 *
 * Sign convention: positive is money arriving in that account. Every transfer's
 * entries sum to zero, and `ledger.entry_balanced` in migration 010 refuses
 * anything that does not.
 */

const CLEARING = 'qpay:clearing';
const REVENUE = 'house:revenue';

export class LedgerError extends Error {
  constructor(
    readonly code: 'INSUFFICIENT_FUNDS' | 'TOPUP_FAILED' | 'NOT_FOUND' | 'PAYMENT_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/* ── accounts ──────────────────────────────────────────────────────── */

/** A guest's wallet, made on first sight. Signing up costs one row. */
async function walletAccount(db: Db, guestId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger.account (kind, owner_id) VALUES ('guest', $1)
     ON CONFLICT (kind, owner_id, currency) WHERE owner_id IS NOT NULL
     DO UPDATE SET owner_id = EXCLUDED.owner_id
     RETURNING id`,
    [guestId],
  );
  return rows[0]!.id;
}

async function namedAccount(db: Db, label: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM ledger.account WHERE label = $1',
    [label],
  );
  const id = rows[0]?.id;
  if (!id) throw new LedgerError('NOT_FOUND', `ledger account ${label} is missing`);
  return id;
}

export async function balance(guestId: string): Promise<number> {
  const { rows } = await getPool().query<{ balance: number }>(
    `SELECT COALESCE(SUM(e.amount_mnt), 0)::bigint AS balance
       FROM ledger.entry e
       JOIN ledger.account a ON a.id = e.account_id
      WHERE a.kind = 'guest' AND a.owner_id = $1`,
    [guestId],
  );
  return rows[0]?.balance ?? 0;
}

/* ── posting ───────────────────────────────────────────────────────── */

interface PostInput {
  kind: 'topup' | 'purchase' | 'refund' | 'promotion' | 'adjustment';
  amountMnt: number;
  from: string;
  to: string;
  subject?: string | undefined;
  subjectId?: string | undefined;
  memo?: string | undefined;
  idempotencyKey: string;
}

/**
 * One movement, two entries, once.
 *
 * The idempotency key is the whole retry story: a double-tapped Pay button, a
 * redelivered QPay callback and a scheduler that ran twice all present the same
 * key and get back the transfer that already exists, rather than a second one.
 */
async function post(db: Db, input: PostInput): Promise<{ id: string; created: boolean }> {
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM ledger.transfer WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger.transfer (kind, amount_mnt, subject, subject_id, memo, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.amountMnt,
      input.subject ?? null,
      input.subjectId ?? null,
      input.memo ?? null,
      input.idempotencyKey,
    ],
  );
  const transferId = rows[0]?.id;
  if (!transferId) {
    // Lost the race with a concurrent identical request; theirs is the truth.
    const { rows: raced } = await db.query<{ id: string }>(
      'SELECT id FROM ledger.transfer WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    return { id: raced[0]!.id, created: false };
  }

  await db.query(
    `INSERT INTO ledger.entry (transfer_id, account_id, amount_mnt)
     VALUES ($1, $2, $3), ($1, $4, $5)`,
    [transferId, input.from, -input.amountMnt, input.to, input.amountMnt],
  );
  return { id: transferId, created: true };
}

/* ── topping up ────────────────────────────────────────────────────── */

export interface TopupStarted {
  topupId: string;
  amountMnt: number;
  /** QPay hands back a deeplink the phone opens; a card flow, a 3DS redirect. */
  actionUrl?: string | undefined;
  state: 'pending' | 'settled';
}

/**
 * Ask the provider for money. Nothing is credited here.
 *
 * The wallet moves when the provider says the money arrived, in `settleTopup` —
 * crediting on the intent instead would let anyone who can start a top-up mint
 * balance by simply never paying.
 */
export async function startTopup(
  ctx: Ctx,
  input: { guestId: string; amountMnt: number },
): Promise<TopupStarted> {
  if (!Number.isInteger(input.amountMnt) || input.amountMnt <= 0) {
    throw new LedgerError('TOPUP_FAILED', 'a top-up has to be a positive whole number of tugriks');
  }
  const now = ctx.clock.now();
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ledger.topup (guest_id, amount_mnt, provider, state, created_at)
     VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
    [input.guestId, input.amountMnt, ctx.payments.name, now],
  );
  const topupId = rows[0]!.id;

  let intent;
  try {
    intent = await ctx.payments.authorize({ reference: topupId, amountMnt: input.amountMnt });
  } catch (error) {
    await getPool().query(`UPDATE ledger.topup SET state = 'failed' WHERE id = $1`, [topupId]);
    throw new LedgerError('TOPUP_FAILED', (error as Error).message);
  }

  await getPool().query(
    `UPDATE ledger.topup SET provider_ref = $2, action_url = $3 WHERE id = $1`,
    [topupId, intent.providerRef, intent.actionUrl ?? null],
  );
  return { topupId, amountMnt: input.amountMnt, actionUrl: intent.actionUrl, state: 'pending' };
}

/**
 * The money arrived. Capture it, then credit the wallet.
 *
 * Idempotent on the top-up id, because this is reached from both the provider's
 * callback and the phone asking "did it work yet?", and those race.
 */
export async function settleTopup(ctx: Ctx, topupId: string): Promise<number> {
  const now = ctx.clock.now();
  const { rows } = await getPool().query<{
    guest_id: string;
    amount_mnt: number;
    provider: string;
    provider_ref: string | null;
    state: string;
  }>('SELECT guest_id, amount_mnt, provider, provider_ref, state FROM ledger.topup WHERE id = $1', [
    topupId,
  ]);
  const topup = rows[0];
  if (!topup) throw new LedgerError('NOT_FOUND', 'no such top-up');
  if (topup.state === 'settled') return balance(topup.guest_id);
  if (topup.state !== 'pending') throw new LedgerError('TOPUP_FAILED', `top-up is ${topup.state}`);

  try {
    if (topup.provider_ref) await ctx.payments.capture(topup.provider_ref);
  } catch (error) {
    await getPool().query(`UPDATE ledger.topup SET state = 'failed' WHERE id = $1`, [topupId]);
    throw new LedgerError('TOPUP_FAILED', (error as Error).message);
  }

  await tx(async (client) => {
    const wallet = await walletAccount(client, topup.guest_id);
    const clearing = await namedAccount(client, CLEARING);
    const transfer = await post(client, {
      kind: 'topup',
      amountMnt: topup.amount_mnt,
      from: clearing,
      to: wallet,
      subject: 'topup',
      subjectId: topupId,
      memo: topup.provider,
      idempotencyKey: `topup:${topupId}`,
    });
    await client.query(
      `UPDATE ledger.topup SET state = 'settled', settled_at = $2, transfer_id = $3 WHERE id = $1`,
      [topupId, now, transfer.id],
    );
    // The provider-side record, for reconciliation against QPay's own report.
    await client.query(
      `INSERT INTO ledger.payment (order_id, provider, provider_ref, amount_mnt, state, authorized_at, captured_at)
       VALUES (NULL, $1, $2, $3, 'captured', $4, $4)
       ON CONFLICT (provider, provider_ref) DO NOTHING`,
      [topup.provider, topup.provider_ref ?? `topup-${topupId}`, topup.amount_mnt, now],
    );
  });

  return balance(topup.guest_id);
}

/* ── spending ──────────────────────────────────────────────────────── */

export interface CollectInput {
  guestId: string;
  amountMnt: number;
  /** The caller's own word for what this buys — `order`, say. */
  subject: string;
  subjectId: string;
  memo?: string;
  /** One key per intention. The same key never charges twice. */
  idempotencyKey: string;
}

export interface Collected {
  transferId: string;
  amountMnt: number;
  /** How much of it came out of balance the guest already had. */
  fromWalletMnt: number;
  /** How much had to be pulled from the payment provider on the spot. */
  toppedUpMnt: number;
}

/**
 * Take money for something, from the wallet, topping up the shortfall.
 *
 * This is the only thing a vertical calls to get paid, and it is deliberately
 * not "charge the card": a guest with 31 500 ₮ sitting in Basu who orders an
 * 18 500 ₮ lunch should not see a card prompt, and a guest with 5 000 ₮ should
 * be asked for 13 500 ₮, not for the whole bill.
 */
export async function collect(ctx: Ctx, input: CollectInput): Promise<Collected> {
  if (!Number.isInteger(input.amountMnt) || input.amountMnt <= 0) {
    throw new LedgerError('PAYMENT_FAILED', 'amount has to be a positive whole number of tugriks');
  }

  const already = await getPool().query<{ id: string }>(
    'SELECT id FROM ledger.transfer WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if (already.rows[0]) {
    return {
      transferId: already.rows[0].id,
      amountMnt: input.amountMnt,
      fromWalletMnt: input.amountMnt,
      toppedUpMnt: 0,
    };
  }

  const held = await balance(input.guestId);
  const shortfall = Math.max(0, input.amountMnt - held);

  // The provider call happens outside the transaction on purpose: a network
  // call inside a BEGIN holds a connection and a row lock for as long as QPay
  // takes to answer, which on a bad day is the whole pool.
  if (shortfall > 0) {
    const topup = await startTopup(ctx, { guestId: input.guestId, amountMnt: shortfall });
    await settleTopup(ctx, topup.topupId);
  }

  const transferId = await tx(async (client) => {
    const wallet = await walletAccount(client, input.guestId);
    // Serialise everything that spends this wallet, so two requests cannot
    // both read a balance of 20 000 ₮ and both spend it.
    await client.query('SELECT id FROM ledger.account WHERE id = $1 FOR UPDATE', [wallet]);

    const { rows } = await client.query<{ balance: number }>(
      `SELECT COALESCE(SUM(amount_mnt), 0)::bigint AS balance
         FROM ledger.entry WHERE account_id = $1`,
      [wallet],
    );
    if ((rows[0]?.balance ?? 0) < input.amountMnt) {
      throw new LedgerError('INSUFFICIENT_FUNDS', 'not enough in the wallet');
    }

    const revenue = await namedAccount(client, REVENUE);
    const transfer = await post(client, {
      kind: 'purchase',
      amountMnt: input.amountMnt,
      from: wallet,
      to: revenue,
      subject: input.subject,
      subjectId: input.subjectId,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
    });
    return transfer.id;
  });

  return {
    transferId,
    amountMnt: input.amountMnt,
    fromWalletMnt: input.amountMnt - shortfall,
    toppedUpMnt: shortfall,
  };
}

/**
 * Give it back, into the wallet.
 *
 * Money returns to the balance rather than to the card. That is what a wallet
 * is for, it is instant where a card refund is days, and it keeps the reversal
 * on the same two accounts the purchase used — so the pair nets to zero and
 * reads as one story in the statement.
 */
export async function refund(input: {
  guestId: string;
  amountMnt: number;
  subject: string;
  subjectId: string;
  memo?: string;
  idempotencyKey: string;
}): Promise<string> {
  return tx(async (client) => {
    const wallet = await walletAccount(client, input.guestId);
    const revenue = await namedAccount(client, REVENUE);
    const transfer = await post(client, {
      kind: 'refund',
      amountMnt: input.amountMnt,
      from: revenue,
      to: wallet,
      subject: input.subject,
      subjectId: input.subjectId,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
    });
    return transfer.id;
  });
}

/* ── what the guest sees ───────────────────────────────────────────── */

export interface StatementLine {
  transferId: string;
  kind: string;
  /** Signed from the guest's point of view: what their balance did. */
  amountMnt: number;
  subject: string | null;
  subjectId: string | null;
  memo: string | null;
  at: Date;
}

export interface Wallet {
  balanceMnt: number;
  currency: 'MNT';
  lines: StatementLine[];
}

export async function wallet(guestId: string, limit = 25): Promise<Wallet> {
  const { rows } = await getPool().query<{
    transfer_id: string;
    kind: string;
    amount_mnt: number;
    subject: string | null;
    subject_id: string | null;
    memo: string | null;
    created_at: Date;
  }>(
    `SELECT e.transfer_id, t.kind, e.amount_mnt, t.subject, t.subject_id, t.memo, e.created_at
       FROM ledger.entry e
       JOIN ledger.account  a ON a.id = e.account_id
       JOIN ledger.transfer t ON t.id = e.transfer_id
      WHERE a.kind = 'guest' AND a.owner_id = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [guestId, limit],
  );

  return {
    balanceMnt: await balance(guestId),
    currency: 'MNT',
    lines: rows.map((r) => ({
      transferId: r.transfer_id,
      kind: r.kind,
      amountMnt: r.amount_mnt,
      subject: r.subject,
      subjectId: r.subject_id,
      memo: r.memo,
      at: r.created_at,
    })),
  };
}

/**
 * Every tugrik is somewhere.
 *
 * The sum of all entries across all accounts is zero, always — if it is not,
 * something wrote a single-sided entry and the ledger is no longer evidence.
 * Ops runs this beside the receipt reconciliation at 23:30.
 */
export async function reconcileLedger(): Promise<{ drift: number; accounts: number }> {
  const { rows } = await getPool().query<{ drift: number; accounts: number }>(
    `SELECT COALESCE(SUM(amount_mnt), 0)::bigint AS drift,
            (SELECT count(*)::int FROM ledger.account) AS accounts
       FROM ledger.entry`,
  );
  return { drift: rows[0]?.drift ?? 0, accounts: rows[0]?.accounts ?? 0 };
}
