import { allOrders, guestsByDeliveryPhone } from '../idesh/index.js';
import { closeAccount, findGuests, guestCard, guestCards, sessionsOf } from '../platform/identity/index.js';
import { balance, wallet } from '../platform/ledger/index.js';
import { devicesOf, inbox } from '../platform/notify/index.js';
import { dineOrdersOf } from '../services/guestOrders.js';
import { liveOrderCount } from '../services/orders.js';
import { shapeOrder } from './shapes.js';

/**
 * One person, as the desk sees them: who they are, what they hold, what they
 * ordered on either side of the house, what we told them. Each module answers
 * for its own part; nothing here is joined that a module did not hand over.
 */

const shapeCard = (g: NonNullable<Awaited<ReturnType<typeof guestCard>>>) => ({
  id: g.id,
  phone: g.phone,
  email: g.email,
  ways: g.ways,
  name: g.name,
  joined_at: g.joinedAt.toISOString(),
  closed_at: g.closedAt?.toISOString() ?? null,
});

/**
 * Guests by what the desk has in front of it: a name, an address, a number.
 * Somebody who signed up by email has no phone of their own — but the one
 * they gave for a delivery is the one they call from, so a number finds them
 * by their orders too, after the accounts whose own number it is, each
 * saying which delivery number found it.
 */
export async function guestSearch(q: string) {
  const found = await findGuests(q, 200);
  const digits = q.replace(/\D/g, '');
  if (digits.length < 4) return { guests: found.map(shapeCard) };
  const seen = new Set(found.map((g) => g.id));
  const byDelivery = (await guestsByDeliveryPhone(digits)).filter((hit) => !seen.has(hit.guestId));
  const cards = await guestCards(byDelivery.map((hit) => hit.guestId));
  const more = byDelivery.flatMap((hit) => {
    const card = cards.get(hit.guestId);
    return card ? [{ ...shapeCard(card), delivery_phone: hit.phone }] : [];
  });
  return { guests: [...found.map(shapeCard), ...more] };
}

export async function guestFile(guestId: string) {
  const card = await guestCard(guestId);
  if (!card) return null;
  const [statement, sessions, devices, dine, idesh, messages] = await Promise.all([
    wallet(guestId, 50),
    sessionsOf(guestId),
    devicesOf(guestId),
    dineOrdersOf(guestId),
    allOrders({ scope: 'all', guestId }),
    inbox(guestId, 30),
  ]);
  return {
    guest: shapeCard(card),
    wallet: {
      balance_mnt: statement.balanceMnt,
      lines: statement.lines.map((l) => ({
        id: l.transferId,
        kind: l.kind,
        amount_mnt: l.amountMnt,
        subject: l.subject,
        subject_id: l.subjectId,
        memo: l.memo,
        at: l.at.toISOString(),
      })),
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label,
      created_at: s.createdAt.toISOString(),
      last_seen_at: s.lastSeenAt?.toISOString() ?? null,
      expires_at: s.expiresAt.toISOString(),
    })),
    devices: devices.map((d) => ({ id: d.id, platform: d.platform, label: d.label, last_seen_at: d.lastSeenAt?.toISOString() ?? null })),
    dine_orders: dine.map((o) => ({
      id: o.id,
      code: o.code,
      state: o.state,
      restaurant: o.restaurant,
      party_size: o.partySize,
      total_mnt: o.totalMnt,
      slot_starts_at: o.slotStartsAt.toISOString(),
      created_at: o.createdAt.toISOString(),
    })),
    idesh_orders: idesh.map(shapeOrder),
    messages: messages.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      template: m.template,
      channel: m.channel,
      state: m.state,
      created_at: m.createdAt.toISOString(),
      read_at: m.readAt?.toISOString() ?? null,
    })),
  };
}

/** The desk closing an account on somebody's behalf, under the same two refusals the app has. */
export async function closeGuest(guestId: string, at: Date): Promise<void> {
  const [balanceMnt, lunches, meat] = await Promise.all([
    balance(guestId),
    liveOrderCount(guestId),
    allOrders({ scope: 'live', guestId }),
  ]);
  await closeAccount({ guestId, at, balanceMnt, liveWork: lunches + meat.length });
}
