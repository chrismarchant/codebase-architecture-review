import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createNonceCache,
  generateApiKey,
  hashApiKey,
  openSecret,
  openSecretBytes,
  sealSecret,
  signWake,
  verifyApiKey,
  verifyWake,
} from '../../src/crypto/index.js';

const kek = randomBytes(32).toString('base64');

describe('secret box', () => {
  it('round-trips strings and bytes with the documented layout', () => {
    const sealed = sealSecret(kek, 'ghp_example-token');
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(sealed.length).toBe(12 + Buffer.byteLength('ghp_example-token') + 16);
    expect(openSecret(kek, sealed)).toBe('ghp_example-token');

    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(Array.from(openSecretBytes(kek, sealSecret(kek, bytes)))).toEqual([0, 1, 2, 255]);
    expect(openSecret(kek, sealSecret(kek, ''))).toBe('');
  });

  it('uses a fresh IV per seal', () => {
    const a = sealSecret(kek, 'same');
    const b = sealSecret(kek, 'same');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('detects tampering in the iv, ciphertext and tag', () => {
    const sealed = sealSecret(kek, 'secret value');
    for (const index of [0, 12, sealed.length - 1]) {
      const copy = new Uint8Array(sealed);
      copy[index] = copy[index]! ^ 0x01;
      expect(() => openSecret(kek, copy)).toThrow('secret could not be opened');
    }
    expect(() => openSecret(kek, sealed.subarray(0, sealed.length - 1))).toThrow();
    expect(() => openSecret(kek, new Uint8Array(5))).toThrow('malformed');
  });

  it('fails with a different key and rejects invalid keys', () => {
    const sealed = sealSecret(kek, 'x');
    expect(() => openSecret(randomBytes(32).toString('base64'), sealed)).toThrow('secret could not be opened');
    expect(() => sealSecret(randomBytes(16).toString('base64'), 'x')).toThrow(/32 bytes/);
    expect(() => openSecret('', sealed)).toThrow(/32 bytes/);
  });

  it('works on a subarray view (as returned by database drivers)', () => {
    const sealed = sealSecret(kek, 'view');
    const backing = new Uint8Array(sealed.length + 10);
    backing.set(sealed, 5);
    expect(openSecret(kek, backing.subarray(5, 5 + sealed.length))).toBe('view');
  });
});

describe('api keys', () => {
  it('generates ar_ keys with a 12 character prefix and a sha256 hash', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^ar_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix).toHaveLength(12);
    expect(hash).toHaveLength(32);
    expect(Buffer.from(hashApiKey(key)).equals(hash)).toBe(true);
    expect(generateApiKey().key).not.toBe(key);
  });

  it('verifies the right key and rejects wrong keys and malformed hashes', () => {
    const { key, hash } = generateApiKey();
    expect(verifyApiKey(key, hash)).toBe(true);
    expect(verifyApiKey(key, new Uint8Array(hash))).toBe(true);
    expect(verifyApiKey(`${key}x`, hash)).toBe(false);
    expect(verifyApiKey(generateApiKey().key, hash)).toBe(false);
    expect(verifyApiKey('', hash)).toBe(false);
    expect(verifyApiKey(key, hash.subarray(0, 16))).toBe(false);
    expect(verifyApiKey(key, new Uint8Array(0))).toBe(false);
    // A key lacking the ar_ prefix never verifies even if its hash matches.
    expect(verifyApiKey('xx_abc', hashApiKey('xx_abc'))).toBe(false);
  });
});

describe('wake tokens', () => {
  const secret = 'shared-wake-secret';
  const now = 1_800_000_000_000;
  const body = { scanId: '11111111-1111-4111-8111-111111111111', nonce: 'n-1', ts: now };

  it('signs deterministically and verifies', () => {
    const token = signWake(secret, body);
    expect(token).toBe(signWake(secret, { ...body }));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyWake(secret, body, token, { now })).toBe(true);
    // Key order of the input object does not matter (canonical JSON).
    expect(verifyWake(secret, { ts: body.ts, nonce: body.nonce, scanId: body.scanId }, token, { now })).toBe(true);
  });

  it('supports wake-all tokens without a scanId', () => {
    const b = { nonce: 'n-2', ts: now };
    const token = signWake(secret, b);
    expect(verifyWake(secret, b, token, { now })).toBe(true);
    expect(verifyWake(secret, { ...b, scanId: null }, token, { now })).toBe(true);
    expect(verifyWake(secret, { ...b, scanId: 'x' }, token, { now })).toBe(false);
  });

  it('enforces the timestamp window (default 5 minutes, either direction)', () => {
    const token = signWake(secret, body);
    expect(verifyWake(secret, body, token, { now: now + 300_000 })).toBe(true);
    expect(verifyWake(secret, body, token, { now: now + 300_001 })).toBe(false);
    expect(verifyWake(secret, body, token, { now: now - 300_000 })).toBe(true);
    expect(verifyWake(secret, body, token, { now: now - 300_001 })).toBe(false);
    expect(verifyWake(secret, body, token, { now: now + 10_000, maxSkewMs: 5_000 })).toBe(false);
  });

  it('rejects tampered bodies, tokens and wrong secrets', () => {
    const token = signWake(secret, body);
    expect(verifyWake(secret, { ...body, nonce: 'n-9' }, token, { now })).toBe(false);
    expect(verifyWake(secret, { ...body, ts: now + 1 }, token, { now })).toBe(false);
    expect(verifyWake(secret, { ...body, scanId: 'other' }, token, { now })).toBe(false);
    expect(verifyWake('another-secret', body, token, { now })).toBe(false);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyWake(secret, body, flipped, { now })).toBe(false);
    expect(verifyWake(secret, body, '', { now })).toBe(false);
    expect(verifyWake(secret, body, token.slice(0, 20), { now })).toBe(false);
    expect(verifyWake('', body, token, { now })).toBe(false);
  });

  it('rejects malformed bodies', () => {
    const token = signWake(secret, body);
    expect(verifyWake(secret, { ...body, nonce: '' }, token, { now })).toBe(false);
    expect(verifyWake(secret, { ...body, ts: Number.NaN }, token, { now })).toBe(false);
    expect(verifyWake(secret, { ...body, ts: '1' as unknown as number }, token, { now })).toBe(false);
    expect(verifyWake(secret, undefined as never, token, { now })).toBe(false);
    expect(() => signWake('', body)).toThrow();
  });

  it('uses the real clock by default', () => {
    const fresh = { nonce: 'n-3', ts: Date.now() };
    expect(verifyWake(secret, fresh, signWake(secret, fresh))).toBe(true);
    const old = { nonce: 'n-4', ts: Date.now() - 3_600_000 };
    expect(verifyWake(secret, old, signWake(secret, old))).toBe(false);
  });

  it('nonce cache detects replays, expires entries and stays bounded', () => {
    const cache = createNonceCache({ ttlMs: 1000, maxEntries: 3 });
    expect(cache.seen('a', 0)).toBe(false);
    expect(cache.seen('a', 10)).toBe(true);
    expect(cache.seen('a', 1011)).toBe(false); // expired, accepted again
    for (const n of ['b', 'c', 'd', 'e']) cache.seen(n, 1100);
    expect(cache.size).toBe(3);
    expect(cache.seen('b', 1100)).toBe(false); // evicted as oldest
  });
});
