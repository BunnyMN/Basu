import type { Db } from '../db/pool.js';
import {
  applySupplier,
  createListing,
  createSupplierCode,
  pairSupplier,
  registerSupplier,
  type Kind,
  type Unit,
} from '../idesh/index.js';
import { startSession } from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';

/**
 * Four suppliers under contract and what they are selling this autumn.
 *
 * Four rather than one because the guest's page is a comparison — a herder
 * from Архангай beside an abattoir in town, whole animals beside meat by the
 * kilogram, one who delivers and one who does not. A single supplier shows the
 * shape of the page and none of the choice.
 */

interface SeedSupplier {
  name: string;
  phone: string;
  tin: string;
  pickup: string;
  lat: number;
  lon: number;
}

export const SUPPLIERS: SeedSupplier[] = [
  {
    name: 'Архангай · Доржийн хот айл',
    phone: '+97688010001',
    tin: '6501234567',
    pickup: 'Баянзүрх дүүрэг, Нарантуул захын хойд хаалга, 3-р зогсоол',
    lat: 47.9178,
    lon: 106.9702,
  },
  {
    name: 'Хэнтий · «Хэрлэн» хоршоо',
    phone: '+97688010002',
    tin: '6502345678',
    pickup: 'Сонгинохайрхан дүүрэг, Эмээлтийн махны зах, 12-р байр',
    lat: 47.9067,
    lon: 106.7801,
  },
  {
    name: 'Төв аймаг · «Баянговь» ферм',
    phone: '+97688010003',
    tin: '6503456789',
    pickup: 'Хан-Уул дүүрэг, Зайсан, «Баянговь» дэлгүүр',
    lat: 47.8873,
    lon: 106.9241,
  },
  {
    name: 'Улаанбаатар махны төв',
    phone: '+97688010004',
    tin: '6504567890',
    pickup: 'Сүхбаатар дүүрэг, Бага тойруу 24, махны төв',
    lat: 47.9208,
    lon: 106.9091,
  },
];

interface SeedListing {
  supplier: number;
  kind: Kind;
  unit: Unit;
  title: string;
  note?: string;
  price: number;
  approxKg?: number;
  minQty?: number;
  quantity: number;
  origin: string;
  /** Days after the demo day. */
  readyIn: number;
  delivers: boolean;
  fee?: number;
}

export const LISTINGS: SeedListing[] = [
  // ── the herder: whole animals, honest weights, will deliver ─────────
  { supplier: 0, kind: 'sheep', unit: 'whole', title: 'Хонь, залуу ирэг', note: 'Их тамирын бэлчээрийн хонь. Толгой, дотор мөнтэйгээ.', price: 460_000, approxKg: 38, quantity: 20, origin: 'Архангай, Их тамир', readyIn: 12, delivers: true, fee: 25_000 },
  { supplier: 0, kind: 'sheep', unit: 'whole', title: 'Хонь, том эм', note: 'Өвөлжилтөнд тохирсон тарган хонь.', price: 520_000, approxKg: 44, quantity: 12, origin: 'Архангай, Их тамир', readyIn: 12, delivers: true, fee: 25_000 },
  { supplier: 0, kind: 'goat', unit: 'whole', title: 'Ямаа, серх', note: 'Уулын ямаа. Хониноос бага өөхтэй.', price: 380_000, approxKg: 30, quantity: 15, origin: 'Архангай, Их тамир', readyIn: 12, delivers: true, fee: 25_000 },
  { supplier: 0, kind: 'horse', unit: 'whole', title: 'Адуу, гүү', note: 'Бүтэн гулууз. Хоёр айл хувааж авахад тохиромжтой.', price: 1_950_000, approxKg: 180, quantity: 4, origin: 'Архангай, Их тамир', readyIn: 20, delivers: true, fee: 45_000 },

  // ── the co-op: beef by the head, and cut by the kilo, pickup only ───
  { supplier: 1, kind: 'beef', unit: 'whole', title: 'Үхэр, шар', note: 'Хэрлэнгийн үхэр. Нядалж, дөрөв хуваагаад өгнө.', price: 2_600_000, approxKg: 220, quantity: 6, origin: 'Хэнтий, Хэрлэн', readyIn: 18, delivers: false },
  { supplier: 1, kind: 'beef', unit: 'kg', title: 'Үхрийн мах, кг-аар', note: 'Хагас гулуузаас зүсэж өгнө. Доод тал нь 20 кг.', price: 13_500, minQty: 20, quantity: 600, origin: 'Хэнтий, Хэрлэн', readyIn: 18, delivers: false },
  { supplier: 1, kind: 'sheep', unit: 'kg', title: 'Хонины мах, кг-аар', note: 'Ясгүй биш, ястай. Доод тал нь 10 кг.', price: 12_000, minQty: 10, quantity: 300, origin: 'Хэнтий, Хэрлэн', readyIn: 10, delivers: false },

  // ── the farm: fat animals, fed on hay, dearer, delivers for a fee ───
  { supplier: 2, kind: 'sheep', unit: 'whole', title: 'Хонь, фермийн тарган', note: 'Өвсөөр бордсон. 45 кг орчим.', price: 590_000, approxKg: 46, quantity: 30, origin: 'Төв аймаг, Баянчандмань', readyIn: 8, delivers: true, fee: 20_000 },
  { supplier: 2, kind: 'beef', unit: 'whole', title: 'Үхэр, бяруу', note: 'Залуу үхэр, зөөлөн мах. Хоёр айлд тохирно.', price: 1_650_000, approxKg: 140, quantity: 8, origin: 'Төв аймаг, Баянчандмань', readyIn: 14, delivers: true, fee: 35_000 },
  { supplier: 2, kind: 'goat', unit: 'whole', title: 'Ямаа, ишиг', note: 'Жижиг, нэг айлд.', price: 260_000, approxKg: 20, quantity: 25, origin: 'Төв аймаг, Баянчандмань', readyIn: 8, delivers: true, fee: 20_000 },

  // ── the abattoir in town: ready soon, by the kilo, delivers cheaply ──
  { supplier: 3, kind: 'beef', unit: 'kg', title: 'Үхрийн мах, кг-аар', note: 'Өнөөдөр нядалсан. Доод тал нь 15 кг.', price: 14_500, minQty: 15, quantity: 900, origin: 'Улаанбаатар, Эмээлт', readyIn: 2, delivers: true, fee: 10_000 },
  { supplier: 3, kind: 'sheep', unit: 'kg', title: 'Хонины мах, кг-аар', note: 'Доод тал нь 10 кг.', price: 12_800, minQty: 10, quantity: 500, origin: 'Улаанбаатар, Эмээлт', readyIn: 2, delivers: true, fee: 10_000 },
  { supplier: 3, kind: 'horse', unit: 'kg', title: 'Адууны мах, кг-аар', note: 'Доод тал нь 10 кг.', price: 11_000, minQty: 10, quantity: 400, origin: 'Улаанбаатар, Эмээлт', readyIn: 2, delivers: true, fee: 10_000 },
  { supplier: 3, kind: 'sheep', unit: 'whole', title: 'Хонь, бүтэн', note: 'Нядалж бэлдсэн гулууз.', price: 480_000, approxKg: 36, quantity: 10, origin: 'Улаанбаатар, Эмээлт', readyIn: 2, delivers: true, fee: 10_000 },
];

/** The demo clock jumps hours; pairing codes have to outlive that. */
const PAIRING_TTL_MINUTES = 8 * 60;

/** The would-be supplier in the seed. Sign in as them to see the application. */
export const APPLICANT_PHONE = '+97688010009';

function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ulaanbaatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export async function seedIdesh(
  ctx: Ctx,
  db: Db,
  today: string,
): Promise<{ codes: Array<{ name: string; code: string }>; paired: string; listings: number }> {
  const ids: string[] = [];
  const codes: Array<{ name: string; code: string }> = [];

  for (const s of SUPPLIERS) {
    const id = await registerSupplier(
      {
        name: s.name,
        phone: s.phone,
        merchantTin: s.tin,
        pickupAddress: s.pickup,
        lat: s.lat,
        lon: s.lon,
      },
      db,
    );
    ids.push(id);
    codes.push({
      name: s.name,
      code: await createSupplierCode(ctx, id, 'Нийлүүлэгчийн дэлгэц', PAIRING_TTL_MINUTES),
    });
  }

  const now = ctx.clock.now();
  for (const l of LISTINGS) {
    await createListing(
      ids[l.supplier]!,
      {
        kind: l.kind,
        unit: l.unit,
        title: l.title,
        note: l.note ?? null,
        priceMnt: l.price,
        approxKg: l.approxKg ?? null,
        minQty: l.minQty ?? 1,
        quantity: l.quantity,
        origin: l.origin,
        readyFrom: plusDays(today, l.readyIn),
        delivers: l.delivers,
        deliveryFeeMnt: l.fee ?? 0,
      },
      now,
      db,
    );
  }

  // One supplier's screen is on from the start, like the first kitchen's.
  const first = codes[0]!;
  await pairSupplier(ctx, first.code);

  // And one person asking to become one, so the ops page has a decision to
  // make rather than an empty list to show the shape of.
  const applicant = await startSession(ctx, APPLICANT_PHONE, 'Нийлүүлэгчийн дэлгэц');
  await applySupplier(ctx, {
    guestId: applicant.guestId,
    name: 'Завхан · Бат-Эрдэнийн хот айл',
    merchantTin: '6505678901',
    pickupAddress: 'Баянгол дүүрэг, Хархорин захын урд хаалга',
    about: 'Завханы хонь, ямаа. 10-р сарын дундаас 30 толгой. Хүргэлт хийнэ.',
  });

  return { codes: codes.slice(1), paired: first.name, listings: LISTINGS.length };
}
