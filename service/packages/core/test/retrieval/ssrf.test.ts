/** A6: the SSRF guard is wired into the resolver, before any provider call. */
import { describe, expect, it } from 'vitest';
import { UrlPolicyError } from '../../src/retrieval/errors.js';
import { resolveRepository } from '../../src/retrieval/resolver.js';
import type { LookupFn } from '../../src/retrieval/url-policy.js';

const never = (): never => {
  throw new Error('provider must not be reached');
};
const lookupTo = (address: string): LookupFn => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

describe('resolveRepository SSRF guard', () => {
  it.each([
    ['http://github.com/o/r', '140.82.112.3'],
    ['ssh://github.com/o/r', '140.82.112.3'],
    ['file:///etc/passwd', '140.82.112.3'],
    ['https://127.0.0.1/o/r', '140.82.112.3'],
    ['https://localhost/o/r', '127.0.0.1'],
    ['https://169.254.169.254/latest/meta-data', '169.254.169.254'],
    ['https://other.example.com/o/r', '140.82.112.3'],
  ])('%s is refused before any network call', async (url) => {
    await expect(resolveRepository({ url, allowlist: 'github.com', lookup: lookupTo('140.82.112.3'), fetch: never, gitBin: '/nonexistent/git' })).rejects.toBeInstanceOf(UrlPolicyError);
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1', '192.168.0.10', 'fd00::1'])(
    'an allow-listed host resolving to %s is refused (DNS rebinding to internal ranges)',
    async (addr) => {
      await expect(resolveRepository({ url: 'https://github.com/o/r', allowlist: 'github.com', lookup: lookupTo(addr), fetch: never })).rejects.toBeInstanceOf(UrlPolicyError);
      await expect(resolveRepository({ url: 'https://git.example.org/o/r', allowlist: '*.example.org', lookup: lookupTo(addr), fetch: never, gitBin: '/nonexistent/git' })).rejects.toBeInstanceOf(
        UrlPolicyError,
      );
    },
  );
});
