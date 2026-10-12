# mini-app

A tiny order service: an HTTP API receives orders, a service layer prices them,
a database client stores them, and a payment gateway integration charges the customer.

Layout:

- `src/server.ts` HTTP entry point
- `src/routes/orders.ts` request handlers
- `src/services/` business logic
- `src/db/` PostgreSQL access
- `src/integrations/payment-gateway.ts` external payment API
