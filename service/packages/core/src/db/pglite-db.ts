import type { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, QueryResult } from './db.js';

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<Array<{ rows: Record<string, unknown>[]; affectedRows?: number }>>;
}

// PGlite reports affectedRows = 0 for SELECT; pg reports the number of rows returned. Take the larger.
const countOf = (affected: number | undefined, returned: number): number => Math.max(affected ?? 0, returned);

function wrap(q: PgliteLike): Queryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      if (!params || params.length === 0) {
        // exec() uses the simple protocol, so multi-statement SQL (migrations) works like pg's simple query.
        const results = await q.exec(sql);
        const last = results[results.length - 1];
        const rows = (last?.rows ?? []) as Row[];
        return { rows, rowCount: countOf(last?.affectedRows, rows.length) };
      }
      const res = await q.query<Row>(sql, [...params]);
      return { rows: res.rows, rowCount: countOf(res.affectedRows, res.rows.length) };
    },
  };
}

/**
 * In-memory PGlite database (ADR-006). @electric-sql/pglite is a devDependency, so it is
 * imported lazily: production code paths never load it.
 */
export async function createPgliteDb(): Promise<Db> {
  const { PGlite: Ctor } = await import('@electric-sql/pglite');
  const pglite: PGlite = new Ctor();
  await pglite.waitReady;
  const base = wrap(pglite as unknown as PgliteLike);
  let closed = false;
  return {
    query: base.query,
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pglite.transaction((tx) => fn(wrap(tx as unknown as PgliteLike)));
    },
    async close() {
      if (closed) return;
      closed = true;
      await pglite.close();
    },
    async ping() {
      if (closed) return false;
      try {
        await pglite.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
