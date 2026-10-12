/**
 * Structured logger: one JSON object per line on stderr (stdout is reserved for
 * program output). Secret-like keys are redacted recursively; long strings are
 * truncated so that file contents cannot leak into logs by accident.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Line sink; defaults to process.stderr. Used by tests. */
  write?: (line: string) => void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|key|authorization|password|cookie/i;
const REDACTED = '[REDACTED]';
const MAX_STRING = 4096;
const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Returns a JSON-safe deep copy with secret-like keys redacted. */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING}]` : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
  }
  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (ArrayBuffer.isView(obj)) return `[bytes ${obj.byteLength}]`;
  if (obj instanceof ArrayBuffer) return `[bytes ${obj.byteLength}]`;
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  try {
    if (obj instanceof Error) {
      const out: Record<string, unknown> = { name: obj.name, message: redact(obj.message, depth + 1, seen) };
      if (obj.stack) out.stack = redact(obj.stack, depth + 1, seen);
      const code = (obj as { code?: unknown }).code;
      if (code !== undefined) out.code = redact(code, depth + 1, seen);
      return out;
    }
    if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj); // only true cycles are flagged; shared references are fine
  }
}

export function createLogger(name: string, level: LogLevel = 'info', opts: LoggerOptions = {}): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = opts.write ?? ((line: string) => void process.stderr.write(`${line}\n`));

  const make = (bound: Record<string, unknown>): Logger => {
    const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
      if (LEVELS[lvl] < threshold) return;
      // Reserved keys are written last so caller fields cannot spoof them.
      const record = {
        ...(redact({ ...bound, ...fields }) as Record<string, unknown>),
        ts: new Date().toISOString(),
        level: lvl,
        name,
        msg,
      };
      // Put the reserved keys first for readability.
      const { ts, level: l, name: n, msg: m, ...rest } = record;
      let line: string;
      try {
        line = JSON.stringify({ ts, level: l, name: n, msg: m, ...rest });
      } catch {
        line = JSON.stringify({ ts, level: l, name: n, msg: m, logError: 'unserializable fields' });
      }
      write(line);
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (f) => make({ ...bound, ...f }),
    };
  };
  return make({});
}
