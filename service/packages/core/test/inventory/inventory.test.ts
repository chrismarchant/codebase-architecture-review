import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Inventory } from '@archreview/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildHostileRepo, type HostileRepo } from '../../../../fixtures/repos/hostile-fs/build.js';
import { buildInventory, compileExcludeGlobs, countLines, DEFAULT_EXCLUDE_GLOBS } from '../../src/inventory/builder.js';
import { isLockfile, languageForPath } from '../../src/inventory/language.js';
import { exportCommit } from '../../src/retrieval/exporter.js';
import { makeTreeWritable } from '../../src/retrieval/safe-extract.js';

const SHA = 'a'.repeat(40);
const SNAP = 'b'.repeat(64);
const MIB = 1024 * 1024;
const NOW = new Date('2024-05-06T07:08:09.000Z');
const created: string[] = [];

function snapshot(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}
afterEach(async () => {
  for (const d of created.splice(0)) {
    await makeTreeWritable(d).catch(() => undefined);
    rmSync(d, { recursive: true, force: true });
  }
});

const build = (dir: string, excluded: Parameters<typeof buildInventory>[1] = [], extra: Partial<Parameters<typeof buildInventory>[2]> = {}) =>
  buildInventory(dir, excluded, { commitSha: SHA, snapshotSha256: SNAP, now: NOW, ...extra });
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

describe('buildInventory', () => {
  it('lists files with bytes, sha256, language and line counts, sorted, and validates against the contract', async () => {
    const dir = snapshot({
      'src/b.ts': 'export const b = 1;\nexport const c = 2;\n',
      'src/a.py': 'print(1)',
      'README.md': '# hi\n\n',
      'empty.txt': '',
      'no-ext': 'plain',
      '.hidden': 'x\n',
    });
    const inv = await build(dir);
    expect(Inventory.safeParse(inv).success).toBe(true);
    expect(inv.schema).toBe('archreview.inventory/1.0');
    expect(inv.commitSha).toBe(SHA);
    expect(inv.snapshotSha256).toBe(SNAP);
    expect(inv.generatedAt).toBe('2024-05-06T07:08:09.000Z');
    expect(inv.files.map((f) => f.path)).toEqual(['.hidden', 'README.md', 'empty.txt', 'no-ext', 'src/a.py', 'src/b.ts']);
    const byPath = Object.fromEntries(inv.files.map((f) => [f.path, f]));
    expect(byPath['src/b.ts']).toEqual({ path: 'src/b.ts', bytes: 40, sha256: sha256('export const b = 1;\nexport const c = 2;\n'), language: 'typescript', lines: 2 });
    expect(byPath['src/a.py']).toMatchObject({ language: 'python', lines: 1 }); // no trailing newline still counts
    expect(byPath['README.md']).toMatchObject({ language: 'markdown', lines: 2 });
    expect(byPath['empty.txt']).toMatchObject({ bytes: 0, lines: 0, sha256: sha256('') });
    expect(byPath['no-ext']?.language).toBeNull();
    expect(byPath['.hidden']?.language).toBeNull();
  });

  it('computes totals and a per-language file count', async () => {
    const dir = snapshot({ 'a.ts': 'x\n', 'b.ts': 'yy\n', 'c.py': 'z\n', 'd.xyz': 'q\n' });
    const inv = await build(dir);
    expect(inv.totals).toEqual({ files: 4, bytes: 2 + 3 + 2 + 2, byLanguage: { python: 1, typescript: 2, unknown: 1 } });
  });

  it('detects binary files by a NUL in the first 8 KiB and excludes them with reason binary', async () => {
    const late = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])]); // NUL after the sniffed window
    const dir = snapshot({
      'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      'text-with-late-nul.txt': late,
      'ok.txt': 'fine\n',
    });
    const inv = await build(dir);
    expect(inv.excluded).toContainEqual({ path: 'img.png', reason: 'binary', bytes: 6 });
    expect(inv.files.map((f) => f.path)).toEqual(['ok.txt', 'text-with-late-nul.txt']);
    expect(inv.totals.files).toBe(2);
  });

  it('applies the default exclude globs at any depth and keeps lockfiles, flagged as such', async () => {
    const dir = snapshot({
      'node_modules/pkg/index.js': 'x',
      'packages/app/node_modules/dep/a.js': 'x',
      'vendor/lib.go': 'x',
      'dist/out.js': 'x',
      'packages/app/build/gen.ts': 'x',
      'web/app.min.js': 'x',
      'web/app.js': 'x',
      'src/distance.ts': 'x',
      'package-lock.json': '{}',
      'pnpm-lock.yaml': 'a: 1\n',
      'Cargo.lock': 'x',
      'go.sum': 'x',
    });
    const inv = await build(dir);
    expect(inv.excluded.filter((e) => e.reason === 'glob_exclude').map((e) => e.path)).toEqual([
      'dist/out.js',
      'node_modules/pkg/index.js',
      'packages/app/build/gen.ts',
      'packages/app/node_modules/dep/a.js',
      'vendor/lib.go',
      'web/app.min.js',
    ]);
    expect(inv.files.map((f) => f.path)).toEqual(['Cargo.lock', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml', 'src/distance.ts', 'web/app.js']);
    for (const lock of ['Cargo.lock', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml']) {
      expect(inv.files.find((f) => f.path === lock)?.language).toBe('lockfile');
    }
    expect(inv.totals.byLanguage.lockfile).toBe(4);
  });

  it('supports caller-provided globs', async () => {
    const dir = snapshot({ 'gen/a.ts': 'x', 'src/a.ts': 'x', 'src/a.snap': 'x' });
    const inv = await build(dir, [], { excludeGlobs: ['gen/**', '*.snap'] });
    expect(inv.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(inv.excluded.map((e) => e.path)).toEqual(['gen/a.ts', 'src/a.snap']);
  });

  it('excludes files above the per-file cap defensively', async () => {
    const dir = snapshot({ 'big.txt': 'x'.repeat(100), 'small.txt': 'x' });
    const inv = await build(dir, [], { budgets: { maxFileBytes: 50 } });
    expect(inv.excluded).toEqual([{ path: 'big.txt', reason: 'over_file_byte_cap', bytes: 100 }]);
    expect(inv.files.map((f) => f.path)).toEqual(['small.txt']);
  });

  it('merges export-time exclusions and never lists an exported-excluded path as a file', async () => {
    const dir = snapshot({ 'kept.ts': 'x', 'listed.txt': 'x' });
    const inv = await build(dir, [
      { path: 'link', reason: 'symlink' },
      { path: 'data/huge.txt', reason: 'over_file_byte_cap', bytes: 2 * MIB },
      { path: 'listed.txt', reason: 'lfs_pointer', bytes: 130 },
    ]);
    expect(inv.files.map((f) => f.path)).toEqual(['kept.ts']);
    expect(inv.excluded.map((e) => [e.path, e.reason])).toEqual([
      ['data/huge.txt', 'over_file_byte_cap'],
      ['link', 'symlink'],
      ['listed.txt', 'lfs_pointer'],
    ]);
  });

  it('does not follow symlinks if one is ever present', async () => {
    const outside = snapshot({ 'secret.txt': 'top secret' });
    const dir = snapshot({ 'a.txt': 'x' });
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'file-link'));
    symlinkSync(outside, path.join(dir, 'dir-link'));
    const inv = await build(dir);
    expect(inv.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(inv.excluded.map((e) => [e.path, e.reason])).toEqual([
      ['dir-link', 'symlink'],
      ['file-link', 'symlink'],
    ]);
  });

  it('works on a read-only snapshot', async () => {
    const dir = snapshot({ 'd/a.ts': 'x\n' });
    chmodSync(path.join(dir, 'd/a.ts'), 0o444);
    chmodSync(path.join(dir, 'd'), 0o555);
    chmodSync(dir, 0o555);
    expect((await build(dir)).files).toHaveLength(1);
  });

  it('is deterministic', async () => {
    const dir = snapshot({ 'b.ts': '1', 'a.ts': '2', 'z/c.ts': '3' });
    expect(await build(dir)).toEqual(await build(dir));
  });
});

describe('inventory of an exported hostile repository', () => {
  let repo: HostileRepo;
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(path.join(os.tmpdir(), 'inv-hostile-'));
    repo = buildHostileRepo({ dir: path.join(work, 'repo'), canaryPath: path.join(work, 'CANARY') });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('combines exporter exclusions with what is on disk', async () => {
    const dest = path.join(work, 'snapshot');
    created.push(dest);
    const exp = await exportCommit({
      url: repo.url,
      sha: repo.sha,
      destDir: dest,
      budgets: { maxFiles: 20_000, maxBytes: 200 * MIB, maxFileBytes: MIB },
      timeoutMs: 60_000,
      allowFileUrlForTests: true,
    });
    const inv = await buildInventory(dest, exp.excluded, { commitSha: exp.sha, snapshotSha256: exp.snapshotSha256, now: NOW });
    expect(Inventory.safeParse(inv).success).toBe(true);
    const reasons = Object.fromEntries(inv.excluded.map((e) => [e.path, e.reason]));
    expect(reasons).toMatchObject({
      'escape-link': 'symlink',
      'loop-a': 'symlink',
      'data/large.txt': 'over_file_byte_cap',
      'assets/model.bin': 'lfs_pointer',
      'third_party/ext': 'submodule',
      'assets/logo.png': 'binary',
    });
    const files = inv.files.map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['.hidden-config', 'hooks/pre-commit', 'src/index.ts', 'src/util/math.ts', 'package-lock.json', '.gitattributes']));
    expect(inv.files.find((f) => f.path === 'package-lock.json')?.language).toBe('lockfile');
    expect(inv.files.find((f) => f.path === 'src/index.ts')?.language).toBe('typescript');
    expect(inv.totals.files).toBe(files.length);
    expect(inv.snapshotSha256).toBe(exp.snapshotSha256);
  });
});

describe('language helpers', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['a.TSX', 'typescript'],
    ['x/y/main.go', 'go'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile.prod', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['.env', 'dotenv'],
    ['.gitignore', 'gitconfig'],
    ['config.yml', 'yaml'],
    ['LICENSE', null],
    ['archive.unknownext', null],
    ['yarn.lock', 'lockfile'],
    ['sub/dir/Cargo.lock', 'lockfile'],
    ['bun.lockb', 'lockfile'],
  ])('%s -> %s', (p, lang) => {
    expect(languageForPath(p)).toBe(lang);
  });
  it('recognises lockfiles by name only', () => {
    expect(isLockfile('a/package-lock.json')).toBe(true);
    expect(isLockfile('a/package.json')).toBe(false);
  });
  it('counts lines', () => {
    expect([countLines(Buffer.from('')), countLines(Buffer.from('a')), countLines(Buffer.from('a\n')), countLines(Buffer.from('a\nb')), countLines(Buffer.from('\n\n'))]).toEqual([0, 1, 1, 2, 2]);
  });
  it('matches globs', () => {
    const m = compileExcludeGlobs(DEFAULT_EXCLUDE_GLOBS);
    expect(m('node_modules/a')).toBe(true);
    expect(m('a/vendor/b/c')).toBe(true);
    expect(m('a.min.js')).toBe(true);
    expect(m('a/b.min.jsx')).toBe(false);
    expect(m('vendors/a')).toBe(false);
    expect(m('src/index.ts')).toBe(false);
  });
});
