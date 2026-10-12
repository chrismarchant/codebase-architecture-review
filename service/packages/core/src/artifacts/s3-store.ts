import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { z } from 'zod';
import type { CommonEnv } from '../config.js';

// config.ts exports the schema only; derive the parsed shape here.
type CommonEnvShape = z.infer<typeof CommonEnv>;
import type { ArtifactStore, ObjectInfo, PutOptions } from './store.js';
import { ChecksumMismatchError, assertDeletablePrefix, assertSafeKey, assertSafePrefix, collect, sha256Hex } from './keys.js';

export type S3Env = Pick<
  CommonEnvShape,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

/** The only part of S3Client the store uses; tests inject a fake. */
export interface S3Sender {
  send(command: unknown): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** S3 PutObject needs a known length, so streams are buffered. Published artifacts are small text/tar files. */
const MAX_PUT_BYTES = 256 * 1024 * 1024;
const S3_PAGE = 1000;
const SHA_META = 'sha256';

const httpStatus = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const isNotFound = (e: unknown): boolean => {
  const name = (e as { name?: string })?.name;
  return httpStatus(e) === 404 || name === 'NoSuchKey' || name === 'NotFound';
};

export class S3ArtifactStore implements ArtifactStore {
  readonly id = 's3';
  private readonly client: S3Sender;
  private readonly bucket: string;

  constructor(env: S3Env, client?: S3Sender) {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required for the S3 artifact store');
    this.bucket = env.S3_BUCKET;
    this.client =
      client ??
      new S3Client({
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
          : {}),
      });
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<{ bytes: number; sha256: string }> {
    assertSafeKey(key);
    const { buf, sha256 } = await collect(body, MAX_PUT_BYTES);
    if (opts.sha256 && opts.sha256.toLowerCase() !== sha256) throw new ChecksumMismatchError(key, opts.sha256, sha256);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buf,
        ContentLength: buf.length,
        ContentType: opts.contentType,
        Metadata: { [SHA_META]: sha256 },
      }),
    );
    return { bytes: buf.length, sha256 };
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const { buf } = await collect(toReadable(res.Body), MAX_PUT_BYTES);
    // Integrity check against the digest recorded at upload time (absent for foreign objects).
    const expected = res.Metadata?.[SHA_META];
    if (expected && expected !== sha256Hex(buf)) throw new ChecksumMismatchError(key, expected, sha256Hex(buf));
    return buf;
  }

  async getStream(key: string) {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        stream: toReadable(res.Body),
        contentType: (res.ContentType as string | undefined) ?? null,
        bytes: typeof res.ContentLength === 'number' ? (res.ContentLength as number) : null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, bytes: Number(res.ContentLength ?? 0), lastModified: (res.LastModified as Date | undefined) ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(prefix: string, limit = S3_PAGE): Promise<ObjectInfo[]> {
    assertSafePrefix(prefix);
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    while (out.length < limit) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(S3_PAGE, limit - out.length),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of (res.Contents ?? []) as Array<{ Key?: string; Size?: number; LastModified?: Date }>) {
        if (o.Key === undefined) continue;
        out.push({ key: o.Key, bytes: Number(o.Size ?? 0), lastModified: o.LastModified ?? null });
        if (out.length >= limit) break;
      }
      if (!res.IsTruncated || !res.NextContinuationToken) break;
      token = res.NextContinuationToken as string;
    }
    return out;
  }

  async deletePrefix(prefix: string, limit: number): Promise<number> {
    assertDeletablePrefix(prefix, limit);
    const victims = await this.list(prefix, limit);
    let deleted = 0;
    for (let i = 0; i < victims.length; i += S3_PAGE) {
      const batch = victims.slice(i, i + S3_PAGE);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
        }),
      );
      // With Quiet, S3 reports only failures; count the rest as deleted.
      deleted += batch.length - ((res?.Errors as unknown[] | undefined)?.length ?? 0);
    }
    return deleted;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function toReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return Readable.from(body as AsyncIterable<Buffer>);
  }
  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(body as import('node:stream/web').ReadableStream);
  }
  if (body instanceof Uint8Array) return Readable.from([Buffer.from(body)]);
  return Readable.from([]);
}
