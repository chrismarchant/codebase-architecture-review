# Deployment Runbook — Railway

Status: prepared, **not deployed**. Nothing in this runbook has been executed against Railway under the build directive. Every step marked *Railway-only* can only be verified after an operator deploys.

Sources for Railway behaviour: documentation fetched 2026-10-12 (`/deployments/serverless`, `/deployments/healthchecks`, `/deployments/deployment-teardown`, `/deployments/troubleshooting/nodejs-sigterm-handling`, `/deployments/restart-policy`, `/infrastructure-as-code`, `/infrastructure-as-code/reference`, `/storage-buckets`, `/builds/dockerfiles`) and the `railway@3.13.1` SDK type definitions. Re-fetch before relying on them.

## 1. Topology

| Railway resource | Name | Source | Notes |
| --- | --- | --- | --- |
| Service | `api` | GitHub `chrismarchant/codebase-architecture-review`, Dockerfile `service/apps/api/Dockerfile` | public domain; sleeps when idle |
| Service | `runner` | same repo, Dockerfile `service/apps/runner/Dockerfile` | **no public domain**; reached as `runner.railway.internal:3001`; sleeps when idle |
| Postgres | `postgres` | Railway managed | `DATABASE_URL` (private) |
| Bucket | `artifacts` | Railway Bucket, region `iad` | private, S3-compatible; credentials referenced in IaC |

Defined in `.railway/railway.ts` (ADR-007).

## 2. One-time setup (operator)

1. Install the Railway CLI, `railway login`, create a project (or `railway link` to an existing empty one).
2. `cd .railway && npm install` (installs the `railway` SDK that evaluates the IaC file).
3. `railway config plan` from the repository root. Expected: 2 services, 1 database, 1 bucket to add; variables shown as `«hidden»`.
4. Set the preserved secrets in the dashboard or with `railway variables` **before** apply so `preserve()` has values to keep:
   - both services: `WAKE_SHARED_SECRET` (32 random bytes, base64), `RETRIEVAL_KEK` (32 random bytes, base64)
   - `api`: `AUTH_BOOTSTRAP_KEYS` (`name:ar_<base64url 32 bytes>;…`, generate with `node -e "console.log('ar_'+require('crypto').randomBytes(32).toString('base64url'))"`)
   - `runner`: `ANTHROPIC_API_KEY`, optional `RETRIEVAL_GITHUB_TOKEN` (fine-grained, read-only Contents permission on the repositories to analyse)
5. `railway config apply` (interactive confirmation). *Railway-only.*
6. Generate a public domain for `api` only. Do **not** give `runner` a public domain.
7. Confirm in the dashboard that Serverless is enabled on both services (`deploy.sleepApplication: true` in IaC; the setting takes effect on the next deployment per Railway docs).

## 3. Environment variables

See `docs/ENV-TEMPLATE.md` for the full table. Railway bucket variables map as `ENDPOINT→S3_ENDPOINT`, `REGION→S3_REGION`, `BUCKET→S3_BUCKET`, `ACCESS_KEY_ID→S3_ACCESS_KEY_ID`, `SECRET_ACCESS_KEY→S3_SECRET_ACCESS_KEY` (done by `ref()` in IaC). No Railway control-plane token is set on either service.

## 4. Deploy and verify

| Check | How | Local or Railway-only |
| --- | --- | --- |
| Images build | `docker build -f service/apps/api/Dockerfile .` and the runner equivalent | local (needs a Docker daemon; not available in the build sandbox — see `docs/TEST-EVIDENCE.md`) |
| Migrations apply | API and runner run `runMigrations` on boot; check logs for `migrations.applied` | both |
| Health | `GET https://<api-domain>/health` → 200; runner `/health` via `railway run curl http://runner.railway.internal:3001/health` | Railway-only |
| Readiness | `/ready` on both → 200 with `db: ok, artifacts: ok` | Railway-only |
| Cold start | after > 10 min idle, `POST /v1/scans`; first request may 502 (Railway doc) — the UI/API client retries once; the job row exists before the wake call | Railway-only |
| Wake retry | with the runner asleep, submit a scan; `wake_log` shows attempts with 502 then 202; job moves to `running` within the retry window | Railway-only |
| Active job survives quiet stages | submit a scan of a medium repository; runner logs show `lease.heartbeat` every 30 s during `analyze`; service does not sleep while a job runs | Railway-only |
| Artifact durability | after `succeeded`, redeploy the runner; `GET /v1/scans/:id/artifacts` still serves every file with matching hashes | Railway-only (local equivalent: `restart-recovery.test.ts`) |
| Eventual idle sleep | with no jobs, both services show "sleeping" in the dashboard after 5–10 min; reconciler log shows `reconciler.disarmed` | Railway-only |
| SIGTERM | redeploy during a job; old runner logs `shutdown.begin`, `lease.released`; new runner re-claims and resumes from the checkpoint | Railway-only (local: `shutdown.test.ts`) |

## 5. Reconciliation operating procedure

Normal operation needs no manual action: the API reconciler re-wakes queued jobs and requeues or fails jobs with expired leases while work exists, then disarms.

Manual intervention:

| Symptom | Action |
| --- | --- |
| Jobs stay `queued` > 5 min | `GET /ready` on runner; check `wake_log` for errors; verify `RUNNER_INTERNAL_URL` and `WAKE_SHARED_SECRET` match; call `POST /internal/reconcile` with an admin key |
| Job `running` with stale `lease_expires_at` | wait one reconciler interval, or call `POST /internal/reconcile`; the job is requeued (attempt+1) or failed at `max_attempts` |
| Repeated `max_attempts` failures | read `job_events` for the job; typical causes: provider auth (`authorization_failed`), oversized repository (budgets), model errors; fix the cause and resubmit |
| Bucket full of unpublished attempts | the reconciler deletes unpublished prefixes older than 24 h in batches; for a large backlog run several `POST /internal/reconcile` calls |
| Retention sweep | runs with the reconciler at most once per 24 h; `RETENTION_DAYS` controls published attempts |

Never edit `jobs` rows by hand except to set `cancel_requested = true` (equivalent to the cancel endpoint).

## 6. Cost measurement procedure

Two cost streams: Railway compute/storage and model provider usage.

**Idle resources** (per month, measure, do not assume):
1. Deploy, leave both services idle for 24 h.
2. Railway dashboard → service → Metrics: record CPU, memory, and whether the service slept (Serverless). With sleep working, idle compute should be near zero; Postgres and the bucket are billed regardless.
3. Bucket: `$0.015/GB-month` (doc) × stored artifacts; API operations and egress free (doc).

**Per scan**:
1. Submit a scan of a reference repository (for example this repository at `upstream-baseline`) with default budgets.
2. Record from `GET /v1/scans/:id`: `usage.totalCostUsd` (client-side estimate from the Agent SDK), `usage.byModel` tokens, `usage.durationMs`.
3. Compare the estimate with the Anthropic Console usage page for the same window; the console is authoritative.
4. Record runner CPU-seconds and memory from the Railway metrics for the job window; multiply by the plan's per-unit rates.
5. Record artifact bytes from the manifest (`artifacts[].bytes` sum) for storage cost.

Repeat with three repository sizes (small, medium, large) and tabulate; set `BUDGET_CEILING_MAX_BUDGET_USD` from the measured distribution. Keep a hard Railway usage limit configured (Cost Control doc) and a provider spend ceiling in the Anthropic Console.

## 7. Rollback

Redeploy the previous Railway deployment from the dashboard. Migrations are additive (`CREATE … IF NOT EXISTS`); no down migrations are provided. Published artifacts are immutable and unaffected by rollback.
