import { formatReport } from './report.js';
import { simulateDay, DEFAULT_SIM } from './simulateDay.js';

/**
 * `npm run sim` — one lunch service, printed.
 *
 * Flags mirror the config: --seed 7 --restaurants 20 --spread even
 * --signal-drop 0.6 --late 0.4 --slot-cap 8
 */
function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const spreadIndex = process.argv.indexOf('--spread');
const spread =
  spreadIndex !== -1 && process.argv[spreadIndex + 1] === 'even' ? 'even' : DEFAULT_SIM.arrivalSpread;

const started = performance.now();
const result = simulateDay({
  seed: flag('seed', DEFAULT_SIM.seed),
  restaurants: flag('restaurants', DEFAULT_SIM.restaurants),
  ordersPerRestaurant: flag('orders', DEFAULT_SIM.ordersPerRestaurant),
  signalDropRate: flag('signal-drop', DEFAULT_SIM.signalDropRate),
  lateRate: flag('late', DEFAULT_SIM.lateRate),
  noShowRate: flag('no-show', DEFAULT_SIM.noShowRate),
  maxOrdersPerSlot: flag('slot-cap', DEFAULT_SIM.maxOrdersPerSlot),
  arrivalSpread: spread,
});
const elapsed = performance.now() - started;

console.log(formatReport(result));
console.log('');
console.log(`3 цаг 45 минутын үйлчилгээ ${elapsed.toFixed(0)} мс-д дуусав.`);
