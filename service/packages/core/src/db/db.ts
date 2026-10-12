/**
 * Minimal database abstraction (ADR-006). Production: pg Pool. Tests: PGlite.
 * Both run the same SQL migrations from packages/core/migrations.
 */
export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface Db extends Queryable {
  /** Runs fn inside BEGIN/COMMIT; rolls back on throw. Nested calls are not supported. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Closes pooled connections. Idempotent. */
  close(): Promise<void>;
  /** Cheap connectivity probe used by /ready. */
  ping(): Promise<boolean>;
}
