import { describe, expect, it } from 'vitest';
import { createTestDb, withPglite } from '../../src/testing/index.js';

describe('testing helpers', () => {
  it('withPglite provides a migrated database and closes it afterwards', async () => {
    let captured: Awaited<ReturnType<typeof createTestDb>> | undefined;
    const count = await withPglite(async (db) => {
      captured = db;
      const res = await db.query<{ n: string | number | bigint }>('SELECT count(*) AS n FROM jobs');
      return Number(res.rows[0]!.n);
    });
    expect(count).toBe(0);
    expect(await captured!.ping()).toBe(false);
  });

  it('withPglite closes the database when fn throws, and each call is isolated', async () => {
    await expect(
      withPglite(async (db) => {
        await db.query(`INSERT INTO principals (id, name) VALUES ('00000000-0000-4000-8000-000000000009', 'x')`);
        throw new Error('fail inside');
      }),
    ).rejects.toThrow('fail inside');
    await withPglite(async (db) => {
      expect((await db.query('SELECT 1 FROM principals')).rowCount).toBe(0);
    });
  });
});
