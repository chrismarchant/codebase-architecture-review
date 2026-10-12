import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Wake tokens (SS00 §6 `/internal/wake`, §10): HMAC-SHA256 over canonical JSON of
 * {nonce, scanId, ts}. The token authorizes "start claiming" only. `ts` is epoch
 * milliseconds; verification enforces a skew window. Replay protection for the
 * nonce is the receiver's job: use createNonceCache.
 */
export interface WakeBody {
  scanId?: string | null;
  nonce: string;
  ts: number;
}

export interface VerifyWakeOptions {
  /** Maximum |now - ts| accepted. Default 300 000 ms. */
  maxSkewMs?: number;
  /** Clock override for tests. */
  now?: number;
}

export const DEFAULT_WAKE_SKEW_MS = 300_000;

function canonical(body: WakeBody): string {
  // Fixed key order => canonical JSON.
  return JSON.stringify({ nonce: body.nonce, scanId: body.scanId ?? null, ts: body.ts });
}

function mac(secret: string, body: WakeBody): Buffer {
  return createHmac('sha256', secret).update(canonical(body), 'utf8').digest();
}

export function signWake(secret: string, body: WakeBody): string {
  if (!secret) throw new Error('wake secret must not be empty');
  return mac(secret, body).toString('base64url');
}

export function verifyWake(secret: string, body: WakeBody, token: string, opts: VerifyWakeOptions = {}): boolean {
  if (!secret || typeof token !== 'string') return false;
  if (typeof body?.nonce !== 'string' || body.nonce.length === 0) return false;
  if (typeof body.ts !== 'number' || !Number.isFinite(body.ts)) return false;
  if (body.scanId != null && typeof body.scanId !== 'string') return false;
  const maxSkew = opts.maxSkewMs ?? DEFAULT_WAKE_SKEW_MS;
  const now = opts.now ?? Date.now();
  const expected = mac(secret, body);
  const given = Buffer.from(token, 'base64url');
  // Compare first, then check the window, so that timing does not reveal which check failed.
  const macOk = given.length === expected.length && timingSafeEqual(given, expected);
  return macOk && Math.abs(now - body.ts) <= maxSkew;
}

export interface NonceCache {
  /** Returns true when the nonce was already seen (replay); otherwise records it and returns false. */
  seen(nonce: string, now?: number): boolean;
  readonly size: number;
}

/** Bounded in-memory replay cache. Entries expire after ttlMs; oldest are evicted beyond maxEntries. */
export function createNonceCache(opts: { ttlMs?: number; maxEntries?: number } = {}): NonceCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_WAKE_SKEW_MS * 2;
  const maxEntries = opts.maxEntries ?? 10_000;
  const entries = new Map<string, number>(); // insertion order == expiry order
  const prune = (now: number) => {
    for (const [nonce, at] of entries) {
      if (now - at <= ttlMs && entries.size <= maxEntries) break;
      entries.delete(nonce);
    }
  };
  return {
    seen(nonce, now = Date.now()) {
      prune(now);
      if (entries.has(nonce)) return true;
      entries.set(nonce, now);
      prune(now);
      return false;
    },
    get size() {
      return entries.size;
    },
  };
}
