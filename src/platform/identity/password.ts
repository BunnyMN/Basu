import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * A password at rest.
 *
 * scrypt, from Node's own crypto: the cost is in memory as well as time, so a
 * stolen table cannot be walked on a rented graphics card the way a SHA table
 * can. No dependency — this file is thirty lines, and a password hash is not
 * something to import from a stranger.
 *
 * The parameters live in the stored string rather than in the code, so that
 * raising the cost in two years does not lock out everybody who set a
 * password before it: an old row still says how it was made.
 */

/** `promisify` loses the options overload, so the wrapper is written out. */
const scrypt = (plain: string, salt: Buffer, bytes: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(plain, salt, bytes, options, (error, key) => (error ? reject(error) : resolve(key)));
  });

/** ~100ms on a small server, which is the number that matters. */
const COST = 16384;
const BLOCK = 8;
const PARALLEL = 1;
const KEY_BYTES = 32;

export const MIN_PASSWORD = 8;

export class PasswordError extends Error {
  constructor(readonly code: 'TOO_SHORT' | 'TOO_LONG', message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

/** What a person may choose. Length only: rules about punctuation buy nothing. */
export function checkPassword(plain: string): void {
  if (plain.length < MIN_PASSWORD) {
    throw new PasswordError('TOO_SHORT', `a password is at least ${MIN_PASSWORD} characters`);
  }
  // scrypt would happily hash a megabyte and take the server down with it.
  if (plain.length > 200) throw new PasswordError('TOO_LONG', 'a password is at most 200 characters');
}

export async function hashPassword(plain: string): Promise<string> {
  checkPassword(plain);
  const salt = randomBytes(16);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEY_BYTES, { N: COST, r: BLOCK, p: PARALLEL, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', COST, BLOCK, PARALLEL, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** False for a wrong password and for a stored value this code cannot read. */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, cost, block, parallel, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !cost || !block || !parallel || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  let given: Buffer;
  try {
    given = await scrypt(plain.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(cost),
      r: Number(block),
      p: Number(parallel),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
