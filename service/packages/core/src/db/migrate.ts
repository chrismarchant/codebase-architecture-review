import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

/**
 * Both src/db/migrate.ts (tsx) and dist/db/migrate.js sit two levels below the
 * package root, so the same relative path resolves packages/core/migrations.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

// Serialises concurrent migrators (API and runner may start together).
const MIGRATION_LOCK_ID = 7_261_001;

const BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.sql')).sort();
}

/** Applies pending migrations in name order, one transaction each. Idempotent. Returns the names applied now. */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  await db.query(BOOTSTRAP_SQL);
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rowCount > 0) return;
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      applied.push(name);
    });
  }
  return applied;
}

/** Migration files not yet recorded; empty means the schema is current (used by /ready). */
export async function pendingMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  let done: Set<string>;
  try {
    const res = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    done = new Set(res.rows.map((r) => r.name));
  } catch {
    done = new Set(); // table missing: nothing applied yet
  }
  return files.filter((f) => !done.has(f));
}
