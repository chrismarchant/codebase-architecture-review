import { describe, expect, it } from 'vitest';
import { AuthorizationError, RetrievalError, ShaMismatch } from '../../src/retrieval/errors.js';
import { resolveGithub, type FetchFn } from '../../src/retrieval/providers/github.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: string;
}

function mockFetch(routes: Record<string, () => Response>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (input, init) => {
    calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect as string });
    const path = new URL(input).pathname;
    const handler = routes[path];
    if (!handler) return new Response('{}', { status: 404 });
    return handler();
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const happy = (extra: { sha?: string; isPrivate?: boolean } = {}) => ({
  '/repos/octo/repo': () => json({ default_branch: 'trunk', private: extra.isPrivate ?? false }),
  '/repos/octo/repo/commits/trunk': () => json({ sha: extra.sha ?? SHA }),
  '/repos/octo/repo/commits/feature/x%20y': () => json({ sha: OTHER }),
  [`/repos/octo/repo/commits/${SHA}`]: () => json({ sha: SHA }),
  [`/repos/octo/repo/commits/${OTHER}`]: () => json({ sha: SHA }), // server answers with a different commit
});

describe('resolveGithub', () => {
  it('resolves the default branch when no ref is given', async () => {
    const { fetch, calls } = mockFetch(happy({ isPrivate: true }));
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', fetch })).resolves.toEqual({ sha: SHA, defaultBranch: 'trunk', isPrivate: true });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/repos/octo/repo', '/repos/octo/repo/commits/trunk']);
    expect(calls[0]?.url.startsWith('https://api.github.com/')).toBe(true);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('url-encodes refs but keeps slashes', async () => {
    const { fetch, calls } = mockFetch(happy());
    const r = await resolveGithub({ owner: 'octo', repo: 'repo', ref: 'feature/x y', fetch });
    expect(r.sha).toBe(OTHER);
    expect(new URL(calls[1]?.url as string).pathname).toBe('/repos/octo/repo/commits/feature/x%20y');
  });

  it('sends the Authorization header only when a token is given', async () => {
    const anon = mockFetch(happy());
    await resolveGithub({ owner: 'octo', repo: 'repo', fetch: anon.fetch });
    expect(anon.calls.every((c) => !('Authorization' in c.headers))).toBe(true);

    const authed = mockFetch(happy());
    await resolveGithub({ owner: 'octo', repo: 'repo', token: 'ghp_abc123', fetch: authed.fetch });
    expect(authed.calls.every((c) => c.headers.Authorization === 'Bearer ghp_abc123')).toBe(true);
  });

  it('accepts a matching sha and verifies it against the API', async () => {
    const { fetch, calls } = mockFetch(happy());
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', sha: SHA, ref: 'ignored', fetch })).resolves.toMatchObject({ sha: SHA });
    expect(new URL(calls[1]?.url as string).pathname).toBe(`/repos/octo/repo/commits/${SHA}`);
  });

  it('throws ShaMismatch when the resolved commit differs from the requested sha', async () => {
    const { fetch } = mockFetch(happy());
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', sha: OTHER, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ShaMismatch);
    expect(err).toMatchObject({ expected: OTHER, actual: SHA, retryable: false, code: 'sha_mismatch' });
  });

  it.each([401, 403, 404])('maps HTTP %i to AuthorizationError', async (status) => {
    const { fetch } = mockFetch({ '/repos/octo/repo': () => json({ message: 'nope' }, status) });
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', token: 'secret-token', fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('secret-token');
  });

  it('treats an unknown repository on the commit call as authorization failure too', async () => {
    const { fetch } = mockFetch({ '/repos/octo/repo': () => json({ default_branch: 'main', private: false }) });
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', fetch })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('treats an exhausted rate limit (403) as retryable, not as a permission problem', async () => {
    const { fetch } = mockFetch({ '/repos/octo/repo': () => json({}, 403, { 'x-ratelimit-remaining': '0' }) });
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err).not.toBeInstanceOf(AuthorizationError);
    expect(err.retryable).toBe(true);
  });

  it.each([500, 502, 503, 429])('maps HTTP %i to a retryable RetrievalError', async (status) => {
    const { fetch } = mockFetch({ '/repos/octo/repo': () => json({}, status) });
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.retryable).toBe(true);
  });

  it('maps network failures to a retryable RetrievalError without leaking the token', async () => {
    const fetch: FetchFn = async () => {
      throw new Error('connect ECONNRESET while sending Bearer tok-123');
    };
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', token: 'tok-123', fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('tok-123');
  });

  it('does not follow redirects and reports them as non-retryable', async () => {
    const { fetch } = mockFetch({ '/repos/octo/repo': () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }) });
    const err = await resolveGithub({ owner: 'octo', repo: 'repo', token: 't', fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.retryable).toBe(false);
  });

  it('maps 422 (unknown ref) to a non-retryable error and rejects garbage SHAs', async () => {
    const unknown = mockFetch({ ...happy(), '/repos/octo/repo/commits/nope': () => json({}, 422) });
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', ref: 'nope', fetch: unknown.fetch })).rejects.toMatchObject({ code: 'ref_not_found', retryable: false });
    const bad = mockFetch(happy({ sha: 'not-a-sha' }));
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', fetch: bad.fetch })).rejects.toMatchObject({ code: 'provider_unexpected' });
  });

  it('rejects tokens with header-injection characters before any request', async () => {
    const { fetch, calls } = mockFetch(happy());
    await expect(resolveGithub({ owner: 'octo', repo: 'repo', token: 'a\r\nX-Evil: 1', fetch })).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toHaveLength(0);
  });
});
