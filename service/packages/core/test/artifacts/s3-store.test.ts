import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ChecksumMismatchError, InvalidArtifactKeyError, S3ArtifactStore } from '../../src/artifacts/index.js';

const ENV = {
  S3_BUCKET: 'bkt',
  S3_REGION: 'auto',
  S3_ENDPOINT: 'http://localhost:9',
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk',
  S3_FORCE_PATH_STYLE: true,
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

interface Stored {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  lastModified: Date;
}

/** In-memory fake implementing just `send`, dispatching on the SDK command's class name. No network. */
class FakeS3 {
  objects = new Map<string, Stored>();
  calls: Array<{ name: string; input: any }> = [];
  pageSize = 1000;
  deleteErrors = new Set<string>();

  async send(cmd: { constructor: { name: string }; input: any }): Promise<any> {
    const name = cmd.constructor.name;
    const input = cmd.input;
    this.calls.push({ name, input });
    expect(input.Bucket).toBe('bkt');
    switch (name) {
      case 'PutObjectCommand':
        this.objects.set(input.Key, {
          body: Buffer.from(input.Body),
          contentType: input.ContentType,
          metadata: input.Metadata,
          lastModified: new Date(),
        });
        return {};
      case 'GetObjectCommand': {
        const o = this.objects.get(input.Key);
        if (!o) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return {
          Body: Readable.from([o.body]),
          ContentType: o.contentType,
          ContentLength: o.body.length,
          Metadata: o.metadata,
        };
      }
      case 'HeadObjectCommand': {
        const o = this.objects.get(input.Key);
        if (!o) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return { ContentLength: o.body.length, LastModified: o.lastModified };
      }
      case 'ListObjectsV2Command': {
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(input.Prefix ?? '')).sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const size = Math.min(input.MaxKeys ?? 1000, this.pageSize);
        const page = keys.slice(start, start + size);
        const truncated = start + size < keys.length;
        return {
          Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key)!.body.length, LastModified: this.objects.get(Key)!.lastModified })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(start + size) : undefined,
        };
      }
      case 'DeleteObjectsCommand': {
        expect(input.Delete.Objects.length).toBeLessThanOrEqual(1000);
        const errors: unknown[] = [];
        for (const { Key } of input.Delete.Objects) {
          if (this.deleteErrors.has(Key)) errors.push({ Key, Code: 'AccessDenied' });
          else this.objects.delete(Key);
        }
        return { Errors: errors.length ? errors : undefined };
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  }
}

function make(): { store: S3ArtifactStore; fake: FakeS3 } {
  const fake = new FakeS3();
  return { store: new S3ArtifactStore(ENV, fake), fake };
}

describe('S3ArtifactStore', () => {
  it('requires a bucket', () => {
    expect(() => new S3ArtifactStore({ ...ENV, S3_BUCKET: undefined })).toThrow(/S3_BUCKET/);
  });

  it('constructs a real client from env without any network call', () => {
    const store = new S3ArtifactStore(ENV);
    expect(store.id).toBe('s3');
  });

  it('puts buffers and streams, hashing and recording the digest as metadata', async () => {
    const { store, fake } = make();
    expect(await store.put('a/b.json', Buffer.from('hello'), { contentType: 'application/json' })).toEqual({
      bytes: 5,
      sha256: sha('hello'),
    });
    expect(await store.put('a/c.txt', Readable.from([Buffer.from('he'), Buffer.from('llo')]), { contentType: 'text/plain' })).toEqual({
      bytes: 5,
      sha256: sha('hello'),
    });
    const put = fake.calls[0]!;
    expect(put.name).toBe('PutObjectCommand');
    expect(put.input).toMatchObject({ Key: 'a/b.json', ContentType: 'application/json', ContentLength: 5 });
    expect(put.input.Metadata).toEqual({ sha256: sha('hello') });
    expect(put.input).not.toHaveProperty('ChecksumAlgorithm');
  });

  it('rejects a digest mismatch before uploading', async () => {
    const { store, fake } = make();
    await expect(store.put('k', Buffer.from('x'), { contentType: 't', sha256: sha('y') })).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(fake.calls).toHaveLength(0);
  });

  it('gets, streams and heads objects; missing keys give null', async () => {
    const { store } = make();
    await store.put('o', Buffer.from('payload'), { contentType: 'text/plain' });
    expect((await store.get('o'))?.toString()).toBe('payload');
    const s = await store.getStream('o');
    expect(s).toMatchObject({ contentType: 'text/plain', bytes: 7 });
    const chunks: Buffer[] = [];
    for await (const c of s!.stream) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('payload');
    expect(await store.head('o')).toMatchObject({ key: 'o', bytes: 7 });

    expect(await store.get('missing')).toBeNull();
    expect(await store.getStream('missing')).toBeNull();
    expect(await store.head('missing')).toBeNull();
  });

  it('detects corruption against the recorded digest on get', async () => {
    const { store, fake } = make();
    await store.put('o', Buffer.from('payload'), { contentType: 't' });
    fake.objects.get('o')!.body = Buffer.from('tampered');
    await expect(store.get('o')).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it('lists across pages up to the limit', async () => {
    const { store, fake } = make();
    fake.pageSize = 2;
    for (const k of ['p/1', 'p/2', 'p/3', 'p/4', 'p/5', 'other']) await store.put(k, Buffer.from(k), { contentType: 't' });
    fake.calls.length = 0;
    expect((await store.list('p/')).map((o) => o.key)).toEqual(['p/1', 'p/2', 'p/3', 'p/4', 'p/5']);
    expect(fake.calls.filter((c) => c.name === 'ListObjectsV2Command')).toHaveLength(3);
    expect((await store.list('p/', 3)).map((o) => o.key)).toEqual(['p/1', 'p/2', 'p/3']);
  });

  it('deletes in batches of at most 1000, bounded by limit, and counts failures out', async () => {
    const { store, fake } = make();
    for (let i = 0; i < 2300; i++) fake.objects.set(`d/${String(i).padStart(5, '0')}`, { body: Buffer.alloc(1), lastModified: new Date() });
    fake.objects.set('keep', { body: Buffer.alloc(1), lastModified: new Date() });

    expect(await store.deletePrefix('d/', 1500)).toBe(1500);
    const deletes = fake.calls.filter((c) => c.name === 'DeleteObjectsCommand');
    expect(deletes.map((c) => c.input.Delete.Objects.length)).toEqual([1000, 500]);
    expect(deletes[0]!.input.Delete.Quiet).toBe(true);
    expect([...fake.objects.keys()].filter((k) => k.startsWith('d/'))).toHaveLength(800);

    fake.deleteErrors.add('d/01500');
    expect(await store.deletePrefix('d/', 10)).toBe(9);
    expect(fake.objects.has('keep')).toBe(true);
  });

  it('refuses empty prefixes for deletion and unsafe keys everywhere', async () => {
    const { store, fake } = make();
    await expect(store.deletePrefix('', 10)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.deletePrefix('a/', 0)).rejects.toThrow(RangeError);
    for (const key of ['../x', '/x', 'a\\b', 'a/../b']) {
      await expect(store.put(key, Buffer.from('x'), { contentType: 't' })).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      await expect(store.get(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      await expect(store.head(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    }
    await expect(store.list('../')).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    expect(fake.calls).toHaveLength(0);
  });

  it('pings via a one-key listing and reports failures as false', async () => {
    const { store, fake } = make();
    expect(await store.ping()).toBe(true);
    expect(fake.calls[0]).toMatchObject({ name: 'ListObjectsV2Command', input: { MaxKeys: 1 } });
    const broken = new S3ArtifactStore(ENV, { send: async () => Promise.reject(new Error('down')) });
    expect(await broken.ping()).toBe(false);
  });

  it('propagates non-404 errors', async () => {
    const denied = new S3ArtifactStore(ENV, {
      send: async () => Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })),
    });
    await expect(denied.get('k')).rejects.toThrow('denied');
    await expect(denied.head('k')).rejects.toThrow('denied');
  });
});
