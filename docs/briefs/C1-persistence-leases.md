# C1 — Persistence, leases, fencing, artifact stores, crypto, logging (Sonnet 5.5)

Spec: SS00 §2, §3.3–§3.7, §7, §9 retention; ADR-005, ADR-006.

## Owns

- `service/packages/core/src/db/` (except the frozen `db.ts`): `pg-db.ts`, `pglite-db.ts`, `migrate.ts`, `index.ts` (barrel)
- `service/packages/core/src/jobs/` (except frozen `store.ts`): `pg-job-store.ts`, `index.ts`
- `service/packages/core/src/artifacts/` (except frozen `store.ts`): `fs-store.ts`, `s3-store.ts`, `index.ts`
- `service/packages/core/src/crypto/`: `secret-box.ts` (AES-256-GCM with `RETRIEVAL_KEK`), `api-key.ts` (generate/hash/verify `ar_` keys, constant-time compare), `hmac.ts` (wake token sign/verify with timestamp window and nonce), `index.ts`
- `service/packages/core/src/logging/`: `logger.ts` (JSON lines to stderr, levels, redaction of keys named like `token|secret|key|authorization|password|cookie`), `index.ts`
- `service/packages/core/src/testing/`: `pglite.ts` (fresh migrated PGlite `Db` per test), `index.ts`
- `service/packages/core/test/db/**`, `test/jobs/**`, `test/artifacts/**`, `test/crypto/**`, `test/logging/**`

## Deliverables

1. **`Db` implementations.** `createPgDb(env)` (pool max `DB_POOL_MAX`, `idleTimeoutMillis = DB_IDLE_TIMEOUT_MS`, `connectionTimeoutMillis`, `allowExitOnIdle: true`, statement timeout 30 s) and `createPgliteDb()` (in-memory). Both implement `transaction`, `ping`, `close`.
2. **Migration runner** `runMigrations(db)`: applies `packages/core/migrations/*.sql` in name order inside a transaction each, records in `schema_migrations`, idempotent. Resolve the migrations directory from `import.meta.url` so it works from `src/` (tsx) and `dist/`.
3. **`PgJobStore` implementing `JobStore`** exactly as specified. Required SQL properties:
   - `claim` is **one statement** of the form `UPDATE jobs SET status='running', lease_owner=$1, lease_expires_at=now()+$2, fence_token=fence_token+1, attempt=attempt+1, started_at=COALESCE(started_at, now()), updated_at=now() WHERE id IN (SELECT id FROM jobs WHERE (status='queued' AND (not_before IS NULL OR not_before<=now())) OR (status='running' AND lease_expires_at < now()) ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING *`. PGlite accepts `FOR UPDATE SKIP LOCKED` syntactically; correctness in tests comes from the conditional `WHERE`.
   - Every worker-side write includes `AND fence_token = $fence` (and `lease_owner = $worker` for heartbeat) and returns `rowCount === 1`.
   - `publish` additionally requires `status='running'`; `fail` with `retryable && attempt < max_attempts` sets `status='queued', not_before=now()+backoff, lease_owner=NULL, lease_expires_at=NULL`.
   - `appendEvent` computes `seq` as `COALESCE(MAX(seq),0)+1` inside a transaction.
   - `queuePosition` counts queued jobs created earlier.
   - `list` uses keyset pagination on `(created_at, id)`; cursor is base64url of both.
   - `requestCancel`: if `queued` → `cancelled` + `finished_at`; if `running` → `cancel_requested=true`; terminal → unchanged. Returns the row.
   - `requeueOrFailExpired(id, expectedFence, backoffMs)`: only acts when `fence_token = expectedFence AND status='running' AND lease_expires_at < now()`.
   - Row mapping: snake_case → camelCase, jsonb parsed, timestamps as `Date`.
4. **Artifact stores.** `FsArtifactStore(root)` keys mapped to `root/<key>` with traversal protection (reject keys containing `..`, leading `/`, or `\`); `S3ArtifactStore(env)` using `@aws-sdk/client-s3` (`PutObject`, `GetObject`, `HeadObject`, `ListObjectsV2`, `DeleteObjects` batched ≤1000), `forcePathStyle` from env, `ChecksumAlgorithm` left default. `put` computes SHA-256 while streaming. `deletePrefix` is bounded by `limit`.
5. **Crypto.** `sealSecret(kekB64, plaintext) → Uint8Array` (12-byte IV ‖ ciphertext ‖ 16-byte tag), `openSecret`. `generateApiKey() → { key: 'ar_' + base64url(32 bytes), prefix: key.slice(0,12), hash: sha256(key) }`, `verifyApiKey(key, hash)` with `timingSafeEqual`. `signWake(secret, {scanId, nonce, ts}) → token` (HMAC-SHA256 over canonical JSON), `verifyWake(secret, body, token, { maxSkewMs: 300000 })`.
6. **Logger.** `createLogger(name, level)` → `{ debug, info, warn, error, child(fields) }` writing one JSON object per line with `ts, level, name, msg, ...fields`, redacting secret-like keys recursively.
7. **Testing helper.** `withPglite(fn)` creates a migrated PGlite db, runs `fn`, closes it.

## Tests (minimum)

- `migrate.test.ts`: migrations apply twice without error; tables exist.
- `job-store.test.ts`: create → claim returns fence 1; second claim with no expired lease returns nothing; expire lease (`UPDATE jobs SET lease_expires_at = now() - interval '1 minute'`) → re-claim returns fence 2 and attempt 2; old fence `heartbeat`, `setStage`, `setCheckpoint`, `publish` all return false; new fence `publish` returns true and sets `published_attempt = 2`; a second `publish` returns false; `fail` with retryable requeues until `max_attempts`; `requestCancel` semantics; idempotency unique violation surfaces as a typed error `IdempotencyConflict`; `listNeedingWake`/`listExpiredLeases` bounds; `queuePosition`.
- `fs-store.test.ts`, `s3-store.test.ts` (S3 via an injected fake client implementing `send` — no network).
- `crypto.test.ts`: seal/open round trip, tamper detection, api key verify constant-time path, wake token skew and tamper rejection.
- `logger.test.ts`: redaction.

## Acceptance

Maps to SS00 §13 A7, A8, A10 (store side). `pnpm typecheck` clean; unit project passes.
