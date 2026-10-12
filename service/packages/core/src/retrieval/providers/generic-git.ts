/**
 * Generic Git remote provider: `git ls-remote` (SS00 §5.2). No shell; minimal environment;
 * the credential reaches git only through a GIT_ASKPASS helper in a private temp dir that is removed afterwards.
 */
import { Sha1Hex } from '@archreview/contracts';
import { RetrievalError } from '../errors.js';
import {
  assertFileUrlAllowed,
  classifyGitFailure,
  gitEnv,
  hardeningArgs,
  makeScratch,
  runGit,
  writeAskPass,
} from '../git-process.js';
import type { ResolvedRef, ResolveRequest } from '../types.js';

export interface GenericResolveOptions extends ResolveRequest {
  url: string;
  gitBin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** tests only; refused unless NODE_ENV === 'test' */
  allowFileUrlForTests?: boolean;
}

export interface LsRemoteEntry {
  sha: string;
  ref: string;
}

/** Parse `git ls-remote --symref` output. */
export function parseLsRemote(stdout: string): { entries: LsRemoteEntry[]; headTarget: string | null } {
  const entries: LsRemoteEntry[] = [];
  let headTarget: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const sym = /^ref: (\S+)\tHEAD$/.exec(line);
    if (sym) {
      headTarget = sym[1] as string;
      continue;
    }
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (m) entries.push({ sha: m[1] as string, ref: m[2] as string });
  }
  return { entries, headTarget };
}

/** Pick the commit for `ref`: exact ref name, then branch, then peeled tag, then lightweight tag. */
export function pickRef(entries: readonly LsRemoteEntry[], ref: string): string | null {
  const by = new Map(entries.map((e) => [e.ref, e.sha]));
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  for (const c of candidates) {
    const sha = by.get(c);
    if (sha) return sha;
  }
  return null;
}

export async function resolveGeneric(o: GenericResolveOptions): Promise<ResolvedRef> {
  const allowFile = assertFileUrlAllowed(o.allowFileUrlForTests);
  if (!allowFile && !o.url.startsWith('https://')) throw new RetrievalError('only https:// remotes are supported', { code: 'url_rejected' });
  const scratch = await makeScratch('archreview-lsremote');
  try {
    const askPass = o.token ? await writeAskPass(scratch.dir, o.token) : undefined;
    // With a ref we ask for HEAD (default branch via --symref) plus the ref; patterns match by ref-name tail.
    const patterns = o.ref && o.sha === undefined ? ['HEAD', o.ref, `${o.ref}^{}`] : ['HEAD'];
    const { stdout, stderr, exit } = await runGit({
      gitBin: o.gitBin,
      args: [...hardeningArgs({ allowFileProtocol: allowFile }), 'ls-remote', '--symref', '--', o.url, ...patterns],
      env: gitEnv({ home: scratch.home, askPass }),
      timeoutMs: o.timeoutMs ?? 60_000,
      signal: o.signal,
    });
    if (exit.code !== 0) throw classifyGitFailure('git ls-remote', exit, stderr, o.token);
    const { entries, headTarget } = parseLsRemote(stdout);
    const defaultBranch = headTarget?.startsWith('refs/heads/') ? headTarget.slice('refs/heads/'.length) : null;

    if (o.sha !== undefined) {
      // ls-remote cannot prove an arbitrary commit is reachable; the exporter's fetch-by-SHA does.
      // Reaching this point still proves the remote is accessible with the given credential.
      return { sha: o.sha, defaultBranch, isPrivate: null };
    }
    let sha: string | null;
    if (o.ref) sha = pickRef(entries, o.ref);
    else sha = entries.find((e) => e.ref === 'HEAD')?.sha ?? null;
    if (!sha) throw new RetrievalError(`ref ${o.ref ?? 'HEAD'} not found on remote`, { code: 'ref_not_found' });
    const parsed = Sha1Hex.parse(sha);
    return { sha: parsed, defaultBranch, isPrivate: null };
  } finally {
    await scratch.cleanup();
  }
}

