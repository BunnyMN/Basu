import { getPool } from '../../db/pool.js';

/**
 * The part of a person that every vertical is allowed to show.
 *
 * Deliberately thin. A profile that accumulates one field per product — table
 * preference here, drop-off address there — stops being a platform record and
 * becomes four verticals sharing a table by accident. Anything that is only
 * meaningful inside one vertical belongs to that vertical.
 */

export interface Profile {
  guestId: string;
  /** Null for an account made by email, Google or Apple. */
  phone: string | null;
  email: string | null;
  displayName: string | null;
  locale: 'mn' | 'en';
  avatarSeed: string;
  memberSince: Date;
}

/** What a person can be reached on. The only thing notify needs from here. */
export interface Contact {
  guestId: string;
  /** Null when the account was made without one. */
  phone: string | null;
  email: string | null;
}

export async function profileOf(guestId: string): Promise<Profile | null> {
  const { rows } = await getPool().query<{
    guest_id: string;
    phone_e164: string | null;
    email: string | null;
    display_name: string | null;
    locale: 'mn' | 'en';
    avatar_seed: string;
    created_at: Date;
  }>(
    `SELECT g.id AS guest_id, g.phone_e164, g.email, g.created_at,
            COALESCE(p.display_name, g.name) AS display_name,
            COALESCE(p.locale, 'mn')         AS locale,
            COALESCE(p.avatar_seed, substr(md5(g.id::text), 1, 8)) AS avatar_seed
       FROM identity.guest g
       LEFT JOIN identity.profile p ON p.guest_id = g.id
      WHERE g.id = $1`,
    [guestId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    guestId: row.guest_id,
    phone: row.phone_e164,
    email: row.email,
    displayName: row.display_name,
    locale: row.locale,
    avatarSeed: row.avatar_seed,
    memberSince: row.created_at,
  };
}

export interface ProfileEdit {
  displayName?: string | null;
  locale?: 'mn' | 'en';
}

export async function updateProfile(
  guestId: string,
  edit: ProfileEdit,
  at: Date,
): Promise<Profile | null> {
  const name = edit.displayName?.trim();
  await getPool().query(
    `INSERT INTO identity.profile (guest_id, display_name, locale, updated_at)
     VALUES ($1, $2, COALESCE($3, 'mn'), $4)
     ON CONFLICT (guest_id) DO UPDATE
        SET display_name = COALESCE($2, identity.profile.display_name),
            locale       = COALESCE($3, identity.profile.locale),
            updated_at   = $4`,
    [guestId, name === undefined ? null : name || null, edit.locale ?? null, at],
  );
  // `guest.name` is what the kitchen ticket prints, so it follows the profile.
  if (name !== undefined) {
    await getPool().query('UPDATE identity.guest SET name = $2 WHERE id = $1', [
      guestId,
      name || null,
    ]);
  }
  return profileOf(guestId);
}

/**
 * Contact details for a set of people, in one round trip.
 *
 * This is the whole of identity's outward surface for other modules: notify
 * calls it instead of joining `identity.guest`, which is what makes moving
 * identity into its own process a change of transport rather than a rewrite.
 */
export async function contactsFor(guestIds: readonly string[]): Promise<Map<string, Contact>> {
  if (guestIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ id: string; phone_e164: string | null; email: string | null }>(
    // A closed account keeps neither: its phone column holds a tombstone.
    `SELECT id, CASE WHEN closed_at IS NULL THEN phone_e164 END AS phone_e164, email
       FROM identity.guest WHERE id = ANY($1::uuid[])`,
    [[...new Set(guestIds)]],
  );
  return new Map(rows.map((r) => [r.id, { guestId: r.id, phone: r.phone_e164, email: r.email }]));
}

/**
 * What to call people, in public, in bulk.
 *
 * The rule that a review or a kitchen ticket never shows a phone number lives
 * here rather than in each caller — there is one right answer to "how do we
 * name a guest we barely know", and four verticals inventing it separately is
 * how the fourth one ends up printing +976 99001122 on a screen in a dining
 * room.
 */
export async function displayNamesFor(
  guestIds: readonly string[],
): Promise<Map<string, string>> {
  if (guestIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ id: string; name: string | null; phone: string | null; email: string | null }>(
    `SELECT g.id, COALESCE(p.display_name, g.name) AS name, g.phone_e164 AS phone, g.email
       FROM identity.guest g
       LEFT JOIN identity.profile p ON p.guest_id = g.id
      WHERE g.id = ANY($1::uuid[])`,
    [[...new Set(guestIds)]],
  );
  // Never the whole number or the whole address: the last four digits, or the
  // first letters of the mailbox, is enough to tell two strangers apart.
  const fallback = (r: { phone: string | null; email: string | null }) =>
    r.phone && !r.phone.startsWith('closed:')
      ? `\u00b7\u00b7\u00b7${r.phone.slice(-4)}`
      : r.email
        ? `${r.email.split('@')[0]!.slice(0, 3)}\u00b7\u00b7\u00b7`
        : '\u00b7\u00b7\u00b7';
  return new Map(rows.map((r) => [r.id, r.name?.trim().split(' ')[0] || fallback(r)]));
}
