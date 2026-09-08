import type { IdeshState } from './states.js';
import type { Receive } from './pricing.js';

/**
 * The money rules of an идэш, as pure functions.
 *
 * Three numbers decided in one sitting (see CONTEXT.md — шимтгэл, суутгал,
 * ирээгүй зочин), written here once so a cancel button, an ops list and a
 * message all agree. Nothing in this file touches a database.
 */

/** Why a supplier cancels. The one the scheduler gives is not on this list. */
export const CANCEL_REASONS = ['guest_asked', 'vet', 'cannot_fulfil', 'no_show', 'unreachable'] as const;
export type SupplierReason = (typeof CANCEL_REASONS)[number];
export type CancelReason = SupplierReason | 'draft_expired';

export const REASON_LABEL: Record<CancelReason, string> = {
  guest_asked: 'Зочин хүссэн',
  vet: 'Мал эмнэлгийн шалгалт',
  cannot_fulfil: 'Нийлүүлэгч биелүүлж чадахгүй',
  no_show: 'Зочин ирээгүй',
  unreachable: 'Хаяг дээр холбогдоогүй',
  draft_expired: 'Төлөгдөөгүй',
};

/** Kept from the guest's refund when the animal was slaughtered on their word. */
export const FORFEIT_PCT = 10;
/** A ready order the guest has not collected this many days after their day. */
export const NO_SHOW_DAYS = 3;
/** Basu's share of the meat price for a new contract. Per contract after that. */
export const DEFAULT_COMMISSION_PCT = 2;

const SUPPLIER_FAULT: readonly CancelReason[] = ['vet', 'cannot_fulfil'];

export function isSupplierFault(reason: CancelReason): boolean {
  return SUPPLIER_FAULT.includes(reason);
}

/** Has the animal been slaughtered in this state? Past PAID it has. */
export function slaughteredIn(state: IdeshState): boolean {
  return state !== 'DRAFT' && state !== 'PAID' && state !== 'CLOSED';
}

export interface Split {
  refundMnt: number;
  forfeitMnt: number;
}

/**
 * What goes back to the guest and what stays with the supplier.
 *
 * Before the animal is slaughtered, or whenever the supplier is at fault,
 * everything goes back. After slaughter on the guest's own change of mind,
 * absence or silence, a tenth of the meat price stays — never of the delivery
 * fee, since no delivery happened.
 */
export function splitRefund(input: {
  state: IdeshState;
  reason: CancelReason;
  meatMnt: number;
  deliveryFeeMnt: number;
}): Split {
  const total = input.meatMnt + input.deliveryFeeMnt;
  if (!slaughteredIn(input.state) || isSupplierFault(input.reason)) {
    return { refundMnt: total, forfeitMnt: 0 };
  }
  const forfeitMnt = Math.round((input.meatMnt * FORFEIT_PCT) / 100);
  return { refundMnt: total - forfeitMnt, forfeitMnt };
}

/** Basu's share of the meat price at this supplier's rate. */
export function commissionOf(meatMnt: number, pct: number): number {
  return Math.round((meatMnt * pct) / 100);
}

/** The first day a supplier may call a guest absent: their day, plus the grace. */
export function noShowFrom(readyAt: Date, receiveOn: string): Date {
  const day = new Date(`${receiveOn}T00:00:00`);
  const from = new Date(Math.max(readyAt.getTime(), day.getTime()));
  from.setDate(from.getDate() + NO_SHOW_DAYS);
  return from;
}

/**
 * May the supplier give this reason for this order, now? The string is what
 * they are told when not — in words, because it is a person pressing.
 */
export function reasonProblem(input: {
  state: IdeshState;
  reason: CancelReason;
  receive: Receive;
  readyAt: Date | null;
  /** `YYYY-MM-DD` */
  receiveOn: string;
  now: Date;
}): string | null {
  switch (input.reason) {
    case 'draft_expired':
      return 'энэ шалтгаан нийлүүлэгчийнх биш';
    case 'no_show': {
      if (input.receive !== 'pickup' || input.state !== 'READY' || !input.readyAt) {
        return 'зочин ирээгүй гэж зөвхөн бэлэн болсон, өөрөө авах захиалгыг цуцална';
      }
      const from = noShowFrom(input.readyAt, input.receiveOn);
      if (input.now < from) {
        return `зочны өдрөөс ${NO_SHOW_DAYS} хоногийн дараа — ${from.getMonth() + 1}-р сарын ${from.getDate()}-нөөс`;
      }
      return null;
    }
    case 'unreachable':
      if (input.receive !== 'delivery' || (input.state !== 'READY' && input.state !== 'DISPATCHED')) {
        return 'хаяг дээр холбогдоогүй гэж зөвхөн бэлэн болсон хүргэлтийг цуцална';
      }
      return null;
    default:
      return null;
  }
}
