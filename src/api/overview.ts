import { allOrders, listSettlements, listSuppliers, statsFor, type Tally } from '../idesh/index.js';
import { guestCensus } from '../platform/identity/index.js';
import { ledgerOverview } from '../platform/ledger/index.js';
import { notifyOverview } from '../platform/notify/index.js';
import { dineOverview } from '../services/overview.js';
import type { PerPeriod } from '../domain/time.js';

/**
 * The whole house on one page.
 *
 * Every module answers for itself through its front door — the desk adds
 * nothing up that a module could not have told it — and this file only lays
 * the answers side by side and says which of them need somebody's attention.
 */

const mnt = (value: number) => `${value.toLocaleString('mn-MN')}₮`;

export interface Alert {
  level: 'bad' | 'warn' | 'info';
  text: string;
  /** Which section of the desk the fix lives in. */
  tab?: string;
}

const pick = (tallies: { today: Tally; week: Tally; season: Tally }, key: keyof Tally): PerPeriod => ({
  today: tallies.today[key],
  week: tallies.week[key],
  season: tallies.season[key],
});

export async function overviewAt(now: Date) {
  const [guests, wallet, notify, dine, idesh, live, suppliers, settlements] = await Promise.all([
    guestCensus(now),
    ledgerOverview(now),
    notifyOverview(now),
    dineOverview(now),
    statsFor(now),
    allOrders({ scope: 'live' }),
    listSuppliers(),
    listSettlements(),
  ]);
  const applied = suppliers.filter((s) => s.state === 'applied').length;
  const due = settlements.filter((t) => t.state === 'due').length;
  const needsAccount = settlements.filter((t) => t.state === 'needs_account').length;

  const alerts: Alert[] = [];
  if (wallet.drift !== 0) alerts.push({ level: 'bad', text: `Ledger тэнцэхгүй байна: зөрүү ${mnt(wallet.drift)}. Гараар бичсэн нэг талын бичилт орсон.`, tab: 'money' });
  if (dine.late > 0) alerts.push({ level: 'bad', text: `Гал тавих ${dine.late} ажил хугацаанаасаа хоцорч байна. Scheduler ажиллаж байгаа эсэхийг шалга.` });
  if (notify.stuck > 0) alerts.push({ level: 'bad', text: `${notify.stuck} мэдэгдэл 10 минутаас дээш дараалалд гацсан. Relay ажиллахгүй байна.` });
  if (notify.failed.today > 0) alerts.push({ level: 'warn', text: `Өнөөдөр ${notify.failed.today} мэдэгдэл илгээгдэж чадсангүй.` });
  if (wallet.receipts.failed > 0) alerts.push({ level: 'warn', text: `${wallet.receipts.failed} е-баримт гаргаж чадсангүй. PosAPI-г шалга.`, tab: 'money' });
  if (wallet.topups.stuck > 0) alerts.push({ level: 'warn', text: `${wallet.topups.stuck} цэнэглэлт хагас цагаас дээш хүлээгдэж байна. QPay callback ирэхгүй байж магадгүй.`, tab: 'money' });
  if (dine.held > 0) alerts.push({ level: 'warn', text: `Хоолны ${dine.held} захиалга түр зогсоосон байна.` });
  if (dine.restaurants.offline > 0) alerts.push({ level: 'warn', text: `${dine.restaurants.offline} рестораны гал тогооны дэлгэц холбогдоогүй.` });
  if (due > 0) alerts.push({ level: 'warn', text: `Шилжүүлэх ${due} мөнгө хүлээж байна.`, tab: 'pay' });
  if (applied > 0) alerts.push({ level: 'info', text: `${applied} нийлүүлэгчийн өргөдөл хариу хүлээж байна.`, tab: 'suppliers' });
  if (needsAccount > 0) alerts.push({ level: 'info', text: `${needsAccount} буцаалт зочны дансыг хүлээж байна.`, tab: 'pay' });

  return {
    as_of: now.toISOString(),
    guests: {
      total: guests.total,
      closed: guests.closed,
      joined: guests.joined,
      active: guests.active,
      sessions_open: guests.sessionsOpen,
    },
    wallet: {
      liability_mnt: wallet.liabilityMnt,
      payable_mnt: wallet.payableMnt,
      revenue_mnt: wallet.revenueMnt,
      revenue: wallet.revenue,
      topups: {
        pending: wallet.topups.pending,
        stuck: wallet.topups.stuck,
        settled: wallet.topups.settled,
        settled_mnt: wallet.topups.settledMnt,
        failed: wallet.topups.failed,
      },
      purchases: { count: wallet.purchases.count, mnt: wallet.purchases.mnt },
      refunds: { count: wallet.refunds.count, mnt: wallet.refunds.mnt },
      receipts: wallet.receipts,
      drift: wallet.drift,
    },
    dine: {
      live: dine.live,
      held: dine.held,
      late: dine.late,
      restaurants: dine.restaurants,
      placed: dine.placed,
      sales_mnt: dine.salesMnt,
      closed: dine.closed,
      cancelled: dine.cancelled,
      no_shows: dine.noShows,
    },
    idesh: {
      live: live.length,
      applied,
      settlements: { due, needs_account: needsAccount },
      paid: pick(idesh, 'paid'),
      sales_mnt: pick(idesh, 'salesMnt'),
      handed: pick(idesh, 'handed'),
      commission_mnt: pick(idesh, 'commissionMnt'),
      cancelled: pick(idesh, 'cancelled'),
      refund_mnt: pick(idesh, 'refundMnt'),
    },
    notify: {
      queued: notify.queued,
      stuck: notify.stuck,
      devices: notify.devices,
      sent: notify.sent,
      failed: notify.failed,
      sms: notify.sms,
      push: notify.push,
    },
    alerts,
  };
}
