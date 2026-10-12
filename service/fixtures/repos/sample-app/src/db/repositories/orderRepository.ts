import type { Queryable } from '../client.js';

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'fulfilled';

export interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  unitCents: number;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  version: number;
  stripeSessionId: string | null;
  lines: OrderLine[];
  createdAt: string;
  updatedAt: string;
}

interface OrderRow {
  id: string;
  user_id: string;
  status: OrderStatus;
  currency: string;
  total_cents: number;
  version: number;
  stripe_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  sku: string;
  name: string;
  quantity: number;
  unit_cents: number;
}

async function loadLines(db: Queryable, orderId: string): Promise<OrderLine[]> {
  const result = await db.query<LineRow>(
    'SELECT sku, name, quantity, unit_cents FROM order_items WHERE order_id = $1 ORDER BY line_no',
    [orderId],
  );
  return result.rows.map((r) => ({ sku: r.sku, name: r.name, quantity: r.quantity, unitCents: r.unit_cents }));
}

async function toOrder(db: Queryable, row: OrderRow): Promise<Order> {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    currency: row.currency.trim(),
    totalCents: row.total_cents,
    version: row.version,
    stripeSessionId: row.stripe_session_id,
    lines: await loadLines(db, row.id),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface NewOrder {
  userId: string;
  currency: string;
  totalCents: number;
  lines: OrderLine[];
}

/**
 * Inserts an order and its lines. Callers must run this inside a transaction
 * so that the order and its queued job commit together.
 */
export async function insertOrder(db: Queryable, input: NewOrder): Promise<Order> {
  const inserted = await db.query<OrderRow>(
    'INSERT INTO orders (user_id, status, currency, total_cents) VALUES ($1, $2, $3, $4) RETURNING *',
    [input.userId, 'pending', input.currency, input.totalCents],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('insert into orders returned no row');
  for (const [index, line] of input.lines.entries()) {
    await db.query(
      'INSERT INTO order_items (order_id, line_no, sku, name, quantity, unit_cents) VALUES ($1, $2, $3, $4, $5, $6)',
      [row.id, index + 1, line.sku, line.name, line.quantity, line.unitCents],
    );
  }
  return toOrder(db, row);
}

export async function findOrderById(db: Queryable, id: string): Promise<Order | null> {
  const result = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? toOrder(db, row) : null;
}

export async function findOrderForUser(db: Queryable, id: string, userId: string): Promise<Order | null> {
  const result = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? toOrder(db, row) : null;
}

export async function setStripeSession(db: Queryable, id: string, sessionId: string): Promise<void> {
  await db.query('UPDATE orders SET stripe_session_id = $2, updated_at = now() WHERE id = $1', [id, sessionId]);
}

/**
 * Compare-and-set on status. Returns false when the order is not in `from`, which lets
 * redelivered webhooks and concurrent cancels become no-ops.
 */
export async function transitionStatus(
  db: Queryable,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<boolean> {
  const result = await db.query(
    'UPDATE orders SET status = $3, version = version + 1, updated_at = now() WHERE id = $1 AND status = $2',
    [id, from, to],
  );
  return (result.rowCount ?? 0) === 1;
}
