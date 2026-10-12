# C6 — Runner service: claim loop, heartbeat, wake endpoint, health, SIGTERM (Sonnet 5.5)

Spec: SS00 §3.3, §3.6, §10 (runner side), §11; ADR-008, ADR-013. Depends on C1 and C4.

## Owns

- `service/apps/runner/src/**`, `service/apps/runner/test/**`
- `service/packages/core/src/pipeline/runner-loop.ts` (the only pipeline file not owned by C4)

## Requirements

1. **`RunnerLoop`** (`packages/core/src/pipeline/runner-loop.ts`): `start()` claims up to `RUNNER_MAX_CONCURRENCY - active` jobs via `store.claim(workerId, slots, LEASE_TTL_MS)` on `kick()`; `kick()` is idempotent and coalesces concurrent calls; for each claimed job starts a heartbeat timer (`LEASE_HEARTBEAT_MS`) that calls `store.heartbeat`; on `false` it aborts the job's `AbortController` with reason `fenced`; runs `runJob(ctx)` (C4); on completion clears the timer and calls `kick()` again to drain the queue; `stop(graceMs)` stops claiming, aborts active jobs with reason `shutdown` after `graceMs` if they have not reached a checkpoint (C4's `analyze` uploads per-perspective checkpoints; the abort is observed by the runtime), waits for them, then `releaseLease` for each still-held job.
2. **HTTP** (`hono`): `POST /internal/wake` verifies `X-Wake-Token` with `verifyWake` (reject skew > 5 min, reject replayed nonces within the window using an in-memory set bounded to 10 000 entries), then `loop.kick()` and responds 202 `{ accepted: true, activeJobs }`. Without a valid token: 401, no kick. `GET /health` → 200 `{ ok: true, workerId, activeJobs }`. `GET /ready` → 200 only when db `ping()` and artifacts `ping()` succeed and migrations are current, else 503 with reasons.
3. **`main.ts`**: load `RunnerEnv`, build db (pg), run migrations, artifact store, runtime (`claude-agent-sdk` or `mock` per `ANALYSIS_RUNTIME`; for `mock` load the script from `MOCK_AGENT_SCRIPT`), logger; `workerId = RUNNER_WORKER_ID || `${hostname()}-${pid}``; start loop, `kick()` once on boot (startup reconciliation: claims queued and lease-expired jobs); listen on `PORT`; on `SIGTERM`/`SIGINT`: stop accepting (`server.close`), `loop.stop(SHUTDOWN_GRACE_MS)`, `db.close()`, exit 0; a second signal exits immediately with 1. Start Node directly (`node dist/main.js`), never via a package manager, so the signal reaches the process (Railway docs).
4. **Workspace**: per job `WORKSPACE_ROOT/<jobId>-<fence>/` with `snapshot/`, `out/`, `tmp/`; removed in cleanup; on boot, delete leftover directories older than 1 h.
5. **Logging**: every stage transition and every lease event as structured JSON with `jobId`, `fence`, `stage`; never log tokens or file contents.

## Tests (minimum)

- `runner-loop.test.ts` (PGlite, fs store, mock runtime, mini-app fixture): boot kick claims a queued job and completes it; `kick()` coalescing; heartbeat extends lease; fenced-out heartbeat aborts the job and the stale context cannot publish; `stop()` releases leases within grace and a second loop re-claims and resumes from checkpoint (A10, A17).
- `wake.test.ts`: valid token → 202 and kick; bad token/skew/replay → 401 and no kick.
- `health.test.ts`: ready 503 when db ping fails.
- `shutdown.test.ts`: SIGTERM handler path exercised through an exported `shutdown()` function (do not send real signals in tests).

## Acceptance

SS00 §13 A10, A17; wake/reconcile behaviour of §10 items 2–6 (runner side).
