import type { Queryable } from '../client.js';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, name, created_at';

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at.toISOString() };
}

/** Looks up a non-revoked user by the SHA-256 hex digest of their API key. */
export async function findUserByApiKeyHash(db: Queryable, apiKeyHash: string): Promise<User | null> {
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE api_key_hash = $1 AND revoked_at IS NULL`,
    [apiKeyHash],
  );
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function findUserById(db: Queryable, id: string): Promise<User | null> {
  const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function updateUserName(db: Queryable, id: string, name: string): Promise<User | null> {
  const result = await db.query<UserRow>(
    `UPDATE users SET name = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING ${USER_COLUMNS}`,
    [id, name],
  );
  const row = result.rows[0];
  return row ? toUser(row) : null;
}
