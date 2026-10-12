/**
 * GitHub REST provider (SS00 §5.2): confirms access and resolves a ref to a full SHA.
 * `fetch` is injected so tests never reach the network. The token is only ever sent to `apiBase`
 * and redirects are not followed, so it cannot be forwarded to another host.
 */
import { Sha1Hex } from '@archreview/contracts';
import { AuthorizationError, RetrievalError, ShaMismatch, redactSecret } from '../errors.js';
import { assertTokenShape } from '../git-process.js';
import type { ResolvedRef, ResolveRequest } from '../types.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubResolveOptions extends ResolveRequest {
  owner: string;
  repo: string;
  fetch?: FetchFn;
  apiBase?: string;
  timeoutMs?: number;
}

const DEFAULT_API = 'https://api.github.com';

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export async function resolveGithub(o: GithubResolveOptions): Promise<ResolvedRef> {
  const doFetch: FetchFn = o.fetch ?? ((input, init) => fetch(input, init));
  const base = (o.apiBase ?? DEFAULT_API).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'archreview-service',
  };
  if (o.token) {
    assertTokenShape(o.token);
    headers.Authorization = `Bearer ${o.token}`;
  }

  async function get(pathname: string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${pathname}`, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new RetrievalError(`GitHub API request failed: ${redactSecret((err as Error).message, o.token)}`, { code: 'network', retryable: true });
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // GitHub answers 404 for private repositories the caller cannot see, so 404 is an authorization failure.
      // Exception: 403/429 with an exhausted rate limit is transient, not a permission problem.
      if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))) {
        throw new RetrievalError('GitHub API rate limit exceeded', { code: 'rate_limited', retryable: true });
      }
      throw new AuthorizationError(`GitHub denied access to ${o.owner}/${o.repo} (HTTP ${res.status})`);
    }
    if (res.status === 429) throw new RetrievalError('GitHub API rate limit exceeded', { code: 'rate_limited', retryable: true });
    if (res.status >= 500) throw new RetrievalError(`GitHub API error (HTTP ${res.status})`, { code: 'provider_unavailable', retryable: true });
    if (res.status === 422) throw new RetrievalError('ref does not resolve to a commit', { code: 'ref_not_found' });
    if (res.status >= 300) throw new RetrievalError(`unexpected GitHub API response (HTTP ${res.status})`, { code: 'provider_unexpected' });
    try {
      return await res.json();
    } catch {
      throw new RetrievalError('GitHub API returned malformed JSON', { code: 'provider_unexpected', retryable: true });
    }
  }

  const repoPath = `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}`;
  const repoInfo = (await get(repoPath)) as { default_branch?: unknown; private?: unknown } | null;
  const defaultBranch = typeof repoInfo?.default_branch === 'string' ? repoInfo.default_branch : null;
  const isPrivate = repoInfo?.private === true;

  const target = o.sha ?? o.ref ?? defaultBranch;
  if (!target) throw new RetrievalError('repository has no default branch and no ref was given', { code: 'ref_not_found' });
  const commit = (await get(`${repoPath}/commits/${encodeRef(target)}`)) as { sha?: unknown } | null;
  const parsed = Sha1Hex.safeParse(commit?.sha);
  if (!parsed.success) throw new RetrievalError('GitHub returned an invalid commit SHA', { code: 'provider_unexpected' });
  if (o.sha !== undefined && parsed.data !== o.sha) throw new ShaMismatch(o.sha, parsed.data);
  return { sha: parsed.data, defaultBranch, isPrivate };
}
