import { IdeshError } from './errors.js';

/**
 * What an order costs, and whether the listing can take it.
 *
 * Pure: no clock, no database. `today` is handed in because the rule that a
 * date must not be in the past is only testable if the test says what day it
 * is — the same reason nothing in src/domain reads Date.now().
 */

export type Unit = 'whole' | 'kg';
export type Receive = 'delivery' | 'pickup';

export interface Offer {
  unit: Unit;
  priceMnt: number;
  minQty: number;
  quantity: number;
  sold: number;
  delivers: boolean;
  deliveryFeeMnt: number;
  /** `YYYY-MM-DD`, the restaurant-zone calendar day. */
  readyFrom: string;
}

export interface Want {
  qty: number;
  receive: Receive;
  /** `YYYY-MM-DD` */
  receiveOn: string;
}

export interface Quote {
  qty: number;
  unitPriceMnt: number;
  deliveryFeeMnt: number;
  totalMnt: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Refuses rather than rounding: a quantity under the minimum, a delivery from
 * a supplier who does not deliver, or a day before the meat exists are all
 * things the page should have stopped — and a request that gets past the page
 * is exactly the one that must not be quietly accepted.
 */
export function quote(offer: Offer, want: Want, today: string): Quote {
  if (!Number.isInteger(want.qty) || want.qty <= 0) {
    throw new IdeshError('TOO_FEW', 'quantity has to be a positive whole number');
  }
  if (want.qty < offer.minQty) {
    throw new IdeshError('TOO_FEW', `the smallest order is ${offer.minQty}`);
  }
  if (offer.sold + want.qty > offer.quantity) {
    throw new IdeshError('SOLD_OUT', `only ${offer.quantity - offer.sold} left`);
  }
  if (want.receive === 'delivery' && !offer.delivers) {
    throw new IdeshError('NO_DELIVERY', 'this supplier does not deliver');
  }
  if (!DAY.test(want.receiveOn)) {
    throw new IdeshError('BAD_DATE', 'receive_on must be YYYY-MM-DD');
  }
  // Calendar days compare as strings when they are written this way.
  if (want.receiveOn < offer.readyFrom) {
    throw new IdeshError('BAD_DATE', `nothing is ready before ${offer.readyFrom}`);
  }
  if (want.receiveOn < today) {
    throw new IdeshError('BAD_DATE', 'that day has passed');
  }

  const deliveryFeeMnt = want.receive === 'delivery' ? offer.deliveryFeeMnt : 0;
  return {
    qty: want.qty,
    unitPriceMnt: offer.priceMnt,
    deliveryFeeMnt,
    totalMnt: offer.priceMnt * want.qty + deliveryFeeMnt,
  };
}

/** `2026-11-03` in Ulaanbaatar for any instant. The vertical's calendar. */
export function dayOf(at: Date, timeZone = 'Asia/Ulaanbaatar'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
