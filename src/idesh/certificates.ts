import { getPool, type Db } from '../db/pool.js';
import { IdeshError } from './errors.js';

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
 */

export type CertificateState = 'unchecked' | 'genuine' | 'false';

export interface Certificate {
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

/** What a guest is told of a certificate: which one, from whom, and whether Basu looked it up. */
export interface CertificateFacts {
  number: string;
  issuer: string;
  issuedOn: string;
  checked: boolean;
}

/** A certificate as the desk lists it: the supplier's name beside it. */
export interface DeskCertificate extends Certificate {
  supplierName: string;
}

export interface CertificatePhoto {
  type: 'image/jpeg' | 'image/png';
  bytes: Buffer;
}

export interface CertificateInput {
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
}

const SELECT = `
  SELECT c.id, c.supplier_id, s.name AS supplier, c.number, c.issuer,
         to_char(c.issued_on, 'YYYY-MM-DD') AS issued_on, c.photo IS NOT NULL AS has_photo,
         c.state, c.checked_by, c.checked_at, c.check_note, c.created_at,
         (SELECT count(*)::int FROM idesh.listing l WHERE l.certificate_id = c.id) AS listings,
         (SELECT count(*)::int FROM idesh.idesh_order o WHERE o.certificate_id = c.id) AS orders
    FROM idesh.certificate c
    JOIN idesh.supplier s ON s.id = c.supplier_id`;

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

function validate(input: CertificateInput, today: string): void {
  const number = tidyNumber(input.number ?? '');
  if (number.length < 3 || number.length > 40) throw new IdeshError('BAD_CERTIFICATE', 'the number is 3 to 40 characters');
  const issuer = input.issuer?.trim() ?? '';
  if (issuer.length < 2 || issuer.length > 120) throw new IdeshError('BAD_CERTIFICATE', 'who gave the certificate is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issuedOn ?? '') || Number.isNaN(Date.parse(input.issuedOn))) {
    throw new IdeshError('BAD_CERTIFICATE', 'issued_on must be YYYY-MM-DD');
  }
  // A certificate is given before the meat moves, never after today.
  if (input.issuedOn > today) throw new IdeshError('BAD_CERTIFICATE', 'issued_on cannot be in the future');
  if (input.photo) {
    if (input.photo.bytes.length > MAX_PHOTO_BYTES) throw new IdeshError('BAD_CERTIFICATE', 'the photo is too large');
    if (photoType(input.photo.bytes) !== input.photo.type) throw new IdeshError('BAD_CERTIFICATE', 'the photo is not a JPEG or a PNG');
  }
}

/** The supplier writes a certificate in. The same number twice is the same certificate, and is refused. */
export async function addCertificate(
  supplierId: string,
  input: CertificateInput,
  at: Date,
  today: string,
  db: Db = getPool(),
): Promise<Certificate> {
  validate(input, today);
  let inserted;
  try {
    inserted = await db.query<{ id: string }>(
      `INSERT INTO idesh.certificate (supplier_id, number, issuer, issued_on, photo, photo_type, added_by, created_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
       RETURNING id`,
      [
        supplierId,
        tidyNumber(input.number),
        input.issuer.trim(),
        input.issuedOn,
        input.photo?.bytes ?? null,
        input.photo?.type ?? null,
        input.addedBy ?? null,
        at,
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
}): CertificateFacts | null =>
  row.cert_number && row.cert_issuer && row.cert_issued_on
    ? { number: row.cert_number, issuer: row.cert_issuer, issuedOn: row.cert_issued_on, checked: row.cert_state === 'genuine' }
    : null;

/** The columns `factsOf` reads, from a certificate joined as `c`. */
export const CERT_COLUMNS = `c.number AS cert_number, c.issuer AS cert_issuer,
         to_char(c.issued_on, 'YYYY-MM-DD') AS cert_issued_on, c.state AS cert_state`;
