/**
 * Immutable commit export (ADR-010): fetch exactly one commit into a scratch bare repository,
 * then stream `git archive` through the defensive tar reader. Nothing is ever checked out, so
 * hooks, filters and submodules cannot execute or be fetched.
 *
 * Known limit: `git archive` honours `export-ignore` / `export-subst` attributes committed in the
 * target repository, so a repository can hide its own files from the snapshot. That only reduces
 * what is analysed (coverage shows the file count), it does not widen access.
 */
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Sha1Hex } from '@archreview/contracts';
import { RetrievalError } from './errors.js';
import {
  assertFileUrlAllowed,
  assertTokenShape,
  classifyGitFailure,
  gitEnv,
  hardeningArgs,
  makeScratch,
  runGit,
  spawnGit,
} from './git-process.js';
import { computeSnapshotSha256, extractTarStream, makeTreeReadOnly, type Exclusion } from './safe-extract.js';
import { parseRepositoryUrl } from './url-policy.js';
import type { ExportBudgets } from './types.js';

export interface ExportOptions {
  url: string;
  /** full 40-hex commit SHA, already resolved by stage 1 */
  sha: string;
  token?: string;
  /** must not exist or be empty */
  destDir: string;
  budgets: ExportBudgets;
  /** overall deadline for fetch + archive + extraction */
  timeoutMs: number;
  /** when given, the URL is re-checked against the allow-list (defence in depth) */
  allowlist?: string | readonly string[];
  /** `Authorization` scheme for the git transport; GitHub's git endpoint expects basic, many others accept bearer */
  authScheme?: 'bearer' | 'basic';
  signal?: AbortSignal;
  gitBin?: string;
  /** tests only; refused unless NODE_ENV === 'test' */
  allowFileUrlForTests?: boolean;
}

export interface ExportResult {
  sha: string;
  snapshotSha256: string;
  fileCount: number;
  bytes: number;
  excluded: Exclusion[];
  /** number of exclusions not listed because the list hit its safety cap */
  excludedOverflow: number;
}

function quoteConfigValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function exportCommit(o: ExportOptions): Promise<ExportResult> {
  const sha = Sha1Hex.parse(o.sha);
  const allowFile = assertFileUrlAllowed(o.allowFileUrlForTests);
  let configHost: string | undefined;
  if (allowFile && o.url.startsWith('file://')) {
    // test fixture repository
  } else if (o.allowlist !== undefined) {
    configHost = parseRepositoryUrl(o.url, o.allowlist).host;
  } else {
    if (!o.url.startsWith('https://')) throw new RetrievalError('only https:// remotes can be exported', { code: 'url_rejected' });
    configHost = new URL(o.url).hostname.toLowerCase();
  }
  if (o.token) assertTokenShape(o.token);

  const deadline = Date.now() + o.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  await mkdir(o.destDir, { recursive: true, mode: 0o755 });
  if ((await readdir(o.destDir)).length > 0) throw new RetrievalError('destination directory is not empty', { code: 'dest_not_empty' });

  const scratch = await makeScratch('archreview-export');
  try {
    const bare = path.join(scratch.dir, 'repo.git');
    let configGlobal: string | undefined;
    if (o.token) {
      // Credential travels in a 0600 global config scoped to the remote's host, never on a command line.
      configGlobal = path.join(scratch.dir, 'gitconfig');
      const scheme = o.authScheme === 'basic' ? 'Basic' : 'Bearer';
      const secret = o.authScheme === 'basic' ? Buffer.from(`x-access-token:${o.token}`).toString('base64') : o.token;
      const section = configHost ? `[http "https://${configHost}/"]` : '[http]';
      await writeFile(configGlobal, `${section}\n\textraheader = ${quoteConfigValue(`Authorization: ${scheme} ${secret}`)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(configGlobal, 0o600);
    }
    const env = gitEnv({ home: scratch.home, configGlobal });
    const base = { gitBin: o.gitBin, env, signal: o.signal };
    const hard = hardeningArgs({ allowFileProtocol: allowFile });

    const init = await runGit({ ...base, args: [...hard, 'init', '--bare', '--quiet', bare], timeoutMs: remaining() });
    if (init.exit.code !== 0) throw classifyGitFailure('git init', init.exit, init.stderr, o.token);

    const fetchArgs = (filter: boolean): string[] => [
      ...hard,
      `--git-dir=${bare}`,
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--depth',
      '1',
      ...(filter ? ['--filter=blob:none'] : []),
      '--',
      o.url,
      sha,
    ];
    let fetched = await runGit({ ...base, args: fetchArgs(true), timeoutMs: remaining() });
    if (fetched.exit.code !== 0 && !fetched.exit.timedOut && !fetched.exit.aborted) {
      // Some servers refuse partial-clone filters; retry the same single commit without one.
      fetched = await runGit({ ...base, args: fetchArgs(false), timeoutMs: remaining() });
    }
    if (fetched.exit.code !== 0) {
      if (/couldn't find remote ref|not our ref|no such remote ref|unadvertised object|bad object/i.test(fetched.stderr)) {
        throw new RetrievalError(`commit ${sha} is not available from the remote`, { code: 'commit_not_found' });
      }
      throw classifyGitFailure('git fetch', fetched.exit, fetched.stderr, o.token);
    }

    // After a blob:none fetch, `git archive` makes ONE batched lazy fetch of the blobs from the promisor remote,
    // using this same scrubbed env and credential config; its failures surface through archive's exit status.
    const archive = spawnGit({
      gitBin: o.gitBin,
      args: [...hard, `--git-dir=${bare}`, 'archive', '--format=tar', sha],
      env,
      timeoutMs: remaining(),
      signal: o.signal,
    });
    let result;
    try {
      result = await extractTarStream(archive.child.stdout as Readable, {
        destDir: o.destDir,
        budgets: o.budgets,
        signal: o.signal,
      });
    } catch (err) {
      archive.kill();
      const exit = await archive.exit;
      if (exit.timedOut || exit.aborted) throw classifyGitFailure('git archive', exit, archive.stderr(), o.token);
      throw err;
    }
    const exit = await archive.exit;
    if (exit.code !== 0) throw classifyGitFailure('git archive', exit, archive.stderr(), o.token);

    await makeTreeReadOnly(o.destDir);
    return {
      sha,
      snapshotSha256: computeSnapshotSha256(result.files),
      fileCount: result.files.length,
      bytes: result.bytes,
      excluded: result.excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : 1)),
      excludedOverflow: result.excludedOverflow,
    };
  } finally {
    await scratch.cleanup(); // removes the bare repo, HOME and every credential file
  }
}

