import '../env.js';
import { parseArgs } from 'node:util';
import { closePool } from '../db/pool.js';
import { accountByContact } from '../platform/identity/index.js';
import { registerSupplier } from './index.js';

/**
 * Register a supplier, once the contract is signed.
 *
 *   npm run supplier:add -- --name "Архангай · Дорж" --phone +97688010001 \
 *       --tin 6501234567 --address "Нарантуул, хойд хаалга" --lat 47.9178 --lon 106.9702 \
 *       [--owner dorj@gmail.com]
 *
 * The owner is a Basu account that already exists — named by `--owner`, a
 * phone or an email, or by `--phone` when that is left out. The person signs
 * in to Basu first; the business is then theirs, and everybody who works
 * there comes in by the roles they give.
 *
 * Prints the supplier's id. «Баталгаатай» means «has a contract with us»;
 * the owner then signs in to /supplier as themselves, puts up the listings,
 * and gives the people who work there their roles.
 */

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    phone: { type: 'string' },
    owner: { type: 'string' },
    tin: { type: 'string' },
    address: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
  },
});

const missing = (['name', 'phone', 'address'] as const).filter((k) => !values[k]);
if (missing.length) {
  console.error(`Дутуу: --${missing.join(', --')}`);
  console.error(
    'Хэрэглээ: npm run supplier:add -- --name "…" --phone +976… --address "…" [--owner утас/имэйл] [--tin …] [--lat … --lon …]',
  );
  process.exit(1);
}
if (!/^\+976\d{8}$/.test(values.phone!)) {
  console.error('Утас +976XXXXXXXX хэлбэртэй байх ёстой.');
  process.exit(1);
}

try {
  const owner = await accountByContact(values.owner ?? values.phone!);
  if (!owner) {
    throw new Error(`${values.owner ?? values.phone} — Basu-д бүртгэлгүй. Эзэмшигч эхлээд Basu-д нэвтэрч бүртгүүлнэ.`);
  }
  const id = await registerSupplier({
    ownerId: owner.guestId,
    name: values.name!,
    phone: values.phone!,
    merchantTin: values.tin ?? null,
    pickupAddress: values.address!,
    lat: values.lat ? Number(values.lat) : null,
    lon: values.lon ? Number(values.lon) : null,
  });

  console.log(`\nНийлүүлэгч бүртгэгдлээ: ${values.name}`);
  console.log(`  id:       ${id}`);
  console.log(`  эзэмшигч: ${owner.name ?? owner.email ?? owner.phone}`);
  console.log(`\nЭзэмшигч /supplier хуудсанд өөрийн бүртгэлээр нэвтэрч зараа тавина.\n`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
