import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHostileRepo, BIG_FILE_BYTES, type HostileRepo } from '../../../../fixtures/repos/hostile-fs/build.js';
import { exportCommit, type ExportOptions } from '../../src/retrieval/exporter.js';
import { RetrievalError } from '../../src/retrieval/errors.js';
import { cleanupTmp, gitWrapper, tmpDir, walkTree } from './helpers.js';

const MIB = 1024 * 1024;
const budgets = { maxFiles: 20_000, maxBytes: 200 * MIB, maxFileBytes: MIB };

let repo: HostileRepo;
let canary: string;
let work: string;

beforeAll(() => {
  // not tmpDir(): the source repository must outlive the per-test cleanup
  work = mkdtempSync(path.join(os.tmpdir(), 'hostile-src-'));
  canary = path.join(work, 'CANARY-EXECUTED');
  repo = buildHostileRepo({ dir: path.join(work, 'repo'), canaryPath: canary });
});
afterEach(cleanupTmp);
afterAll(() => rmSync(work, { recursive: true, force: true }));

function opts(over: Partial<ExportOptions> = {}): ExportOptions {
  const parent = tmpDir('export');
  return { url: repo.url, sha: repo.sha, destDir: path.join(parent, 'snapshot'), budgets, timeoutMs: 60_000, allowFileUrlForTests: true, ...over };
}

describe('exportCommit on the hostile-fs fixture', () => {
  it('materialises only safe regular files and records every exclusion', async () => {
    const o = opts();
    const res = await exportCommit(o);
    expect(res.sha).toBe(repo.sha);
    const tree = walkTree(o.destDir);

    // containment: nothing but regular files and directories, nothing outside destDir
    expect(tree.filter((e) => e.type === 'symlink' || e.type === 'other')).toEqual([]);
    const realRoot = realpathSync(o.destDir);
    for (const e of tree) expect(realpathSync(path.join(o.destDir, e.rel)).startsWith(realRoot)).toBe(true);
    expect(walkTree(path.dirname(o.destDir)).filter((e) => !e.rel.startsWith('snapshot'))).toEqual([]);

    const reasons = new Map(res.excluded.map((e) => [e.path, e]));
    for (const link of ['escape-link', 'absolute-link', 'loop-a', 'loop-b', 'dir-link']) {
      expect(reasons.get(link)?.reason, link).toBe('symlink');
      expect(existsSync(path.join(o.destDir, link))).toBe(false);
    }
    expect(reasons.get('data/large.txt')).toEqual({ path: 'data/large.txt', reason: 'over_file_byte_cap', bytes: BIG_FILE_BYTES });
    expect(existsSync(path.join(o.destDir, 'data/large.txt'))).toBe(false);
    expect(reasons.get('assets/model.bin')?.reason).toBe('lfs_pointer');
    expect(reasons.get('third_party/ext')?.reason).toBe('submodule');

    // present as plain, non-executable data
    expect(readFileSync(path.join(o.destDir, '.hidden-config'), 'utf8')).toBe('secret=value\n');
    expect(readFileSync(path.join(o.destDir, 'hooks/pre-commit'), 'utf8')).toContain('touch');
    expect(lstatSync(path.join(o.destDir, 'hooks/pre-commit')).mode & 0o111).toBe(0);
    expect(existsSync(path.join(o.destDir, '.gitattributes'))).toBe(true);
    expect(existsSync(path.join(o.destDir, 'third_party/.gitmodules'))).toBe(true);
    expect(existsSync(path.join(o.destDir, 'src/util/math.ts'))).toBe(true);
    expect(existsSync(path.join(o.destDir, '.git'))).toBe(false);

    // no execution: neither hooks nor the filter driver ran
    expect(existsSync(canary)).toBe(false);

    // read-only snapshot (mode bits; root ignores write permission so do not rely on EACCES)
    for (const e of tree) expect(e.mode & 0o222, e.rel).toBe(0);
    expect(lstatSync(o.destDir).mode & 0o222).toBe(0);

    expect(res.fileCount).toBe(tree.filter((e) => e.type === 'file').length);
    expect(res.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.excludedOverflow).toBe(0);
  });

  it('is deterministic across two exports', async () => {
    const a = await exportCommit(opts());
    const b = await exportCommit(opts());
    expect(b.snapshotSha256).toBe(a.snapshotSha256);
    expect(b.excluded).toEqual(a.excluded);
    expect(b.fileCount).toBe(a.fileCount);
    expect(b.bytes).toBe(a.bytes);
  });

  it('includes the large file when the per-file cap allows it (and the hash changes)', async () => {
    const small = await exportCommit(opts());
    const big = await exportCommit(opts({ budgets: { ...budgets, maxFileBytes: 4 * MIB } }));
    expect(big.excluded.find((e) => e.path === 'data/large.txt')).toBeUndefined();
    expect(big.bytes).toBe(small.bytes + BIG_FILE_BYTES);
    expect(big.snapshotSha256).not.toBe(small.snapshotSha256);
  });

  it('applies file-count and total-byte budgets', async () => {
    const byCount = await exportCommit(opts({ budgets: { ...budgets, maxFiles: 3 } }));
    expect(byCount.fileCount).toBe(3);
    expect(byCount.excluded.filter((e) => e.reason === 'over_file_count_cap').length).toBeGreaterThan(0);
    const byBytes = await exportCommit(opts({ budgets: { ...budgets, maxBytes: 200 } }));
    expect(byBytes.bytes).toBeLessThanOrEqual(200);
    expect(byBytes.excluded.some((e) => e.reason === 'over_total_byte_cap')).toBe(true);
  });

  it('retries the fetch without a filter when the server refuses one', async () => {
    const dir = tmpDir('wrap');
    const log = path.join(dir, 'calls.log');
    const gitBin = gitWrapper(
      dir,
      `echo "$*" >> '${log}'\nfor a in "$@"; do case "$a" in --filter*) echo "fatal: filtering not recognized by server" >&2; exit 128;; esac; done`,
    );
    const res = await exportCommit(opts({ gitBin }));
    expect(res.fileCount).toBeGreaterThan(5);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--filter=blob:none');
    expect(calls.split('\n').filter((l) => / fetch /.test(l) && !l.includes('--filter')).length).toBe(1);
  });

  it('passes credentials only through a 0600 temp config and a scrubbed environment, then deletes them', async () => {
    const dir = tmpDir('wrap');
    const log = path.join(dir, 'calls.log');
    const token = 'tok_SECRET_value-123';
    const gitBin = gitWrapper(
      dir,
      [
        `echo "ARGV: $*" >> '${log}'`,
        `if [ "$GIT_CONFIG_GLOBAL" != /dev/null ]; then echo "CFG_PATH: $GIT_CONFIG_GLOBAL" >> '${log}'; stat -c 'CFG_MODE: %a' "$GIT_CONFIG_GLOBAL" >> '${log}'; sed 's/^/CFG: /' "$GIT_CONFIG_GLOBAL" >> '${log}'; fi`,
        `env | sed 's/^/ENV: /' >> '${log}'`,
      ].join('\n'),
    );
    await exportCommit(opts({ gitBin, token }));
    const text = readFileSync(log, 'utf8');
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('ARGV:') && l.includes(token))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('ENV:') && l.includes(token))).toEqual([]);
    expect(lines).toContain('CFG_MODE: 600');
    expect(text).toContain(`CFG: \textraheader = "Authorization: Bearer ${token}"`);
    const cfgPath = (lines.find((l) => l.startsWith('CFG_PATH: ')) as string).slice('CFG_PATH: '.length);
    expect(existsSync(cfgPath)).toBe(false);
    const envKeys = new Set(lines.filter((l) => l.startsWith('ENV: ')).map((l) => l.slice(5).split('=')[0]));
    for (const k of envKeys) expect(['PATH', 'HOME', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'LC_ALL', 'PWD', 'SHLVL', '_', 'OLDPWD']).toContain(k);
    for (const k of ['PATH', 'HOME', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'LC_ALL']) expect(envKeys.has(k)).toBe(true);
    expect(lines).toContain('ENV: GIT_TERMINAL_PROMPT=0');
    expect(lines).toContain('ENV: GIT_CONFIG_NOSYSTEM=1');
    // hardening flags are present on every invocation
    expect(lines.filter((l) => l.startsWith('ARGV:') && !l.includes('core.hooksPath=/dev/null'))).toEqual([]);
  });

  it('uses the basic scheme when asked', async () => {
    const dir = tmpDir('wrap');
    const log = path.join(dir, 'calls.log');
    const gitBin = gitWrapper(dir, `if [ "$GIT_CONFIG_GLOBAL" != /dev/null ]; then cat "$GIT_CONFIG_GLOBAL" >> '${log}'; fi`);
    await exportCommit(opts({ gitBin, token: 'abc', authScheme: 'basic' }));
    expect(readFileSync(log, 'utf8')).toContain(`Authorization: Basic ${Buffer.from('x-access-token:abc').toString('base64')}`);
  });

  it('kills a hung git process group at the timeout and reports a retryable error', async () => {
    const dir = tmpDir('wrap');
    const pidFile = path.join(dir, 'sleep.pid');
    const gitBin = gitWrapper(dir, `case "$*" in *" fetch "*) sleep 60 & echo $! > '${pidFile}'; wait;; esac`);
    const started = Date.now();
    await expect(exportCommit(opts({ gitBin, timeoutMs: 800 }))).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await vi.waitFor(() => {
      // the background child died with the group (a zombie awaiting reaping by init also counts as dead)
      const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
      expect(stat === '' || /^\d+ \(.*\) Z/.test(stat)).toBe(true);
    });
  });

  it('reports an unknown commit as non-retryable', async () => {
    await expect(exportCommit(opts({ sha: '2'.repeat(40) }))).rejects.toMatchObject({ code: 'commit_not_found', retryable: false });
  });

  it('honours an abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(exportCommit(opts({ signal: ac.signal }))).rejects.toBeInstanceOf(RetrievalError);
  });

  it('validates its inputs', async () => {
    await expect(exportCommit(opts({ sha: 'main' }))).rejects.toThrow();
    await expect(exportCommit(opts({ url: 'http://github.com/o/r.git', allowFileUrlForTests: false }))).rejects.toMatchObject({ code: 'url_rejected' });
    await expect(exportCommit(opts({ url: repo.url, allowFileUrlForTests: false }))).rejects.toMatchObject({ code: 'url_rejected' });
    await expect(exportCommit(opts({ url: 'https://evil.example.com/o/r.git', allowlist: 'github.com' }))).rejects.toMatchObject({ code: 'url_rejected' });
    await expect(exportCommit(opts({ token: 'bad token\nwith newline' }))).rejects.toThrow(/unsupported characters/);
    const o = opts();
    await exportCommit(o);
    await expect(exportCommit({ ...o })).rejects.toMatchObject({ code: 'dest_not_empty' });
  });

  it('refuses allowFileUrlForTests outside NODE_ENV=test', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(exportCommit(opts())).rejects.toMatchObject({ code: 'file_url_refused' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
