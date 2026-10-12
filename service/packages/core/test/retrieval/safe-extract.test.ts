import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeSnapshotSha256,
  extractTarStream,
  makeTreeReadOnly,
  makeTreeWritable,
  parseGitmodulesPaths,
  sanitizeEntryPath,
} from '../../src/retrieval/safe-extract.js';
import { buildTar, cleanupTmp, tmpDir, walkTree, type TarSpec } from './helpers.js';

afterEach(cleanupTmp);

const budgets = { maxFiles: 100, maxBytes: 10 * 1024 * 1024, maxFileBytes: 1024 * 1024 };

async function extract(entries: TarSpec[], b = budgets) {
  const parent = tmpDir('extract');
  const dest = path.join(parent, 'snap');
  const buf = buildTar(entries);
  // feed in small chunks to exercise streaming across entry boundaries
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 700) chunks.push(buf.subarray(i, i + 700));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dest);
  const result = await extractTarStream(Readable.from(chunks), { destDir: dest, budgets: b });
  return { parent, dest, result };
}

describe('sanitizeEntryPath', () => {
  it.each([
    ['src/a.ts', false, 'src/a.ts'],
    ['dir/', true, 'dir'],
    ['.hidden', false, '.hidden'],
    ['../evil', false, null],
    ['a/../../evil', false, null],
    ['/etc/passwd', false, null],
    ['a//b', false, null],
    ['./a', false, null],
    ['a/./b', false, null],
    ['.git/config', false, null],
    ['sub/.GIT/hooks/x', false, null],
    ['.gitignore', false, '.gitignore'],
    ['bad\nname', false, null],
    ['', false, null],
  ])('%j (dir=%s) -> %j', (raw, isDir, expected) => {
    expect(sanitizeEntryPath(raw, isDir)).toBe(expected);
  });
});

describe('extractTarStream', () => {
  it('writes regular files and refuses links, devices, FIFOs and unsafe paths', async () => {
    const { parent, dest, result } = await extract([
      { name: 'ok/file.txt', data: 'hello\n' },
      { name: 'empty.txt' },
      { name: 'sym', type: '2', linkname: '/etc/passwd' },
      { name: 'hard', type: '1', linkname: 'ok/file.txt' },
      { name: 'dev', type: '3' },
      { name: 'blk', type: '4' },
      { name: 'fifo', type: '6' },
      { name: '../escape.txt', data: 'x' },
      { name: '/abs.txt', data: 'x' },
      { name: 'a/../../up.txt', data: 'x' },
      { name: '.git/config', data: '[core]' },
      { name: 'nested/.git/HEAD', data: 'ref' },
      { name: 'dir/', type: '5' },
    ]);
    expect(result.files.map((f) => f.path).sort()).toEqual(['empty.txt', 'ok/file.txt']);
    const reasons = Object.fromEntries(result.excluded.map((e) => [e.path, e.reason]));
    expect(reasons).toMatchObject({ sym: 'symlink', hard: 'hardlink', dev: 'special_file', blk: 'special_file', fifo: 'special_file' });
    expect(result.excluded.filter((e) => e.reason === 'unsafe_path')).toHaveLength(5);
    expect(readFileSync(path.join(dest, 'ok/file.txt'), 'utf8')).toBe('hello\n');
    expect(walkTree(dest).filter((e) => e.type === 'symlink' || e.type === 'other')).toEqual([]);
    expect(existsSync(path.join(parent, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(dest, '.git'))).toBe(false);
    expect(walkTree(parent).map((e) => e.rel)).toEqual(['snap', 'snap/empty.txt', 'snap/ok', 'snap/ok/file.txt']);
  });

  it('enforces per-file, file-count and total-byte caps in order', async () => {
    const { result } = await extract(
      [
        { name: 'a.txt', data: 'aaaa' },
        { name: 'big.txt', data: 'x'.repeat(50) },
        { name: 'b.txt', data: 'bbbb' },
        { name: 'c.txt', data: 'cccc' },
        { name: 'd.txt', data: 'dddd' },
      ],
      { maxFiles: 3, maxBytes: 12, maxFileBytes: 10 },
    );
    expect(result.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result.excluded).toEqual([
      { path: 'big.txt', reason: 'over_file_byte_cap', bytes: 50 },
      { path: 'd.txt', reason: 'over_file_count_cap', bytes: 4 },
    ]);
    const total = await extract(
      [
        { name: 'a.txt', data: 'aaaaaaaa' },
        { name: 'b.txt', data: 'bbbbbbbb' },
        { name: 'c.txt', data: 'cc' },
      ],
      { maxFiles: 10, maxBytes: 10, maxFileBytes: 10 },
    );
    expect(total.result.files.map((f) => f.path)).toEqual(['a.txt', 'c.txt']);
    expect(total.result.excluded).toEqual([{ path: 'b.txt', reason: 'over_total_byte_cap', bytes: 8 }]);
  });

  it('records LFS pointers without writing them, and submodule paths from nested .gitmodules', async () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n';
    const { dest, result } = await extract([
      { name: 'model.bin', data: pointer },
      { name: 'notlfs.txt', data: `# ${pointer}` },
      { name: 'third_party/.gitmodules', data: '[submodule "x"]\n\tpath = ext\n\turl = https://example.com/x\n[submodule "y"]\n\tpath = "../../bad"\n' },
      { name: '.gitmodules', data: '[submodule "r"]\n  path=vendor/r\n' },
    ]);
    expect(existsSync(path.join(dest, 'model.bin'))).toBe(false);
    expect(result.excluded).toContainEqual({ path: 'model.bin', reason: 'lfs_pointer', bytes: pointer.length });
    expect(result.excluded).toContainEqual({ path: 'third_party/ext', reason: 'submodule' });
    expect(result.excluded).toContainEqual({ path: 'vendor/r', reason: 'submodule' });
    expect(result.excluded.filter((e) => e.reason === 'submodule')).toHaveLength(2);
    expect(result.files.map((f) => f.path).sort()).toEqual(['.gitmodules', 'notlfs.txt', 'third_party/.gitmodules']);
  });

  it('refuses a later entry that collides with an earlier file/directory name', async () => {
    const { result } = await extract([
      { name: 'a', data: 'file' },
      { name: 'a/b.txt', data: 'under a file' },
      { name: 'c.txt', data: '1' },
      { name: 'c.txt', data: '2' },
    ]);
    expect(result.files.map((f) => f.path).sort()).toEqual(['a', 'c.txt']);
    expect(result.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ['a/b.txt', 'unsafe_path'],
      ['c.txt', 'unsafe_path'],
    ]);
  });

  it('rejects a corrupt archive', async () => {
    const dest = tmpDir('corrupt');
    const garbage = Buffer.alloc(2048, 0x41);
    await expect(extractTarStream(Readable.from([garbage]), { destDir: dest, budgets })).rejects.toThrow(/malformed|archive/);
  });

  it('makes the tree read-only and restorable', async () => {
    const { dest } = await extract([{ name: 'd/f.txt', data: 'x' }]);
    await makeTreeReadOnly(dest);
    const tree = walkTree(dest);
    expect(tree.every((e) => (e.mode & 0o222) === 0)).toBe(true);
    await makeTreeWritable(dest);
    expect(walkTree(dest).every((e) => (e.mode & 0o200) !== 0)).toBe(true);
  });
});

describe('computeSnapshotSha256', () => {
  it('is order independent and path/content sensitive', () => {
    const a = { path: 'a', sha256: '1'.repeat(64) };
    const b = { path: 'b', sha256: '2'.repeat(64) };
    expect(computeSnapshotSha256([a, b])).toBe(computeSnapshotSha256([b, a]));
    expect(computeSnapshotSha256([a, b])).not.toBe(computeSnapshotSha256([a, { ...b, sha256: '3'.repeat(64) }]));
    expect(computeSnapshotSha256([a, b])).not.toBe(computeSnapshotSha256([a, { ...b, path: 'c' }]));
    expect(computeSnapshotSha256([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseGitmodulesPaths', () => {
  it('joins relative to the containing directory and drops unsafe values', () => {
    expect(parseGitmodulesPaths('[submodule "a"]\n\tpath = x/y\n\tpath = ../z\n', 'base')).toEqual(['base/x/y']);
    expect(parseGitmodulesPaths('path = top', '')).toEqual(['top']);
  });
});
