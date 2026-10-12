-- Orders and their lines. Money is stored as integer minor units (cents).
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  status            text NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'fulfilled')),
  currency          char(3) NOT NULL,
  total_cents       integer NOT NULL CHECK (total_cents >= 0),
  version           integer NOT NULL DEFAULT 0,
  stripe_session_id text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_id_idx ON orders (user_id);

CREATE TABLE order_items (
  order_id   uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  line_no    integer NOT NULL,
  sku        text NOT NULL,
  name       text NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_cents integer NOT NULL CHECK (unit_cents >= 0),
  PRIMARY KEY (order_id, line_no)
);
