import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

/** Anything that can run a query: the pool itself or a checked-out client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createPool(connectionString: string, max: number): pg.Pool {
  return new Pool({ connectionString, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
}

/** Runs fn inside BEGIN/COMMIT on a single connection; rolls back and rethrows on error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies every *.sql file in lexical order that is not yet recorded in schema_migrations.
 * Each file runs in its own transaction. No advisory lock is taken: run one migrating
 * process at a time.
 */
export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if ((done.rowCount ?? 0) > 0) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await withTransaction(pool, async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Readiness probe helper. Never throws; returns false when the database cannot answer. */
export async function pingDatabase(db: Queryable): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
