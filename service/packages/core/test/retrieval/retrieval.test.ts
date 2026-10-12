/** A3: the resolved SHA is immutable; a ref that moves later does not change the analysed tree. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exportCommit } from '../../src/retrieval/exporter.js';
import { resolveGeneric } from '../../src/retrieval/providers/generic-git.js';
import { resolveRepository } from '../../src/retrieval/resolver.js';
import type { FetchFn } from '../../src/retrieval/providers/github.js';
import { cleanupTmp, gitWrapper, tmpDir } from './helpers.js';

const MIB = 1024 * 1024;
const budgets = { maxFiles: 1000, maxBytes: 50 * MIB, maxFileBytes: MIB };
let work: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: work,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    },
  }).trim();
}
function commit(file: string, content: string, message: string): string {
  writeFileSync(path.join(repo, file), content);
  git('add', '.');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'retrieval-'));
  repo = path.join(work, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
});
afterEach(cleanupTmp);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('immutable retrieval', () => {
  it('exports the recorded commit even after the ref has moved on', async () => {
    const first = commit('app.txt', 'version one\n', 'one');
    const resolved = await resolveGeneric({ url: `file://${repo}`, ref: 'main', allowFileUrlForTests: true });
    expect(resolved.sha).toBe(first);

    const second = commit('app.txt', 'version two\n', 'two'); // main moves after submission
    expect((await resolveGeneric({ url: `file://${repo}`, ref: 'main', allowFileUrlForTests: true })).sha).toBe(second);

    const dest = path.join(tmpDir('snap'), 'snapshot');
    const res = await exportCommit({ url: `file://${repo}`, sha: resolved.sha, destDir: dest, budgets, timeoutMs: 30_000, allowFileUrlForTests: true });
    expect(res.sha).toBe(first);
    expect(readFileSync(path.join(dest, 'app.txt'), 'utf8')).toBe('version one\n');

    const dest2 = path.join(tmpDir('snap'), 'snapshot');
    const res2 = await exportCommit({ url: `file://${repo}`, sha: second, destDir: dest2, budgets, timeoutMs: 30_000, allowFileUrlForTests: true });
    expect(readFileSync(path.join(dest2, 'app.txt'), 'utf8')).toBe('version two\n');
    expect(res2.snapshotSha256).not.toBe(res.snapshotSha256);
  });

  it('does not export a tree for a sha the remote does not have', async () => {
    const dest = path.join(tmpDir('snap'), 'snapshot');
    await expect(exportCommit({ url: `file://${repo}`, sha: 'f'.repeat(40), destDir: dest, budgets, timeoutMs: 30_000, allowFileUrlForTests: true })).rejects.toMatchObject({ code: 'commit_not_found' });
    expect(existsSync(path.join(dest, 'app.txt'))).toBe(false);
  });
});

describe('resolveRepository (GitHub path, injected fetch)', () => {
  const SHA = 'c'.repeat(40);
  const lookup = async () => [{ address: '140.82.112.3', family: 4 }];
  function recorder(): { fetch: FetchFn; auth: Array<string | undefined>; urls: string[] } {
    const auth: Array<string | undefined> = [];
    const urls: string[] = [];
    const fetch: FetchFn = async (input, init) => {
      urls.push(input);
      auth.push((init?.headers as Record<string, string>).Authorization);
      const p = new URL(input).pathname;
      return new Response(JSON.stringify(p.includes('/commits/') ? { sha: SHA } : { default_branch: 'main', private: true }), { status: 200 });
    };
    return { fetch, auth, urls };
  }

  it('returns the canonical URL, provider and SHA; a per-request token wins over the service token', async () => {
    const r = recorder();
    const res = await resolveRepository({
      url: 'https://github.com/octo/repo',
      ref: 'main',
      token: 'request-token',
      serviceGithubToken: 'service-token',
      allowlist: 'github.com',
      lookup,
      fetch: r.fetch,
    });
    expect(res).toEqual({ sha: SHA, defaultBranch: 'main', isPrivate: true, provider: 'github', url: 'https://github.com/octo/repo.git', host: 'github.com' });
    expect(r.auth).toEqual(['Bearer request-token', 'Bearer request-token']);
  });

  it('falls back to the service-level GitHub token and treats a 40-hex ref as a sha', async () => {
    const r = recorder();
    await resolveRepository({ url: 'https://github.com/octo/repo.git', ref: SHA, serviceGithubToken: 'service-token', allowlist: 'github.com', lookup, fetch: r.fetch });
    expect(r.auth).toEqual(['Bearer service-token', 'Bearer service-token']);
    expect(r.urls[1]).toContain(`/commits/${SHA}`);
  });

  it('does not forward the service-level GitHub token to a generic host', async () => {
    const dir = tmpDir('wrap');
    const log = path.join(dir, 'log');
    const gitBin = gitWrapper(dir, `echo "ASKPASS=[$GIT_ASKPASS]" >> '${log}'\necho "fatal: Authentication failed" >&2; exit 128`);
    await expect(
      resolveRepository({ url: 'https://git.example.org/o/r', ref: 'main', serviceGithubToken: 'service-token', allowlist: '*.example.org', lookup, gitBin }),
    ).rejects.toMatchObject({ code: 'repository_not_authorized' });
    expect(readFileSync(log, 'utf8').trim()).toBe('ASKPASS=[]');
  });
});
