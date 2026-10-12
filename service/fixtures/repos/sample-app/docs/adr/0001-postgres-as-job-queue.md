# ADR-0001: Use a Postgres table as the job queue

**Status:** Accepted

## Context

Order receipts and Stripe event processing must happen after the request that caused them
has returned, and must survive a process restart. The service already depends on PostgreSQL
for orders, so a second system adds operational cost.

## Decision

Jobs are rows in the `jobs` table, inserted in the same transaction as the business write
that causes them. Workers claim rows with `FOR UPDATE SKIP LOCKED`.

## Consequences

- An order and its `order.created` job commit or roll back together. No outbox relay is needed.
- Throughput is limited by one polling query per worker per interval. This is adequate for the
  expected volume and is revisited if it is not.
- Stale locks are reclaimed by a time-based rule (five minutes), not by heartbeats.
- Retries use a fixed linear backoff. Dead jobs stay in the table for inspection.
