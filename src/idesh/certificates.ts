import { getPool, type Db } from '../db/pool.js';
import { IdeshError } from './errors.js';
import { KINDS, type Kind } from './listings.js';

/**
 * The veterinary certificate a shipment of meat came with.
 *
 * The soum's vet gives one per shipment, numbered, and the state keeps it in
 * its own system (МЭНС) — the number is what anybody can look up there. The
 * supplier writes it in once, when the meat arrives, and then points listings
 * and orders at it: meat by the kilogram carries its certificate on the
 * listing, a whole animal gets one when it has been slaughtered.
 *
 * Basu does not vouch for a certificate it has not looked up. One the desk
 * has not checked is shown as the supplier's own word; one the desk found
 * false takes every listing it is on out of the guests' sight.
 *
 * The fields follow the paper itself — МЭЕГ order А/67's domestic
 * certificate and the electronic one with its QR: who wrote it and who
 * confirmed it, how long it holds, where the animals came from, what it
 * covers, the laboratory's tests, the route. A guest reads the origin and
 * the tests; the herder, the route and the photograph name people and
 * lorries, and stay with the supplier and the desk.
 */

export type CertificateState = 'unchecked' | 'genuine' | 'false';

/** The aimags a certificate's origin can name, and the capital, as the paper writes them. */
export const AIMAGS: readonly string[] = [
  'Архангай', 'Баян-Өлгий', 'Баянхонгор', 'Булган', 'Говь-Алтай', 'Говьсүмбэр', 'Дархан-Уул',
  'Дорноговь', 'Дорнод', 'Дундговь', 'Завхан', 'Орхон', 'Өвөрхангай', 'Өмнөговь', 'Сүхбаатар',
  'Сэлэнгэ', 'Төв', 'Увс', 'Ховд', 'Хөвсгөл', 'Хэнтий', 'Улаанбаатар',
];

/** The certificate's «хэмжих нэгж»: head of live animals, pieces of carcass, kilograms. */
export type CertificateUnit = 'head' | 'piece' | 'kg';
export const CERTIFICATE_UNITS: readonly CertificateUnit[] = ['head', 'piece', 'kg'];

/** One line of the certificate's product table: «Хонь · гулууз мах · 301 ш». */
export interface CertificateProduct {
  kind: Kind;
  what: string;
  unit: CertificateUnit;
  quantity: number;
}

/** One test the laboratory found negative: «Шүлхий, 2019-10-25, Завхан аймгийн лаборатори». */
export interface CertificateTest {
  disease: string;
  /** `YYYY-MM-DD` */
  testedOn: string | null;
  lab: string | null;
}

export interface CertificateOrigin {
  aimag: string;
  soum: string;
  bag: string | null;
}

/** The paper's details beyond its number: everything here but the origin may be left out. */
export interface CertificateDetails {
  /** `YYYY-MM-DD`, the last day it holds. */
  validUntil: string | null;
  inspector: string | null;
  origin: CertificateOrigin | null;
  herder: string | null;
  route: string | null;
  products: CertificateProduct[];
  tests: CertificateTest[];
  qr: string | null;
}

/** «Завхан, Отгон сум» — the origin as one line, for a guest. */
export const originLine = (o: CertificateOrigin | null): string | null =>
  o ? `${o.aimag}, ${/сум$|дүүрэг$/i.test(o.soum) ? o.soum : `${o.soum} ${o.aimag === 'Улаанбаатар' ? 'дүүрэг' : 'сум'}`}` : null;

export interface Certificate extends CertificateDetails {
  id: string;
  supplierId: string;
  number: string;
  issuer: string;
  /** `YYYY-MM-DD` */
  issuedOn: string;
  hasPhoto: boolean;
  state: CertificateState;
  checkedBy: string | null;
  checkedAt: Date | null;
  checkNote: string | null;
  createdAt: Date;
  /** How many listings and orders point at it: one in use is not taken away. */
  listings: number;
  orders: number;
}

/**
 * What a guest is told of a certificate: which one, from whom, where the
 * animals came from, what the laboratory found nothing of, and whether Basu
 * looked it up.
 */
export interface CertificateFacts {
  number: string;
  issuer: string;
  issuedOn: string;
  checked: boolean;
  /** «Завхан, Отгон сум», or null for a certificate written in before origins were asked. */
  origin: string | null;
  /** The diseases tested for and not found. */
  tests: string[];
}

/** A certificate as the desk lists it: the supplier's name beside it. */
export interface DeskCertificate extends Certificate {
  supplierName: string;
  /** Other suppliers' certificates with the same number or QR: worth a look. */
  twins: number;
}

export interface CertificatePhoto {
  type: 'image/jpeg' | 'image/png';
  bytes: Buffer;
}

export interface CertificateInput extends Partial<CertificateDetails> {
  number: string;
  issuer: string;
  issuedOn: string;
  photo?: CertificatePhoto | null;
  addedBy?: string | null;
}

/** A photograph of one sheet of paper, already made small by the page that sent it. */
export const MAX_PHOTO_BYTES = 900 * 1024;

interface Row {
  id: string;
  supplier_id: string;
  supplier?: string;
  number: string;
  issuer: string;
  issued_on: string;
  has_photo: boolean;
  state: CertificateState;
  checked_by: string | null;
  checked_at: Date | null;
  check_note: string | null;
  created_at: Date;
  listings: number;
  orders: number;
  twins: number;
  valid_until: string | null;
  inspector: string | null;
  origin_aimag: string | null;
  origin_soum: string | null;
  origin_bag: string | null;
  herder: string | null;
  route: string | null;
  products: { kind: Kind; what: string; unit: CertificateUnit; quantity: number }[];
  tests: { disease: string; tested_on: string | null; lab: string | null }[];
  qr: string | null;
}

const SELECT = `
  SELECT c.id, c.supplier_id, s.name AS supplier, c.number, c.issuer,
         to_char(c.issued_on, 'YYYY-MM-DD') AS issued_on, c.photo IS NOT NULL AS has_photo,
         c.state, c.checked_by, c.checked_at, c.check_note, c.created_at,
         to_char(c.valid_until, 'YYYY-MM-DD') AS valid_until, c.inspector,
         c.origin_aimag, c.origin_soum, c.origin_bag, c.herder, c.route, c.products, c.tests, c.qr,
         (SELECT count(*)::int FROM idesh.listing l WHERE l.certificate_id = c.id) AS listings,
         (SELECT count(*)::int FROM idesh.idesh_order o WHERE o.certificate_id = c.id) AS orders,
         (SELECT count(*)::int FROM idesh.certificate x
           WHERE x.supplier_id <> c.supplier_id AND (x.number = c.number OR x.qr = c.qr)) AS twins
    FROM idesh.certificate c
    JOIN idesh.supplier s ON s.id = c.supplier_id`;

const originOf = (r: { origin_aimag: string | null; origin_soum: string | null; origin_bag: string | null }): CertificateOrigin | null =>
  r.origin_aimag && r.origin_soum ? { aimag: r.origin_aimag, soum: r.origin_soum, bag: r.origin_bag } : null;

function shape(r: Row): DeskCertificate {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    supplierName: r.supplier ?? '',
    number: r.number,
    issuer: r.issuer,
    issuedOn: r.issued_on,
    hasPhoto: r.has_photo,
    state: r.state,
    checkedBy: r.checked_by,
    checkedAt: r.checked_at,
    checkNote: r.check_note,
    createdAt: r.created_at,
    listings: r.listings,
    orders: r.orders,
    twins: r.twins,
    validUntil: r.valid_until,
    inspector: r.inspector,
    origin: originOf(r),
    herder: r.herder,
    route: r.route,
    // jsonb keeps its keys in its own order; a line is read back in the paper's.
    products: r.products.map((p) => ({ kind: p.kind, what: p.what, unit: p.unit, quantity: Number(p.quantity) })),
    tests: r.tests.map((t) => ({ disease: t.disease, testedOn: t.tested_on, lab: t.lab })),
    qr: r.qr,
  };
}

/** As printed, but for the case and the spaces a thumb adds. */
export const tidyNumber = (typed: string): string => typed.trim().replace(/\s+/g, '').toUpperCase();

/** JPEG or PNG by its first bytes — what the file says it is, not what its sender did. */
export function photoType(bytes: Buffer): CertificatePhoto['type'] | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Trimmed, or null for nothing; refused when longer than the paper has room for. */
function text(value: unknown, what: string, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new IdeshError('BAD_CERTIFICATE', `${what} must be text`);
  const t = value.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.length < min || t.length > max) throw new IdeshError('BAD_CERTIFICATE', `${what} is ${min} to ${max} characters`);
  return t;
}

/** The input made tidy and checked — what is written to the row. */
interface Clean extends CertificateDetails {
  number: string;
  issuer: string;
  issuedOn: string;
  photo: CertificatePhoto | null | undefined;
}

function validate(input: CertificateInput, today: string): Clean {
  const number = tidyNumber(input.number ?? '');
  if (number.length < 3 || number.length > 40) throw new IdeshError('BAD_CERTIFICATE', 'the number is 3 to 40 characters');
  const issuer = input.issuer?.trim() ?? '';
  if (issuer.length < 2 || issuer.length > 120) throw new IdeshError('BAD_CERTIFICATE', 'who gave the certificate is required');
  if (!isDay(input.issuedOn)) throw new IdeshError('BAD_CERTIFICATE', 'issued_on must be YYYY-MM-DD');
  // A certificate is given before the meat moves, never after today.
  if (input.issuedOn > today) throw new IdeshError('BAD_CERTIFICATE', 'issued_on cannot be in the future');
  if (input.photo) {
    if (input.photo.bytes.length > MAX_PHOTO_BYTES) throw new IdeshError('BAD_CERTIFICATE', 'the photo is too large');
    if (photoType(input.photo.bytes) !== input.photo.type) throw new IdeshError('BAD_CERTIFICATE', 'the photo is not a JPEG or a PNG');
  }

  let validUntil: string | null = null;
  if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') {
    if (!isDay(input.validUntil)) throw new IdeshError('BAD_CERTIFICATE', 'valid_until must be YYYY-MM-DD');
    if (input.validUntil < input.issuedOn) throw new IdeshError('BAD_CERTIFICATE', 'valid_until is before issued_on');
    validUntil = input.validUntil;
  }

  // Every certificate names where the animals came from; Basu asks it of
  // every new one, and of an old one as soon as it is touched.
  const o = input.origin;
  const aimag = text(o?.aimag, 'the aimag', 2, 40);
  const soum = text(o?.soum, 'the soum', 2, 60);
  if (!aimag || !soum) throw new IdeshError('BAD_CERTIFICATE', 'the origin — aimag and soum — is required');
  if (!AIMAGS.includes(aimag)) throw new IdeshError('BAD_CERTIFICATE', 'no such aimag');

  const products = input.products ?? [];
  if (!Array.isArray(products) || products.length > 10) throw new IdeshError('BAD_CERTIFICATE', 'up to 10 product lines');
  const cleanProducts = products.map((p) => {
    if (!p || !KINDS.includes(p.kind)) throw new IdeshError('BAD_CERTIFICATE', 'a product line names sheep, goat, beef or horse');
    if (!CERTIFICATE_UNITS.includes(p.unit)) throw new IdeshError('BAD_CERTIFICATE', 'a product line counts head, pieces or kg');
    if (typeof p.quantity !== 'number' || !Number.isFinite(p.quantity) || p.quantity <= 0 || p.quantity > 1_000_000) {
      throw new IdeshError('BAD_CERTIFICATE', 'a product line has a quantity');
    }
    const what = text(p.what, 'the product', 2, 60);
    if (!what) throw new IdeshError('BAD_CERTIFICATE', 'a product line says what it is');
    return { kind: p.kind, what, unit: p.unit, quantity: Math.round(p.quantity * 100) / 100 };
  });

  const tests = input.tests ?? [];
  if (!Array.isArray(tests) || tests.length > 12) throw new IdeshError('BAD_CERTIFICATE', 'up to 12 tests');
  const cleanTests = tests.map((t) => {
    const disease = text(t?.disease, 'the disease', 2, 60);
    if (!disease) throw new IdeshError('BAD_CERTIFICATE', 'a test names its disease');
    let testedOn: string | null = null;
    if (t.testedOn) {
      if (!isDay(t.testedOn)) throw new IdeshError('BAD_CERTIFICATE', 'tested_on must be YYYY-MM-DD');
      if (t.testedOn > today) throw new IdeshError('BAD_CERTIFICATE', 'tested_on cannot be in the future');
      testedOn = t.testedOn;
    }
    return { disease, testedOn, lab: text(t.lab, 'the laboratory', 2, 120) };
  });
  const diseases = cleanTests.map((t) => t.disease.toLowerCase());
  if (new Set(diseases).size !== diseases.length) throw new IdeshError('BAD_CERTIFICATE', 'a disease is named twice');

  return {
    number,
    issuer,
    issuedOn: input.issuedOn,
    photo: input.photo,
    validUntil,
    inspector: text(input.inspector, 'the inspector', 2, 120),
    origin: { aimag, soum, bag: text(o?.bag, 'the bag', 1, 60) },
    herder: text(input.herder, 'the herder', 2, 120),
    route: text(input.route, 'the route', 2, 200),
    products: cleanProducts,
    tests: cleanTests,
    qr: text(input.qr, 'the QR', 1, 1000),
  };
}

/** The details as the row keeps them, in the order DETAIL_COLUMNS names them. */
const detailValues = (c: Clean) => [
  c.validUntil,
  c.inspector,
  c.origin?.aimag ?? null,
  c.origin?.soum ?? null,
  c.origin?.bag ?? null,
  c.herder,
  c.route,
  JSON.stringify(c.products),
  JSON.stringify(c.tests.map((t) => ({ disease: t.disease, tested_on: t.testedOn, lab: t.lab }))),
  c.qr,
];
const DETAIL_COLUMNS = ['valid_until', 'inspector', 'origin_aimag', 'origin_soum', 'origin_bag', 'herder', 'route', 'products', 'tests', 'qr'];

/** The supplier writes a certificate in. The same number twice is the same certificate, and is refused. */
export async function addCertificate(
  supplierId: string,
  input: CertificateInput,
  at: Date,
  today: string,
  db: Db = getPool(),
): Promise<Certificate> {
  const clean = validate(input, today);
  let inserted;
  try {
    inserted = await db.query<{ id: string }>(
      `INSERT INTO idesh.certificate (supplier_id, number, issuer, issued_on, photo, photo_type, added_by, created_at,
                                      ${DETAIL_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18)
       RETURNING id`,
      [
        supplierId,
        clean.number,
        clean.issuer,
        clean.issuedOn,
        clean.photo?.bytes ?? null,
        clean.photo?.type ?? null,
        input.addedBy ?? null,
        at,
        ...detailValues(clean),
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new IdeshError('CERTIFICATE_EXISTS', 'this supplier already has a certificate with that number');
    }
    throw error;
  }
  return (await certificateById(inserted.rows[0]!.id, db))!;
}

/**
 * The supplier corrects or completes a certificate — an old one written in
 * before origins were asked, most often. The whole paper is sent again.
 *
 * A certificate the desk found false stays false: a new one is written in.
 * One the desk found genuine is looked at again once it says something else.
 * Its number changes only while nothing points at it and nobody has checked
 * it, as it could be taken away and written in again; the photograph is kept
 * unless a new one is sent.
 */
export async function updateCertificate(
  supplierId: string,
  certificateId: string,
  input: CertificateInput,
  today: string,
  db: Db = getPool(),
): Promise<Certificate> {
  const found = await certificateById(certificateId, db);
  if (!found || found.supplierId !== supplierId) throw new IdeshError('NO_CERTIFICATE', 'no such certificate here');
  if (found.state === 'false') throw new IdeshError('CERTIFICATE_FALSE', 'the desk found that certificate false; write in a new one');
  const clean = validate(input, today);
  if (clean.number !== found.number && (found.listings > 0 || found.orders > 0 || found.state !== 'unchecked')) {
    throw new IdeshError('CERTIFICATE_IN_USE', 'the number of a certificate in use or checked stays');
  }
  const same =
    clean.number === found.number &&
    clean.issuer === found.issuer &&
    clean.issuedOn === found.issuedOn &&
    clean.photo === undefined &&
    JSON.stringify(detailValues(clean)) === JSON.stringify(detailValues({ ...found, photo: undefined }));
  if (same) return found;
  try {
    await db.query(
      `UPDATE idesh.certificate
          SET number = $3, issuer = $4, issued_on = $5::date,
              photo = COALESCE($6, photo), photo_type = COALESCE($7, photo_type),
              ${DETAIL_COLUMNS.map((c, i) => `${c} = $${i + 8}${c === 'valid_until' ? '::date' : c === 'products' || c === 'tests' ? '::jsonb' : ''}`).join(', ')},
              state = 'unchecked', checked_by = NULL, checked_at = NULL, check_note = NULL
        WHERE id = $1 AND supplier_id = $2`,
      [certificateId, supplierId, clean.number, clean.issuer, clean.issuedOn, clean.photo?.bytes ?? null, clean.photo?.type ?? null, ...detailValues(clean)],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new IdeshError('CERTIFICATE_EXISTS', 'this supplier already has a certificate with that number');
    }
    throw error;
  }
  return (await certificateById(certificateId, db))!;
}

/** The supplier's own certificates, the newest shipment first. */
export async function certificatesOf(supplierId: string, db: Db = getPool()): Promise<Certificate[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE c.supplier_id = $1 ORDER BY c.issued_on DESC, c.created_at DESC`, [supplierId]);
  return rows.map(shape);
}

export async function certificateById(id: string, db: Db = getPool()): Promise<DeskCertificate | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/** Every certificate, for the desk: the ones nobody has looked up first, oldest of them at the top. */
export async function certificatesForDesk(db: Db = getPool()): Promise<DeskCertificate[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} ORDER BY (c.state = 'unchecked') DESC, CASE WHEN c.state = 'unchecked' THEN c.created_at END, c.created_at DESC LIMIT 500`,
  );
  return rows.map(shape);
}

/** The photograph, for whoever may see it. `supplierId` narrows it to that supplier's own. */
export async function certificatePhoto(id: string, supplierId: string | null, db: Db = getPool()): Promise<CertificatePhoto | null> {
  const { rows } = await db.query<{ photo: Buffer | null; photo_type: CertificatePhoto['type'] | null }>(
    'SELECT photo, photo_type FROM idesh.certificate WHERE id = $1 AND ($2::uuid IS NULL OR supplier_id = $2)',
    [id, supplierId],
  );
  const row = rows[0];
  return row?.photo && row.photo_type ? { type: row.photo_type, bytes: row.photo } : null;
}

/**
 * A certificate this supplier may put on meat: their own, and not one the
 * desk found false. Asked inside whatever transaction is about to use it.
 */
export async function usableCertificate(supplierId: string, certificateId: string, db: Db = getPool()): Promise<void> {
  const { rows } = await db.query<{ state: CertificateState }>(
    'SELECT state FROM idesh.certificate WHERE id = $1 AND supplier_id = $2',
    [certificateId, supplierId],
  );
  if (!rows[0]) throw new IdeshError('NO_CERTIFICATE', 'no such certificate here');
  if (rows[0].state === 'false') throw new IdeshError('CERTIFICATE_FALSE', 'the desk found that certificate false');
}

/**
 * A certificate written in by mistake is taken away — while nothing points at
 * it and nobody has checked it. Once meat was sold under it, or the desk has
 * said what it found, it is the record and it stays.
 */
export async function removeCertificate(supplierId: string, certificateId: string, db: Db = getPool()): Promise<void> {
  const found = await certificateById(certificateId, db);
  if (!found || found.supplierId !== supplierId) throw new IdeshError('NO_CERTIFICATE', 'no such certificate here');
  if (found.listings > 0 || found.orders > 0 || found.state !== 'unchecked') {
    throw new IdeshError('CERTIFICATE_IN_USE', 'a certificate that is in use or checked stays');
  }
  await db.query('DELETE FROM idesh.certificate WHERE id = $1 AND supplier_id = $2', [certificateId, supplierId]);
}

/** Somebody at the desk looked the number up, and says what they found. */
export async function checkCertificate(
  input: { id: string; genuine: boolean; by: string; note?: string | null; at: Date },
  db: Db = getPool(),
): Promise<DeskCertificate> {
  const { rowCount } = await db.query(
    `UPDATE idesh.certificate
        SET state = $2, checked_by = $3, checked_at = $4, check_note = $5
      WHERE id = $1`,
    [input.id, input.genuine ? 'genuine' : 'false', input.by, input.at, input.note?.trim() || null],
  );
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such certificate');
  return (await certificateById(input.id, db))!;
}

/** What a guest reads of the certificate on a listing or an order. */
export const factsOf = (row: {
  cert_number: string | null;
  cert_issuer: string | null;
  cert_issued_on: string | null;
  cert_state: CertificateState | null;
  cert_origin_aimag: string | null;
  cert_origin_soum: string | null;
  cert_tests: { disease: string }[] | null;
}): CertificateFacts | null =>
  row.cert_number && row.cert_issuer && row.cert_issued_on
    ? {
        number: row.cert_number,
        issuer: row.cert_issuer,
        issuedOn: row.cert_issued_on,
        checked: row.cert_state === 'genuine',
        origin: originLine(
          row.cert_origin_aimag && row.cert_origin_soum ? { aimag: row.cert_origin_aimag, soum: row.cert_origin_soum, bag: null } : null,
        ),
        tests: (row.cert_tests ?? []).map((t) => t.disease),
      }
    : null;

/** The columns `factsOf` reads, from a certificate joined as `c`. */
export const CERT_COLUMNS = `c.number AS cert_number, c.issuer AS cert_issuer,
         to_char(c.issued_on, 'YYYY-MM-DD') AS cert_issued_on, c.state AS cert_state,
         c.origin_aimag AS cert_origin_aimag, c.origin_soum AS cert_origin_soum, c.tests AS cert_tests`;
