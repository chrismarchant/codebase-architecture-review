import { describe, expect, it } from 'vitest';
import { createLogger, isSecretKey, redact } from '../../src/logging/index.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const lines: string[] = [];
  const log = createLogger('test', level, { write: (l) => lines.push(l) });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, any>) };
}

describe('logger', () => {
  it('writes one JSON object per line with ts, level, name, msg and fields', () => {
    const { log, lines, parsed } = capture();
    log.info('hello', { jobId: 'j1', n: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const rec = parsed()[0]!;
    expect(rec).toMatchObject({ level: 'info', name: 'test', msg: 'hello', jobId: 'j1', n: 2 });
    expect(new Date(rec.ts).toISOString()).toBe(rec.ts);
    expect(Object.keys(rec).slice(0, 4)).toEqual(['ts', 'level', 'name', 'msg']);
  });

  it('filters by level', () => {
    const { log, parsed } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(parsed().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('redacts secret-like keys at any depth, case-insensitively', () => {
    const { log, lines, parsed } = capture();
    log.info('request', {
      token: 'tok-123',
      nested: { Authorization: 'Bearer abc', apiKey: 'k-1', ok: 'visible', deeper: [{ password: 'pw', cookie: 'c' }] },
      client_secret: 's',
      list: [{ SECRET_THING: 'x' }],
      safe: 'value',
    });
    const text = lines[0]!;
    for (const leaked of ['tok-123', 'Bearer abc', 'k-1', '"pw"', '"c"', '"s"', '"x"']) expect(text).not.toContain(leaked);
    const rec = parsed()[0]!;
    expect(rec.token).toBe('[REDACTED]');
    expect(rec.nested.Authorization).toBe('[REDACTED]');
    expect(rec.nested.ok).toBe('visible');
    expect(rec.nested.deeper[0]).toEqual({ password: '[REDACTED]', cookie: '[REDACTED]' });
    expect(rec.safe).toBe('value');
  });

  it('child loggers bind fields (also redacted) and caller fields cannot spoof reserved keys', () => {
    const { log, parsed } = capture();
    const child = log.child({ component: 'runner', accessToken: 'abc' });
    child.warn('careful', { msg: 'spoof', level: 'debug', name: 'evil', ts: 'now', extra: 1 });
    const rec = parsed()[0]!;
    expect(rec).toMatchObject({ level: 'warn', name: 'test', msg: 'careful', component: 'runner', accessToken: '[REDACTED]', extra: 1 });
    expect(rec.ts).not.toBe('now');
  });

  it('serialises errors, dates, bigints, buffers and circular references safely', () => {
    const { log, parsed } = capture();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    log.error('boom', {
      err: Object.assign(new Error('failed'), { code: 'E_X' }),
      at: new Date('2026-01-02T03:04:05.000Z'),
      big: 10n,
      bytes: Buffer.from('file contents'),
      circular,
    });
    const rec = parsed()[0]!;
    expect(rec.err).toMatchObject({ name: 'Error', message: 'failed', code: 'E_X' });
    expect(rec.at).toBe('2026-01-02T03:04:05.000Z');
    expect(rec.big).toBe('10');
    expect(rec.bytes).toBe('[bytes 13]');
    expect(rec.circular).toEqual({ a: 1, self: '[circular]' });
  });

  it('truncates very long strings so file contents cannot flood the log', () => {
    const { log, parsed } = capture();
    log.info('big', { content: 'x'.repeat(10_000) });
    const content = parsed()[0]!.content as string;
    expect(content.length).toBeLessThan(4200);
    expect(content).toContain('[truncated');
  });

  it('writes to stderr by default', () => {
    const original = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    process.stderr.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      createLogger('stderr-test', 'info').info('to stderr');
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join('')).toMatch(/"msg":"to stderr"\}\n$/);
  });
});

describe('redact helpers', () => {
  it('classifies secret-like key names', () => {
    for (const k of ['token', 'accessToken', 'API_KEY', 'authorization', 'password', 'Set-Cookie', 'clientSecret']) {
      expect(isSecretKey(k)).toBe(true);
    }
    for (const k of ['jobId', 'message', 'stage', 'attempt']) expect(isSecretKey(k)).toBe(false);
  });

  it('keeps shared (non-circular) references and primitives intact', () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared, n: null, u: undefined })).toEqual({ a: { v: 1 }, b: { v: 1 }, n: null, u: undefined });
    expect(redact(42)).toBe(42);
  });
});
