import { describe, expect, it } from 'vitest';
import { createPgDb, createPgliteDb, listMigrationFiles, pendingMigrations, runMigrations } from '../../src/db/index.js';
import { createTestDb, withPglite } from '../../src/testing/index.js';

const TABLES = [
  'schema_migrations',
  'principals',
  'api_keys',
  'sessions',
  'jobs',
  'job_events',
  'scan_grants',
  'comparisons',
  'wake_log',
  'rate_limits',
];

describe('runMigrations', () => {
  it('applies the migrations, creating all tables, and is idempotent', async () => {
    const db = await createPgliteDb();
    try {
      const files = await listMigrationFiles();
      expect(files).toContain('001_init.sql');
      expect(await pendingMigrations(db)).toEqual(files);

      const first = await runMigrations(db);
      expect(first).toEqual(files);
      const second = await runMigrations(db);
      expect(second).toEqual([]);

      const res = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const names = res.rows.map((r) => r.table_name);
      for (const t of TABLES) expect(names).toContain(t);

      const recorded = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(recorded.rows.map((r) => r.name)).toEqual(files);
      expect(await pendingMigrations(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe('PGlite Db', () => {
  it('commits and rolls back transactions, reports rowCount, pings and closes idempotently', async () => {
    await withPglite(async (db) => {
      expect(await db.ping()).toBe(true);
      await db.query(`INSERT INTO principals (id, name) VALUES ($1, 'a')`, ['00000000-0000-4000-8000-000000000001']);

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO principals (id, name) VALUES ($1, 'b')`, ['00000000-0000-4000-8000-000000000002']);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const afterRollback = await db.query('SELECT 1 FROM principals');
      expect(afterRollback.rowCount).toBe(1);

      const out = await db.transaction(async (tx) => {
        const r = await tx.query(`UPDATE principals SET name = 'c' WHERE id = $1`, ['00000000-0000-4000-8000-000000000001']);
        return r.rowCount;
      });
      expect(out).toBe(1);

      // Multi-statement SQL without params goes through the simple protocol.
      const multi = await db.query('SELECT 1 AS a; SELECT 2 AS b');
      expect(multi.rows).toEqual([{ b: 2 }]);
    });
  });

  it('close is idempotent and ping fails afterwards', async () => {
    const db = await createTestDb();
    await db.close();
    await db.close();
    expect(await db.ping()).toBe(false);
  });
});

describe('createPgDb', () => {
  it('requires DATABASE_URL', () => {
    expect(() => createPgDb({ DB_POOL_MAX: 3, DB_IDLE_TIMEOUT_MS: 10_000, DB_CONNECT_TIMEOUT_MS: 1000 })).toThrow(/DATABASE_URL/);
  });

  it('builds a lazy pool that reports an unreachable server through ping() and closes idempotently', async () => {
    // No connection is attempted until first use; port 1 is closed so ping resolves false quickly.
    const db = createPgDb({
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      DB_POOL_MAX: 1,
      DB_IDLE_TIMEOUT_MS: 1000,
      DB_CONNECT_TIMEOUT_MS: 1000,
    });
    expect(await db.ping()).toBe(false);
    await db.close();
    await db.close();
  });

  // Optional pre-deployment integration run against a real server (ADR-006).
  it.skipIf(!process.env.DATABASE_URL)('runs migrations against DATABASE_URL', async () => {
    const db = createPgDb({
      DATABASE_URL: process.env.DATABASE_URL,
      DB_POOL_MAX: 2,
      DB_IDLE_TIMEOUT_MS: 1000,
      DB_CONNECT_TIMEOUT_MS: 5000,
    });
    try {
      await runMigrations(db);
      expect(await pendingMigrations(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
