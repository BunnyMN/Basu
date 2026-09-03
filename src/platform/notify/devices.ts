import { getPool } from '../../db/pool.js';

/**
 * The phones a person can be pushed to.
 *
 * One row per install, keyed by the push token itself: a reinstall issues a
 * new token and an old one silently stops working, so the token is the only
 * honest identity a device has. A token that reappears under a different guest
 * — a shared handset, or somebody signing out and back in as someone else —
 * moves to the new guest rather than sending their messages to the old one.
 */

export interface Device {
  id: string;
  platform: 'ios' | 'android' | 'web';
  label: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export async function registerDevice(input: {
  guestId: string;
  platform: 'ios' | 'android' | 'web';
  pushToken: string;
  label?: string | null;
  at: Date;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO notify.device (guest_id, platform, push_token, label, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (push_token) DO UPDATE
        SET guest_id     = EXCLUDED.guest_id,
            platform     = EXCLUDED.platform,
            label        = COALESCE(EXCLUDED.label, notify.device.label),
            last_seen_at = EXCLUDED.last_seen_at,
            revoked_at   = NULL`,
    [input.guestId, input.platform, input.pushToken, input.label ?? null, input.at],
  );
}

export async function revokeDevice(guestId: string, pushToken: string, at: Date): Promise<void> {
  await getPool().query(
    `UPDATE notify.device SET revoked_at = $3
      WHERE guest_id = $1 AND push_token = $2 AND revoked_at IS NULL`,
    [guestId, pushToken, at],
  );
}

export async function devicesOf(guestId: string): Promise<Device[]> {
  const { rows } = await getPool().query<{
    id: string;
    platform: 'ios' | 'android' | 'web';
    label: string | null;
    last_seen_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, platform, label, last_seen_at, created_at
       FROM notify.device
      WHERE guest_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [guestId],
  );
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    label: r.label,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  }));
}

/**
 * The most recently seen live token per guest, for a batch of guests.
 *
 * Most recent rather than all of them: a person with a phone and a tablet
 * should get one notification, on the thing they last used, not one per
 * device — the message budget is per guest, not per install.
 */
export async function pushTokensFor(guestIds: readonly string[]): Promise<Map<string, string>> {
  if (guestIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ guest_id: string; push_token: string }>(
    `SELECT DISTINCT ON (guest_id) guest_id, push_token
       FROM notify.device
      WHERE guest_id = ANY($1::uuid[]) AND revoked_at IS NULL
      ORDER BY guest_id, COALESCE(last_seen_at, created_at) DESC`,
    [[...new Set(guestIds)]],
  );
  return new Map(rows.map((r) => [r.guest_id, r.push_token]));
}
