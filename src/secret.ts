import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mode } from './mode.js';

/**
 * The few fields that are worth encrypting at rest.
 *
 * A bank account number and the name on it are what make a transfer
 * possible, and a stolen database dump is the way they leak. Everything else
 * in these tables is either public (a supplier's name), already hashed (a
 * session token) or useless on its own (an order code), so it stays readable
 * — an encrypted column nobody can search is a cost, and paying it for the
 * whole schema buys nothing.
 *
 * AES-256-GCM, one random nonce per write, the tag stored beside the text:
 * a row that has been tampered with fails to open rather than opening wrong.
 * The key is `BANK_KEY` in the environment, 32 bytes, base64. It is not in
 * the database and not in the repository, so a dump is not enough.
 *
 * Sealed text is self-describing — `v1:<nonce>:<tag>:<ciphertext>` — so
 * `unseal` can hand back a value written before there was a key, and the
 * switch needs no data migration. Production refuses to seal without a key;
 * a developer's machine writes plain text and says so through `sealed()`.
 */

const PREFIX = 'v1';

let cached: { raw: string; key: Buffer } | null = null;

function key(): Buffer | null {
  const raw = process.env['BANK_KEY']?.trim();
  if (!raw) return null;
  if (cached?.raw === raw) return cached.key;
  const parsed = Buffer.from(raw, 'base64');
  if (parsed.length !== 32) {
    throw new Error('BANK_KEY must be 32 bytes, base64 encoded — try: openssl rand -base64 32');
  }
  cached = { raw, key: parsed };
  return parsed;
}

/** Whether values written from now on will be encrypted. Startup logs this. */
export function sealing(): boolean {
  return key() !== null;
}

/** True for a value this module wrote. Used by tests and by the checks. */
export function sealed(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

export function seal(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (sealed(value)) return value;
  const k = key();
  if (!k) {
    if (mode() === 'production') {
      throw new Error('BANK_KEY is missing: production will not store a bank account in the clear');
    }
    return value;
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, nonce);
  const text = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [PREFIX, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), text.toString('base64url')].join(':');
}

export function unseal(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!sealed(value)) return value;
  const k = key();
  if (!k) throw new Error('BANK_KEY is missing: this value was stored encrypted and cannot be read without it');
  const [, nonce, tag, text] = value.split(':');
  if (!nonce || !tag || !text) throw new Error('sealed value is malformed');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(text, 'base64url')), decipher.final()]).toString('utf8');
}
