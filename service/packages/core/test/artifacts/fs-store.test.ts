import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, FsArtifactStore, InvalidArtifactKeyError, artifactKeys } from '../../src/artifacts/index.js';

let root: string;
let store: FsArtifactStore;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const text = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fs-store-'));
  store = new FsArtifactStore(join(root, 'store'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FsArtifactStore', () => {
  it('puts buffers and streams, returning byte count and sha256', async () => {
    const a = await store.put('scans/s1/attempts/1/a.json', Buffer.from('hello'), { contentType: 'application/json' });
    expect(a).toEqual({ bytes: 5, sha256: sha('hello') });
    const b = await store.put('scans/s1/attempts/1/b.txt', Readable.from([Buffer.from('he'), Buffer.from('llo!')]), {
      contentType: 'text/plain',
      sha256: sha('hello!'),
    });
    expect(b).toEqual({ bytes: 6, sha256: sha('hello!') });
    expect((await store.get('scans/s1/attempts/1/a.json'))?.toString()).toBe('hello');
    expect((await store.get('scans/s1/attempts/1/b.txt'))?.toString()).toBe('hello!');
  });

  it('rejects a precomputed digest mismatch and leaves nothing behind', async () => {
    await expect(store.put('x/y', Buffer.from('data'), { contentType: 't', sha256: sha('other') })).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
    expect(await store.head('x/y')).toBeNull();
    const staged = await readdir(join(root, 'store', '.tmp-uploads'));
    expect(staged).toEqual([]);
  });

  it('overwrites existing keys', async () => {
    await store.put('k', Buffer.from('one'), { contentType: 't' });
    await store.put('k', Buffer.from('two!'), { contentType: 't' });
    expect((await store.get('k'))?.toString()).toBe('two!');
    expect((await store.head('k'))?.bytes).toBe(4);
  });

  it('returns null for missing keys and directories', async () => {
    await store.put('dir/file', Buffer.from('x'), { contentType: 't' });
    expect(await store.get('nope')).toBeNull();
    expect(await store.get('dir')).toBeNull();
    expect(await store.head('nope')).toBeNull();
    expect(await store.head('dir')).toBeNull();
    expect(await store.getStream('nope')).toBeNull();
    expect(await store.getStream('dir')).toBeNull();
  });

  it('streams objects with their size', async () => {
    await store.put('s/o', Buffer.from('streamed'), { contentType: 'text/plain' });
    const res = await store.getStream('s/o');
    expect(res?.bytes).toBe(8);
    expect(res?.contentType).toBeNull();
    expect(await text(res!.stream)).toBe('streamed');
  });

  it('heads objects', async () => {
    await store.put('h/o', Buffer.from('12345'), { contentType: 't' });
    const info = await store.head('h/o');
    expect(info).toMatchObject({ key: 'h/o', bytes: 5 });
    expect(info?.lastModified).toBeInstanceOf(Date);
  });

  it('lists by prefix in key order, bounded by limit, ignoring staging files', async () => {
    for (const k of ['p/2/b', 'p/1/a', 'p/1/c', 'p/10/z', 'q/1/a', 'pp']) {
      await store.put(k, Buffer.from(k), { contentType: 't' });
    }
    expect((await store.list('p/')).map((o) => o.key)).toEqual(['p/1/a', 'p/1/c', 'p/10/z', 'p/2/b']);
    expect((await store.list('p/1')).map((o) => o.key)).toEqual(['p/1/a', 'p/1/c', 'p/10/z']);
    expect((await store.list('p/1/')).map((o) => o.key)).toEqual(['p/1/a', 'p/1/c']);
    expect((await store.list('p/', 2)).map((o) => o.key)).toEqual(['p/1/a', 'p/1/c']);
    expect((await store.list('p', 100)).map((o) => o.key)).toContain('pp');
    expect((await store.list('')).map((o) => o.key)).toHaveLength(6);
    expect(await store.list('missing/')).toEqual([]);
  });

  it('deletes at most `limit` objects under a prefix and prunes empty directories', async () => {
    const prefix = artifactKeys.attemptPrefix('scan', 1);
    for (const n of ['a', 'b', 'c', 'sub/d']) await store.put(`${prefix}${n}`, Buffer.from(n), { contentType: 't' });
    await store.put(artifactKeys.attemptPrefix('scan', 2) + 'keep', Buffer.from('k'), { contentType: 't' });

    expect(await store.deletePrefix(prefix, 2)).toBe(2);
    expect(await store.list(prefix)).toHaveLength(2);
    expect(await store.deletePrefix(prefix, 100)).toBe(2);
    expect(await store.list(prefix)).toEqual([]);
    expect(await store.deletePrefix(prefix, 100)).toBe(0);
    expect((await store.list('scans/'))?.map((o) => o.key)).toEqual(['scans/scan/attempts/2/keep']);
    expect(await readdir(join(root, 'store', 'scans', 'scan', 'attempts'))).toEqual(['2']);
  });

  it('refuses to delete with an empty prefix or an invalid limit', async () => {
    await store.put('a', Buffer.from('a'), { contentType: 't' });
    await expect(store.deletePrefix('', 10)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.deletePrefix('a', 0)).rejects.toThrow(RangeError);
    expect(await store.head('a')).not.toBeNull();
  });

  it.each([
    '../escape',
    'a/../../escape',
    '/abs/path',
    'a\\b',
    'a/..',
    '',
    'dir/',
    'a\0b',
    '.tmp-uploads/x',
  ])('rejects unsafe key %j on every operation', async (key) => {
    const body = Buffer.from('x');
    await expect(store.put(key, body, { contentType: 't' })).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.get(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.getStream(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.head(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
  });

  it('rejects unsafe prefixes for list and deletePrefix', async () => {
    await expect(store.list('../')).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.deletePrefix('/', 5)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(store.deletePrefix('a\\b', 5)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
  });

  it('never writes outside the root', async () => {
    await store.ping(); // creates the store directory
    await writeFile(join(root, 'outside.txt'), 'secret');
    await expect(store.put('../outside.txt', Buffer.from('pwn'), { contentType: 't' })).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual(['outside.txt', 'store']);
  });

  it('pings, creating the root when missing', async () => {
    expect(await store.ping()).toBe(true);
    await mkdir(join(root, 'file-parent'), { recursive: true });
    await writeFile(join(root, 'file-parent', 'f'), '');
    const bad = new FsArtifactStore(join(root, 'file-parent', 'f', 'sub'));
    expect(await bad.ping()).toBe(false);
  });

  it('does not follow a symlinked directory out of a prefix listing as a regular file', async () => {
    await store.put('d/a', Buffer.from('a'), { contentType: 't' });
    await symlink(root, join(root, 'store', 'link'));
    const keys = (await store.list('')).map((o) => o.key);
    expect(keys).toEqual(['d/a']);
  });
});

describe('artifactKeys', () => {
  it('builds attempt-scoped keys', () => {
    expect(artifactKeys.manifest('s', 3)).toBe('scans/s/attempts/3/manifest.json');
    expect(artifactKeys.checkpointPrefix('s', 3)).toBe('scans/s/attempts/3/checkpoint/');
  });
});
