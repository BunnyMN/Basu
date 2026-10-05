import { getPool, tx, type Db } from '../db/pool.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import {
  assertCollectable,
  balance,
  collectOrInvoice,
  dropInvoice,
  INVOICE_LIFETIME_MINUTES,
  lapsedInvoices,
  LedgerError,
  openInvoices,
  pendingInvoice,
  queueReceipt,
  receiptsFor,
  settleTopup,
  type Invoice,
} from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { CERT_COLUMNS, factsOf, usableCertificate, type CertificateFacts, type CertificateState } from './certificates.js';
import { IdeshError } from './errors.js';
import { PHOTO_PLACE, type Kind } from './listings.js';
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
import { openSettlement, refundOf, settlementsOfOrder, type Settlement } from './settlements.js';
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
 * an hour (see `housekeeping`). One nobody could pay for is never made: with
 * payments closed, the wallet must cover the whole total, or PAYMENTS_CLOSED.
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
      certificate_id: string | null;
      certificate_false: boolean;
    }>(
      `SELECT l.id, l.supplier_id, (s.active AND s.state = 'contracted') AS supplier_active, l.active, l.kind, l.unit,
              l.title, l.origin, l.price_mnt, l.min_qty, l.quantity, l.sold, l.delivers,
              l.delivery_fee_mnt, to_char(l.ready_from, 'YYYY-MM-DD') AS ready_from, l.certificate_id,
              COALESCE((SELECT c.state = 'false' FROM idesh.certificate c WHERE c.id = l.certificate_id), false) AS certificate_false
         FROM idesh.listing l JOIN idesh.supplier s ON s.id = l.supplier_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [input.listingId],
    );
    const listing = rows[0];
    // Meat under a certificate the desk found false is not on offer, whatever page still shows it.
    if (!listing || !listing.active || !listing.supplier_active || listing.certificate_false) {
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

    // An order nobody can pay for holds nothing. On a server with no payment
    // provider a draft the guest's wallet does not cover could never be paid,
    // and it held its animal for half an hour all the same: a few curious
    // presses of «Төлөх» made a live stall read «Энэ зар дууссан» to everybody.
    await assertCollectable(ctx, { guestId: input.guestId, amountMnt: priced.totalMnt }, client);

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
          address, address_phone, address_lat, address_lon, created_at, updated_at, certificate_id)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date,
               $15, $16, $17, $18, $19, $19, $20)
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
        // The certificate the meat is under today: the listing may carry the next shipment's tomorrow.
        listing.certificate_id,
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

export type PayOutcome = { state: 'PAID' } | { state: 'AWAITING_PAYMENT'; invoice: Invoice | null };

/**
 * The whole price, once, out of the wallet.
 *
 * Idesh never talks to QPay. It says «collect 420 000 ₮ from this guest for
 * this order» and the ledger decides whether that is a balance they already
 * hold or a shortfall the guest pays first — on the provider's own page, by
 * QPay. Then the answer is AWAITING_PAYMENT with the invoice, the order
 * still a draft; asked again (the page, the provider's callback, the
 * scheduler), a paid invoice buys it. The receipt is queued now, on the
 * supplier's TIN: the sale is complete the moment the money moves.
 *
 * The money taken and the order marked paid are one transaction. They used
 * to be two: a draft the scheduler gave back in between was left with its
 * money taken, unpaid, and no refund.
 */
export async function payIdesh(
  ctx: Ctx,
  orderId: string,
  /** `native`: the app draws the invoice itself (the QR and bank apps) instead of opening the provider's page. */
  opts: { returnUrl?: string; raise?: boolean; native?: boolean } = {},
): Promise<PayOutcome> {
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');
  if (facts.state !== 'DRAFT') throw new IdeshError('WRONG_STATE', `cannot pay in ${facts.state}`);

  const now = ctx.clock.now();
  const markPaid = async (client: Db, transferId: string, split: { fromWalletMnt: number; toppedUpMnt: number }) => {
    await client.query('UPDATE idesh.idesh_order SET ledger_transfer_id = $2 WHERE id = $1', [orderId, transferId]);
    const moved = await transition(client, orderId, ['DRAFT'], 'PAID', { paid_at: now });
    if (!moved) throw new IdeshError('WRONG_STATE', 'order left DRAFT while paying');
    await appendEvent(client, orderId, 'PAID', `guest:${facts.guestId}`, { amountMnt: facts.totalMnt, ...split });
  };

  let outcome;
  try {
    outcome = await collectOrInvoice(ctx, {
      guestId: facts.guestId,
      amountMnt: facts.totalMnt,
      subject: 'idesh',
      subjectId: orderId,
      // What the guest reads in their statement. The ledger never learns what
      // an идэш is; the vertical names itself here.
      memo: `Идэш · ${facts.supplier} №${facts.code}`,
      idempotencyKey: `idesh:${orderId}:purchase`,
      forSubject: 'idesh',
      forSubjectId: orderId,
      returnUrl: opts.returnUrl,
      description: `Basu · Идэш №${facts.code}`,
      native: opts.native,
      within: markPaid,
      raise: opts.raise,
    });
  } catch (error) {
    // Given back while paying: said as it is, the money left in the wallet.
    if (error instanceof IdeshError) throw error;
    // A server with no payment provider says so in its own words. «Try
    // again» would send the guest back to a button that cannot work today.
    if (error instanceof LedgerError && error.code === 'PAYMENTS_CLOSED') throw error;
    throw new IdeshError('PAYMENT_FAILED', (error as Error).message);
  }
  if (outcome.state === 'awaiting') return { state: 'AWAITING_PAYMENT', invoice: outcome.invoice };
  if (outcome.replayed) {
    // Bought a moment ago by another ask under the same key (the page, QPay's callback and the scheduler
    // finishing one invoice at once): said as bought, and nothing sent twice.
    const nowState = (await billingFacts(orderId))?.state;
    if (nowState && nowState !== 'DRAFT') {
      if (nowState === 'CANCELLED' || nowState === 'CLOSED') throw new IdeshError('WRONG_STATE', `cannot pay in ${nowState}`);
      return { state: 'PAID' };
    }
    // Taken before under this key while the order stayed a draft — the old two steps, one of them lost:
    // the order follows its money now.
    await tx((client) => markPaid(client, outcome.transferId, { fromWalletMnt: outcome.fromWalletMnt, toppedUpMnt: outcome.toppedUpMnt }));
  }
  const collected = outcome;

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
  return { state: 'PAID' };
}

/**
 * Who may cancel: the supplier, or the house sweeping up an unpaid draft.
 * Never the guest. Money that has moved does not come back at the press of a
 * button; a guest who chose wrongly rings the supplier, they talk, and the
 * supplier cancels from their screen.
 */
export interface CancelledBy {
  actor: string;
  role: 'supplier' | 'system' | 'ops';
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
  if (by.role === 'supplier' || by.role === 'ops') {
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

  // Only from the state the refund above was worked out for: a draft bought in the moment between (by
  // QPay's callback, the page) is not the draft whose refund was nothing — closing it would keep the
  // money and give no refund.
  const from: readonly IdeshState[] = (['DRAFT', 'PAID', 'PREPARING', 'READY', 'DISPATCHED'] as const).filter((s) => s === facts.state);

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

/**
 * «Бэлэн» — the meat exists. This is the message that matters, so it goes by SMS.
 *
 * A whole animal has its certificate from this moment, not before: the
 * supplier names it as they mark the meat ready, when they have it by then.
 */
export async function markReady(ctx: Ctx, orderId: string, actor: string, certificateId?: string | null): Promise<void> {
  const now = ctx.clock.now();
  await tx(async (client) => {
    if (certificateId) await putCertificate(client, orderId, certificateId);
    const ok = await transition(client, orderId, ['PREPARING'], 'READY', { ready_at: now });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not being prepared');
    await appendEvent(client, orderId, 'READY', actor, certificateId ? { certificateId } : {});
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

/** Point an order at a certificate of its own supplier's. */
async function putCertificate(db: Db, orderId: string, certificateId: string): Promise<void> {
  const { rows } = await db.query<{ supplier_id: string }>('SELECT supplier_id FROM idesh.idesh_order WHERE id = $1 FOR UPDATE', [orderId]);
  if (!rows[0]) throw new IdeshError('NOT_FOUND', 'no such order');
  await usableCertificate(rows[0].supplier_id, certificateId, db);
  await db.query('UPDATE idesh.idesh_order SET certificate_id = $2, updated_at = now() WHERE id = $1', [orderId, certificateId]);
}

/**
 * The certificate arrives after the order did — the meat was marked ready
 * before the paper was written in, or the wrong one was chosen. Allowed
 * while the order is still the supplier's to work on; once it is closed the
 * order is a record, and stays as it was handed over.
 */
export async function certifyIdesh(orderId: string, actor: string, certificateId: string): Promise<void> {
  await tx(async (client) => {
    const { rows } = await client.query<{ state: IdeshState }>('SELECT state FROM idesh.idesh_order WHERE id = $1 FOR UPDATE', [orderId]);
    const state = rows[0]?.state;
    if (!state) throw new IdeshError('NOT_FOUND', 'no such order');
    if (!(['PAID', 'PREPARING', 'READY', 'DISPATCHED', 'HANDED'] as IdeshState[]).includes(state)) {
      throw new IdeshError('WRONG_STATE', 'this order is no longer being worked on');
    }
    await putCertificate(client, orderId, certificateId);
    await appendEvent(client, orderId, 'CERTIFIED', actor, { certificateId });
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
 * Every invoice out for an идэш, looked at: paid, its order is bought (the
 * money lands in the wallet first, so an order given back meanwhile leaves it
 * there, never lost); lapsed unpaid, let go. Also what the provider's
 * callback does for the one it names (`finishInvoiceFor`).
 */
async function finishOpenInvoices(ctx: Ctx): Promise<number> {
  let bought = 0;
  for (const invoice of await openInvoices('idesh')) {
    if ((await finishInvoiceFor(ctx, invoice.subjectId, invoice)) === 'PAID') bought++;
  }
  return bought;
}

/**
 * Let go unpaid, then paid in the moment after: the money lands in the wallet, and buys the order if it
 * still waits — given back meanwhile, it stays in the wallet, the guest's to spend or have refunded.
 */
async function finishLapsedInvoices(ctx: Ctx): Promise<number> {
  let bought = 0;
  for (const lapsed of await lapsedInvoices('idesh', ctx.clock.now())) {
    try {
      await settleTopup(ctx, lapsed.topupId);
    } catch {
      continue; // still unpaid, as it was let go
    }
    try {
      if ((await payIdesh(ctx, lapsed.subjectId, { raise: false })).state === 'PAID') bought++;
    } catch {
      // given back, or bought by now: the money is in the wallet either way
    }
  }
  return bought;
}

/**
 * The invoice out for this order, looked at once: 'PAID' when it was paid
 * and the order is bought now, 'WAITING' while it may still be paid,
 * 'LAPSED' when it was let go unpaid. The provider's callback calls this for
 * the purchase it names.
 */
export async function finishInvoiceFor(
  ctx: Ctx,
  orderId: string,
  known?: { topupId: string; createdAt: Date },
): Promise<'PAID' | 'WAITING' | 'LAPSED' | 'NONE'> {
  const invoice = known ?? (await pendingInvoice('idesh', orderId));
  if (invoice) {
    try {
      await settleTopup(ctx, invoice.topupId);
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      // No answer from the provider: still waiting — nothing let go, nothing given back, on silence.
      if (error.code === 'PROVIDER_UNREACHABLE') return 'WAITING';
      if (error.code !== 'NOT_PAID_YET') return 'LAPSED'; // refused by the provider, marked so
      // Unpaid, but the wallet covers the order by now (a payment that came in late): bought from there,
      // the invoice let go — rather than left out for the guest to pay a second time.
      const facts = await billingFacts(orderId);
      const covered = facts?.state === 'DRAFT' && (await balance(facts.guestId)) >= facts.totalMnt;
      if (!covered) {
        if (ctx.clock.now().getTime() - invoice.createdAt.getTime() < INVOICE_LIFETIME_MINUTES * 60_000) return 'WAITING';
        await dropInvoice(ctx, invoice.topupId);
        return 'LAPSED';
      }
    }
  }
  // In the wallet now — settled just above, or by the callback just before: the purchase goes through
  // from there, if the order still waits for it. Never a new invoice: nobody is here to pay one.
  try {
    return (await payIdesh(ctx, orderId, { raise: false })).state === 'PAID' ? 'PAID' : 'WAITING';
  } catch {
    return 'NONE';
  }
}

/**
 * What the tick does for this vertical: drafts nobody paid for give their
 * animal back, and handed-over orders leave the launcher a day later.
 */
export async function housekeeping(
  ctx: Ctx,
  /**
   * Whether this tick looks at the invoices out (`invoices`) and at the ones let go in the last hour
   * (`lapsed`) — each a question to the provider. The scheduler ticks every second and asks at its own
   * slower pace; a test asks every time.
   */
  { invoices = true, lapsed = true }: { invoices?: boolean; lapsed?: boolean } = {},
): Promise<{ expired: number; closed: number; bought: number }> {
  const now = ctx.clock.now();
  const db = getPool();

  // Invoices out for drafts: one paid while nobody was looking buys its order
  // — the person may never come back to the page, and the provider's callback
  // may never come — and one that lapsed unpaid is let go.
  let bought = 0;
  if (invoices) bought += await finishOpenInvoices(ctx);
  if (lapsed) bought += await finishLapsedInvoices(ctx);

  const { rows: stale } = await db.query<{ id: string }>(
    `SELECT id FROM idesh.idesh_order
      WHERE state = 'DRAFT' AND created_at < $1::timestamptz - make_interval(mins => $2)`,
    [now, DRAFT_TTL_MINUTES],
  );
  let expired = 0;
  for (const row of stale) {
    // Somebody paying it right now, on the provider's page: theirs a little longer. An older invoice is
    // looked at first — paid, the order is bought instead of given back; unpaid, it is let go.
    const out = await pendingInvoice('idesh', row.id);
    if (out) {
      if (now.getTime() - out.createdAt.getTime() < INVOICE_LIFETIME_MINUTES * 60_000) continue;
      const looked = await finishInvoiceFor(ctx, row.id, out);
      if (looked === 'PAID') bought++;
      // Bought, or the provider gave no answer: not given back on this tick.
      if (looked === 'PAID' || looked === 'WAITING') continue;
    }
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

  return { expired, closed, bought };
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
      // The website takes the account too: somebody who ordered on it may never have had the app.
      `Буцаалт ${amount} — basu.burzai.cloud/orders хуудсанд эсвэл Basu аппад дансаа оруулна уу.`,
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
  /** Where a pickup is collected: the supplier's own address. The guest's lists carry it for the lock screen. */
  pickupAddress?: string;
  /** The veterinary certificate this meat is under, once it has one. */
  certificate: CertificateFacts | null;
  /** Which example photograph the listing it was bought from wears — see `Listing.photo`. */
  photo: number;
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
  cert_number: string | null;
  cert_issuer: string | null;
  cert_issued_on: string | null;
  cert_state: CertificateState | null;
  photo: number | null;
}

const ORDER_SELECT = `
  SELECT o.id, o.code, o.state, o.supplier_id, s.name AS supplier, s.phone AS supplier_phone,
         s.pickup_address, s.lat AS pickup_lat, s.lon AS pickup_lon, o.guest_id,
         o.kind, o.unit, o.title, o.origin, o.qty, o.unit_price_mnt, o.delivery_fee_mnt,
         o.total_mnt, o.receive, to_char(o.receive_on, 'YYYY-MM-DD') AS receive_on,
         o.address, o.address_phone, o.address_lat, o.address_lon, o.ledger_transfer_id,
         o.paid_at, o.preparing_at, o.ready_at, o.dispatched_at, o.handed_at,
         o.cancel_reason, o.refund_mnt, o.forfeit_mnt, s.commission_pct,
         ${CERT_COLUMNS},
         (SELECT ${PHOTO_PLACE.replace(/ AS photo$/, '')} FROM idesh.listing l WHERE l.id = o.listing_id) AS photo
    FROM idesh.idesh_order o
    JOIN idesh.supplier s ON s.id = o.supplier_id
    LEFT JOIN idesh.certificate c ON c.id = o.certificate_id`;

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
    pickupAddress: r.pickup_address,
    certificate: factsOf(r),
    photo: r.photo ?? 0,
  };
}

/** Where each of these orders stands, for the lock screen cards that follow them. */
export async function ideshCardFacts(
  orderIds: string[],
  db: Db = getPool(),
): Promise<Map<string, { state: IdeshState; receiveOn: string }>> {
  if (orderIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; state: IdeshState; receive_on: string }>(
    `SELECT id::text AS id, state, to_char(receive_on, 'YYYY-MM-DD') AS receive_on
       FROM idesh.idesh_order WHERE id::text = ANY($1::text[])`,
    [orderIds],
  );
  return new Map(rows.map((r) => [r.id, { state: r.state, receiveOn: r.receive_on }]));
}

/** Is this order this guest's? What a lock screen card may be registered against. */
export async function ownsIdesh(guestId: string, orderId: string, db: Db = getPool()): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM idesh.idesh_order WHERE id::text = $1 AND guest_id = $2`, [
    orderId,
    guestId,
  ]);
  return (rowCount ?? 0) > 0;
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

/**
 * Every order of this guest's that was ever paid for, newest first: what the
 * website's «Миний захиалга» lists, finished ones included. A draft that was
 * never paid is not an order anybody made, so it is left out — still
 * waiting, and after half an hour given back too. Asked for by its state,
 * a lapsed draft came back closed, and was listed as a finished order.
 */
export async function allFor(guestId: string, db: Db = getPool()): Promise<IdeshSummary[]> {
  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE o.guest_id = $1 AND o.paid_at IS NOT NULL
      ORDER BY o.created_at DESC
      LIMIT 200`,
    [guestId],
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
  /** The name the guest chose — on the supplier's screens null when they chose none (the desk's lists say who in its place). */
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

/** The supplier's screen, in one call: the orders with a job still to do. */
export async function boardFor(supplierId: string, db: Db = getPool()): Promise<Board> {
  const named = await db.query<{ id: string; name: string }>('SELECT id, name FROM idesh.supplier WHERE id = $1', [supplierId]);
  const supplier = named.rows[0] ?? null;

  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE o.supplier_id = $1::uuid
        AND o.state = ANY($2::text[])
      ORDER BY o.receive_on, o.paid_at`,
    [supplierId, BOARD_STATES],
  );

  // One call for the whole board rather than a join: identity is a module.
  // Only the names people chose: a piece of somebody's address is no name to greet at the counter.
  const names = await displayNamesFor(rows.map((r) => r.guest_id), { fallback: false });
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
function ticketOf(r: OrderRow, names: Map<string, string>, contacts: Map<string, { phone: string | null }>): BoardTicket {
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
  /**
   * The account that bought it — for the desk, which names the guest by
   * their address when they gave no name. The supplier's routes shape an
   * order field by field and never send it.
   */
  guestId: string;
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
  // The supplier is told the names people chose, never a piece of their number or address in its place.
  return listOrders({ ...opts, supplierId }, db, { fallback: false });
}

export interface OrderFilter {
  scope?: OrderScope | undefined;
  /** One state, when the scope is too wide. */
  state?: IdeshState | undefined;
  supplierId?: string | undefined;
  guestId?: string | undefined;
  /** `YYYY-MM-DD` — orders to be received that day. */
  day?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
}

/** Ops sees every supplier's orders through one window. */
export async function allOrders(opts: OrderFilter = {}, db: Db = getPool()): Promise<SupplierOrder[]> {
  return listOrders(opts, db);
}

async function listOrders(opts: OrderFilter, db: Db, { fallback = true }: { fallback?: boolean } = {}): Promise<SupplierOrder[]> {
  const scope = opts.scope ?? 'all';
  const states = opts.state ? [opts.state] : SCOPE_STATES[scope];
  const { rows } = await db.query<OrderRow & { handed_at: Date | null; cancelled_at: Date | null; created_at: Date }>(
    `${ORDER_SELECT.replace('o.cancel_reason,', 'o.cancel_reason, o.cancelled_at, o.created_at,')}
      WHERE o.state = ANY($1::text[])
        AND ($2::uuid IS NULL OR o.supplier_id = $2::uuid)
        AND ($3::date IS NULL OR o.receive_on = $3::date)
        AND ($4::uuid IS NULL OR o.guest_id = $4::uuid)
      ORDER BY o.created_at DESC
      LIMIT 500`,
    [states, opts.supplierId ?? null, opts.day ?? null, opts.guestId ?? null],
  );
  const names = await displayNamesFor(rows.map((r) => r.guest_id), { fallback });
  const contacts = await contactsFor(rows.map((r) => r.guest_id));
  const q = (opts.q ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const digits = q.replace(/\D/g, '');
  const all = rows.map((r) => ({
    ...ticketOf(r, names, contacts),
    guestId: r.guest_id,
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
          o.supplier.name.toLowerCase().replace(/\s+/g, '').includes(q) ||
          (o.guest ?? '').toLowerCase().replace(/\s+/g, '').includes(q) ||
          (digits.length >= 4 &&
            ((o.guestPhone ?? '').replace(/\D/g, '').includes(digits) ||
              (o.addressPhone ?? '').replace(/\D/g, '').includes(digits))),
      )
    : all;
  return hits.slice(0, opts.limit ?? 100);
}

/**
 * The accounts that gave this number for a delivery — somebody who signed
 * up by email has no phone of their own, and the desk looking for a caller
 * has only the number they ring from. `digits` is at least four of them;
 * each account once, with the number its latest such order carried.
 */
export async function guestsByDeliveryPhone(
  digits: string,
  db: Db = getPool(),
): Promise<Array<{ guestId: string; phone: string }>> {
  const wanted = digits.replace(/\D/g, '');
  if (wanted.length < 4) return [];
  const { rows } = await db.query<{ guest_id: string; address_phone: string }>(
    `SELECT DISTINCT ON (guest_id) guest_id, address_phone
       FROM idesh.idesh_order
      WHERE address_phone IS NOT NULL
        AND regexp_replace(address_phone, '[^0-9]', '', 'g') LIKE '%' || $1 || '%'
      ORDER BY guest_id, created_at DESC
      LIMIT 50`,
    [wanted],
  );
  return rows.map((r) => ({ guestId: r.guest_id, phone: r.address_phone }));
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

/** One order as ops sees it: the order, its story, and every settlement on it. */
export async function orderForOps(
  orderId: string,
  db: Db = getPool(),
): Promise<{ order: SupplierOrder; events: OrderEvent[]; settlements: Settlement[] } | null> {
  const [order] = (await listOrders({ limit: 1000 }, db)).filter((o) => o.id === orderId);
  if (!order) return null;
  const { rows } = await db.query<{ seq: number; type: string; actor: string; payload: Record<string, unknown>; created_at: Date }>(
    'SELECT seq, type, actor, payload, created_at FROM idesh.order_event WHERE order_id = $1 ORDER BY seq',
    [orderId],
  );
  return {
    order,
    events: rows.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, at: e.created_at })),
    settlements: await settlementsOfOrder(orderId, db),
  };
}

/**
 * Say it again. The guest's message for the state the order is in, sent
 * afresh — a phone that was off, an SMS that never came. Ops presses this,
 * and the order remembers that they did.
 */
export async function resendForOps(ctx: Ctx, orderId: string, who: string): Promise<string> {
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');
  const again = `resend:${Date.now()}`;
  const say = (template: string, channel: 'push' | 'sms', title: string, body: string) =>
    enqueue(ctx, { guestId: facts.guestId, subject: 'idesh', subjectId: orderId, template, channel, dedupeKey: `${orderId}:${template}:${again}`, title, body });
  switch (facts.state) {
    case 'PAID':
    case 'PREPARING':
      await say('idesh.paid', 'sms', 'Идэш баталгаажлаа',
        `Basu: ${facts.title} №${facts.code} баталгаажсан. ${facts.supplier} ${dayLabel(facts.receiveOn)}-нд ${facts.receive === 'delivery' ? 'хүргэнэ' : 'бэлэн байлгана'}.`);
      break;
    case 'READY':
      await say('idesh.ready', 'sms', 'Идэш бэлэн боллоо',
        facts.receive === 'pickup'
          ? `Таны идэш бэлэн боллоо. ${facts.pickupAddress} хаягаас авна уу. Код №${facts.code}.`
          : `Таны идэш бэлэн боллоо. ${dayLabel(facts.receiveOn)}-нд хүргэнэ.`);
      break;
    case 'DISPATCHED':
      await say('idesh.dispatched', 'sms', 'Идэш замд гарлаа', `Таны идэш №${facts.code} замд гарлаа. Хүргэгч залгана.`);
      break;
    case 'CANCELLED':
      await say('idesh.cancelled', 'sms', 'Идэш цуцлагдлаа',
        `Идэш №${facts.code} цуцлагдсан. Буцаалтаа авахын тулд basu.burzai.cloud/orders хуудсанд эсвэл Basu аппад дансаа оруулна уу.`);
      break;
    default:
      throw new IdeshError('WRONG_STATE', `nothing to say in ${facts.state}`);
  }
  await tx(async (client) => {
    await appendEvent(client, orderId, 'RESENT', who, { state: facts.state });
  });
  return facts.state;
}

/* ── the numbers ops reads ────────────────────────────────────────── */

export interface Tally {
  /** Orders paid for in the period, and what they came to. */
  paid: number;
  salesMnt: number;
  /** Orders handed over in the period, and Basu's share of them. */
  handed: number;
  commissionMnt: number;
  /** Cancelled in the period: how many, whose fault, and the money that moved back or stayed. */
  cancelled: number;
  supplierFault: number;
  guestFault: number;
  refundMnt: number;
  forfeitMnt: number;
}

export interface SupplierTally {
  id: string;
  name: string;
  active: boolean;
  paid: number;
  handed: number;
  cancelled: number;
  supplierFault: number;
  noShows: number;
  salesMnt: number;
  commissionMnt: number;
  /** Paid to ready, averaged, in hours. Null until something was ready. */
  readyHours: number | null;
}

export interface OpsStats {
  today: Tally;
  week: Tally;
  season: Tally;
  suppliers: SupplierTally[];
  byKind: Array<{ kind: Kind; unit: Unit; qty: number; orders: number; salesMnt: number }>;
}

const SUPPLIER_FAULT_SQL = `cancel_reason IN ('vet','cannot_fulfil')`;

async function tally(db: Db, from: Date | null, to: Date): Promise<Tally> {
  const { rows } = await db.query<Record<string, string | number>>(
    `SELECT count(*) FILTER (WHERE paid_at IS NOT NULL AND paid_at >= COALESCE($1, '-infinity'::timestamptz) AND paid_at < $2)::int AS paid,
            COALESCE(sum(total_mnt) FILTER (WHERE paid_at IS NOT NULL AND paid_at >= COALESCE($1, '-infinity'::timestamptz) AND paid_at < $2), 0) AS sales,
            count(*) FILTER (WHERE handed_at IS NOT NULL AND handed_at >= COALESCE($1, '-infinity'::timestamptz) AND handed_at < $2)::int AS handed,
            COALESCE(sum(commission_mnt) FILTER (WHERE handed_at IS NOT NULL AND handed_at >= COALESCE($1, '-infinity'::timestamptz) AND handed_at < $2), 0) AS commission,
            count(*) FILTER (WHERE cancelled_at IS NOT NULL AND paid_at IS NOT NULL AND cancelled_at >= COALESCE($1, '-infinity'::timestamptz) AND cancelled_at < $2)::int AS cancelled,
            count(*) FILTER (WHERE cancelled_at IS NOT NULL AND paid_at IS NOT NULL AND ${SUPPLIER_FAULT_SQL} AND cancelled_at >= COALESCE($1, '-infinity'::timestamptz) AND cancelled_at < $2)::int AS supplier_fault,
            COALESCE(sum(refund_mnt) FILTER (WHERE cancelled_at IS NOT NULL AND cancelled_at >= COALESCE($1, '-infinity'::timestamptz) AND cancelled_at < $2), 0) AS refund,
            COALESCE(sum(forfeit_mnt) FILTER (WHERE cancelled_at IS NOT NULL AND cancelled_at >= COALESCE($1, '-infinity'::timestamptz) AND cancelled_at < $2), 0) AS forfeit
       FROM idesh.idesh_order`,
    [from, to],
  );
  const r = rows[0]!;
  const cancelled = Number(r['cancelled']);
  const supplierFault = Number(r['supplier_fault']);
  return {
    paid: Number(r['paid']),
    salesMnt: Number(r['sales']),
    handed: Number(r['handed']),
    commissionMnt: Number(r['commission']),
    cancelled,
    supplierFault,
    guestFault: cancelled - supplierFault,
    refundMnt: Number(r['refund']),
    forfeitMnt: Number(r['forfeit']),
  };
}

/** Today, the last seven days, and the whole season, plus every supplier and every kind of meat. */
export async function statsFor(now: Date, db: Db = getPool()): Promise<OpsStats> {
  const startOfToday = new Date(`${dayOf(now)}T00:00:00+08:00`);
  const weekAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
  const end = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const [today, week, season] = await Promise.all([
    tally(db, startOfToday, end),
    tally(db, weekAgo, end),
    tally(db, null, end),
  ]);

  const { rows: suppliers } = await db.query<Record<string, string | number | boolean | null>>(
    `SELECT s.id, s.name, s.active,
            count(o.id) FILTER (WHERE o.paid_at IS NOT NULL)::int AS paid,
            count(o.id) FILTER (WHERE o.handed_at IS NOT NULL)::int AS handed,
            count(o.id) FILTER (WHERE o.cancelled_at IS NOT NULL AND o.paid_at IS NOT NULL)::int AS cancelled,
            count(o.id) FILTER (WHERE o.cancelled_at IS NOT NULL AND o.${SUPPLIER_FAULT_SQL})::int AS supplier_fault,
            count(o.id) FILTER (WHERE o.cancel_reason = 'no_show')::int AS no_shows,
            COALESCE(sum(o.total_mnt) FILTER (WHERE o.handed_at IS NOT NULL), 0) AS sales,
            COALESCE(sum(o.commission_mnt) FILTER (WHERE o.handed_at IS NOT NULL), 0) AS commission,
            avg(EXTRACT(EPOCH FROM (o.ready_at - o.paid_at)) / 3600) FILTER (WHERE o.ready_at IS NOT NULL) AS ready_hours
       FROM idesh.supplier s
       LEFT JOIN idesh.idesh_order o ON o.supplier_id = s.id
      WHERE s.state = 'contracted'
      GROUP BY s.id, s.name, s.active
      ORDER BY sales DESC, s.name`,
  );
  const { rows: kinds } = await db.query<{ kind: Kind; unit: Unit; qty: string; orders: number; sales: string }>(
    `SELECT kind, unit, sum(qty) AS qty, count(*)::int AS orders, sum(total_mnt) AS sales
       FROM idesh.idesh_order WHERE handed_at IS NOT NULL
      GROUP BY kind, unit ORDER BY sum(total_mnt) DESC`,
  );
  return {
    today,
    week,
    season,
    suppliers: suppliers.map((r) => ({
      id: String(r['id']),
      name: String(r['name']),
      active: Boolean(r['active']),
      paid: Number(r['paid']),
      handed: Number(r['handed']),
      cancelled: Number(r['cancelled']),
      supplierFault: Number(r['supplier_fault']),
      noShows: Number(r['no_shows']),
      salesMnt: Number(r['sales']),
      commissionMnt: Number(r['commission']),
      readyHours: r['ready_hours'] === null ? null : Math.round(Number(r['ready_hours']) * 10) / 10,
    })),
    byKind: kinds.map((k) => ({ kind: k.kind, unit: k.unit, qty: Number(k.qty), orders: k.orders, salesMnt: Number(k.sales) })),
  };
}
