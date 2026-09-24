import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyIdToken, type Jwk } from './idtoken.js';

/**
 * A token from Google or Apple, believed only for the right reasons.
 *
 * The keys are made here, so every property is checked against a signature
 * that really verifies — a test that only feeds garbage proves nothing about
 * the path a real token takes.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'RS256' };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }, key = privateKey) {
  const head = b64(header);
  const body = b64(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString('base64url')}`;
}

const now = new Date('2026-09-24T03:00:00Z');
const seconds = Math.floor(now.getTime() / 1000);
const good = { iss: 'https://accounts.google.com', aud: 'client-1', sub: 'g-123', exp: seconds + 600, iat: seconds, email: 'bat@gmail.com', email_verified: true };
const options = { issuers: ['https://accounts.google.com'], audiences: ['client-1'], now, jwksUri: 'unused', keys: [jwk] };

describe('an ID token', () => {
  it('is believed when the key, issuer, audience and clock all agree', async () => {
    const claims = await verifyIdToken(sign(good), options);
    expect(claims).toMatchObject({ sub: 'g-123', email: 'bat@gmail.com' });
  });

  it('is refused when signed by a key the provider does not publish', async () => {
    await expect(verifyIdToken(sign(good, undefined, other.privateKey), options)).rejects.toThrow(/bad signature/);
    await expect(verifyIdToken(sign(good, { alg: 'RS256', kid: 'nobody' }), options)).rejects.toThrow(/does not publish/);
  });

  it('is refused when made for another app, or by another issuer', async () => {
    await expect(verifyIdToken(sign({ ...good, aud: 'someone-else' }), options)).rejects.toThrow(/another app/);
    await expect(verifyIdToken(sign({ ...good, iss: 'https://evil.example' }), options)).rejects.toThrow(/issued by/);
  });

  it('is refused once it has expired', async () => {
    await expect(verifyIdToken(sign({ ...good, exp: seconds - 3600 }), options)).rejects.toThrow(/expired/);
  });

  it('is refused when it names no algorithm, or the wrong one', async () => {
    const [, body] = sign(good).split('.');
    const none = `${b64({ alg: 'none' })}.${body}.`;
    await expect(verifyIdToken(none, options)).rejects.toThrow(/refusing algorithm/);
    await expect(verifyIdToken(sign(good, { alg: 'HS256', kid: 'k1' }), options)).rejects.toThrow(/refusing algorithm/);
  });

  it('is refused when it has been edited after signing', async () => {
    const [head, , signature] = sign(good).split('.');
    const forged = `${head}.${b64({ ...good, sub: 'someone-else' })}.${signature}`;
    await expect(verifyIdToken(forged, options)).rejects.toThrow(/bad signature/);
  });

  it('is refused when it is not a token at all', async () => {
    await expect(verifyIdToken('hello', options)).rejects.toThrow(/not a JWT/);
  });
});
