/**
 * Artifact store interface (SS00 §2, ADR-005). Keys are opaque strings under a
 * per-scan attempt prefix. Implementations: S3-compatible (production, Railway
 * Buckets) and local filesystem (tests, development).
 */
import type { Readable } from 'node:stream';

export interface PutOptions {
  contentType: string;
  /** Optional precomputed SHA-256 (hex) for integrity verification on read. */
  sha256?: string;
}

export interface ObjectInfo {
  key: string;
  bytes: number;
  lastModified: Date | null;
}

export interface ArtifactStore {
  readonly id: string; // 's3' | 'fs'
  put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<Buffer | null>;
  getStream(key: string): Promise<{ stream: Readable; contentType: string | null; bytes: number | null } | null>;
  head(key: string): Promise<ObjectInfo | null>;
  list(prefix: string, limit?: number): Promise<ObjectInfo[]>;
  /** Deletes up to `limit` objects under prefix; returns how many were deleted. Bounded. */
  deletePrefix(prefix: string, limit: number): Promise<number>;
  ping(): Promise<boolean>;
}

/** Key layout (SS00 §8). Keep in one place so API and runner agree. */
export const artifactKeys = {
  attemptPrefix: (scanId: string, fence: number) => `scans/${scanId}/attempts/${fence}/`,
  checkpointPrefix: (scanId: string, fence: number) => `scans/${scanId}/attempts/${fence}/checkpoint/`,
  artifact: (scanId: string, fence: number, relPath: string) => `scans/${scanId}/attempts/${fence}/${relPath}`,
  manifest: (scanId: string, fence: number) => `scans/${scanId}/attempts/${fence}/manifest.json`,
  comparison: (comparisonId: string) => `comparisons/${comparisonId}/comparison.json`,
} as const;
