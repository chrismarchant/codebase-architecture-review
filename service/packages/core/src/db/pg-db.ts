import pg from 'pg';
import type { z } from 'zod';
import type { CommonEnv } from '../config.js';

// config.ts exports the schema only; derive the parsed shape here.
type CommonEnvShape = z.infer<typeof CommonEnv>;
import type { Db, Queryable, QueryResult } from './db.js';
import { createLogger } from '../logging/index.js';

type PgEnv = Pick<
  CommonEnvShape,
  'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_IDLE_TIMEOUT_MS' | 'DB_CONNECT_TIMEOUT_MS'
> &
  Partial<Pick<CommonEnvShape, 'LOG_LEVEL'>>;

/** Server-side cap on any single statement (SS00 task C1). */
export const STATEMENT_TIMEOUT_MS = 30_000;

function wrap(q: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      // An absent/empty params array uses the simple protocol, which allows multi-statement SQL (migrations).
      const res = await q.query(sql, params ? [...params] : undefined);
      return { rows: res.rows as Row[], rowCount: res.rowCount ?? res.rows.length };
    },
  };
}

/**
 * Production Db over a bounded pg Pool. Idle connections are closed after
 * DB_IDLE_TIMEOUT_MS and `allowExitOnIdle` lets the process exit/sleep when idle.
 */
export function createPgDb(env: PgEnv): Db {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL database');
  const log = createLogger('db', env.LOG_LEVEL ?? 'info');
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // An unhandled 'error' on an idle client would crash the process; the pool discards the client itself.
  pool.on('error', (err) => log.error('idle pool client error', { err }));

  const base = wrap(pool);
  let closing: Promise<void> | null = null;
  return {
    query: base.query,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let failed: unknown;
      try {
        await client.query('BEGIN');
        try {
          const out = await fn(wrap(client));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          failed = err;
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      } finally {
        // Passing an error destroys the connection instead of returning a possibly broken one to the pool.
        client.release(failed instanceof Error ? failed : undefined);
      }
    },
    async close() {
      closing ??= pool.end();
      await closing;
    },
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
