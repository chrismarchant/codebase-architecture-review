/**
 * Repository URL policy and SSRF guard (SS00 §5.2, ADR-010).
 *
 * `parseRepositoryUrl` is pure. `assertPublicAddress` takes an injectable `lookup`
 * so tests never touch the network.
 *
 * Known limit: the DNS answer checked here is not pinned for the later `git`
 * connection, so a DNS-rebinding attacker with a very short TTL could still win
 * the race. The allow-list (operator-controlled hosts) is the primary control;
 * the address check is defence in depth, as the spec describes.
 */
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import { UrlPolicyError } from './errors.js';

export type RepositoryProvider = 'github' | 'generic';

export interface ParsedRepositoryUrl {
  /** canonical https URL: lowercased host, no trailing slash, no query/fragment */
  url: string;
  host: string;
  /** path with leading slash and without a trailing slash */
  path: string;
  provider: RepositoryProvider;
  /** GitHub only */
  owner?: string;
  repo?: string;
}

/** Split a comma-separated `RETRIEVAL_HOST_ALLOWLIST` value. */
export function parseHostAllowlist(value: string | readonly string[]): string[] {
  const parts = typeof value === 'string' ? value.split(',') : [...value];
  return parts.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
}

/** Exact match, or `*.suffix` which matches any subdomain of suffix (not suffix itself). */
export function hostMatchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      if (suffix.length > 1 && host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (entry === host) {
      return true;
    }
  }
  return false;
}

const GITHUB_HOST = 'github.com';
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const GENERIC_SEGMENT = /^[A-Za-z0-9_.~%+@-]{1,200}$/;

function reject(message: string): never {
  throw new UrlPolicyError(message);
}

export function parseRepositoryUrl(input: string, allowlist: string | readonly string[]): ParsedRepositoryUrl {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) reject('repository URL is empty or too long');
  if (/[\u0000- \u007f\\]/.test(input)) reject('repository URL contains whitespace, control characters or backslashes');
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return reject('repository URL is not a valid URL');
  }
  // WHATWG parsing silently resolves dot segments; refuse them (and encoded dots/slashes) in the input instead.
  if (/%2e|%2f|%5c/i.test(input) || /\/\.\.?(\/|$)/.test(input.replace(/^https:\/\//i, ''))) reject('repository URL contains dot segments or encoded separators');
  if (u.protocol !== 'https:') reject('only https:// repository URLs are allowed');
  if (u.username !== '' || u.password !== '') reject('credentials in the repository URL are not allowed');
  if (u.port !== '' && u.port !== '443') reject('only port 443 is allowed');
  if (u.search !== '' || u.hash !== '') reject('query strings and fragments are not allowed in repository URLs');

  const host = u.hostname.toLowerCase();
  if (host === '' || host.endsWith('.')) reject('invalid host');
  // WHATWG parsing already canonicalises decimal/hex/octal IPv4 forms, so isIP catches them too.
  if (net.isIP(host) !== 0 || host.startsWith('[')) reject('IP literal hosts are not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    reject('local and internal hosts are not allowed');
  }
  if (!host.includes('.')) reject('single-label hosts are not allowed');
  if (!hostMatchesAllowlist(host, parseHostAllowlist(allowlist))) reject(`host ${host} is not in the retrieval allow-list`);

  const path = u.pathname.replace(/\/+$/, '');
  const segments = path.split('/').slice(1);
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) reject('repository path is invalid');

  if (host === GITHUB_HOST) {
    if (segments.length !== 2) reject('GitHub URLs must look like https://github.com/{owner}/{repo}(.git)');
    const owner = segments[0] as string;
    const repo = (segments[1] as string).replace(/\.git$/, '');
    if (!NAME.test(owner) || !NAME.test(repo) || repo === '' || repo === '.' || repo === '..') reject('GitHub owner or repository name is invalid');
    return { url: `https://${host}/${owner}/${repo}.git`, host, path: `/${owner}/${repo}`, provider: 'github', owner, repo };
  }

  if (segments.length > 8 || !segments.every((s) => GENERIC_SEGMENT.test(s))) reject('repository path contains unsupported characters');
  return { url: `https://${host}${path}`, host, path, provider: 'generic' };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Expand an IPv6 textual address into 8 16-bit groups, or null when malformed. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded dotted IPv4 tail (::ffff:10.0.0.1)
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16);
    const lo = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] as string);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] as string);
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isNonPublicIPv4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network" and unspecified
    a === 10 || // RFC1918
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // RFC1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True when the textual IP is anything other than a globally routable unicast address. Unparseable input counts as non-public. */
export function isNonPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isNonPublicIPv4(v4);
  const g = parseIPv6(ip);
  if (!g) return true;
  const embeddedV4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (first5Zero && g[5] === 0xffff) return isNonPublicIPv4(embeddedV4(g[6] as number, g[7] as number)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isNonPublicIPv4(embeddedV4(g[6] as number, g[7] as number)); // NAT64 64:ff9b::/96
  }
  const g0 = g[0] as number;
  if (g0 === 0x2002) return isNonPublicIPv4(embeddedV4(g[1] as number, g[2] as number)); // 6to4
  if (g0 === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32
  if (g0 === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export type LookupFn = (host: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

/** Resolve `host` and reject when any answer is not a public address. Returns the vetted addresses. */
export async function assertPublicAddress(host: string, lookup: LookupFn = dnsPromises.lookup as unknown as LookupFn): Promise<string[]> {
  const literal = net.isIP(host) !== 0;
  let addresses: string[];
  if (literal) {
    addresses = [host];
  } else {
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await lookup(host, { all: true });
    } catch (err) {
      throw new UrlPolicyError(`host ${host} could not be resolved: ${(err as Error).message}`);
    }
    addresses = answers.map((a) => a.address);
  }
  if (addresses.length === 0) throw new UrlPolicyError(`host ${host} resolved to no addresses`);
  for (const a of addresses) {
    if (isNonPublicAddress(a)) throw new UrlPolicyError(`host ${host} resolves to a non-public address`);
  }
  return addresses;
}
