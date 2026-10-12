import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, RetrievalError } from '../../src/retrieval/errors.js';
import { parseLsRemote, pickRef, resolveGeneric } from '../../src/retrieval/providers/generic-git.js';
import { cleanupTmp, gitWrapper, tmpDir } from './helpers.js';
import os from 'node:os';

let work: string;
let url: string;
const shas: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
      GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
    },
  }).trim();
}

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'generic-git-'));
  const repo = path.join(work, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), '1');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  shas.main1 = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'v1');
  git(repo, 'tag', '-a', 'v2', '-m', 'annotated');
  git(repo, 'checkout', '-q', '-b', 'dev');
  writeFileSync(path.join(repo, 'b.txt'), '2');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'two');
  shas.dev = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  url = `file://${repo}`;
});
afterEach(cleanupTmp);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('parseLsRemote / pickRef', () => {
  const out = [
    'ref: refs/heads/trunk\tHEAD',
    `${'1'.repeat(40)}\tHEAD`,
    `${'2'.repeat(40)}\trefs/heads/trunk`,
    `${'3'.repeat(40)}\trefs/heads/release/1.0`,
    `${'4'.repeat(40)}\trefs/tags/v1`,
    `${'5'.repeat(40)}\trefs/tags/v2`,
    `${'6'.repeat(40)}\trefs/tags/v2^{}`,
    `${'7'.repeat(40)}\trefs/heads/v1`,
    'garbage line',
  ].join('\n');
  const parsed = parseLsRemote(out);
  it('parses symref and entries', () => {
    expect(parsed.headTarget).toBe('refs/heads/trunk');
    expect(parsed.entries).toHaveLength(7);
  });
  it('prefers exact, then branch, then peeled tag, then lightweight tag', () => {
    expect(pickRef(parsed.entries, 'refs/tags/v1')).toBe('4'.repeat(40));
    expect(pickRef(parsed.entries, 'v1')).toBe('7'.repeat(40)); // branch beats tag
    expect(pickRef(parsed.entries, 'v2')).toBe('6'.repeat(40)); // peeled commit of annotated tag
    expect(pickRef(parsed.entries, 'release/1.0')).toBe('3'.repeat(40));
    expect(pickRef(parsed.entries, 'nope')).toBeNull();
  });
});

describe('resolveGeneric against a local repository', () => {
  const base = () => ({ url, allowFileUrlForTests: true, timeoutMs: 30_000 });

  it('resolves HEAD / default branch when no ref is given', async () => {
    await expect(resolveGeneric(base())).resolves.toEqual({ sha: shas.main1, defaultBranch: 'main', isPrivate: null });
  });

  it.each([
    ['main', 'main1'],
    ['dev', 'dev'],
    ['v1', 'main1'],
    ['v2', 'main1'],
    ['refs/heads/dev', 'dev'],
  ])('resolves ref %s', async (ref, key) => {
    const r = await resolveGeneric({ ...base(), ref });
    expect(r.sha).toBe(shas[key]);
  });

  it('reports an unknown ref as non-retryable', async () => {
    await expect(resolveGeneric({ ...base(), ref: 'does-not-exist' })).rejects.toMatchObject({ code: 'ref_not_found', retryable: false });
  });

  it('echoes a client sha after proving the remote is reachable', async () => {
    await expect(resolveGeneric({ ...base(), sha: shas.dev, ref: 'main' })).resolves.toMatchObject({ sha: shas.dev });
  });

  it('fails for an unreachable remote without retry', async () => {
    const err = await resolveGeneric({ ...base(), url: `file://${work}/missing` }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.retryable).toBe(false);
  });

  it('refuses non-https URLs unless the test escape hatch is used, and the hatch only works under NODE_ENV=test', async () => {
    await expect(resolveGeneric({ url })).rejects.toMatchObject({ code: 'url_rejected' });
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(resolveGeneric(base())).rejects.toMatchObject({ code: 'file_url_refused' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('maps git failures: auth -> AuthorizationError, network -> retryable, timeout -> retryable', async () => {
    const d = tmpDir('wrap');
    const auth = gitWrapper(d, `echo "fatal: Authentication failed for 'https://x/'" >&2; exit 128`, 'auth');
    const net = gitWrapper(d, `echo "fatal: unable to access 'https://x/': Could not resolve host: x" >&2; exit 128`, 'net');
    const slow = gitWrapper(d, `sleep 30`, 'slow');
    await expect(resolveGeneric({ ...base(), gitBin: auth, token: 'tok-abc' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolveGeneric({ ...base(), gitBin: net })).rejects.toMatchObject({ retryable: true, code: 'network' });
    await expect(resolveGeneric({ ...base(), gitBin: slow, timeoutMs: 400 })).rejects.toMatchObject({ retryable: true, code: 'timeout' });
  });

  it('never leaks the token in error text', async () => {
    const d = tmpDir('wrap');
    const leaky = gitWrapper(d, `echo "fatal: bad credentials tok-SECRET-1 for remote" >&2; exit 128`, 'leaky');
    const err = await resolveGeneric({ ...base(), gitBin: leaky, token: 'tok-SECRET-1' }).catch((e) => e);
    expect(err.message).not.toContain('tok-SECRET-1');
  });

  it('supplies the credential via a private GIT_ASKPASS helper and a scrubbed environment, then removes it', async () => {
    const d = tmpDir('wrap');
    const log = path.join(d, 'log');
    const token = "tok'with\"quotes$and`ticks";
    const gitBin = gitWrapper(
      d,
      [
        `echo "ARGV: $*" >> '${log}'`,
        `echo "ASKPASS: $GIT_ASKPASS" >> '${log}'`,
        `stat -c 'ASKPASS_MODE: %a' "$GIT_ASKPASS" >> '${log}'`,
        `echo "USER: $("$GIT_ASKPASS" "Username for 'https://h': ")" >> '${log}'`,
        `echo "PASS: $("$GIT_ASKPASS" "Password for 'https://x@h': ")" >> '${log}'`,
        `env | sed 's/^/ENV: /' >> '${log}'`,
      ].join('\n'),
    );
    await resolveGeneric({ ...base(), gitBin, token });
    const lines = readFileSync(log, 'utf8').split('\n');
    const askpass = (lines.find((l) => l.startsWith('ASKPASS: ')) as string).slice(9);
    expect(lines).toContain('ASKPASS_MODE: 700');
    expect(lines).toContain('USER: x-access-token');
    expect(lines).toContain(`PASS: ${token}`);
    expect(existsSync(askpass)).toBe(false);
    expect(lines.filter((l) => l.startsWith('ARGV:') && l.includes('tok'))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('ENV:') && l.includes(token))).toEqual([]);
    const keys = new Set(lines.filter((l) => l.startsWith('ENV: ')).map((l) => l.slice(5).split('=')[0]));
    for (const k of keys) {
      expect(['PATH', 'HOME', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'LC_ALL', 'GIT_ASKPASS', 'PWD', 'SHLVL', '_', 'OLDPWD']).toContain(k);
    }
    expect(lines).toContain('ENV: GIT_CONFIG_GLOBAL=/dev/null');
    expect(lines.some((l) => l.startsWith('ARGV:') && l.includes(' ls-remote ') && l.includes('--symref'))).toBe(true);
  });
});
