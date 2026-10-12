export const INSERT_ORDER =
  'INSERT INTO orders (customer_id, total_cents, status) VALUES ($1, $2, $3) RETURNING id';

export const SELECT_ORDER = 'SELECT id, total_cents, status FROM orders WHERE id = $1';
