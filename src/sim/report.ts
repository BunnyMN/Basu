import { diffMinutes } from '../domain/time.js';
import { percentile } from './rng.js';
import type { SimOrder, SimResult } from './simulateDay.js';

/**
 * The numbers the daily ops report is meant to carry (§13 of the technical
 * spec), computed off a simulated day so we can watch them move while the
 * engine is still being written.
 */
export interface SimMetrics {
  orders: number;
  fired: number;
  served: number;
  noShow: number;
  /** Fired, but the guest never sat: the expensive failure. */
  firedAndAbandoned: number;
  /** Never fired and not a no-show — a ticket the kitchen was never told about. */
  stranded: number;

  /** ready − seated, in minutes. Negative means the food waited. */
  accuracy: { p50: number; p85: number; p95: number; withinThree: number };
  /** How long a seated guest waited for food. The product's one promise. */
  ttfb: { p50: number; p85: number; underThree: number };

  heldShare: number;
  manualShare: number;
  autoShare: number;
  /** Fired only because the guest was already seated — a miss, not a choice. */
  rescueShare: number;
  replansPerOrder: number;

  doubleFires: number;
  overloads: number;
  illegalTransitions: number;
}

const share = (n: number, total: number) => (total === 0 ? 0 : n / total);

export function measure(result: SimResult): SimMetrics {
  const { orders } = result;
  const fired = orders.filter((o) => o.firedAt);
  const seatedAndReady = orders.filter((o) => o.readyAt && o.seatedAt);

  const accuracy = seatedAndReady.map((o) => diffMinutes(o.readyAt!, o.seatedAt!));
  const ttfb = seatedAndReady.map((o) => Math.max(0, diffMinutes(o.readyAt!, o.seatedAt!)));

  const counts = new Map<string, number>();
  for (const order of fired) {
    counts.set(order.id, (counts.get(order.id) ?? 0) + order.fireCount);
  }

  return {
    orders: orders.length,
    fired: fired.length,
    served: orders.filter((o) => o.state === 'SERVED').length,
    noShow: orders.filter((o) => o.trueArrivalAt === null).length,
    firedAndAbandoned: fired.filter((o) => !o.seatedAt).length,
    stranded: orders.filter((o) => !o.firedAt && o.trueArrivalAt !== null).length,

    accuracy: {
      p50: percentile(accuracy.map(Math.abs), 50),
      p85: percentile(accuracy.map(Math.abs), 85),
      p95: percentile(accuracy.map(Math.abs), 95),
      withinThree: share(accuracy.filter((d) => Math.abs(d) <= 3).length, accuracy.length),
    },
    ttfb: {
      p50: percentile(ttfb, 50),
      p85: percentile(ttfb, 85),
      underThree: share(ttfb.filter((t) => t < 3).length, ttfb.length),
    },

    heldShare: share(orders.filter((o) => o.heldMinutes > 0).length, orders.length),
    manualShare: share(fired.filter((o) => o.firedBy === 'manual').length, fired.length),
    autoShare: share(fired.filter((o) => o.firedBy === 'auto').length, fired.length),
    rescueShare: share(fired.filter((o) => o.firedBy === 'rescue').length, fired.length),
    replansPerOrder:
      orders.length === 0
        ? 0
        : orders.reduce((sum, o) => sum + o.replans, 0) / orders.length,

    doubleFires: orders.filter((o) => o.fireCount > 1).length,
    overloads: result.overloads.length,
    illegalTransitions: result.illegalTransitions.length,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const min = (v: number) => (Number.isNaN(v) ? '—' : `${v.toFixed(1)} мин`);

function verdict(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** The five dish names that drifted furthest — the weekly calibration list. */
export function worstDishes(result: SimResult, limit = 5): Array<[string, number]> {
  const drift = new Map<string, { total: number; n: number }>();
  for (const order of result.orders) {
    if (!order.readyAt || !order.seatedAt) continue;
    const delta = Math.abs(diffMinutes(order.readyAt, order.seatedAt));
    for (const l of order.lines) {
      const entry = drift.get(l.name) ?? { total: 0, n: 0 };
      entry.total += delta;
      entry.n += 1;
      drift.set(l.name, entry);
    }
  }
  return [...drift.entries()]
    .map(([name, { total, n }]) => [name, total / n] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function formatReport(result: SimResult): string {
  const m = measure(result);
  const c = result.config;
  const lines: string[] = [];

  lines.push(`Өдрийн симуляц · seed ${c.seed}`);
  lines.push(
    `${c.restaurants} ресторан × ${c.ordersPerRestaurant} захиалга · ` +
      `${c.arrivalSpread === 'bunched' ? 'оргилтой' : 'жигд'} урсгал · ` +
      `дохиогүй ${pct(c.signalDropRate)} · хоцрогч ${pct(c.lateRate)}`,
  );
  lines.push('');

  lines.push('ХАТУУ НӨХЦӨЛ');
  lines.push(`  ${verdict(m.doubleFires === 0)} давхар галлалт            ${m.doubleFires}`);
  lines.push(`  ${verdict(m.overloads === 0)} станцын ачаалал хэтрэлт    ${m.overloads}`);
  lines.push(
    `  ${verdict(m.illegalTransitions === 0)} хууль бус шилжилт          ${m.illegalTransitions}`,
  );
  lines.push('');

  lines.push('ГҮЙЦЭТГЭЛ');
  lines.push(`  Захиалга                    ${m.orders}`);
  lines.push(`  Галласан                    ${m.fired} (${pct(share(m.fired, m.orders))})`);
  lines.push(`  Галлагдаагүй үлдсэн         ${m.stranded}`);
  lines.push(`  No-show                     ${m.noShow} (${pct(share(m.noShow, m.orders))})`);
  lines.push(`  Галласан ч ирээгүй          ${m.firedAndAbandoned}`);
  lines.push('');

  lines.push('НАРИЙВЧЛАЛ  |ready − seated|');
  lines.push(`  p50 ${min(m.accuracy.p50)}   p85 ${min(m.accuracy.p85)}   p95 ${min(m.accuracy.p95)}`);
  lines.push(
    `  ${verdict(m.accuracy.withinThree >= 0.85)} ±3 минутад багтсан        ` +
      `${pct(m.accuracy.withinThree)}  (зорилт 85%)`,
  );
  lines.push('');

  lines.push('TTFB  зочин ширээндээ хүлээсэн');
  lines.push(`  p50 ${min(m.ttfb.p50)}   p85 ${min(m.ttfb.p85)}`);
  lines.push(
    `  ${verdict(m.ttfb.underThree >= 0.6)} 3 минутаас бага           ` +
      `${pct(m.ttfb.underThree)}  (зорилт 60%)`,
  );
  lines.push('');

  lines.push('АЖИЛЛАГАА');
  lines.push(
    `  ${verdict(m.heldShare <= 0.03)} HELD                      ${pct(m.heldShare)}  (зорилт ≤3%)`,
  );
  lines.push(
    `  ${verdict(m.manualShare <= 0.15)} гараар галласан           ${pct(m.manualShare)}  (зорилт ≤15%)`,
  );
  lines.push(`    автоматаар                ${pct(m.autoShare)}`);
  lines.push(
    `  ${verdict(m.rescueShare <= 0.05)} аврах галлалт             ${pct(m.rescueShare)}  (зочин аль хэдийн сууснаас)`,
  );
  lines.push(`    дахин төлөвлөлт/захиалга  ${m.replansPerOrder.toFixed(2)}`);
  lines.push('');

  lines.push('ХАМГИЙН ИХ ЗӨРСӨН ХООЛ  (7 хоногийн тохируулгын жагсаалт)');
  for (const [name, drift] of worstDishes(result)) {
    lines.push(`  ${name.padEnd(20)} ${drift.toFixed(1)} мин`);
  }

  return lines.join('\n');
}

export function firstFailure(result: SimResult): string | null {
  const m = measure(result);
  if (m.doubleFires > 0) return `${m.doubleFires} orders fired more than once`;
  if (m.overloads > 0) {
    const o = result.overloads[0]!;
    return `station ${o.station} at ${o.restaurantId} ran ${o.used} lanes`;
  }
  if (m.illegalTransitions > 0) return result.illegalTransitions[0]!;
  return null;
}

export type { SimOrder };
