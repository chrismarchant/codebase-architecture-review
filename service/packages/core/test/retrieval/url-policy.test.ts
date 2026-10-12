import { describe, expect, it } from 'vitest';
import {
  assertPublicAddress,
  hostMatchesAllowlist,
  isNonPublicAddress,
  parseHostAllowlist,
  parseRepositoryUrl,
  type LookupFn,
} from '../../src/retrieval/url-policy.js';
import { UrlPolicyError } from '../../src/retrieval/errors.js';

const ALLOW = 'github.com,*.example.org, git.corp.test';

describe('parseRepositoryUrl accepts', () => {
  it.each([
    ['https://github.com/octo/repo', 'https://github.com/octo/repo.git'],
    ['https://github.com/octo/repo.git', 'https://github.com/octo/repo.git'],
    ['https://github.com/octo/repo/', 'https://github.com/octo/repo.git'],
    ['https://GitHub.com/octo/repo', 'https://github.com/octo/repo.git'],
    ['https://github.com:443/octo/repo', 'https://github.com/octo/repo.git'],
    ['https://git.example.org/group/sub/repo.git', 'https://git.example.org/group/sub/repo.git'],
    ['https://git.corp.test/team/repo', 'https://git.corp.test/team/repo'],
  ])('%s', (input, canonical) => {
    expect(parseRepositoryUrl(input, ALLOW).url).toBe(canonical);
  });

  it('classifies providers and extracts owner/repo', () => {
    expect(parseRepositoryUrl('https://github.com/octo/repo.git', ALLOW)).toMatchObject({ provider: 'github', owner: 'octo', repo: 'repo', host: 'github.com' });
    expect(parseRepositoryUrl('https://git.corp.test/a/b', ALLOW)).toMatchObject({ provider: 'generic', host: 'git.corp.test' });
  });
});

describe('parseRepositoryUrl rejects', () => {
  it.each([
    ['http scheme', 'http://github.com/octo/repo'],
    ['ssh scheme', 'ssh://git@github.com/octo/repo'],
    ['git scheme', 'git://github.com/octo/repo'],
    ['file scheme', 'file:///etc/passwd'],
    ['scp-like', 'git@github.com:octo/repo.git'],
    ['userinfo', 'https://user:pw@github.com/octo/repo'],
    ['username only', 'https://token@github.com/octo/repo'],
    ['other port', 'https://github.com:8443/octo/repo'],
    ['http port', 'https://github.com:80/octo/repo'],
    ['ipv4 literal', 'https://140.82.112.3/octo/repo'],
    ['decimal ipv4', 'https://2130706433/octo/repo'],
    ['hex ipv4', 'https://0x7f000001/octo/repo'],
    ['ipv6 literal', 'https://[::1]/octo/repo'],
    ['localhost', 'https://localhost/octo/repo'],
    ['sub.localhost', 'https://a.localhost/octo/repo'],
    ['.local', 'https://printer.local/octo/repo'],
    ['.internal', 'https://metadata.internal/octo/repo'],
    ['host not on allow-list', 'https://gitlab.com/octo/repo'],
    ['suffix trick', 'https://github.com.evil.io/octo/repo'],
    ['prefix trick', 'https://evilgithub.com/octo/repo'],
    ['wildcard apex', 'https://example.org/a/b'],
    ['trailing-dot host', 'https://github.com./octo/repo'],
    ['github extra path', 'https://github.com/octo/repo/tree/main'],
    ['github owner only', 'https://github.com/octo'],
    ['github root', 'https://github.com/'],
    ['github traversal', 'https://github.com/octo/../repo'],
    ['github bad chars', 'https://github.com/oc%20to/repo'],
    ['query string', 'https://github.com/octo/repo?x=1'],
    ['fragment', 'https://github.com/octo/repo#frag'],
    ['whitespace', 'https://github.com/octo/re po'],
    ['backslash', 'https://github.com\\@evil.com/octo/repo'],
    ['empty', ''],
    ['not a url', 'github.com/octo/repo'],
    ['generic traversal', 'https://git.example.org/a/../b'],
    ['generic encoded slash', 'https://git.example.org/a/%2e%2e/b'],
  ])('%s', (_label, input) => {
    expect(() => parseRepositoryUrl(input, ALLOW)).toThrow(UrlPolicyError);
  });
});

describe('allow-list matching', () => {
  it('parses comma separated values', () => {
    expect(parseHostAllowlist(' GitHub.com , *.Foo.io ,,')).toEqual(['github.com', '*.foo.io']);
  });
  it('supports exact and *.suffix entries', () => {
    const l = ['github.com', '*.foo.io'];
    expect(hostMatchesAllowlist('github.com', l)).toBe(true);
    expect(hostMatchesAllowlist('a.foo.io', l)).toBe(true);
    expect(hostMatchesAllowlist('a.b.foo.io', l)).toBe(true);
    expect(hostMatchesAllowlist('foo.io', l)).toBe(false);
    expect(hostMatchesAllowlist('xfoo.io', l)).toBe(false);
    expect(hostMatchesAllowlist('api.github.com', l)).toBe(false);
    expect(hostMatchesAllowlist('github.com', ['*.'])).toBe(false);
    expect(hostMatchesAllowlist('github.com', [])).toBe(false);
  });
});

describe('isNonPublicAddress', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255', '240.0.0.1', '192.0.2.1', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fe80::abcd%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1',
    '::ffff:a00:1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::10.0.0.1', 'not-an-ip', '1.2.3', '1.2.3.256',
  ])('%s is non-public', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['140.82.112.3', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    '%s is public',
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );
});

describe('assertPublicAddress (injected lookup)', () => {
  const answering =
    (...addresses: string[]): LookupFn =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1'])('rejects %s', async (addr) => {
    await expect(assertPublicAddress('git.example.org', answering(addr))).rejects.toBeInstanceOf(UrlPolicyError);
  });

  it('rejects when any answer is private (mixed A/AAAA)', async () => {
    await expect(assertPublicAddress('git.example.org', answering('140.82.112.3', '10.0.0.5'))).rejects.toThrow(/non-public/);
  });

  it('accepts public addresses and returns them', async () => {
    await expect(assertPublicAddress('github.com', answering('140.82.112.3', '2606:4700:4700::1111'))).resolves.toEqual(['140.82.112.3', '2606:4700:4700::1111']);
  });

  it('asks for all addresses', async () => {
    let seen: unknown;
    await assertPublicAddress('github.com', async (_h, opts) => {
      seen = opts;
      return [{ address: '140.82.112.3', family: 4 }];
    });
    expect(seen).toEqual({ all: true });
  });

  it('rejects empty answers and lookup failures', async () => {
    await expect(assertPublicAddress('x.example.org', async () => [])).rejects.toThrow(/no addresses/);
    await expect(
      assertPublicAddress('x.example.org', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('checks IP literals without a lookup', async () => {
    const never: LookupFn = async () => {
      throw new Error('should not be called');
    };
    await expect(assertPublicAddress('127.0.0.1', never)).rejects.toBeInstanceOf(UrlPolicyError);
    await expect(assertPublicAddress('8.8.8.8', never)).resolves.toEqual(['8.8.8.8']);
  });
});
