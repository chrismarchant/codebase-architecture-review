import pg from 'pg';
import { INSERT_ORDER, SELECT_ORDER } from './queries.js';

export interface Db {
  insertOrder(customerId: string, totalCents: number, status: string): Promise<string>;
  findOrder(id: string): Promise<{ id: string; totalCents: number; status: string } | null>;
}

// PostgreSQL client: a small pool and two prepared queries.
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async insertOrder(customerId, totalCents, status) {
      const res = await pool.query(INSERT_ORDER, [customerId, totalCents, status]);
      return res.rows[0].id as string;
    },
    async findOrder(id) {
      const res = await pool.query(SELECT_ORDER, [id]);
      const row = res.rows[0];
      return row ? { id: row.id, totalCents: row.total_cents, status: row.status } : null;
    },
  };
}
