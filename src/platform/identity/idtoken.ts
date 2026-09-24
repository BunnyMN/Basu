import { createPublicKey, verify } from 'node:crypto';

/** One published signing key, as a JWK set lists it. */
export interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/**
 * An ID token from Google or Apple, checked the way their documents say.
 *
 * Both sign with RS256 and publish their current public keys at a URL. A
 * token is believed when, and only when: its signature verifies against one
 * of those keys, it was issued by the provider we expect, for this app (the
 * audience), and it has not expired. Anything else is a string somebody
 * typed.
 *
 * No library: Node verifies RS256 against a JWK on its own, and a JWT is
 * three base64 strings and a dot. The part that is easy to get wrong —
 * accepting `alg: none`, or an HMAC signed with the public key — is closed by
 * accepting RS256 and nothing else.
 */

export interface IdClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat?: number;
  email?: string;
  /** Google sends a boolean, Apple a boolean or the string "true". */
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
}

export interface VerifyOptions {
  issuers: readonly string[];
  audiences: readonly string[];
  now: Date;
  /** The provider's published keys. Fetched and cached when not given. */
  jwksUri: string;
  keys?: readonly Jwk[];
}

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/* Keys change a few times a year; an hour's cache is polite and fresh enough. */
const cache = new Map<string, { keys: Jwk[]; until: number }>();

async function keysFor(uri: string, now: Date, forceRefresh = false): Promise<Jwk[]> {
  const held = cache.get(uri);
  if (held && held.until > now.getTime() && !forceRefresh) return held.keys;
  const response = await fetch(uri);
  if (!response.ok) throw new IdTokenError(`could not fetch signing keys (${response.status})`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  cache.set(uri, { keys, until: now.getTime() + 60 * 60 * 1000 });
  return keys;
}

export async function verifyIdToken(token: string, options: VerifyOptions): Promise<IdClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('not a JWT');
  const [head, body, signature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = decode(head) as { alg?: string; kid?: string };
    claims = decode(body) as IdClaims;
  } catch {
    throw new IdTokenError('unreadable token');
  }
  if (header.alg !== 'RS256') throw new IdTokenError(`refusing algorithm ${String(header.alg)}`);

  // A key we have never seen may be one published since we last looked.
  let keys = options.keys ? [...options.keys] : await keysFor(options.jwksUri, options.now);
  let key = keys.find((k) => k.kid === header.kid);
  if (!key && !options.keys) {
    keys = await keysFor(options.jwksUri, options.now, true);
    key = keys.find((k) => k.kid === header.kid);
  }
  if (!key) throw new IdTokenError('signed by a key the provider does not publish');

  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${head}.${body}`),
    createPublicKey({ key: { ...key }, format: 'jwk' }),
    Buffer.from(signature, 'base64url'),
  );
  if (!ok) throw new IdTokenError('bad signature');

  if (!options.issuers.includes(claims.iss)) throw new IdTokenError(`issued by ${claims.iss}`);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((a) => options.audiences.includes(a))) throw new IdTokenError('issued for another app');
  // A little slack for clocks that disagree, and no more.
  const nowSeconds = Math.floor(options.now.getTime() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 300 < nowSeconds) throw new IdTokenError('expired');
  if (typeof claims.iat === 'number' && claims.iat - 300 > nowSeconds) throw new IdTokenError('issued in the future');
  if (!claims.sub) throw new IdTokenError('no subject');
  return claims;
}

/** Google says true; Apple says true or "true". Anything else is no. */
export const emailVerified = (claims: IdClaims): boolean =>
  claims.email_verified === true || claims.email_verified === 'true';
