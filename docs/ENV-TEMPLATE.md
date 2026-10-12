# Environment template

Source of truth: `service/packages/core/src/config.ts` (zod schemas `CommonEnv`, `ApiEnv`, `RunnerEnv`). Every variable defined there appears in one of the tables below. Variables read elsewhere (Railway platform settings, test-only switches) are listed separately at the end.

## Column meanings

- **Required**: `optional` means zod accepts the variable being absent. `effective` means the service cannot work without it, although `config.ts` does not enforce it. Startup fails only where zod rejects a value.
- **Default**: the value zod applies when the variable is unset. For numeric fields an empty string also takes the default. For booleans, only `1` or `true` mean true, except `COOKIE_SECURE`, which is true unless the value is `0` or `false`.
- **Stage**: where the variable is used. Job stages follow SS00 section 3.2 (`authorize`, `retrieve`, `inventory`, `analyze`, `validate`, `publish`, `cleanup`). Process phases are `boot`, `http`, `wake`, `reconcile`, `claim`, `heartbeat`, `shutdown`.
- **Secret**: yes means `config.ts` lists the name in `SECRET_KEYS`. `describe()` then logs `<set>` or `<unset>` and never the value. Secrets must not appear in logs, in committed files or in `.env.example` values.

## API service (`ApiEnv`)

| Name | Required | Default | Description | Stage | Secret |
| --- | --- | --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | optional | unset | Public origin of the API. Its purpose is not defined in SS00 or the ADRs and no code reads it yet. See unresolved items. | http | no |
| `RUNNER_INTERNAL_URL` | effective | unset | Base URL the API calls for `POST /internal/wake`, for example `http://<runner>.railway.internal:<port>` (config.ts comment, ADR-008). | wake | no |
| `AUTH_BOOTSTRAP_KEYS` | optional | unset | Principals created on first start, format `name:ar_xxx;name2:ar_yyy` (ADR-009). | boot | yes |
| `SESSION_TTL_HOURS` | optional | `12` | Lifetime of a web session row (SS00 section 5.1). | http | no |
| `RATE_LIMIT_PER_MINUTE` | optional | `60` | Token bucket per principal on mutating routes (SS00 section 5.1). | http | no |
| `WAKE_RETRY_DELAYS_MS` | optional | `1000,3000,9000` | Comma-separated retry delays for the wake call (ADR-008). | wake | no |
| `RECONCILE_MIN_INTERVAL_MS` | optional | `60000` | Shortest interval between reconciler ticks, which run only while queued or running work exists (SS00 section 10). | reconcile | no |
| `RECONCILE_MAX_INTERVAL_MS` | optional | `900000` | Longest interval between reconciler ticks, the backoff ceiling (SS00 section 10). | reconcile | no |
| `RECONCILE_BATCH` | optional | `50` | Jobs handled per reconciler tick (SS00 section 11). | reconcile | no |
| `LEASE_TTL_MS` | optional | `120000` | Lease time-to-live. The reconciler expires `running` jobs past `LEASE_TTL_MS x 3` (SS00 section 11). Also defined in `RunnerEnv` with the same default. | reconcile, claim | no |
| `RETENTION_DAYS` | optional | `90` | Retention for published attempts (SS00 section 9). | reconcile | no |
| `RETENTION_BATCH` | optional | `200` | Maximum objects deleted per nightly retention sweep (SS00 section 9). | reconcile | no |
| `BUDGET_CEILING_MAX_BUDGET_USD` | optional | `20` | Service maximum for per-principal `maxBudgetUsd` overrides (SS00 section 9). | http | no |
| `BUDGET_CEILING_MAX_TIME_SECONDS` | optional | `5400` | Service maximum for per-principal `maxTimeSeconds` overrides (SS00 section 9). | http | no |
| `BUDGET_CEILING_MAX_TURNS` | optional | `1000` | Service maximum for per-principal `maxTurns` overrides (SS00 section 9). | http | no |
| `BUDGET_CEILING_MAX_BYTES` | optional | `524288000` (500 MiB) | Service maximum for per-principal `maxBytes` overrides (SS00 section 9). | http | no |
| `COOKIE_SECURE` | optional | `true` | `Secure` attribute on the `ar_session` cookie (ADR-009). Set `0` or `false` only for local plain-HTTP testing. | http | no |

## Runner service (`RunnerEnv`)

| Name | Required | Default | Description | Stage | Secret |
| --- | --- | --- | --- | --- | --- |
| `RUNNER_WORKER_ID` | optional | hostname and pid | Lease owner identity recorded with the fence token. | claim | no |
| `RUNNER_MAX_CONCURRENCY` | optional | `1` | Jobs one runner replica runs at once (ADR-013). | claim | no |
| `LEASE_TTL_MS` | optional | `120000` | Lease time-to-live. Also defined in `ApiEnv` with the same default. | claim | no |
| `LEASE_HEARTBEAT_MS` | optional | `30000` | Interval at which the lease is extended. Each heartbeat is outbound traffic that keeps the service awake (SS00 sections 3.3 and 10). | heartbeat | no |
| `CANCEL_POLL_MS` | optional | `5000` | Interval at which the running job checks `cancel_requested` (SS00 section 3.6). | all | no |
| `WORKSPACE_ROOT` | optional | `/tmp/archreview-work` | Ephemeral workspace root containing `snapshot/` (read-only) and `out/` (SS00 section 4.2). | retrieve to cleanup | no |
| `RETRIEVAL_HOST_ALLOWLIST` | optional | `github.com` | Hosts permitted for generic HTTPS Git remotes. The list delimiter is not defined; `config.ts` treats the value as one string. | retrieve | no |
| `RETRIEVAL_GITHUB_TOKEN` | optional | unset | Operator-scoped retrieval token, used when a request supplies none (SS00 section 5.2, option b). | retrieve | yes |
| `RETRIEVAL_TIMEOUT_MS` | optional | `600000` | Retrieval time limit. The name suggests the retrieve-stage timeout; SS00 does not define it. | retrieve | no |
| `ANALYSIS_RUNTIME` | optional | `claude-agent-sdk` | Agent runtime: `claude-agent-sdk` or `mock` (SS00 section 4.3). | analyze | no |
| `ANALYSIS_MODEL` | optional | `claude-sonnet-5-5` | Model for analysis (ADR-014). | analyze | no |
| `ANALYSIS_FALLBACK_MODEL` | optional | unset | Fallback model for analysis (ADR-014). | analyze | no |
| `ANALYSIS_EFFORT` | optional | `medium` | Effort level: `low`, `medium`, `high`, `xhigh` or `max` (ADR-014). | analyze | no |
| `ANTHROPIC_API_KEY` | effective when `ANALYSIS_RUNTIME=claude-agent-sdk` | unset | Key passed only to the agent process environment (SS00 section 5.3). | analyze | yes |
| `ANTHROPIC_BASE_URL` | optional | unset | Endpoint override for the agent SDK (SS00 section 5.3). | analyze | no |
| `MOCK_AGENT_SCRIPT` | optional | unset | Path to a fixture script used when `ANALYSIS_RUNTIME=mock`. SS00 section 4.3 places fixtures in `service/fixtures/agent/*.json`; the script format is not defined. | analyze | no |

## Both services (`CommonEnv`)

| Name | Required | Default | Description | Stage | Secret |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | optional | `production` | Runtime mode. Any string is accepted; `config.ts` does not restrict it. | boot | no |
| `PORT` | optional | `3000` | HTTP listen port. Railway injects `PORT` (SS00 section 10). | boot | no |
| `LOG_LEVEL` | optional | `info` | One of `debug`, `info`, `warn`, `error`. | all | no |
| `SERVICE_VERSION` | optional | `0.1.0` | Version reported by the service. | boot | no |
| `SERVICE_GIT_SHA` | optional | unset | Commit SHA of the running build. SS00 does not define where it is reported. | boot | no |
| `DATABASE_URL` | effective | unset | PostgreSQL connection string (ADR-006). The `config.ts` comment says it is required in production; zod does not enforce this. | all | yes |
| `DB_POOL_MAX` | optional | `3` | Maximum pool connections (ADR-006). | all | no |
| `DB_IDLE_TIMEOUT_MS` | optional | `10000` | Idle connections close after this time so the service can sleep (ADR-006). | all | no |
| `DB_CONNECT_TIMEOUT_MS` | optional | `10000` | Connection timeout. Not in SS00 or the ADRs; purpose taken from the name. | all | no |
| `ARTIFACT_STORE` | optional | `s3` | Artifact storage: `s3` (Railway buckets) or `fs` (local and development) (ADR-005). | publish, cleanup, http | no |
| `ARTIFACT_FS_ROOT` | effective when `ARTIFACT_STORE=fs` | unset | Directory for the filesystem store. Not enforced by zod. | publish, cleanup, http | no |
| `S3_ENDPOINT` | effective when `ARTIFACT_STORE=s3` | unset | Bucket endpoint. Railway: `ENDPOINT`. | publish, cleanup, http | no |
| `S3_REGION` | optional | `auto` | Bucket region. Railway: `REGION`. | publish, cleanup, http | no |
| `S3_BUCKET` | effective when `ARTIFACT_STORE=s3` | unset | Bucket name. Railway: `BUCKET`. | publish, cleanup, http | no |
| `S3_ACCESS_KEY_ID` | effective when `ARTIFACT_STORE=s3` | unset | Bucket access key. Railway: `ACCESS_KEY_ID`. | publish, cleanup, http | yes |
| `S3_SECRET_ACCESS_KEY` | effective when `ARTIFACT_STORE=s3` | unset | Bucket secret key. Railway: `SECRET_ACCESS_KEY`. | publish, cleanup, http | yes |
| `S3_FORCE_PATH_STYLE` | optional | `false` | Path-style addressing. Keep `false` for Railway buckets, which are virtual-hosted style (SS00 section 10). | publish, cleanup, http | no |
| `WAKE_SHARED_SECRET` | effective | unset | HMAC key for `/internal/wake`. The API signs with it and the runner verifies with it, so both services need the same value (ADR-008). | wake | yes |
| `RETRIEVAL_KEK` | effective | unset | Base64 of 32 random bytes. AES-256-GCM key for per-request retrieval tokens at rest (SS00 section 5.2). Both services need it if the API encrypts and the runner decrypts (inferred; see unresolved items). | http, retrieve | yes |
| `ARCHREVIEW_UPSTREAM_ROOT` | optional | located from `import.meta.url` | Upstream repository root override (ADR-002). | boot | no |
| `SHUTDOWN_GRACE_MS` | optional | `25000` | SIGTERM grace period before the job stops at its next checkpoint (SS00 section 10). Keep below the Railway drain setting of 30 s. | shutdown | no |

## Railway bucket variables and the `S3_*` mapping

Railway provides these on the bucket resource (SS00 section 10). `config.ts` does not read them under these names. Map each one to the service variable on the API and the runner that use the bucket. The reference form is Railway's variable reference syntax; check the exact bucket service name in the runbook.

| Railway variable | Service variable | Notes |
| --- | --- | --- |
| `BUCKET` | `S3_BUCKET` | Bucket name |
| `ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID` | Secret |
| `SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY` | Secret |
| `REGION` | `S3_REGION` | Passed through; `auto` is the default if unset |
| `ENDPOINT` | `S3_ENDPOINT` | Endpoint URL |

Keep `S3_FORCE_PATH_STYLE=false`. Only set `ARTIFACT_STORE=s3` when all five `S3_*` values are present.

## Variables read outside `config.ts`

| Name | Read by | Purpose | Secret |
| --- | --- | --- | --- |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Railway platform | Drain window before SIGKILL, set to `30` by the runbook (SS00 section 10). Not read by the application. | no |
| `ANALYSIS_LIVE` | Live test project (`pnpm test:live`) | Set to `1` to allow paid provider calls in tests (SS00 A19). Not in `config.ts`. | no |
| `ANALYSIS_SPEND_CEILING_USD` | Live test project | Spend ceiling for live runs (SS00 A19). Not in `config.ts`. | no |

## `.env.example`: API service

```dotenv
# Copy to .env for local development only. Never commit real values.
NODE_ENV=development
# Railway injects PORT. Locally, any free port.
PORT=3000
LOG_LEVEL=info
SERVICE_VERSION=0.1.0
SERVICE_GIT_SHA=
# Secret. Local PostgreSQL example.
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/archreview
DB_POOL_MAX=3
DB_IDLE_TIMEOUT_MS=10000
DB_CONNECT_TIMEOUT_MS=10000
# Use fs locally. Use s3 on Railway.
ARTIFACT_STORE=fs
ARTIFACT_FS_ROOT=./.local/artifacts
# Railway bucket mapping (only needed when ARTIFACT_STORE=s3).
# Railway ENDPOINT -> S3_ENDPOINT
S3_ENDPOINT=
# Railway REGION -> S3_REGION
S3_REGION=auto
# Railway BUCKET -> S3_BUCKET
S3_BUCKET=
# Railway ACCESS_KEY_ID -> S3_ACCESS_KEY_ID (secret)
S3_ACCESS_KEY_ID=
# Railway SECRET_ACCESS_KEY -> S3_SECRET_ACCESS_KEY (secret)
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
# Secret. Must equal the runner's value.
WAKE_SHARED_SECRET=replace-with-random-value
# Secret. Base64 of 32 random bytes: openssl rand -base64 32
RETRIEVAL_KEK=replace-with-base64-32-bytes
ARCHREVIEW_UPSTREAM_ROOT=
SHUTDOWN_GRACE_MS=25000
PUBLIC_BASE_URL=
# Runner private hostname. The port must match the runner's PORT (unresolved; see below).
RUNNER_INTERNAL_URL=http://runner.railway.internal:3001
# Secret. Format name:ar_xxx;name2:ar_yyy. Read on first start only.
AUTH_BOOTSTRAP_KEYS=admin:ar_replace-with-generated-key
SESSION_TTL_HOURS=12
RATE_LIMIT_PER_MINUTE=60
WAKE_RETRY_DELAYS_MS=1000,3000,9000
RECONCILE_MIN_INTERVAL_MS=60000
RECONCILE_MAX_INTERVAL_MS=900000
RECONCILE_BATCH=50
LEASE_TTL_MS=120000
RETENTION_DAYS=90
RETENTION_BATCH=200
BUDGET_CEILING_MAX_BUDGET_USD=20
BUDGET_CEILING_MAX_TIME_SECONDS=5400
BUDGET_CEILING_MAX_TURNS=1000
BUDGET_CEILING_MAX_BYTES=524288000
# Leave unset in production (Secure cookies). Set 0 only for local plain HTTP.
COOKIE_SECURE=1
```

## `.env.example`: runner service

```dotenv
# Copy to .env for local development only. Never commit real values.
NODE_ENV=development
# Railway injects PORT. config.ts default is 3000; the config.ts example for RUNNER_INTERNAL_URL uses 3001.
PORT=3001
LOG_LEVEL=info
SERVICE_VERSION=0.1.0
SERVICE_GIT_SHA=
# Secret. Same database as the API.
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/archreview
DB_POOL_MAX=3
DB_IDLE_TIMEOUT_MS=10000
DB_CONNECT_TIMEOUT_MS=10000
ARTIFACT_STORE=fs
ARTIFACT_FS_ROOT=./.local/artifacts
# Railway bucket mapping (only needed when ARTIFACT_STORE=s3). Same values as the API.
S3_ENDPOINT=
S3_REGION=auto
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
# Secret. Must equal the API's value.
WAKE_SHARED_SECRET=replace-with-random-value
# Secret. Must equal the API's value if the runner decrypts tokens the API encrypted (inferred).
RETRIEVAL_KEK=replace-with-base64-32-bytes
ARCHREVIEW_UPSTREAM_ROOT=
SHUTDOWN_GRACE_MS=25000
# Empty means hostname and pid.
RUNNER_WORKER_ID=
RUNNER_MAX_CONCURRENCY=1
LEASE_TTL_MS=120000
LEASE_HEARTBEAT_MS=30000
CANCEL_POLL_MS=5000
WORKSPACE_ROOT=/tmp/archreview-work
RETRIEVAL_HOST_ALLOWLIST=github.com
# Secret. Optional; used when a request supplies no token.
RETRIEVAL_GITHUB_TOKEN=
RETRIEVAL_TIMEOUT_MS=600000
ANALYSIS_RUNTIME=claude-agent-sdk
ANALYSIS_MODEL=claude-sonnet-5-5
ANALYSIS_FALLBACK_MODEL=
ANALYSIS_EFFORT=medium
# Secret. Required when ANALYSIS_RUNTIME=claude-agent-sdk.
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=
# Set only with ANALYSIS_RUNTIME=mock.
MOCK_AGENT_SCRIPT=
```

## Unresolved items

These variables or gaps could not be settled from SS00, the ADRs or the code. The coordinator should fill them in.

- `PUBLIC_BASE_URL`: no purpose stated and no reader in the code.
- `RETRIEVAL_TIMEOUT_MS`: purpose inferred from the name. SS00 does not say whether it bounds the whole retrieve stage or the git operations within it.
- `DB_CONNECT_TIMEOUT_MS`: not described in SS00 or the ADRs.
- `SERVICE_GIT_SHA` and `SERVICE_VERSION`: SS00 does not say where they are reported.
- `MOCK_AGENT_SCRIPT`: the expected file format is not defined. SS00 section 4.3 names `service/fixtures/agent/*.json`.
- `RETRIEVAL_HOST_ALLOWLIST`: the list delimiter is not defined. `config.ts` treats the value as one string.
- `RUNNER_INTERNAL_URL` port: the `config.ts` example uses 3001, the runner's `PORT` default is 3000, and Railway injects `PORT`. It is not stated which value the URL must use.
- `LEASE_TTL_MS`: defined separately in `ApiEnv` and `RunnerEnv`. SS00 does not say whether the two values must match.
- `RETRIEVAL_KEK` on both services: SS00 section 5.2 implies the API encrypts and the runner decrypts, which needs the same key on both. This is inferred, not stated.
- `BUDGET_CEILING_*`: SS00 section 9 says per-principal overrides are bounded by these maxima but does not say at which point the bound is enforced. The template says submission; this is an assumption.
- `DATABASE_URL`: the `config.ts` comment says required in production, but zod does not enforce it, and no startup check is defined.
- `ANALYSIS_LIVE` and `ANALYSIS_SPEND_CEILING_USD`: used by SS00 A19 and the `test:live` script but absent from `config.ts`. Decide whether they belong in the schema.
- Railway bucket reference syntax and the bucket service name: depend on the deployed project and are in the runbook, which is not in `docs/` at this revision.
