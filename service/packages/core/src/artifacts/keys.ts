import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * Key validation shared by all artifact stores. Keys are opaque, but they are
 * built from request-derived values (scan ids, relative paths), so traversal is
 * rejected at the store boundary regardless of the caller.
 */
export class InvalidArtifactKeyError extends Error {
  override readonly name = 'InvalidArtifactKeyError';
  constructor(reason: string) {
    super(`invalid artifact key: ${reason}`);
  }
}

const MAX_KEY_BYTES = 1024;

function check(key: string, what: 'key' | 'prefix'): void {
  if (typeof key !== 'string') throw new InvalidArtifactKeyError(`${what} must be a string`);
  if (key.includes('..')) throw new InvalidArtifactKeyError(`${what} contains '..'`);
  if (key.startsWith('/')) throw new InvalidArtifactKeyError(`${what} starts with '/'`);
  if (key.includes('\\')) throw new InvalidArtifactKeyError(`${what} contains a backslash`);
  if (key.includes('\0')) throw new InvalidArtifactKeyError(`${what} contains a NUL byte`);
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) throw new InvalidArtifactKeyError(`${what} is too long`);
}

/** Validates an object key (non-empty, not a directory-style key). */
export function assertSafeKey(key: string): void {
  check(key, 'key');
  if (key.length === 0) throw new InvalidArtifactKeyError('key is empty');
  if (key.endsWith('/')) throw new InvalidArtifactKeyError("key ends with '/'");
  if (key.includes('//')) throw new InvalidArtifactKeyError("key contains '//'");
}

/** Validates a listing prefix (may be empty or end with '/'). */
export function assertSafePrefix(prefix: string): void {
  check(prefix, 'prefix');
  if (prefix.includes('//')) throw new InvalidArtifactKeyError("prefix contains '//'");
}

/** Deletion is destructive: an empty prefix would address the whole store. */
export function assertDeletablePrefix(prefix: string, limit: number): void {
  assertSafePrefix(prefix);
  if (prefix.length === 0) throw new InvalidArtifactKeyError('refusing to delete with an empty prefix');
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
}

export class ChecksumMismatchError extends Error {
  override readonly name = 'ChecksumMismatchError';
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch for ${key}`);
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Reads a stream fully while hashing; fails once maxBytes is exceeded. */
export async function collect(body: Buffer | Readable, maxBytes: number): Promise<{ buf: Buffer; sha256: string }> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new RangeError(`object exceeds ${maxBytes} bytes`);
    return { buf: body, sha256: sha256Hex(body) };
  }
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > maxBytes) {
      body.destroy();
      throw new RangeError(`object exceeds ${maxBytes} bytes`);
    }
    hash.update(b);
    chunks.push(b);
  }
  return { buf: Buffer.concat(chunks), sha256: hash.digest('hex') };
}
