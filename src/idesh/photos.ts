import { getPool, tx, type Db } from '../db/pool.js';
import { MAX_PHOTO_BYTES, photoType, type CertificatePhoto } from './certificates.js';
import { IdeshError } from './errors.js';

/**
 * The supplier's own photographs of a listing.
 *
 * A listing with none wears one of Basu's example pictures, and says so. One
 * with its own shows those: the animal from the side, from behind, the fat on
 * its back — the first of them on its card, all of them on its page. Each is
 * kept twice, as sent: the photograph, and a small copy for lists. The page
 * that sends them makes both; nothing here resizes an image.
 *
 * A photograph is anybody's to look at, like the listing it is on. It is
 * never changed once kept — so its address is cached for good — only taken
 * away, by the supplier whose listing it is.
 */

/** As many as a guest will look through, and a stall can be asked to take. */
export const MAX_LISTING_PHOTOS = 8;
/** The small copy: a card in a list, 720 px on its long side — a phone's card at twice its width. */
export const MAX_THUMB_BYTES = 150 * 1024;

export type Picture = CertificatePhoto;

/** `(SELECT …)` of a listing's photograph ids, the cover first, for a listing at `ref`. */
export const photoIds = (ref: string): string =>
  `ARRAY(SELECT p.id::text FROM idesh.listing_photo p WHERE p.listing_id = ${ref} ORDER BY p.position, p.created_at, p.id)`;

/** `(SELECT …)` of a listing's cover alone; null when it has no photograph of its own. */
export const coverId = (ref: string): string =>
  `(SELECT p.id::text FROM idesh.listing_photo p WHERE p.listing_id = ${ref} ORDER BY p.position, p.created_at, p.id LIMIT 1)`;

function checked(picture: Picture | null | undefined, limit: number, what: string): Picture {
  if (!picture) throw new IdeshError('BAD_PHOTO', `${what} is missing`);
  if (picture.bytes.length === 0 || picture.bytes.length > limit) throw new IdeshError('BAD_PHOTO', `${what} is too large`);
  if (photoType(picture.bytes) !== picture.type) throw new IdeshError('BAD_PHOTO', `${what} is not a JPEG or a PNG`);
  return picture;
}

/**
 * Put one more photograph on a listing, after the ones it has. The listing's
 * row is locked while they are counted, so two uploads at once cannot both be
 * the eighth.
 */
export async function addListingPhoto(
  supplierId: string,
  listingId: string,
  input: { photo: Picture | null; thumb: Picture | null; addedBy?: string | null },
  at: Date,
): Promise<string> {
  const photo = checked(input.photo, MAX_PHOTO_BYTES, 'the photograph');
  const thumb = checked(input.thumb, MAX_THUMB_BYTES, 'the small copy');
  return tx(async (client) => {
    const owned = await client.query('SELECT 1 FROM idesh.listing WHERE id = $1 AND supplier_id = $2 FOR UPDATE', [listingId, supplierId]);
    if (!owned.rows[0]) throw new IdeshError('NOT_FOUND', 'no such listing here');
    const { rows } = await client.query<{ n: number; last: number | null }>(
      'SELECT count(*)::int AS n, max(position) AS last FROM idesh.listing_photo WHERE listing_id = $1',
      [listingId],
    );
    if (rows[0]!.n >= MAX_LISTING_PHOTOS) throw new IdeshError('TOO_MANY_PHOTOS', `a listing has at most ${MAX_LISTING_PHOTOS} photographs`);
    const added = await client.query<{ id: string }>(
      `INSERT INTO idesh.listing_photo (listing_id, position, photo, photo_type, thumb, thumb_type, added_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [listingId, (rows[0]!.last ?? -1) + 1, photo.bytes, photo.type, thumb.bytes, thumb.type, input.addedBy ?? null, at],
    );
    await client.query('UPDATE idesh.listing SET updated_at = $2 WHERE id = $1', [listingId, at]);
    return added.rows[0]!.id;
  });
}

/** Take one away. The ones after it keep their order. */
export async function removeListingPhoto(supplierId: string, listingId: string, photoId: string, db: Db = getPool()): Promise<void> {
  const { rowCount } = await db.query(
    `DELETE FROM idesh.listing_photo p USING idesh.listing l
      WHERE p.id = $1 AND p.listing_id = $2 AND l.id = p.listing_id AND l.supplier_id = $3`,
    [photoId, listingId, supplierId],
  );
  if (!rowCount) throw new IdeshError('NOT_FOUND', 'no such photograph on that listing');
}

/**
 * The order a guest sees them in, the cover first: every photograph of the
 * listing, once each. A list that leaves one out or names a stranger's is
 * refused whole — an order is of all of them or it is not an order.
 */
export async function orderListingPhotos(supplierId: string, listingId: string, ids: string[]): Promise<void> {
  await tx(async (client) => {
    const owned = await client.query('SELECT 1 FROM idesh.listing WHERE id = $1 AND supplier_id = $2 FOR UPDATE', [listingId, supplierId]);
    if (!owned.rows[0]) throw new IdeshError('NOT_FOUND', 'no such listing here');
    const { rows } = await client.query<{ id: string }>('SELECT id::text AS id FROM idesh.listing_photo WHERE listing_id = $1', [listingId]);
    const have = new Set(rows.map((r) => r.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id))) {
      throw new IdeshError('BAD_PHOTO', 'the order names every photograph of the listing, once');
    }
    await client.query(
      `UPDATE idesh.listing_photo p SET position = o.place - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, place)
        WHERE p.id = o.id AND p.listing_id = $1`,
      [listingId, ids],
    );
  });
}

/** One photograph, or its small copy, for whoever asks: a listing is public and so is what it looks like. */
export async function listingPhoto(photoId: string, size: 'full' | 'thumb', db: Db = getPool()): Promise<Picture | null> {
  const { rows } = await db.query<{ bytes: Buffer; type: Picture['type'] }>(
    size === 'thumb'
      ? 'SELECT thumb AS bytes, thumb_type AS type FROM idesh.listing_photo WHERE id = $1'
      : 'SELECT photo AS bytes, photo_type AS type FROM idesh.listing_photo WHERE id = $1',
    [photoId],
  );
  return rows[0] ?? null;
}
