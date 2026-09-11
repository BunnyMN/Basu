import { getPool, tx, type Db } from '../db/pool.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import { collect, queueReceipt, receiptsFor } from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';
import type { Kind } from './listings.js';
import {
  REASON_LABEL,
  FORFEIT_PCT,
  commissionOf,
  noShowFrom,
  reasonProblem,
  splitRefund,
  type CancelReason,
  type Split,
} from './money.js';
import { dayOf, quote, type Receive, type Unit } from './pricing.js';
import { openSettlement, refundOf, type Settlement } from './settlements.js';
import { ownerOf } from './suppliers.js';
import { BOARD_STATES, LIVE_STATES, type IdeshState } from './states.js';

/**
 * The life of an идэш, one function per thing a person can do.
 *
 * The same discipline as dine's orders: every state change is a conditional
 * UPDATE naming the states it is legal from, and zero rows means somebody got
 * there first. A guest cancelling in the same second the supplier marks the
 * animal slaughtered resolves to one winner, not two half-applied changes.
 */

/** An unpaid draft holds its animal this long, then gives it back. */
const DRAFT_TTL_MINUTES = 30;
/** A handed-over order stays on the launcher this long, then closes. */
const HANDED_TTL_HOURS = 24;

async function transition(
  db: Db,
  orderId: string,
  from: readonly IdeshState[],
  to: IdeshState,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  const { rowCount } = await db.query(
    `UPDATE idesh.idesh_order
        SET state = $2, version = version + 1, updated_at = now()
            ${sets.length ? `, ${sets.join(', ')}` : ''}
      WHERE id = $1 AND state = ANY($3::text[])`,
    [orderId, to, from, ...keys.map((k) => patch[k])],
  );
  return (rowCount ?? 0) > 0;
}

async function appendEvent(
  db: Db,
  orderId: string,
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO idesh.order_event (order_id, seq, type, payload, actor)
     SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3::jsonb, $4
       FROM idesh.order_event WHERE order_id = $1`,
    [orderId, type, JSON.stringify(payload), actor],
  );
}

/** Its own series, from 7001: a supplier must never be read a lunch number. */
async function nextCode(db: Db): Promise<string> {
  const { rows } = await db.query<{ code: string }>(
    `SELECT lpad(((COALESCE(max(code::int), 7000) + 1))::text, 4, '0') AS code
       FROM idesh.idesh_order WHERE code ~ '^[0-9]+$'`,
  );
  return rows[0]!.code;
}

/** `2026-11-03` → `11-р сарын 3`, for a message somebody reads. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split('-');
  return `${Number(month)}-р сарын ${Number(date)}`;
}

/* ── the guest ─────────────────────────────────────────────────────── */

export interface CreateIdeshInput {
  listingId: string;
  guestId: string;
  qty: number;
  receive: Receive;
  /** `YYYY-MM-DD` */
  receiveOn: string;
  address?: string | undefined;
  addressPhone?: string | undefined;
  addressLat?: number | undefined;
  addressLon?: number | undefined;
}

export interface CreatedIdesh {
  orderId: string;
  code: string;
  totalMnt: number;
}

/**
 * Reserve the animal and write the draft. Nothing is charged yet.
 *
 * The listing row is locked for the length of the transaction, and `sold`
 * moves under a `sold + qty <= quantity` guard — so two guests reaching for
 * the last sheep are settled by the database, not by whichever request read
 * the count first. A draft nobody pays for gives the animal back after half
 * an hour (see `housekeeping`).
 */
export async function createIdesh(ctx: Ctx, input: CreateIdeshInput): Promise<CreatedIdesh> {
  const now = ctx.clock.now();
  const today = dayOf(now);

  if (input.receive === 'delivery' && (!input.address?.trim() || !input.addressPhone?.trim())) {
    throw new IdeshError('NO_ADDRESS', 'a delivery needs an address and a phone to call');
  }

  return tx(async (client) => {
    const { rows } = await client.query<{
      id: string;
      supplier_id: string;
      supplier_active: boolean;
      active: boolean;
      kind: Kind;
      unit: Unit;
      title: string;
      origin: string;
      price_mnt: number;
      min_qty: number;
      quantity: number;
      sold: number;
      delivers: boolean;
      delivery_fee_mnt: number;
      ready_from: string;
    }>(
      `SELECT l.id, l.supplier_id, (s.active AND s.state = 'contracted') AS supplier_active, l.active, l.kind, l.unit,
              l.title, l.origin, l.price_mnt, l.min_qty, l.quantity, l.sold, l.delivers,
              l.delivery_fee_mnt, to_char(l.ready_from, 'YYYY-MM-DD') AS ready_from
         FROM idesh.listing l JOIN idesh.supplier s ON s.id = l.supplier_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [input.listingId],
    );
    const listing = rows[0];
    if (!listing || !listing.active || !listing.supplier_active) {
      throw new IdeshError('NOT_FOUND', 'that listing is not on offer');
    }

    const priced = quote(
      {
        unit: listing.unit,
        priceMnt: listing.price_mnt,
        minQty: listing.min_qty,
        quantity: listing.quantity,
        sold: listing.sold,
        delivers: listing.delivers,
        deliveryFeeMnt: listing.delivery_fee_mnt,
        readyFrom: listing.ready_from,
      },
      { qty: input.qty, receive: input.receive, receiveOn: input.receiveOn },
      today,
    );

    // The CHECK on the table does the enforcing; this reads the outcome.
    const taken = await client.query<{ id: string }>(
      `UPDATE idesh.listing SET sold = sold + $2, updated_at = $3
        WHERE id = $1 AND sold + $2 <= quantity
        RETURNING id`,
      [listing.id, priced.qty, now],
    );
    if (!taken.rows[0]) throw new IdeshError('SOLD_OUT', 'somebody took the last one first');

    const code = await nextCode(client);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO idesh.idesh_order
         (code, supplier_id, listing_id, guest_id, state, kind, unit, title, origin, qty,
          unit_price_mnt, delivery_fee_mnt, total_mnt, receive, receive_on,
          address, address_phone, address_lat, address_lon, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date,
               $15, $16, $17, $18, $19, $19)
       RETURNING id`,
      [
        code,
        listing.supplier_id,
        listing.id,
        input.guestId,
        listing.kind,
        listing.unit,
        listing.title,
        listing.origin,
        priced.qty,
        priced.unitPriceMnt,
        priced.deliveryFeeMnt,
        priced.totalMnt,
        input.receive,
        input.receiveOn,
        input.receive === 'delivery' ? input.address!.trim() : null,
        input.receive === 'delivery' ? input.addressPhone!.trim() : null,
        input.addressLat ?? null,
        input.addressLon ?? null,
        now,
      ],
    );
    const orderId = inserted.rows[0]!.id;

    await appendEvent(client, orderId, 'CREATED', `guest:${input.guestId}`, {
      listingId: listing.id,
      qty: priced.qty,
      receive: input.receive,
      receiveOn: input.receiveOn,
      totalMnt: priced.totalMnt,
    });

    return { orderId, code, totalMnt: priced.totalMnt };
  });
}

/**
 * The whole price, once, out of the wallet.
 *
 * Idesh never talks to QPay. It says «collect 420 000 ₮ from this guest for
 * this order» and the ledger decides whether that is a balance they already
 * hold or a shortfall to pull from a card first. The receipt is queued now,
 * on the supplier's TIN: the sale is complete the moment the money moves.
 */
export async function payIdesh(ctx: Ctx, orderId: string): Promise<void> {
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');
  if (facts.state !== 'DRAFT') throw new IdeshError('WRONG_STATE', `cannot pay in ${facts.state}`);

  let collected;
  try {
    collected = await collect(ctx, {
      guestId: facts.guestId,
      amountMnt: facts.totalMnt,
      subject: 'idesh',
      subjectId: orderId,
      // What the guest reads in their statement. The ledger never learns what
      // an идэш is; the vertical names itself here.
      memo: `Идэш · ${facts.supplier} №${facts.code}`,
      idempotencyKey: `idesh:${orderId}:purchase`,
    });
  } catch (error) {
    throw new IdeshError('PAYMENT_FAILED', (error as Error).message);
  }

  const now = ctx.clock.now();
  await tx(async (client) => {
    await client.query('UPDATE idesh.idesh_order SET ledger_transfer_id = $2 WHERE id = $1', [
      orderId,
      collected.transferId,
    ]);
    const moved = await transition(client, orderId, ['DRAFT'], 'PAID', { paid_at: now });
    if (!moved) throw new IdeshError('WRONG_STATE', 'order left DRAFT while paying');
    await appendEvent(client, orderId, 'PAID', `guest:${facts.guestId}`, {
      amountMnt: facts.totalMnt,
      fromWalletMnt: collected.fromWalletMnt,
      toppedUpMnt: collected.toppedUpMnt,
    });
  });

  await queueReceipt({
    transferId: collected.transferId,
    kind: 'SALE',
    merchantTin: facts.merchantTin,
    orderCode: facts.code,
    amountMnt: facts.totalMnt,
  });

  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.paid',
    channel: 'push',
    title: 'Идэш баталгаажлаа',
    body:
      `${facts.title} · №${facts.code}. ${facts.supplier} ${dayLabel(facts.receiveOn)}-нд ` +
      (facts.receive === 'delivery' ? 'хүргэнэ.' : 'бэлэн байлгана.'),
  });

  // The supplier is told too, both ways: a screen nobody is looking at is
  // not a notification, and an order they never heard of is the one that
  // goes unprepared.
  const owner = await ownerOf(facts.supplierId);
  if (owner) {
    const line =
      `Шинэ захиалга №${facts.code}: ${facts.title} ×${facts.qty}, ${dayLabel(facts.receiveOn)}-нд ` +
      (facts.receive === 'delivery' ? 'хүргүүлнэ' : 'өөрөө авна') +
      `. ${facts.totalMnt.toLocaleString('mn-MN')}₮ төлөгдсөн.`;
    for (const channel of ['push', 'sms'] as const) {
      await enqueue(ctx, {
        guestId: owner,
        subject: 'idesh',
        subjectId: orderId,
        template: 'supplier.order',
        channel,
        dedupeKey: `supplier:${orderId}:paid:${channel}`,
        title: 'Шинэ захиалга',
        body: channel === 'sms' ? `Basu: ${line}` : line,
      });
    }
  }
}

/**
 * Who may cancel: the supplier, or the house sweeping up an unpaid draft.
 * Never the guest. Money that has moved does not come back at the press of a
 * button; a guest who chose wrongly rings the supplier, they talk, and the
 * supplier cancels from their screen.
 */
export interface CancelledBy {
  actor: string;
  role: 'supplier' | 'system';
}

/**
 * Cancel, for a reason, and let the rule decide the money.
 *
 * A supplier may cancel at any point short of the handover, and must say
 * why — the reason is what sets the refund, not their choice of number
 * (see `splitRefund`). Some reasons are only true at some times: «зочин
 * ирээгүй» needs a ready order and three days' grace. Past PREPARING the
 * animal has been slaughtered and does not go back on offer.
 */
export async function cancelIdesh(
  ctx: Ctx,
  orderId: string,
  by: CancelledBy,
  reason: CancelReason,
): Promise<Split> {
  const now = ctx.clock.now();
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');

  if (by.role === 'system' && reason !== 'draft_expired') {
    throw new IdeshError('BAD_REASON', 'the scheduler only sweeps unpaid drafts');
  }
  if (by.role === 'supplier') {
    const problem = reasonProblem({
      state: facts.state,
      reason,
      receive: facts.receive,
      readyAt: facts.readyAt,
      receiveOn: facts.receiveOn,
      now,
    });
    if (problem) throw new IdeshError('BAD_REASON', problem);
  }

  const meatMnt = facts.unitPriceMnt * facts.qty;
  const split: Split = facts.transferId
    ? splitRefund({ state: facts.state, reason, meatMnt, deliveryFeeMnt: facts.deliveryFeeMnt })
    : { refundMnt: 0, forfeitMnt: 0 };

  const from: readonly IdeshState[] = ['DRAFT', 'PAID', 'PREPARING', 'READY', 'DISPATCHED'];

  const cancelled = await tx(async (client) => {
    const ok = await transition(client, orderId, from, 'CANCELLED', {
      cancelled_at: now,
      cancelled_by: by.actor,
      cancel_reason: reason,
      refund_mnt: split.refundMnt,
      forfeit_mnt: split.forfeitMnt,
    });
    if (!ok) return false;
    // The animal goes back on offer only if it was never committed. A carcass
    // does not become a sheep again because somebody pressed cancel.
    if (facts.state === 'DRAFT' || facts.state === 'PAID') {
      await client.query(
        `UPDATE idesh.listing SET sold = greatest(sold - $2, 0), updated_at = $3 WHERE id = $1`,
        [facts.listingId, facts.qty, now],
      );
    }
    await appendEvent(client, orderId, 'CANCELLED', by.actor, { reason, from: facts.state, ...split });
    return true;
  });

  if (!cancelled) throw new IdeshError('WRONG_STATE', `cannot cancel in ${facts.state}`);

  if (!facts.transferId) {
    // Never paid: nothing to give back, and nothing left to watch.
    await tx(async (client) => {
      await transition(client, orderId, ['CANCELLED'], 'CLOSED', { closed_at: now });
    });
    return split;
  }

  await arrangeRefund(ctx, orderId, facts, split, reason);
  return split;
}

/* ── the supplier ──────────────────────────────────────────────────── */

/** «Бэлтгэж эхлэх» — the animal is committed. From here the guest cannot cancel. */
export async function startPreparing(ctx: Ctx, orderId: string, actor: string): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['PAID'], 'PREPARING', { preparing_at: now });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not waiting to be prepared');
    await appendEvent(client, orderId, 'PREPARING', actor);
  });

  const facts = await billingFacts(orderId);
  if (!facts) return;
  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.preparing',
    channel: 'push',
    title: 'Мал бэлтгэгдэж байна',
    // The guest is told what changed, the way dine says it at the fire.
    body: `${facts.title} №${facts.code} бэлтгэгдэж эхэллээ.`,
  });
}

/** «Бэлэн» — the meat exists. This is the message that matters, so it goes by SMS. */
export async function markReady(ctx: Ctx, orderId: string, actor: string): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['PREPARING'], 'READY', { ready_at: now });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not being prepared');
    await appendEvent(client, orderId, 'READY', actor);
  });

  const facts = await billingFacts(orderId);
  if (!facts) return;
  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.ready',
    channel: 'sms',
    title: 'Идэш бэлэн боллоо',
    body:
      facts.receive === 'pickup'
        ? `Таны идэш бэлэн боллоо. ${facts.pickupAddress} хаягаас авна уу. Код №${facts.code}.`
        : `Таны идэш бэлэн боллоо. ${dayLabel(facts.receiveOn)}-нд хүргэнэ.`,
  });
}

/** «Замд гаргах» — only a delivery goes anywhere. */
export async function markDispatched(ctx: Ctx, orderId: string, actor: string): Promise<void> {
  const now = ctx.clock.now();
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');
  if (facts.receive !== 'delivery') {
    throw new IdeshError('WRONG_STATE', 'a pickup order is handed over, not dispatched');
  }
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['READY'], 'DISPATCHED', { dispatched_at: now });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not ready to go out');
    await appendEvent(client, orderId, 'DISPATCHED', actor);
  });

  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.dispatched',
    channel: 'sms',
    title: 'Идэш замд гарлаа',
    body: `Таны идэш №${facts.code} замд гарлаа. Хүргэгч ${facts.addressPhone ?? 'таны'} дугаар руу залгана.`,
  });
}

/** «Хүлээлгэн өгсөн» — read against the code the guest shows. */
export async function markHanded(ctx: Ctx, orderId: string, actor: string): Promise<void> {
  const now = ctx.clock.now();
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');

  // The supplier's share is fixed here, at the rate in force today: a
  // contract renegotiated next week does not reach back into this order.
  const commissionMnt = commissionOf(facts.unitPriceMnt * facts.qty, facts.commissionPct);
  const payoutMnt = facts.totalMnt - commissionMnt;

  await tx(async (client) => {
    const ok = await transition(client, orderId, ['READY', 'DISPATCHED'], 'HANDED', {
      handed_at: now,
      commission_mnt: commissionMnt,
      payout_mnt: payoutMnt,
    });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not ready to hand over');
    await appendEvent(client, orderId, 'HANDED', actor, { commissionMnt, payoutMnt });
  });

  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.handed',
    channel: 'push',
    title: 'Идэш хүлээлгэн өглөө',
    body: `${facts.title} №${facts.code} гар дээр чинь очлоо. Сайхан өвөлжөөрэй.`,
  });
}

/* ── the scheduler ─────────────────────────────────────────────────── */

/**
 * What the tick does for this vertical: drafts nobody paid for give their
 * animal back, and handed-over orders leave the launcher a day later.
 */
export async function housekeeping(ctx: Ctx): Promise<{ expired: number; closed: number }> {
  const now = ctx.clock.now();
  const db = getPool();

  const { rows: stale } = await db.query<{ id: string }>(
    `SELECT id FROM idesh.idesh_order
      WHERE state = 'DRAFT' AND created_at < $1::timestamptz - make_interval(mins => $2)`,
    [now, DRAFT_TTL_MINUTES],
  );
  let expired = 0;
  for (const row of stale) {
    try {
      await cancelIdesh(ctx, row.id, { actor: 'system:scheduler', role: 'system' }, 'draft_expired');
      expired++;
    } catch {
      // Paid in the meantime, or already cancelled: not ours any more.
    }
  }

  const { rows: done } = await db.query<{
    id: string;
    code: string;
    supplier_id: string;
    payout_mnt: number | null;
    total_mnt: number;
    unit_price_mnt: number;
    qty: number;
    commission_pct: string;
  }>(
    `SELECT o.id, o.code, o.supplier_id, o.payout_mnt, o.total_mnt, o.unit_price_mnt, o.qty,
            s.commission_pct
       FROM idesh.idesh_order o JOIN idesh.supplier s ON s.id = o.supplier_id
      WHERE o.state = 'HANDED' AND o.handed_at < $1::timestamptz - make_interval(hours => $2)`,
    [now, HANDED_TTL_HOURS],
  );
  let closed = 0;
  for (const row of done) {
    const moved = await tx(async (client) => {
      const ok = await transition(client, row.id, ['HANDED'], 'CLOSED', { closed_at: now });
      if (ok) await appendEvent(client, row.id, 'CLOSED', 'system:scheduler');
      return ok;
    });
    if (!moved) continue;
    closed++;
    // A day after the handover the supplier's share is theirs: the ledger
    // sets it aside and ops gets a line to pay.
    const payoutMnt =
      row.payout_mnt ??
      Number(row.total_mnt) -
        commissionOf(Number(row.unit_price_mnt) * row.qty, Number(row.commission_pct));
    await openSettlement({
      kind: 'payout',
      orderId: row.id,
      orderCode: row.code,
      supplierId: row.supplier_id,
      amountMnt: payoutMnt,
      memo: 'Олголт',
    });
  }

  return { expired, closed };
}

/* ── money back ────────────────────────────────────────────────────── */

/**
 * Not into the wallet: the guest's refund goes to a bank account they name,
 * and the supplier's forfeit, if any, to theirs. Both are set aside in the
 * ledger now and paid by a person later (see settlements.ts). The order stays
 * CANCELLED until the refund has actually been sent, which is when it turns
 * REFUNDED. The guest is told by SMS — this is the message they will act on.
 */
async function arrangeRefund(
  ctx: Ctx,
  orderId: string,
  facts: NonNullable<Awaited<ReturnType<typeof billingFacts>>>,
  split: Split,
  reason: CancelReason,
): Promise<void> {
  if (split.refundMnt > 0) {
    const opened = await openSettlement({
      kind: 'refund',
      orderId,
      orderCode: facts.code,
      guestId: facts.guestId,
      amountMnt: split.refundMnt,
      memo: 'Буцаалт',
    });
    if (opened) {
      await queueReceipt({
        transferId: opened.accrualId,
        kind: 'RETURN',
        merchantTin: facts.merchantTin,
        orderCode: facts.code,
        amountMnt: split.refundMnt,
      });
    }
  }
  if (split.forfeitMnt > 0) {
    await openSettlement({
      kind: 'payout',
      orderId,
      orderCode: facts.code,
      supplierId: facts.supplierId,
      amountMnt: split.forfeitMnt,
      memo: 'Суутгал',
    });
  }

  await tx(async (client) => {
    await appendEvent(client, orderId, 'REFUND_DUE', 'system:payments', { ...split, reason });
  });

  const amount = `${split.refundMnt.toLocaleString('mn-MN')}₮`;
  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.cancelled',
    channel: 'sms',
    title: 'Идэш цуцлагдлаа',
    body:
      `Идэш №${facts.code} цуцлагдлаа (${REASON_LABEL[reason].toLowerCase()}). ` +
      (split.forfeitMnt > 0 ? `Мал нядалсны дараа тул ${FORFEIT_PCT}% суутгав. ` : '') +
      `Буцаалт ${amount} — Basu аппаар дансаа оруулна уу.`,
  });
}

/**
 * The facts a payment, a refund, a receipt and a message all need, from this
 * module's own tables. The transfer id is here because the ledger handed it
 * back when it took the money — nothing reads a ledger table to find it.
 */
async function billingFacts(orderId: string): Promise<{
  guestId: string;
  listingId: string;
  supplierId: string;
  code: string;
  state: IdeshState;
  title: string;
  qty: number;
  unitPriceMnt: number;
  deliveryFeeMnt: number;
  totalMnt: number;
  receive: Receive;
  receiveOn: string;
  readyAt: Date | null;
  addressPhone: string | null;
  supplier: string;
  pickupAddress: string;
  merchantTin: string;
  commissionPct: number;
  transferId: string | null;
} | null> {
  const { rows } = await getPool().query<{
    guest_id: string;
    listing_id: string;
    supplier_id: string;
    code: string;
    state: IdeshState;
    title: string;
    qty: number;
    unit_price_mnt: number;
    delivery_fee_mnt: number;
    total_mnt: number;
    receive: Receive;
    receive_on: string;
    ready_at: Date | null;
    address_phone: string | null;
    supplier: string;
    pickup_address: string;
    tin: string | null;
    commission_pct: string;
    ledger_transfer_id: string | null;
  }>(
    `SELECT o.guest_id, o.listing_id, o.supplier_id, o.code, o.state, o.title, o.qty,
            o.unit_price_mnt, o.delivery_fee_mnt, o.total_mnt, o.receive,
            to_char(o.receive_on, 'YYYY-MM-DD') AS receive_on, o.ready_at, o.address_phone,
            o.ledger_transfer_id, s.name AS supplier, s.pickup_address,
            s.ebarimt_merchant_tin AS tin, s.commission_pct
       FROM idesh.idesh_order o
       JOIN idesh.supplier s ON s.id = o.supplier_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    guestId: row.guest_id,
    listingId: row.listing_id,
    supplierId: row.supplier_id,
    code: row.code,
    state: row.state,
    title: row.title,
    qty: row.qty,
    unitPriceMnt: Number(row.unit_price_mnt),
    deliveryFeeMnt: Number(row.delivery_fee_mnt),
    totalMnt: Number(row.total_mnt),
    receive: row.receive,
    receiveOn: row.receive_on,
    readyAt: row.ready_at,
    addressPhone: row.address_phone,
    supplier: row.supplier,
    pickupAddress: row.pickup_address,
    merchantTin: row.tin ?? 'UNSET',
    commissionPct: Number(row.commission_pct),
    transferId: row.ledger_transfer_id,
  };
}

/* ── what people see ───────────────────────────────────────────────── */

export interface IdeshSummary {
  id: string;
  code: string;
  state: IdeshState;
  supplier: { id: string; name: string };
  kind: Kind;
  unit: Unit;
  title: string;
  qty: number;
  totalMnt: number;
  receive: Receive;
  /** `YYYY-MM-DD` */
  receiveOn: string;
  paidAt: Date | null;
}

export interface IdeshDetail extends IdeshSummary {
  origin: string;
  unitPriceMnt: number;
  deliveryFeeMnt: number;
  address: string | null;
  addressPhone: string | null;
  addressLat: number | null;
  addressLon: number | null;
  /** Shown only once there is money down — a listing is not a phone book. */
  supplierPhone: string | null;
  pickupAddress: string;
  pickupLat: number | null;
  pickupLon: number | null;
  preparingAt: Date | null;
  readyAt: Date | null;
  dispatchedAt: Date | null;
  handedAt: Date | null;
  cancelReason: CancelReason | null;
  refundMnt: number | null;
  forfeitMnt: number | null;
  /** The refund on its way, once cancelled and paid for: where it stands. */
  refund: Pick<Settlement, 'state' | 'bank' | 'paidAt' | 'amountMnt'> | null;
  receipt: { qr: string; lottery: string | null } | null;
}

interface OrderRow {
  id: string;
  code: string;
  state: IdeshState;
  supplier_id: string;
  supplier: string;
  supplier_phone: string;
  pickup_address: string;
  pickup_lat: number | null;
  pickup_lon: number | null;
  guest_id: string;
  kind: Kind;
  unit: Unit;
  title: string;
  origin: string;
  qty: number;
  unit_price_mnt: number;
  delivery_fee_mnt: number;
  total_mnt: number;
  receive: Receive;
  receive_on: string;
  address: string | null;
  address_phone: string | null;
  address_lat: number | null;
  address_lon: number | null;
  ledger_transfer_id: string | null;
  paid_at: Date | null;
  preparing_at: Date | null;
  ready_at: Date | null;
  dispatched_at: Date | null;
  handed_at: Date | null;
  cancel_reason: CancelReason | null;
  refund_mnt: number | null;
  forfeit_mnt: number | null;
  commission_pct: string;
}

const ORDER_SELECT = `
  SELECT o.id, o.code, o.state, o.supplier_id, s.name AS supplier, s.phone AS supplier_phone,
         s.pickup_address, s.lat AS pickup_lat, s.lon AS pickup_lon, o.guest_id,
         o.kind, o.unit, o.title, o.origin, o.qty, o.unit_price_mnt, o.delivery_fee_mnt,
         o.total_mnt, o.receive, to_char(o.receive_on, 'YYYY-MM-DD') AS receive_on,
         o.address, o.address_phone, o.address_lat, o.address_lon, o.ledger_transfer_id,
         o.paid_at, o.preparing_at, o.ready_at, o.dispatched_at, o.handed_at,
         o.cancel_reason, o.refund_mnt, o.forfeit_mnt, s.commission_pct
    FROM idesh.idesh_order o
    JOIN idesh.supplier s ON s.id = o.supplier_id`;

function summary(r: OrderRow): IdeshSummary {
  return {
    id: r.id,
    code: r.code,
    state: r.state,
    supplier: { id: r.supplier_id, name: r.supplier },
    kind: r.kind,
    unit: r.unit,
    title: r.title,
    qty: r.qty,
    totalMnt: r.total_mnt,
    receive: r.receive,
    receiveOn: r.receive_on,
    paidAt: r.paid_at,
  };
}

/**
 * Everything of this guest's still going on, soonest first. What the launcher
 * puts beside the lunch, and what the page uses to find its way back.
 */
export async function liveFor(guestId: string, db: Db = getPool()): Promise<IdeshSummary[]> {
  // A cancelled order stays in view while its refund is still on its way —
  // the guest has an account to type in, then a transfer to expect.
  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE o.guest_id = $1
        AND (o.state = ANY($2::text[])
             OR (o.state = 'CANCELLED' AND EXISTS (
                   SELECT 1 FROM idesh.settlement t
                    WHERE t.order_id = o.id AND t.kind = 'refund' AND t.state <> 'paid')))
      ORDER BY o.receive_on, o.created_at`,
    [guestId, LIVE_STATES],
  );
  return rows.map(summary);
}

export async function detailFor(
  guestId: string,
  orderId: string,
  db: Db = getPool(),
): Promise<IdeshDetail | null> {
  const { rows } = await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 AND o.guest_id = $2`, [
    orderId,
    guestId,
  ]);
  const r = rows[0];
  if (!r) return null;

  const receipt = r.ledger_transfer_id
    ? (await receiptsFor([r.ledger_transfer_id])).get(r.ledger_transfer_id)
    : undefined;
  const paid = r.paid_at !== null;
  const refund = r.cancel_reason ? await refundOf(r.id, db) : null;

  return {
    ...summary(r),
    origin: r.origin,
    unitPriceMnt: r.unit_price_mnt,
    deliveryFeeMnt: r.delivery_fee_mnt,
    address: r.address,
    addressPhone: r.address_phone,
    addressLat: r.address_lat === null ? null : Number(r.address_lat),
    addressLon: r.address_lon === null ? null : Number(r.address_lon),
    supplierPhone: paid ? r.supplier_phone : null,
    pickupAddress: r.pickup_address,
    pickupLat: r.pickup_lat === null ? null : Number(r.pickup_lat),
    pickupLon: r.pickup_lon === null ? null : Number(r.pickup_lon),
    preparingAt: r.preparing_at,
    readyAt: r.ready_at,
    dispatchedAt: r.dispatched_at,
    handedAt: r.handed_at,
    cancelReason: r.cancel_reason,
    refundMnt: r.refund_mnt === null ? null : Number(r.refund_mnt),
    forfeitMnt: r.forfeit_mnt === null ? null : Number(r.forfeit_mnt),
    refund: refund
      ? { state: refund.state, bank: refund.bank, paidAt: refund.paidAt, amountMnt: refund.amountMnt }
      : null,
    receipt: receipt?.qrPayload ? { qr: receipt.qrPayload, lottery: receipt.lottery } : null,
  };
}

/** Is this order this guest's? The API asks before every action. */
export async function ownedByGuest(orderId: string, guestId: string, db: Db = getPool()): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM idesh.idesh_order WHERE id = $1 AND guest_id = $2',
    [orderId, guestId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function ownedBySupplier(
  orderId: string,
  supplierId: string,
  db: Db = getPool(),
): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM idesh.idesh_order WHERE id = $1 AND supplier_id = $2',
    [orderId, supplierId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export interface BoardTicket extends IdeshSummary {
  guest: string | null;
  /** Paid for, so the supplier may ring: the review promised both ways. */
  guestPhone: string | null;
  address: string | null;
  addressPhone: string | null;
  addressLat: number | null;
  addressLon: number | null;
  deliveryFeeMnt: number;
  readyAt: Date | null;
  /** From when «зочин ирээгүй» may be said of a ready pickup; null otherwise. */
  noShowFrom: Date | null;
  /** What the supplier will be paid for this order at their rate. */
  payoutMnt: number;
}

export interface Board {
  supplier: { id: string; name: string } | null;
  lanes: {
    paid: BoardTicket[];
    preparing: BoardTicket[];
    ready: BoardTicket[];
    dispatched: BoardTicket[];
  };
}

/**
 * The supplier's screen, in one call. `supplierId` of null means every
 * supplier at once, which only the demo asks for — the same reason /kds has
 * a «Бүх гал тогоо» view.
 */
export async function boardFor(supplierId: string | null, db: Db = getPool()): Promise<Board> {
  const named = supplierId
    ? await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM idesh.supplier WHERE id = $1',
        [supplierId],
      )
    : null;
  const supplier = named?.rows[0] ?? null;

  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE ($1::uuid IS NULL OR o.supplier_id = $1::uuid)
        AND o.state = ANY($2::text[])
      ORDER BY o.receive_on, o.paid_at`,
    [supplierId, BOARD_STATES],
  );

  // One call for the whole board rather than a join: identity is a module.
  const names = await displayNamesFor(rows.map((r) => r.guest_id));
  const contacts = await contactsFor(rows.map((r) => r.guest_id));

  const lanes: Board['lanes'] = { paid: [], preparing: [], ready: [], dispatched: [] };
  for (const r of rows) {
    const ticket = ticketOf(r, names, contacts);
    if (r.state === 'PAID') lanes.paid.push(ticket);
    else if (r.state === 'PREPARING') lanes.preparing.push(ticket);
    else if (r.state === 'READY') lanes.ready.push(ticket);
    else if (r.state === 'DISPATCHED') lanes.dispatched.push(ticket);
  }

  return { supplier, lanes };
}

/** One row as the supplier's screens read it. */
function ticketOf(r: OrderRow, names: Map<string, string>, contacts: Map<string, { phone: string }>): BoardTicket {
  return {
    ...summary(r),
    guest: names.get(r.guest_id) ?? null,
    guestPhone: contacts.get(r.guest_id)?.phone ?? null,
    address: r.address,
    addressPhone: r.address_phone,
    deliveryFeeMnt: Number(r.delivery_fee_mnt),
    readyAt: r.ready_at,
    noShowFrom:
      r.state === 'READY' && r.receive === 'pickup' && r.ready_at ? noShowFrom(r.ready_at, r.receive_on) : null,
    payoutMnt: Number(r.total_mnt) - commissionOf(Number(r.unit_price_mnt) * r.qty, Number(r.commission_pct)),
    addressLat: r.address_lat === null ? null : Number(r.address_lat),
    addressLon: r.address_lon === null ? null : Number(r.address_lon),
  };
}

/* ── the supplier's own module: today, the list, one order ─────────── */

export interface SupplierHome {
  today: string;
  lanes: { paid: number; preparing: number; ready: number; dispatched: number };
  /** Live orders whose day is today. */
  dueToday: number;
  /** Ready pickups the guest may now be called absent from. */
  overdue: number;
  season: {
    handed: number;
    cancelled: number;
    revenueMnt: number;
    payoutMnt: number;
    forfeitMnt: number;
    byKind: Array<{ kind: Kind; unit: Unit; qty: number; orders: number }>;
  };
}

/** The numbers a supplier opens the app to: what to do today, how the season is going. */
export async function homeOf(supplierId: string, now: Date, db: Db = getPool()): Promise<SupplierHome> {
  const today = dayOf(now);
  const { rows: live } = await db.query<{
    state: IdeshState;
    receive: Receive;
    receive_on: string;
    ready_at: Date | null;
  }>(
    `SELECT state, receive, to_char(receive_on, 'YYYY-MM-DD') AS receive_on, ready_at
       FROM idesh.idesh_order WHERE supplier_id = $1 AND state = ANY($2::text[])`,
    [supplierId, BOARD_STATES],
  );
  const lanes = { paid: 0, preparing: 0, ready: 0, dispatched: 0 };
  let dueToday = 0;
  let overdue = 0;
  for (const r of live) {
    if (r.state === 'PAID') lanes.paid++;
    else if (r.state === 'PREPARING') lanes.preparing++;
    else if (r.state === 'READY') lanes.ready++;
    else if (r.state === 'DISPATCHED') lanes.dispatched++;
    if (r.receive_on === today) dueToday++;
    if (r.state === 'READY' && r.receive === 'pickup' && r.ready_at && noShowFrom(r.ready_at, r.receive_on) <= now) overdue++;
  }

  const { rows: done } = await db.query<{
    handed: number;
    cancelled: number;
    revenue: string;
    payout: string;
    forfeit: string;
  }>(
    `SELECT count(*) FILTER (WHERE state IN ('HANDED','CLOSED'))::int AS handed,
            count(*) FILTER (WHERE state IN ('CANCELLED','REFUNDED'))::int AS cancelled,
            COALESCE(sum(total_mnt) FILTER (WHERE state IN ('HANDED','CLOSED')), 0) AS revenue,
            COALESCE(sum(COALESCE(payout_mnt, total_mnt)) FILTER (WHERE state IN ('HANDED','CLOSED')), 0) AS payout,
            COALESCE(sum(forfeit_mnt) FILTER (WHERE state IN ('CANCELLED','REFUNDED')), 0) AS forfeit
       FROM idesh.idesh_order WHERE supplier_id = $1`,
    [supplierId],
  );
  const { rows: kinds } = await db.query<{ kind: Kind; unit: Unit; qty: string; orders: number }>(
    `SELECT kind, unit, sum(qty) AS qty, count(*)::int AS orders
       FROM idesh.idesh_order
      WHERE supplier_id = $1 AND state IN ('HANDED','CLOSED')
      GROUP BY kind, unit ORDER BY sum(total_mnt) DESC`,
    [supplierId],
  );
  const d = done[0]!;
  return {
    today,
    lanes,
    dueToday,
    overdue,
    season: {
      handed: d.handed,
      cancelled: d.cancelled,
      revenueMnt: Number(d.revenue),
      payoutMnt: Number(d.payout),
      forfeitMnt: Number(d.forfeit),
      byKind: kinds.map((k) => ({ kind: k.kind, unit: k.unit, qty: Number(k.qty), orders: k.orders })),
    },
  };
}

export interface SupplierOrder extends BoardTicket {
  handedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: CancelReason | null;
  refundMnt: number | null;
  forfeitMnt: number | null;
  createdAt: Date;
}

export type OrderScope = 'live' | 'done' | 'all';

const SCOPE_STATES: Record<OrderScope, readonly IdeshState[]> = {
  live: ['PAID', 'PREPARING', 'READY', 'DISPATCHED', 'HANDED'],
  done: ['CLOSED', 'CANCELLED', 'REFUNDED'],
  all: ['PAID', 'PREPARING', 'READY', 'DISPATCHED', 'HANDED', 'CLOSED', 'CANCELLED', 'REFUNDED'],
};

/**
 * The supplier's orders, newest first, by scope, searched by whatever a
 * person has in front of them: a code, a phone number, a guest's name, the
 * meat. The search runs here after the fetch because two of those live in
 * identity, which is a module and not a join.
 */
export async function ordersOf(
  supplierId: string,
  opts: { scope?: OrderScope; q?: string; limit?: number } = {},
  db: Db = getPool(),
): Promise<SupplierOrder[]> {
  const scope = opts.scope ?? 'all';
  const { rows } = await db.query<OrderRow & { handed_at: Date | null; cancelled_at: Date | null; created_at: Date }>(
    `${ORDER_SELECT.replace('o.cancel_reason,', 'o.cancel_reason, o.cancelled_at, o.created_at,')}
      WHERE o.supplier_id = $1 AND o.state = ANY($2::text[])
      ORDER BY o.created_at DESC
      LIMIT 500`,
    [supplierId, SCOPE_STATES[scope]],
  );
  const names = await displayNamesFor(rows.map((r) => r.guest_id));
  const contacts = await contactsFor(rows.map((r) => r.guest_id));
  const q = (opts.q ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const digits = q.replace(/\D/g, '');
  const all = rows.map((r) => ({
    ...ticketOf(r, names, contacts),
    handedAt: r.handed_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    refundMnt: r.refund_mnt === null ? null : Number(r.refund_mnt),
    forfeitMnt: r.forfeit_mnt === null ? null : Number(r.forfeit_mnt),
    createdAt: r.created_at,
  }));
  const hits = q
    ? all.filter(
        (o) =>
          o.code.includes(q) ||
          o.title.toLowerCase().replace(/\s+/g, '').includes(q) ||
          (o.guest ?? '').toLowerCase().replace(/\s+/g, '').includes(q) ||
          (digits.length >= 4 &&
            ((o.guestPhone ?? '').replace(/\D/g, '').includes(digits) ||
              (o.addressPhone ?? '').replace(/\D/g, '').includes(digits))),
      )
    : all;
  return hits.slice(0, opts.limit ?? 100);
}

export interface OrderEvent {
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  at: Date;
}

/** One order of the supplier's, with everything that ever happened to it. */
export async function orderForSupplier(
  supplierId: string,
  orderId: string,
  db: Db = getPool(),
): Promise<{ order: SupplierOrder; events: OrderEvent[] } | null> {
  const [order] = await ordersOf(supplierId, { scope: 'all', limit: 1000 }, db).then((list) =>
    list.filter((o) => o.id === orderId),
  );
  if (!order) return null;
  const { rows } = await db.query<{ seq: number; type: string; actor: string; payload: Record<string, unknown>; created_at: Date }>(
    'SELECT seq, type, actor, payload, created_at FROM idesh.order_event WHERE order_id = $1 ORDER BY seq',
    [orderId],
  );
  return {
    order,
    events: rows.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.created_at })),
  };
}
