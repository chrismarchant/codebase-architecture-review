import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactStore, ObjectInfo, PutOptions } from './store.js';
import { ChecksumMismatchError, InvalidArtifactKeyError, assertDeletablePrefix, assertSafeKey, assertSafePrefix } from './keys.js';

/** Staging directory for atomic writes; keys may not use it. */
const TMP_DIR = '.tmp-uploads';

const isEnoent = (e: unknown) => {
  const c = (e as NodeJS.ErrnoException | undefined)?.code;
  return c === 'ENOENT' || c === 'ENOTDIR' || c === 'EISDIR';
};

/** Local filesystem store for tests and development. Content types are not persisted (reads return null). */
export class FsArtifactStore implements ArtifactStore {
  readonly id = 'fs';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    if (key === TMP_DIR || key.startsWith(`${TMP_DIR}/`)) throw new InvalidArtifactKeyError('reserved key');
    const p = resolve(this.root, key);
    // Belt and braces on top of the '..' rule: the resolved path must stay inside the root.
    if (!p.startsWith(this.root + sep)) throw new InvalidArtifactKeyError('escapes the store root');
    return p;
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<{ bytes: number; sha256: string }> {
    const target = this.pathFor(key);
    const tmpDir = join(this.root, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    const hash = createHash('sha256');
    let bytes = 0;
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    try {
      // Hash while streaming to a staging file, then rename: readers never see a partial object.
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer | Uint8Array>) {
          for await (const c of chunks) {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            hash.update(b);
            bytes += b.length;
            yield b;
          }
        },
        createWriteStream(tmp, { flags: 'wx' }),
      );
      const sha256 = hash.digest('hex');
      if (opts.sha256 && opts.sha256.toLowerCase() !== sha256) throw new ChecksumMismatchError(key, opts.sha256, sha256);
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
      return { bytes, sha256 };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async getStream(key: string) {
    const p = this.pathFor(key);
    try {
      const st = await stat(p);
      if (!st.isFile()) return null;
      return { stream: createReadStream(p) as Readable, contentType: null, bytes: st.size };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const st = await stat(this.pathFor(key));
      return st.isFile() ? { key, bytes: st.size, lastModified: st.mtime } : null;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async list(prefix: string, limit = 1000): Promise<ObjectInfo[]> {
    assertSafePrefix(prefix);
    const keys = await this.walk(prefix);
    keys.sort(); // S3 returns keys in UTF-8 binary order
    const out: ObjectInfo[] = [];
    for (const key of keys.slice(0, Math.max(0, limit))) {
      try {
        const st = await stat(join(this.root, key));
        out.push({ key, bytes: st.size, lastModified: st.mtime });
      } catch (err) {
        if (!isEnoent(err)) throw err; // deleted while listing
      }
    }
    return out;
  }

  async deletePrefix(prefix: string, limit: number): Promise<number> {
    assertDeletablePrefix(prefix, limit);
    const victims = await this.list(prefix, limit);
    let deleted = 0;
    for (const { key } of victims) {
      try {
        await rm(join(this.root, key));
        deleted++;
        await this.pruneEmptyDirs(dirname(join(this.root, key)));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    return deleted;
  }

  async ping(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** All keys starting with prefix, found by walking only the deepest directory the prefix names. */
  private async walk(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf('/');
    const baseRel = slash >= 0 ? prefix.slice(0, slash) : '';
    const out: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(join(this.root, rel), { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (childRel === TMP_DIR) continue;
        if (e.isDirectory()) await visit(childRel);
        else if (e.isFile() && childRel.startsWith(prefix)) out.push(childRel);
      }
    };
    await visit(baseRel);
    return out;
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    let cur = dir;
    while (cur.startsWith(this.root + sep)) {
      try {
        if ((await readdir(cur)).length > 0) return;
        await rmdir(cur); // fails (and stops pruning) if a concurrent put refilled it
      } catch {
        return;
      }
      cur = dirname(cur);
    }
  }
}
