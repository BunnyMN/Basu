import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, tx } from '../../db/pool.js';
import type { Ctx } from '../../ports.js';
import { AuthError, startSessionFor, type GuestSession } from './auth.js';
import { emailVerified, IdTokenError, verifyIdToken, type IdClaims } from './idtoken.js';

/**
 * Signing in with Google, and with Apple.
 *
 * Google runs as a server-side redirect — our page sends the person to
 * Google, Google sends them back to us with a code, we trade the code for an
 * ID token over a back channel. No Google script is loaded into our pages,
 * and the same flow serves the iPhone app through the system's sign-in sheet
 * (Google refuses to sign anybody in inside an embedded web view, and it is
 * right to). A page is handed the sign-in back as a code of our own, which
 * it trades for the session itself — see `handOff`.
 *
 * Apple is native on the iPhone: the app hands us the identity token Apple
 * gave it, and we check it the same way. The App Store asks for Sign in with
 * Apple beside any other social sign-in, which is why it is here at all.
 *
 * Either way the account is found by the provider's own subject first, then
 * — if the provider vouches for the email — by that address, and only then
 * made new. So a person who signed up with an email code and later taps
 * «Google» lands in the same account, provided Google says the address is
 * really theirs.
 */

const PUBLIC_ORIGIN = () => process.env['PUBLIC_ORIGIN']?.trim() || 'https://basu.burzai.cloud';

/* ── where a person may be sent back to ─────────────────────────────── */

/**
 * Our own pages, and the app's own scheme. Nothing else: a sign-in that
 * could return anywhere is an open redirect with a session token attached.
 */
const RETURN_PATHS = ['/', '/login', '/home', '/app', '/idesh', '/dine', '/supplier', '/kds', '/dashboard'];
export const APP_RETURN = 'basu://auth';

export function safeReturn(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  if (raw === APP_RETURN) return APP_RETURN;
  const path = raw.split(/[?#]/)[0] ?? '';
  return RETURN_PATHS.includes(path) ? path : '/';
}

/* ── Google ─────────────────────────────────────────────────────────── */

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The rest are Google's, overridden only by the tests. */
  authUrl?: string;
  tokenUrl?: string;
  jwksUri?: string;
  keys?: Parameters<typeof verifyIdToken>[1]['keys'];
}

export function googleConfigFromEnv(): GoogleConfig | null {
  const clientId = process.env['GOOGLE_CLIENT_ID']?.trim();
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return null;
  const optional = (name: string) => process.env[name]?.trim() || undefined;
  return {
    clientId,
    clientSecret,
    redirectUri: optional('GOOGLE_REDIRECT_URI') ?? `${PUBLIC_ORIGIN()}/v1/auth/google/callback`,
    // Google's own addresses unless a test stands in for them.
    ...(optional('GOOGLE_AUTH_URL') ? { authUrl: optional('GOOGLE_AUTH_URL')! } : {}),
    ...(optional('GOOGLE_TOKEN_URL') ? { tokenUrl: optional('GOOGLE_TOKEN_URL')! } : {}),
    ...(optional('GOOGLE_JWKS_URI') ? { jwksUri: optional('GOOGLE_JWKS_URI')! } : {}),
  };
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
/** A round trip to Google and back is seconds; ten minutes is generous. */
const STATE_MINUTES = 10;

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The first half: where to send the person, and the state that must come back. */
export async function beginGoogle(config: GoogleConfig, returnTo: string, now: Date): Promise<{ url: string; state: string }> {
  const state = b64(randomBytes(24));
  // PKCE: the verifier stays here; only its hash travels through the browser.
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  await getPool().query(
    `WITH gone AS (DELETE FROM identity.oauth_state WHERE created_at < $5::timestamptz - interval '1 hour')
     INSERT INTO identity.oauth_state (state, provider, verifier, return_to, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [state, 'google', verifier, safeReturn(returnTo), now],
  );
  const url = new URL(config.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), state };
}

/**
 * The state that came back, spent on first sight — whether the sign-in goes
 * on to succeed or not, so a state that leaked cannot be replayed. Null for
 * one we never issued, or one that took too long.
 */
export async function takeGoogleState(state: string, now: Date): Promise<{ verifier: string; returnTo: string } | null> {
  const { rows } = await getPool().query<{ verifier: string; return_to: string }>(
    `DELETE FROM identity.oauth_state
      WHERE state = $1 AND provider = 'google' AND created_at > $2::timestamptz - make_interval(mins => $3)
      RETURNING verifier, return_to`,
    [state, now, STATE_MINUTES],
  );
  const row = rows[0];
  return row ? { verifier: row.verifier, returnTo: safeReturn(row.return_to) } : null;
}

/**
 * The code traded for an ID token over the back channel, the token checked,
 * and the account it names — found, joined, or made. No session yet: the
 * app is given one at once, a page is given a code for one (`handOff`).
 */
export async function completeGoogle(
  ctx: Ctx,
  config: GoogleConfig,
  input: { code: string; verifier: string },
): Promise<string> {
  const response = await fetch(config.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.verifier,
    }).toString(),
  });
  const tokens = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!response.ok || !tokens.id_token) {
    throw new AuthError('SOCIAL_REFUSED', `Google would not trade the code: ${tokens.error ?? response.status}`);
  }

  let claims: IdClaims;
  try {
    claims = await verifyIdToken(tokens.id_token, {
      issuers: GOOGLE_ISSUERS,
      audiences: [config.clientId],
      now: ctx.clock.now(),
      jwksUri: config.jwksUri ?? GOOGLE_JWKS,
      ...(config.keys ? { keys: config.keys } : {}),
    });
  } catch (error) {
    throw new AuthError('SOCIAL_REFUSED', `Google's token did not check out: ${(error as IdTokenError).message}`);
  }

  return accountFor(ctx, {
    provider: 'google',
    sub: claims.sub,
    email: emailVerified(claims) ? claims.email ?? null : null,
    name: claims.name ?? null,
  });
}

/* ── the sign-in, handed to the page that asked for it ──────────────── */

/**
 * The callback cannot give a browser the session itself. Whatever it puts
 * in the address — even the fragment, which never reaches a server — the
 * browser's history keeps as it was visited, and Chrome syncs that history
 * to every device the person is signed in on. So a page is sent back a
 * code instead and trades it for the session in a request of its own
 * (`claimHandoff`).
 *
 * The code is good once, for a minute, and only together with the binding,
 * which the callback puts in a cookie in the browser that went to Google.
 * Read out of a history, it has been spent. Sent to somebody else in a link,
 * it arrives without its cookie and opens nothing — where a link carrying a
 * session once signed a stranger into an attacker's account. Both are kept
 * as hashes, like a session.
 */
const HANDOFF_SECONDS = 60;

export async function handOff(guestId: string, label: string, now: Date): Promise<{ code: string; binding: string }> {
  const code = b64(randomBytes(32));
  const binding = b64(randomBytes(32));
  await getPool().query(
    `WITH gone AS (DELETE FROM identity.auth_handoff WHERE expires_at < $5::timestamptz)
     INSERT INTO identity.auth_handoff (code_hash, binding_hash, guest_id, label, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + make_interval(secs => $6))`,
    [sha256(code), sha256(binding), guestId, label, now, HANDOFF_SECONDS],
  );
  return { code, binding };
}

/**
 * The code from the page's address and the binding from its browser's
 * cookie: a session, once. The code is spent on first sight, whether or not
 * the binding matches, so nobody gets a second try at it. One never made,
 * already spent, late, for an account closed since, or brought without its
 * binding opens nothing — and the refusal does not say which.
 */
export async function claimHandoff(ctx: Ctx, input: { code: string; binding: string | null }): Promise<GuestSession> {
  const refused = () => new AuthError('HANDOFF_REFUSED', 'no such handoff, or it was spent, late, or brought without its cookie');
  if (!input.code) throw refused();
  const { rows } = await getPool().query<{ guest_id: string; binding_hash: string; label: string | null }>(
    `DELETE FROM identity.auth_handoff h
      USING identity.guest g
      WHERE h.code_hash = $1 AND h.expires_at > $2 AND g.id = h.guest_id AND g.closed_at IS NULL
      RETURNING h.guest_id, h.binding_hash, h.label`,
    [sha256(input.code), ctx.clock.now()],
  );
  const handoff = rows[0];
  if (!handoff || !input.binding) throw refused();
  const expected = Buffer.from(handoff.binding_hash, 'hex');
  const brought = Buffer.from(sha256(input.binding), 'hex');
  if (expected.length !== brought.length || !timingSafeEqual(expected, brought)) throw refused();
  return startSessionFor(ctx, handoff.guest_id, handoff.label);
}

/* ── Apple ──────────────────────────────────────────────────────────── */

export interface AppleConfig {
  /** The app's bundle id is the audience Apple signs for. */
  audiences: string[];
  jwksUri?: string;
  keys?: Parameters<typeof verifyIdToken>[1]['keys'];
}

export function appleConfigFromEnv(): AppleConfig {
  const ids = (process.env['APPLE_BUNDLE_IDS'] ?? 'mn.basu.app').split(',').map((s) => s.trim()).filter(Boolean);
  const jwksUri = process.env['APPLE_JWKS_URI']?.trim();
  return { audiences: ids, ...(jwksUri ? { jwksUri } : {}) };
}

/**
 * The token the app got from Apple. Apple sends a person's name only the
 * first time, and only to the app — so the app passes it along, and it is
 * kept if the account has none.
 *
 * The app asks Apple with the hash of a random nonce and sends us the nonce
 * itself; the token must carry that hash. A token lifted from somewhere else
 * — issued for another request, another sign-in — carries another, and is
 * refused.
 */
export async function signInWithApple(
  ctx: Ctx,
  config: AppleConfig,
  input: { identityToken: string; nonce: string; name?: string | null; label?: string | null },
): Promise<GuestSession> {
  let claims: IdClaims;
  try {
    claims = await verifyIdToken(input.identityToken, {
      issuers: ['https://appleid.apple.com'],
      audiences: config.audiences,
      now: ctx.clock.now(),
      jwksUri: config.jwksUri ?? 'https://appleid.apple.com/auth/keys',
      ...(config.keys ? { keys: config.keys } : {}),
    });
  } catch (error) {
    throw new AuthError('SOCIAL_REFUSED', `Apple's token did not check out: ${(error as IdTokenError).message}`);
  }
  const expected = createHash('sha256').update(input.nonce).digest('hex');
  if (!input.nonce || claims.nonce !== expected) {
    throw new AuthError('SOCIAL_REFUSED', 'Apple’s token was not asked for by this sign-in');
  }
  const guestId = await accountFor(ctx, {
    provider: 'apple',
    sub: claims.sub,
    email: emailVerified(claims) ? claims.email ?? null : null,
    name: input.name ?? null,
  });
  return startSessionFor(ctx, guestId, input.label ?? null);
}

/* ── one account, whichever door ────────────────────────────────────── */

/** The column that holds each provider's subject. Ours, never input. */
const SUB_COLUMN = { google: 'google_sub', apple: 'apple_sub' } as const;

/** The account a provider's person is: found by their subject, joined by a vouched-for address, or made. */
async function accountFor(
  ctx: Ctx,
  who: { provider: 'google' | 'apple'; sub: string; email: string | null; name: string | null },
): Promise<string> {
  const column = SUB_COLUMN[who.provider];
  const email = who.email?.trim().toLowerCase() || null;
  const now = ctx.clock.now();

  return tx(async (client: PoolClient) => {
    const bySub = await client.query<{ id: string }>(
      `SELECT id FROM identity.guest WHERE ${column} = $1 AND closed_at IS NULL`,
      [who.sub],
    );
    if (bySub.rows[0]) return bySub.rows[0].id;

    if (email) {
      const byEmail = await client.query<{ id: string; linked: string | null }>(
        `SELECT id, ${column} AS linked FROM identity.guest WHERE lower(email) = $1 AND closed_at IS NULL FOR UPDATE`,
        [email],
      );
      const found = byEmail.rows[0];
      if (found) {
        // The address is theirs, but already tied to another account at the
        // same provider: joining them would be a guess, and guesses here
        // hand somebody else's wallet over.
        if (found.linked && found.linked !== who.sub) {
          throw new AuthError('SOCIAL_REFUSED', 'this address is already tied to another account at that provider');
        }
        await client.query(
          `UPDATE identity.guest SET ${column} = $2, email_verified_at = COALESCE(email_verified_at, $3), name = COALESCE(name, $4) WHERE id = $1`,
          [found.id, who.sub, now, who.name?.trim() || null],
        );
        return found.id;
      }
    }

    const made = await client.query<{ id: string }>(
      `INSERT INTO identity.guest (${column}, email, email_verified_at, name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [who.sub, email, email ? now : null, who.name?.trim() || null],
    );
    const id = made.rows[0]!.id;
    await client.query('INSERT INTO identity.profile (guest_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      id,
      who.name?.trim() || null,
    ]);
    return id;
  });
}
