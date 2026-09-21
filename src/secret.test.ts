import { afterEach, describe, expect, it } from 'vitest';
import { seal, sealed, sealing, unseal } from './secret.js';

/**
 * The bank account at rest: unreadable without the key, unchanged without
 * one, and loud when it has been tampered with.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');

afterEach(() => {
  delete process.env['BANK_KEY'];
  delete process.env['BASU_MODE'];
});

describe('sealing a bank account', () => {
  it('hides the number and hands it back', () => {
    process.env['BANK_KEY'] = KEY;
    expect(sealing()).toBe(true);
    const box = seal('5012345678');
    expect(box).not.toContain('5012345678');
    expect(sealed(box)).toBe(true);
    expect(unseal(box)).toBe('5012345678');
  });

  it('never writes the same box twice, so two suppliers with one account cannot be matched up', () => {
    process.env['BANK_KEY'] = KEY;
    expect(seal('5012345678')).not.toBe(seal('5012345678'));
  });

  it('refuses a box that was edited', () => {
    process.env['BANK_KEY'] = KEY;
    const box = seal('5012345678')!;
    const bent = box.slice(0, -4) + (box.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => unseal(bent)).toThrow();
  });

  it('leaves what it has no key for alone, and reads back text written before there was one', () => {
    expect(sealing()).toBe(false);
    expect(seal('5012345678')).toBe('5012345678');
    expect(unseal('5012345678')).toBe('5012345678');
    process.env['BANK_KEY'] = KEY;
    expect(unseal('5012345678')).toBe('5012345678');
  });

  it('will not store an account in the clear in production', () => {
    process.env['BASU_MODE'] = 'production';
    expect(() => seal('5012345678')).toThrow(/BANK_KEY/);
  });

  it('says so rather than guessing when the key is gone', () => {
    process.env['BANK_KEY'] = KEY;
    const box = seal('5012345678')!;
    delete process.env['BANK_KEY'];
    expect(() => unseal(box)).toThrow(/BANK_KEY/);
  });

  it('passes empty and missing values through', () => {
    process.env['BANK_KEY'] = KEY;
    expect(seal(null)).toBeNull();
    expect(seal('')).toBeNull();
    expect(unseal(null)).toBeNull();
    expect(unseal(undefined)).toBeNull();
  });

  it('refuses a key that is not 32 bytes', () => {
    process.env['BANK_KEY'] = Buffer.alloc(16, 1).toString('base64');
    expect(() => seal('5012345678')).toThrow(/32 bytes/);
  });
});
