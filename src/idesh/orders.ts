import { getPool, tx, type Db } from '../db/pool.js';
import { displayNamesFor } from '../platform/identity/index.js';
import {
  collect,
  queueReceipt,
  receiptsFor,
  refund as refundToWallet,
} from '../platform/ledger/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { IdeshError } from './errors.js';
import type { Kind } from './listings.js';
import { dayOf, quote, type Receive, type Unit } from './pricing.js';
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
 * Cancel, and give back whatever there is to give back.
 *
 * A supplier may cancel at any point short of the handover — an order the
 * guest asked them to undo, or an animal that failed the vet — and the guest
 * is refunded in full either way. Past PREPARING the animal has been
 * slaughtered and does not go back on offer.
 */
export async function cancelIdesh(
  ctx: Ctx,
  orderId: string,
  by: CancelledBy,
  reason = 'cancelled',
): Promise<{ refunded: boolean }> {
  const now = ctx.clock.now();
  const facts = await billingFacts(orderId);
  if (!facts) throw new IdeshError('NOT_FOUND', 'no such order');

  const from: readonly IdeshState[] = ['DRAFT', 'PAID', 'PREPARING', 'READY', 'DISPATCHED'];

  const cancelled = await tx(async (client) => {
    const ok = await transition(client, orderId, from, 'CANCELLED', {
      cancelled_at: now,
      cancelled_by: by.actor,
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
    await appendEvent(client, orderId, 'CANCELLED', by.actor, { reason, from: facts.state });
    return true;
  });

  if (!cancelled) throw new IdeshError('WRONG_STATE', `cannot cancel in ${facts.state}`);

  if (!facts.transferId) {
    // Never paid: nothing to give back, and nothing left to watch.
    await tx(async (client) => {
      await transition(client, orderId, ['CANCELLED'], 'CLOSED', { closed_at: now });
    });
    return { refunded: false };
  }

  await refund(ctx, orderId, reason);
  return { refunded: true };
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
  await tx(async (client) => {
    const ok = await transition(client, orderId, ['READY', 'DISPATCHED'], 'HANDED', {
      handed_at: now,
    });
    if (!ok) throw new IdeshError('WRONG_STATE', 'this order is not ready to hand over');
    await appendEvent(client, orderId, 'HANDED', actor);
  });

  const facts = await billingFacts(orderId);
  if (!facts) return;
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
      await cancelIdesh(ctx, row.id, { actor: 'system:scheduler', role: 'system' }, 'draft expired');
      expired++;
    } catch {
      // Paid in the meantime, or already cancelled: not ours any more.
    }
  }

  const { rows: done } = await db.query<{ id: string }>(
    `SELECT id FROM idesh.idesh_order
      WHERE state = 'HANDED' AND handed_at < $1::timestamptz - make_interval(hours => $2)`,
    [now, HANDED_TTL_HOURS],
  );
  let closed = 0;
  for (const row of done) {
    await tx(async (client) => {
      const ok = await transition(client, row.id, ['HANDED'], 'CLOSED', { closed_at: now });
      if (ok) {
        await appendEvent(client, row.id, 'CLOSED', 'system:scheduler');
        closed++;
      }
    });
  }

  return { expired, closed };
}

/* ── money back ────────────────────────────────────────────────────── */

/**
 * Into the wallet, on the same two accounts the purchase used, so the pair
 * nets to zero and reads as one story in the statement.
 */
async function refund(ctx: Ctx, orderId: string, reason: string): Promise<void> {
  const facts = await billingFacts(orderId);
  if (!facts?.transferId) return;

  const transferId = await refundToWallet({
    guestId: facts.guestId,
    amountMnt: facts.totalMnt,
    subject: 'idesh',
    subjectId: orderId,
    memo: `Идэш · буцаалт №${facts.code}`,
    idempotencyKey: `idesh:${orderId}:refund`,
  });

  await tx(async (client) => {
    await transition(client, orderId, ['CANCELLED'], 'REFUNDED');
    await appendEvent(client, orderId, 'REFUNDED', 'system:payments', {
      amountMnt: facts.totalMnt,
      reason,
    });
  });
  await queueReceipt({
    transferId,
    kind: 'RETURN',
    merchantTin: facts.merchantTin,
    orderCode: facts.code,
    amountMnt: facts.totalMnt,
  });

  await enqueue(ctx, {
    guestId: facts.guestId,
    subject: 'idesh',
    subjectId: orderId,
    template: 'idesh.refunded',
    channel: 'push',
    title: 'Идэш цуцлагдлаа',
    body: `№${facts.code}: ${facts.totalMnt.toLocaleString('mn-MN')}₮ түрийвчинд чинь буцаж орлоо.`,
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
  code: string;
  state: IdeshState;
  title: string;
  qty: number;
  totalMnt: number;
  receive: Receive;
  receiveOn: string;
  addressPhone: string | null;
  supplier: string;
  pickupAddress: string;
  merchantTin: string;
  transferId: string | null;
} | null> {
  const { rows } = await getPool().query<{
    guest_id: string;
    listing_id: string;
    code: string;
    state: IdeshState;
    title: string;
    qty: number;
    total_mnt: number;
    receive: Receive;
    receive_on: string;
    address_phone: string | null;
    supplier: string;
    pickup_address: string;
    tin: string | null;
    ledger_transfer_id: string | null;
  }>(
    `SELECT o.guest_id, o.listing_id, o.code, o.state, o.title, o.qty, o.total_mnt, o.receive,
            to_char(o.receive_on, 'YYYY-MM-DD') AS receive_on, o.address_phone,
            o.ledger_transfer_id, s.name AS supplier, s.pickup_address,
            s.ebarimt_merchant_tin AS tin
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
    code: row.code,
    state: row.state,
    title: row.title,
    qty: row.qty,
    totalMnt: row.total_mnt,
    receive: row.receive,
    receiveOn: row.receive_on,
    addressPhone: row.address_phone,
    supplier: row.supplier,
    pickupAddress: row.pickup_address,
    merchantTin: row.tin ?? 'UNSET',
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
}

const ORDER_SELECT = `
  SELECT o.id, o.code, o.state, o.supplier_id, s.name AS supplier, s.phone AS supplier_phone,
         s.pickup_address, s.lat AS pickup_lat, s.lon AS pickup_lon, o.guest_id,
         o.kind, o.unit, o.title, o.origin, o.qty, o.unit_price_mnt, o.delivery_fee_mnt,
         o.total_mnt, o.receive, to_char(o.receive_on, 'YYYY-MM-DD') AS receive_on,
         o.address, o.address_phone, o.address_lat, o.address_lon, o.ledger_transfer_id,
         o.paid_at, o.preparing_at, o.ready_at, o.dispatched_at, o.handed_at
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
  const { rows } = await db.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE o.guest_id = $1 AND o.state = ANY($2::text[])
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
  address: string | null;
  addressPhone: string | null;
  addressLat: number | null;
  addressLon: number | null;
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

  const lanes: Board['lanes'] = { paid: [], preparing: [], ready: [], dispatched: [] };
  for (const r of rows) {
    const ticket: BoardTicket = {
      ...summary(r),
      guest: names.get(r.guest_id) ?? null,
      address: r.address,
      addressPhone: r.address_phone,
      addressLat: r.address_lat === null ? null : Number(r.address_lat),
      addressLon: r.address_lon === null ? null : Number(r.address_lon),
    };
    if (r.state === 'PAID') lanes.paid.push(ticket);
    else if (r.state === 'PREPARING') lanes.preparing.push(ticket);
    else if (r.state === 'READY') lanes.ready.push(ticket);
    else lanes.dispatched.push(ticket);
  }

  return { supplier, lanes };
}
