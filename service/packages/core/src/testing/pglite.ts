import type { Db } from '../db/db.js';
import { runMigrations } from '../db/migrate.js';
import { createPgliteDb } from '../db/pglite-db.js';

/** Fresh in-memory PGlite database with all migrations applied. The caller closes it. */
export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  try {
    await runMigrations(db);
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

/** Runs fn against a fresh migrated PGlite database and always closes it. */
export async function withPglite<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await createTestDb();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
