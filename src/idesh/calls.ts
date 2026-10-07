import { getPool, type Db } from '../db/pool.js';
import { displayNamesFor } from '../platform/identity/index.js';
import { accessIn, membersOf } from '../platform/org/index.js';

/**
 * Who an идэш order lets ring whom, and until when.
 *
 * The same two people, and the same window, as the phone number the order
 * already shows once it is paid: the guest who bought, and the people at
 * the supplier who handle orders. From the payment until the meat is handed
 * over, and for a few days after — a question about the meat still has
 * somebody to ask — never before payment, and never about a cancelled one.
 */
export const CALL_DAYS_AFTER_HANDOVER = 3;

const CALLING_STATES = new Set(['PAID', 'PREPARING', 'READY', 'DISPATCHED']);

/** The permission a person at the supplier needs to be rung: the one that opens the orders. */
const ORDERS = 'org.idesh.orders';

export interface CallTerms {
  /** Which side the person asking is on. */
  side: 'guest' | 'supplier';
  /** Whether a call may start now. */
  open: boolean;
  /** Everybody to ring on the other side. */
  ring: string[];
  /** What the people rung see: the guest's name, or the business's — never one cook's. */
  callerName: string;
  /** What the caller sees of the other side. */
  calleeName: string;
  about: string;
}

/** Null for anybody who is not on either side of this order. */
export async function callTermsFor(orderId: string, guestId: string, now: Date, db: Db = getPool()): Promise<CallTerms | null> {
  const { rows } = await db.query<{
    code: string;
    state: string;
    guest_id: string;
    handed_at: Date | null;
    supplier: string;
    owner_guest_id: string | null;
    org_id: string | null;
  }>(
    `SELECT o.code, o.state, o.guest_id, o.handed_at, s.name AS supplier, s.owner_guest_id, s.org_id
       FROM idesh.idesh_order o JOIN idesh.supplier s ON s.id = o.supplier_id
      WHERE o.id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) return null;

  const handlesOrders = async (person: string) =>
    person === o.owner_guest_id || Boolean(o.org_id && (await accessIn(o.org_id, person, db))?.grants.has(ORDERS));

  let side: CallTerms['side'];
  if (o.guest_id === guestId) side = 'guest';
  else if (await handlesOrders(guestId)) side = 'supplier';
  else return null;

  const open =
    CALLING_STATES.has(o.state) ||
    (o.state === 'HANDED' && o.handed_at !== null && now.getTime() - o.handed_at.getTime() < CALL_DAYS_AFTER_HANDOVER * 86_400_000);

  // The name the guest chose; without one, what the supplier's lists show — the last digits — said to be the guest.
  const chosen = (await displayNamesFor([o.guest_id], { fallback: false })).get(o.guest_id);
  const digits = chosen ? null : (await displayNamesFor([o.guest_id])).get(o.guest_id);
  const guestName = chosen ?? (digits ? `Захиалагч ${digits}` : 'Захиалагч');
  let ring: string[];
  if (side === 'guest') {
    const people = new Set<string>(o.owner_guest_id ? [o.owner_guest_id] : []);
    for (const m of o.org_id ? await membersOf(o.org_id, db) : []) {
      if (await handlesOrders(m.guestId)) people.add(m.guestId);
    }
    ring = [...people];
  } else {
    ring = [o.guest_id];
  }
  ring = ring.filter((person) => person !== guestId);

  return {
    side,
    open,
    ring,
    callerName: side === 'guest' ? guestName : o.supplier,
    calleeName: side === 'guest' ? o.supplier : guestName,
    about: `Идэш №${o.code}`,
  };
}
