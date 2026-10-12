/**
 * Builds a throw-away Git repository full of things that are dangerous to `git clone`/checkout
 * (SS00 §5.3, ADR-010). Invoked from tests; never committed as a real repository.
 *
 * Contents: symlink escaping the tree, symlink loop, absolute symlink, dot-file, `hooks/` directory
 * (committed like .git/hooks), a 2 MiB file, `.gitattributes` with a `filter=` entry, a nested
 * `.gitmodules` (plus a matching gitlink), a Git LFS pointer, and a normal `src/` tree.
 * Hook/filter scripts touch `canaryPath` if anything ever executes them.
 * The commit uses a fixed author/committer/date so the SHA is deterministic for a given canaryPath.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HostileRepo {
  dir: string;
  sha: string;
  canaryPath: string;
  /** file:// URL usable with exportCommit({ allowFileUrlForTests: true }) */
  url: string;
}

export const BIG_FILE_BYTES = 2 * 1024 * 1024;
export const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
const GITLINK_SHA = '1111111111111111111111111111111111111111';

const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2024-01-02T03:04:05+00:00',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_DATE: '2024-01-02T03:04:05+00:00',
};

export function buildHostileRepo(opts: { dir?: string; canaryPath: string; allowFilter?: boolean }): HostileRepo {
  const dir = opts.dir ?? mkdtempSync(path.join(os.tmpdir(), 'hostile-fs-'));
  mkdirSync(dir, { recursive: true });
  const canary = opts.canaryPath;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...FIXED_ENV },
    }).trim();
  const write = (rel: string, content: string | Buffer, mode?: number): void => {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    if (mode !== undefined) chmodSync(p, mode);
  };

  git('init', '-q', '-b', 'main');
  if (opts.allowFilter) git('config', 'uploadpack.allowFilter', 'true');

  // normal source tree
  write('src/index.ts', "import { add } from './util/math';\nexport const total = add(1, 2);\n");
  write('src/util/math.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  write('src/app.py', 'def main():\n    return 0\n');
  write('README.md', '# hostile-fs fixture\n');
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff]));

  // leading-dot file
  write('.hidden-config', 'secret=value\n');

  // hooks/ committed as a plain directory, plus a .gitattributes filter entry; both would touch the canary if executed
  const evil = `#!/bin/sh\ntouch '${canary}'\n`;
  write('hooks/pre-commit', evil, 0o755);
  write('hooks/post-checkout', evil, 0o755);
  write('hooks/post-merge', evil, 0o755);
  write('.gitattributes', `*.txt filter=evil\n*.secret filter=evil diff=evil\n`);
  write('filter-me.txt', 'content filtered by a driver that must never run\n');

  // 2 MiB file (text, deterministic)
  write('data/large.txt', Buffer.from('0123456789abcdef\n'.repeat(Math.ceil(BIG_FILE_BYTES / 17))).subarray(0, BIG_FILE_BYTES));

  // nested .gitmodules and a matching gitlink
  write('third_party/.gitmodules', '[submodule "ext"]\n\tpath = ext\n\turl = https://example.com/ext.git\n');

  // LFS pointer
  write('assets/model.bin', LFS_POINTER);

  // links: outside the tree, absolute, loop
  symlinkSync('../../../../../../etc/passwd', path.join(dir, 'escape-link'));
  symlinkSync('/etc/passwd', path.join(dir, 'absolute-link'));
  symlinkSync('loop-b', path.join(dir, 'loop-a'));
  symlinkSync('loop-a', path.join(dir, 'loop-b'));
  symlinkSync('src', path.join(dir, 'dir-link'));

  git('add', '-A');
  git('update-index', '--add', '--cacheinfo', `160000,${GITLINK_SHA},third_party/ext`);
  git('commit', '-q', '-m', 'hostile fixture');
  const sha = git('rev-parse', 'HEAD');
  return { dir, sha, canaryPath: canary, url: `file://${dir}` };
}
