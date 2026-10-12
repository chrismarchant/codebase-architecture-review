/**
 * Stage 1 helper: policy check + provider call that turns (url, ref|sha) into an immutable SHA.
 */
import { Sha1Hex } from '@archreview/contracts';
import { RetrievalError } from './errors.js';
import { resolveGeneric } from './providers/generic-git.js';
import { resolveGithub, type FetchFn } from './providers/github.js';
import type { ResolvedRef } from './types.js';
import { assertPublicAddress, parseRepositoryUrl, type LookupFn, type RepositoryProvider } from './url-policy.js';

export interface ResolveOptions {
  url: string;
  ref?: string;
  sha?: string;
  /** per-request token (SS00 §5.2 option a) */
  token?: string;
  /** service-level token (option b); used for github.com only and never forwarded to other hosts */
  serviceGithubToken?: string;
  allowlist: string | readonly string[];
  fetch?: FetchFn;
  lookup?: LookupFn;
  gitBin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResolvedRepository extends ResolvedRef {
  provider: RepositoryProvider;
  /** canonical https URL to hand to the exporter */
  url: string;
  host: string;
}

export async function resolveRepository(o: ResolveOptions): Promise<ResolvedRepository> {
  const parsed = parseRepositoryUrl(o.url, o.allowlist);
  await assertPublicAddress(parsed.host, o.lookup);

  // A 40-hex "ref" is just a SHA.
  const sha = o.sha ?? (o.ref !== undefined && Sha1Hex.safeParse(o.ref).success ? o.ref : undefined);
  const ref = sha === undefined ? o.ref : undefined;

  let resolved: ResolvedRef;
  if (parsed.provider === 'github') {
    resolved = await resolveGithub({
      owner: parsed.owner as string,
      repo: parsed.repo as string,
      ref,
      sha,
      token: o.token ?? o.serviceGithubToken,
      fetch: o.fetch,
      timeoutMs: o.timeoutMs,
    });
  } else {
    resolved = await resolveGeneric({ url: parsed.url, ref, sha, token: o.token, gitBin: o.gitBin, timeoutMs: o.timeoutMs, signal: o.signal });
  }
  if (!Sha1Hex.safeParse(resolved.sha).success) throw new RetrievalError('provider returned an invalid SHA', { code: 'provider_unexpected' });
  return { ...resolved, provider: parsed.provider, url: parsed.url, host: parsed.host };
}
