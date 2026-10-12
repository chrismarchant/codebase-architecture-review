# Architecture

## Overview

The service has two long-running processes built from one codebase and one image:

- **API** (`src/server/index.ts`): an Express app that authenticates callers with API keys,
  places orders, starts Stripe Checkout and receives Stripe webhooks.
- **Worker** (`src/workers/index.ts`): a polling consumer of the Postgres `jobs` table. It
  sends order receipts and applies Stripe events to orders.

Both processes share PostgreSQL. There is no other shared state.

## Components

```
            +----------------+        Stripe API (checkout sessions)
Client ---> |  API (Express) | ------------------------------------> Stripe
            |  src/server/   | <-- webhook POST /webhooks/stripe --- Stripe
            +-------+--------+
                    | single transaction: orders + order_items + jobs
                    v
            +----------------+
            |   PostgreSQL   |
            +-------+--------+
                    | FOR UPDATE SKIP LOCKED
                    v
            +----------------+        SMTP (receipts)
            |     Worker     | ------------------------------------> Mail server
            |  src/workers/  |
            +----------------+
```

## Request lifecycle: `POST /v1/orders`

1. `requestLog` records the method, path and eventual status.
2. `express.json` parses the body (limit 100 kB). Malformed JSON becomes a 400.
3. `authenticate` hashes the bearer token (`src/services/userService.ts`) and loads the user.
4. `CreateOrderBody` validates the body (zod). Failure becomes a 422.
5. `orderService.createOrder` prices the SKUs from the server-side catalogue, then in one
   transaction inserts the order, its lines and an `order.created` job.
6. The handler returns 201 with the order. The receipt is sent later by the worker.

## Request lifecycle: Stripe webhook

1. `POST /webhooks/stripe` reads the raw body (`express.raw`, 512 kB limit). It is mounted
   before `express.json`, which would otherwise consume the body.
2. `verifyWebhookEvent` checks the `Stripe-Signature` header. Failure returns 400.
3. The verified event is stored as a `stripe.event` job and the handler returns 200.
4. The worker runs `billingService.handleStripeEvent`. A `checkout.session.completed` event
   moves the order from `pending` to `paid` with a compare-and-set, so redelivery is harmless.

## Job queue

`src/workers/queue.ts` implements the queue on the `jobs` table (see ADR-0001).

- Claim: one `UPDATE jobs ... WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1)` per poll.
- Lease: a claimed row has `status = 'running'` and `locked_at`. A row whose lock is older
  than five minutes is claimable again.
- Retry: failures requeue with a 30 s x attempts delay until `WORKER_MAX_ATTEMPTS`, then the
  row becomes `dead`.
- Job types: `order.created`, `stripe.event`. Unknown types fail the job, not the worker.

## Data

| Table | Purpose |
| --- | --- |
| `users` | Accounts; `api_key_hash` is the SHA-256 of the API key |
| `orders` | Header with status, currency, integer total in minor units, and `version` |
| `order_items` | Priced lines, copied at order time |
| `jobs` | Work queue |
| `schema_migrations` | Applied migration files |

Migrations are plain SQL files in `src/db/migrations/`, applied in lexical order at boot.

## External integrations

| System | Module | Used by | Failure behaviour |
| --- | --- | --- | --- |
| Stripe | `src/integrations/stripe.ts` | API (create session, verify webhook), worker (event payloads) | Session creation errors surface as 500; webhook signature failures return 400 |
| SMTP | `src/integrations/mail.ts` | Worker (`order.created` receipts) | Job fails and is retried |

## Configuration and secrets

All configuration comes from environment variables, parsed in `src/config.ts`. The Stripe
secret key, webhook secret, database URL and SMTP URL are secrets. They are never logged.

## Health

- `GET /health`: process liveness; no database access.
- `GET /ready`: runs `SELECT 1` against the pool.
