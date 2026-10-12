# sample-orders-service

A small TypeScript web service for placing orders, taking payment through Stripe and
sending order receipts by email. It is a fixture for architecture-review tests: the code
is plausible and internally consistent, but it is never run as part of this repository.

## Components

| Component | Location | Role |
| --- | --- | --- |
| HTTP API | `src/server/` | Express app. `/v1/orders`, `/v1/users`, `/webhooks/stripe`, `/health`, `/ready` |
| Worker | `src/workers/` | Consumes the Postgres `jobs` table and runs handlers |
| Data access | `src/db/` | `pg` pool, transactions, migrations, repositories |
| Integrations | `src/integrations/` | Stripe (checkout, webhook verification) and SMTP mail |

## Running locally

```bash
npm install
export DATABASE_URL=postgres://localhost:5432/orders
export APP_PUBLIC_URL=http://localhost:8080
export STRIPE_SECRET_KEY=sk_test_placeholder
export STRIPE_WEBHOOK_SECRET=whsec_placeholder
export SMTP_URL=smtp://localhost:1025
export MAIL_FROM=orders@example.test
npm run build
npm start          # API on PORT (default 8080); migrations run at boot
npm run worker     # second process consuming the jobs table
```

Configuration is validated in `src/config.ts`. Missing or malformed variables stop the process at startup.

## Tests

`npm test` runs the vitest suite in `tests/`. The suite uses fakes and does not call Stripe,
SMTP or a database.

## Documentation

- `docs/architecture.md`: components, request lifecycle and data flow
- `docs/adr/`: architecture decision records
