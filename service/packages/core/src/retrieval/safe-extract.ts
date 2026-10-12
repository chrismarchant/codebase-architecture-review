/**
 * Streaming, defensive tar materialiser (SS00 §5.3 filesystem containment, ADR-010).
 *
 * Input is a tar stream produced by `git archive` from an untrusted repository, so every
 * entry is treated as hostile: only regular files are written, paths are validated twice
 * (lexically and after resolution), nothing is ever created as a link, and caps stop work early.
 */
import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import type { z } from 'zod';
import type { ExclusionReason } from '@archreview/contracts';
import { RetrievalError } from './errors.js';
import type { ExportBudgets } from './types.js';

export type Exclusion = { path: string; reason: z.infer<typeof ExclusionReason>; bytes?: number };
export interface ExtractedFile {
  path: string;
  sha256: string;
  bytes: number;
}
export interface ExtractResult {
  files: ExtractedFile[];
  excluded: Exclusion[];
  /** exclusions dropped from `excluded` once MAX_EXCLUDED_RECORDS was reached */
  excludedOverflow: number;
  bytes: number;
}

/** Bound on memory spent describing hostile repositories with enormous numbers of skipped entries. */
export const MAX_EXCLUDED_RECORDS = 100_000;
const MAX_PATH_LENGTH = 1024;
const LFS_MAGIC = 'version https://git-lfs.github.com/spec/v1';

/** Returns the normalised repository-relative path, or null when it must not be extracted. */
export function sanitizeEntryPath(raw: string, isDirectory: boolean): string | null {
  let p = raw;
  if (isDirectory && p.endsWith('/')) p = p.slice(0, -1);
  if (p.length === 0 || p.length > MAX_PATH_LENGTH) return null;
  // Control characters (incl. NUL and newline) would also corrupt the snapshot-hash line format.
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('/')) return null;
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return null;
    if (s.toLowerCase() === '.git') return null; // never materialise anything named .git
  }
  return p;
}

function displayPath(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, MAX_PATH_LENGTH);
}

function isLfsPointer(buf: Buffer): boolean {
  if (buf.length > 1024) return false;
  const head = buf.subarray(0, 200).toString('utf8');
  return head.startsWith(`${LFS_MAGIC}\n`) || head.startsWith(`${LFS_MAGIC}\r\n`);
}

/** Parse the `path = x` lines of a .gitmodules file into repository-relative paths (relative to the file's directory). */
export function parseGitmodulesPaths(content: string, baseDir: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const value = (m[1] as string).replace(/^"(.*)"$/, '$1');
    const joined = baseDir === '' ? value : `${baseDir}/${value}`;
    const safe = sanitizeEntryPath(joined, false);
    if (safe) out.push(safe);
  }
  return out;
}

export interface ExtractOptions {
  destDir: string;
  budgets: ExportBudgets;
  signal?: AbortSignal;
}

const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

export async function extractTarStream(input: Readable, o: ExtractOptions): Promise<ExtractResult> {
  const destRoot = path.resolve(o.destDir);
  const files: ExtractedFile[] = [];
  const excluded: Exclusion[] = [];
  const gitmodules: Array<{ dir: string; content: string }> = [];
  let excludedOverflow = 0;
  let bytes = 0;
  let fileCount = 0; // files accepted so far (including ones still queued for writing)
  let queue: Promise<void> = Promise.resolve();
  let failure: Error | undefined;

  const exclude = (e: Exclusion): void => {
    if (excluded.length >= MAX_EXCLUDED_RECORDS) excludedOverflow += 1;
    else excluded.push(e);
  };

  /** Returns false when the entry had to be refused (unsafe resolution or a name collision in the archive). */
  async function writeFileSafely(rel: string, data: Buffer): Promise<boolean> {
    const target = path.resolve(destRoot, rel);
    // Second line of defence after the lexical check: the resolved path must stay inside destRoot.
    if (!target.startsWith(destRoot + path.sep)) return false;
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      // O_EXCL refuses to overwrite; O_NOFOLLOW refuses a pre-existing symlink at the final component.
      const fh = await open(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o644);
      try {
        await fh.writeFile(data);
      } finally {
        await fh.close();
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // File/directory name collisions inside the archive: refuse the later entry instead of failing the export.
      if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') return false;
      throw err;
    }
  }

  const handle = (entry: ReadEntry): void => {
    const type = String(entry.type);
    const raw = String(entry.path);
    const isDir = type === 'Directory';
    const rel = sanitizeEntryPath(raw, isDir);
    if (rel === null) {
      exclude({ path: displayPath(raw), reason: 'unsafe_path' });
      entry.resume();
      return;
    }
    if (isDir) {
      entry.resume(); // directories are created on demand by the files they contain
      return;
    }
    if (type === 'SymbolicLink') {
      exclude({ path: rel, reason: 'symlink' });
      entry.resume();
      return;
    }
    if (type === 'Link') {
      exclude({ path: rel, reason: 'hardlink' });
      entry.resume();
      return;
    }
    if (!FILE_TYPES.has(type)) {
      exclude({ path: rel, reason: 'special_file' }); // devices, FIFOs, anything unknown
      entry.resume();
      return;
    }
    const size = Number(entry.size ?? 0);
    if (size > o.budgets.maxFileBytes) {
      exclude({ path: rel, reason: 'over_file_byte_cap', bytes: size });
      entry.resume();
      return;
    }
    if (fileCount >= o.budgets.maxFiles) {
      exclude({ path: rel, reason: 'over_file_count_cap', bytes: size });
      entry.resume();
      return;
    }
    if (bytes + size > o.budgets.maxBytes) {
      exclude({ path: rel, reason: 'over_total_byte_cap', bytes: size });
      entry.resume();
      return;
    }
    // Reserve the budget now (entries are processed in order) so later entries see it.
    fileCount += 1;
    bytes += size;
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    entry.on('data', (c: Buffer) => {
      hash.update(c);
      chunks.push(c);
    });
    entry.once('end', () => {
      const data = Buffer.concat(chunks);
      queue = queue.then(async () => {
        if (failure) return;
        try {
          if (isLfsPointer(data)) {
            // Pointer files are excluded from the snapshot and listed so coverage can say why content is missing.
            exclude({ path: rel, reason: 'lfs_pointer', bytes: data.length });
            fileCount -= 1;
            bytes -= size;
            return;
          }
          if (!(await writeFileSafely(rel, data))) {
            exclude({ path: displayPath(rel), reason: 'unsafe_path' });
            fileCount -= 1;
            bytes -= size;
            return;
          }
          if (path.posix.basename(rel) === '.gitmodules') {
            const dir = path.posix.dirname(rel);
            gitmodules.push({ dir: dir === '.' ? '' : dir, content: data.toString('utf8') });
          }
          files.push({ path: rel, sha256: hash.digest('hex'), bytes: data.length });
        } catch (err) {
          failure = err as Error;
        }
      });
    });
  };

  const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024, onReadEntry: handle });
  let parseError: Error | undefined;
  parser.on('error', (err: Error) => {
    parseError = err;
  });

  try {
    for await (const chunk of input) {
      if (o.signal?.aborted) throw new RetrievalError('export cancelled', { code: 'cancelled' });
      parser.write(chunk as Buffer);
      if (parseError) break;
      await new Promise<void>((r) => setImmediate(r)); // let finished entries enqueue their writes
      await queue;
      if (failure) break;
    }
    if (!parseError && !failure) {
      const ended = new Promise<void>((resolve) => {
        parser.once('end', () => resolve());
        parser.once('close', () => resolve());
      });
      parser.end();
      await ended;
      await new Promise<void>((r) => setImmediate(r));
      await queue;
    }
  } finally {
    input.destroy();
  }
  if (parseError) throw new RetrievalError(`archive is malformed: ${parseError.message}`, { code: 'archive_malformed' });
  if (failure) throw new RetrievalError(`could not write snapshot: ${failure.message}`, { code: 'snapshot_write_failed', cause: failure });

  for (const gm of gitmodules) {
    for (const p of parseGitmodulesPaths(gm.content, gm.dir)) exclude({ path: p, reason: 'submodule' });
  }
  return { files, excluded, excludedOverflow, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Deterministic hash over the sorted `path\0sha256\n` lines of the materialised files. */
export function computeSnapshotSha256(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const h = createHash('sha256');
  for (const f of sorted) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

/** `chmod -R a-w`: files 0444, directories 0555, applied explicitly so the result does not depend on umask. */
export async function makeTreeReadOnly(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await makeTreeReadOnly(p);
    else if (e.isFile()) await chmod(p, 0o444);
  }
  await chmod(dir, 0o555);
}

/** Inverse of makeTreeReadOnly, for cleanup (rm of a read-only tree fails for non-root users). */
export async function makeTreeWritable(dir: string): Promise<void> {
  const st = await lstat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return;
  await chmod(dir, 0o755);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await makeTreeWritable(p);
    else if (e.isFile()) await chmod(p, 0o644);
  }
}
