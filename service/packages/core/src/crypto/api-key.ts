import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** API keys: `ar_` + base64url(32 random bytes). Only sha256(key) and a lookup prefix are stored. */
export const API_KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  key: string;
  /** First 12 characters of the key; unique lookup column `api_keys.prefix`. */
  prefix: string;
  /** sha256(key) as bytes for `api_keys.hash`. */
  hash: Buffer;
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

export function generateApiKey(): GeneratedApiKey {
  const key = `ar_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: apiKeyPrefix(key), hash: hashApiKey(key) };
}

/** Constant-time comparison of sha256(key) against the stored hash. */
export function verifyApiKey(key: string, hash: Uint8Array): boolean {
  const actual = hashApiKey(key);
  // Always run timingSafeEqual on equal-length buffers so the work does not depend on the stored value.
  const expected = hash.length === actual.length ? Buffer.from(hash) : Buffer.alloc(actual.length);
  const equal = timingSafeEqual(actual, expected);
  return equal && hash.length === actual.length && key.startsWith('ar_');
}
