import '../env.js';
import { parseArgs } from 'node:util';
import { closePool } from '../db/pool.js';
import { buildClock } from '../mode.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { createSupplierCode, registerSupplier } from './index.js';

/**
 * Register a supplier, once the contract is signed.
 *
 *   npm run supplier:add -- --name "Архангай · Дорж" --phone +97688010001 \
 *       --tin 6501234567 --address "Нарантуул, хойд хаалга" --lat 47.9178 --lon 106.9702
 *
 * Prints the supplier's id and an eight-digit pairing code good for a day —
 * long enough to read it over the phone. There is no self-signup on purpose:
 * «баталгаатай» means «has a contract with us», and a form cannot sign one.
 * Listings are the supplier's own business, from their screen.
 */

const CODE_TTL_MINUTES = 24 * 60;

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    phone: { type: 'string' },
    tin: { type: 'string' },
    address: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    label: { type: 'string', default: 'Нийлүүлэгчийн дэлгэц' },
  },
});

const missing = (['name', 'phone', 'address'] as const).filter((k) => !values[k]);
if (missing.length) {
  console.error(`Дутуу: --${missing.join(', --')}`);
  console.error(
    'Хэрэглээ: npm run supplier:add -- --name "…" --phone +976… --address "…" [--tin …] [--lat … --lon …]',
  );
  process.exit(1);
}
if (!/^\+976\d{8}$/.test(values.phone!)) {
  console.error('Утас +976XXXXXXXX хэлбэртэй байх ёстой.');
  process.exit(1);
}

const ctx: Ctx = {
  clock: buildClock(),
  payments: new FakePaymentProvider(),
  tax: new FakeTaxProvider(),
  notifier: new FakeNotifier(),
};

try {
  const id = await registerSupplier({
    name: values.name!,
    phone: values.phone!,
    merchantTin: values.tin ?? null,
    pickupAddress: values.address!,
    lat: values.lat ? Number(values.lat) : null,
    lon: values.lon ? Number(values.lon) : null,
  });
  const code = await createSupplierCode(ctx, id, values.label!, CODE_TTL_MINUTES);

  console.log(`\nНийлүүлэгч бүртгэгдлээ: ${values.name}`);
  console.log(`  id:         ${id}`);
  console.log(`  холбох код: ${code}   (24 цаг хүчинтэй)`);
  console.log(`\nНийлүүлэгч /supplier хуудсанд энэ кодыг оруулаад зараа тавина.\n`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
