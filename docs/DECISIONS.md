# Architecture Decision Records

Status key: **Accepted** (in force), **Proposed** (awaiting evidence), **Superseded**.

Each record states the decision, the context that forced it, and the consequences we accept. Records are append-only; a change is a new record that supersedes an old one.

---

## ADR-001 Import upstream through Git history, keep the upstream tree at the repository root

**Status:** Accepted (Stage A)

**Context.** The destination repository was empty. The mission requires preserving all upstream functionality and keeping a separately identifiable upstream baseline.

**Decision.** The branch was created by fetching `https://github.com/oh-my-mermaid/oh-my-mermaid` and resetting to `upstream/main` at commit `38ccdb69298adec949177c92c88d6e3ddfb5bab7` (17 commits of history). That commit is tagged `upstream-baseline`. The upstream project stays at the repository root unchanged (its `package.json`, `src/`, `skills/`, `.claude-plugin/`, `.omm/`, READMEs, CI workflows). The new service lives under `service/`.

**Consequences.** Upstream can be re-synced with `git fetch upstream && git merge upstream/main`. `git diff upstream-baseline -- . ':!service' ':!docs'` shows every change made to upstream files. The root `npm test`/`npm run build` remain the upstream commands.

---

## ADR-002 The service depends on upstream as a package (`file:../`), not by copying source

**Status:** Accepted (Stage B)

**Context.** The service needs the upstream store (`writeNodeField`, `listNodes`, ...), validator, differ, the viewer HTML and the `omm-scan` skill text. Copying would fork the `.omm` format.

**Decision.** The service consumes the upstream **build output** through one shim module, `service/packages/core/src/upstream/index.ts`, which re-exports `../../../../../dist/index.js` (types come from the adjacent `dist/index.d.ts`). The upstream root directory is located at runtime from `import.meta.url` (override: `ARCHREVIEW_UPSTREAM_ROOT`) and is the source of `dist/viewer.html` and `skills/omm-scan/SKILL.md`. The root project is built before the service. An npm `file:../` dependency was tried first and rejected: npm 10 fails with `Cannot read properties of null (reading 'edgesOut')` when a workspace links to an ancestor directory.

**Consequences.** The root build is a prerequisite for the service build and for the Docker images; `yaml` (upstream's only runtime dependency) must be installed at the root. Any upstream API the service needs that is not exported from `src/index.ts` is either added to the export list (small upstream change, recorded in `docs/UPSTREAM-PARITY.md`) or re-implemented in `service/` with a comment pointing at the upstream origin.

---

## ADR-003 Minimal, hook-style changes to `viewer.html`

**Status:** Accepted (Stage B)

**Context.** The upstream viewer fetches `/api/...` with absolute paths, loads `dagre` and `marked` from jsDelivr, renders Markdown with `marked.parse` straight into `innerHTML`, and uses inline event handlers. A multi-tenant hosted service must serve the viewer under a per-scan prefix, with a Content Security Policy that forbids remote and inline script, and with sanitized Markdown.

**Decision.** Upstream `viewer.html` receives three small, backward-compatible hooks: an API base prefix (`window.__ommApiBase`, default `''`), a Markdown sanitizer hook (`window.__ommSanitizeHtml`, default identity), and inline `on*=` handlers replaced by `addEventListener` registrations in the existing module script. The service injects the hook values, serves vendored copies of `dagre`, `marked` and `DOMPurify` from its own origin, and rewrites the two CDN `<script src>` tags at serve time. Everything else about the viewer (parser, layout, navigation, SSE) is untouched.

**Consequences.** `omm view` behaves exactly as before. The exact diff is listed in `docs/UPSTREAM-PARITY.md`. If upstream later changes the viewer, the hooks must be re-applied; the parity test `service/apps/api/test/viewer-hooks.test.ts` fails loudly if a hook is missing.

---

## ADR-004 Headless analysis uses the Claude Agent SDK with a closed tool surface and no shell

**Status:** Accepted (Stage A/B)

**Context.** Upstream `/omm-scan` is a skill for an interactive coding agent that runs `omm write` through Bash. The service must run the same analysis unattended, must never execute target code, and must treat the repository as untrusted data.

**Decision.** The runner invokes `@anthropic-ai/claude-agent-sdk` `query()` with:

- `tools: ['Read', 'Glob', 'Grep']` (built-ins restricted to read-only file tools) and in-process MCP tools `omm_write`, `omm_read`, `omm_list`, `evidence_add`, `coverage_report` exposed through `createSdkMcpServer`;
- `disallowedTools` naming `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `Agent` and every other built-in;
- `permissionMode: 'default'` with a `canUseTool` callback that allows a call only when every path argument resolves inside the immutable snapshot directory (after `realpath`), and denies everything else;
- `systemPrompt` as a plain string (no `claude_code` preset), `settingSources: []`, `strictMcpConfig: true`, `mcpServers` containing only our in-process server, `plugins: []`, `skills: []`;
- `env` built from scratch (API key, `PATH`, a throwaway `HOME`), never inheriting the runner's process environment;
- `cwd` set to the job workspace root, which contains `snapshot/` (read-only) and `out/` (writable only through the MCP tools);
- `maxTurns`, `maxBudgetUsd` and an `AbortController` wired to the job's time budget and cancellation flag.

The model is selected by `ANALYSIS_MODEL` (default `claude-sonnet-5-5`); effort by `ANALYSIS_EFFORT` (default `medium`). Neither the development session's model nor any Fable model is assumed to be available at runtime. A `MockAgentRuntime` reproduces the tool protocol from fixtures for tests.

**Consequences.** The agent cannot run anything: there is no shell tool, and the write path is a typed tool that only produces `.omm` fields. `omm-scan` skill text is adapted (not executed verbatim): the service prompt tells the agent to call `omm_write` instead of `omm write`, and adds evidence and coverage obligations. The skill file itself stays unchanged for interactive use. Isolation is tool-surface and policy based, plus the runner container boundary; it is **not** a kernel sandbox. `docs/SS00-architecture-review.md` §7 states exactly what is and is not enforced.

---

## ADR-005 PostgreSQL is the single authoritative store for job state; object storage is authoritative only for published bytes

**Status:** Accepted (Stage A)

**Context.** Railway offers managed Postgres and private S3-compatible buckets. Jobs must survive runner restarts and sleep; publication must be exactly-once from the reader's point of view.

**Decision.** Job rows, leases, fence tokens, checkpoints, idempotency keys, principals, API keys and comparisons live in Postgres. Artifacts are written to object storage under `scans/{scanId}/attempts/{fenceToken}/...`; a scan becomes *published* only when the database row's `published_attempt` pointer is set by a conditional update that carries the worker's fence token. Readers resolve artifacts through that pointer.

**Consequences.** A stale worker can still write bytes under its own attempt prefix, but cannot make them visible. Garbage collection of unpublished attempts is a bounded reconciliation task. The API never trusts object-store listings for state.

---

## ADR-006 `pg` in production, PGlite for tests, one SQL dialect

**Status:** Accepted (Stage B)

**Context.** Durability and race tests must run in CI and in a sandbox with no external services. Mocks of SQL hide real bugs in conditional updates.

**Decision.** `packages/core` defines a tiny `Db` interface (`query`, `transaction`). Production uses `pg` with a pool bounded by `DB_POOL_MAX` (default 3) and `DB_IDLE_TIMEOUT_MS` (default 10 000) so idle connections close and the service can sleep. Tests use `@electric-sql/pglite` with the same migration files. Statements avoid features PGlite lacks; concurrency-sensitive logic (claim, heartbeat, fence-checked writes) is expressed as single conditional statements so that correctness does not depend on session-level locks.

**Consequences.** True multi-connection interleavings are tested by sequencing the conditional statements explicitly (worker A claims, worker B claims with an expired lease, A's fenced write is rejected), which exercises the same SQL that production runs. A Postgres integration run (`DATABASE_URL` set) is provided for pre-deployment verification.

---

## ADR-007 Railway configuration through Infrastructure as Code (`.railway/railway.ts`), not `railway.json`

**Status:** Accepted (Stage D)

**Context.** The current Railway documentation (fetched 2026-10-12) states that Config as Code (`railway.json` / `railway.toml`) is deprecated, cannot be adopted by new services, and stops being read on 2026-12-01. The replacement is `.railway/railway.ts` evaluated by the Railway CLI (`railway config plan|apply`).

**Decision.** Deployment configuration is authored in `.railway/railway.ts` using only documented DSL calls (`service`, `postgres`, `bucket`, `healthcheck`, `healthcheckTimeout`, `env`, `preserve`, `github(..., { rootDirectory })`). Dockerfiles live at `service/apps/api/Dockerfile` and `service/apps/runner/Dockerfile`. Serverless (sleep) is a per-service dashboard setting; the IaC reference fetched today exposes no key for it, so the runbook documents it as a manual step and the code does not assume it.

**Consequences.** `railway config plan` is the review step; nothing is applied under this directive. Any key not found in the fetched reference is not used.

---

## ADR-008 Wake-up is an authenticated HTTP call from the API to the runner, plus bounded reconciliation; never continuous polling

**Status:** Accepted (Stage A)

**Context.** Railway Serverless sleeps a service after 5–10 minutes without outbound packets and wakes it on inbound traffic (public or private network). Polling would keep both services awake and defeat the purpose. CPU activity alone does not keep a service awake.

**Decision.** `POST /v1/scans` commits the job row first, then calls `POST {RUNNER_INTERNAL_URL}/internal/wake` with an HMAC-signed, time-limited token and the scan id. The call is idempotent: the runner only starts its claim loop. The API retries the wake with backoff (the first request after sleep may return 502 per Railway docs). If all retries fail the job stays `queued`; the API's reconciler (a timer active only while queued/running jobs exist, with a minimum interval of 60 s and a maximum of 15 minutes between attempts) re-issues wakes and expires stale leases. The runner on startup claims queued jobs and reaps expired leases. While a job runs, the runner's lease heartbeat (every 30 s to Postgres) is outbound traffic and keeps the service awake through quiet stages.

**Consequences.** With no work, both services stop sending traffic and can sleep. A missed wake is bounded by the reconciler interval, not lost. Behaviour that depends on Railway's sleep sampling is listed as "requires deployment to verify" in the runbook.

---

## ADR-009 Authentication is API-key based with server-side sessions for the web UI; authorization is per-principal ownership

**Status:** Accepted (Stage B)

**Context.** The service is private. An identity provider integration is out of scope; the mission requires every scan and artifact request to be authorized.

**Decision.** Principals and hashed API keys (`sha256` of a random 32-byte secret, compared in constant time) are stored in Postgres. The API accepts `Authorization: Bearer <key>`. The web UI exchanges a key once for an HttpOnly, `SameSite=Strict`, `Secure` session cookie backed by a `sessions` table. Every scan, artifact, viewer and comparison route loads the scan and checks `scan.principal_id === principal.id` (or an explicit `shared_with` grant) before any body is read. Bootstrap principals are created from `AUTH_BOOTSTRAP_KEYS` on first start.

**Consequences.** No anonymous route except `/health`, `/ready` and the login page. Rate limiting is per principal. Key rotation is a row insert plus a row revoke.

---

## ADR-010 Repository retrieval is an immutable export of a resolved commit, never a working clone

**Status:** Accepted (Stage A)

**Context.** Target repositories are untrusted. Git hooks, symlinks, submodules and `.gitattributes` filters can execute code or escape the checkout during a normal clone.

**Decision.** Retrieval resolves the requested ref to a full 40-character SHA via the provider API (GitHub) or `git ls-remote`, then fetches that exact commit with `git -c core.hooksPath=/dev/null -c core.symlinks=false -c core.fsmonitor=false -c core.sshCommand=false clone --filter=blob:none --no-checkout` into a scratch bare repository and materialises the tree with `git archive <sha> | tar -x` into `snapshot/`, skipping symlinks, hard links, device nodes, absolute or `..` paths, and files above the byte budget. Submodules are not fetched. The snapshot is made read-only (`chmod -R a-w`) before analysis. Credentials are passed to `git` through `GIT_ASKPASS`/`http.extraheader` in the retrieval step's environment only and are wiped after the step.

**Consequences.** Analysis sees exactly the committed tree of one SHA. Repositories relying on LFS objects show their pointer files (documented limitation). The resolved SHA is recorded in the manifest and compared against any client-supplied SHA.

---

## ADR-011 Artifact schemas are versioned, additive, and hashed in an immutable manifest

**Status:** Accepted (Stage B)

**Context.** Consumers (viewer, comparisons, Security Studio adapter, Codex review) need stable contracts.

**Decision.** Schema identifiers are `archreview.<name>/<major>.<minor>`: `architecture/1.0`, `evidence/1.0`, `coverage/1.0`, `manifest/1.0`, `comparison/1.0`, `studio-export/1.0`. JSON Schemas live in `service/packages/contracts/schemas/`; zod definitions in `service/packages/contracts/src/` are the source of truth and the JSON Schemas are generated from them and committed. The manifest lists every artifact with its SHA-256, byte size and schema id, plus service version, upstream baseline SHA, model id, and provider usage. Minor versions only add optional fields.

**Consequences.** A breaking change is a new major version with a new directory; readers declare which majors they accept.

---

## ADR-012 Security Studio integration is a fixture-backed adapter behind a narrow interface

**Status:** Accepted (Stage E)

**Context.** No Security Studio contract has been inspected. The mission forbids modifying Studio or claiming live integration.

**Decision.** `packages/core/src/studio/` exposes `buildStudioExport(scan, artifacts)` producing `archreview.studio-export/1.0` for the proposed capability `architecture.scan.readonly`, and `checkRevisionMatch(export, studioRevision)` that reports `match | mismatch | unknown`. Fixtures in `service/fixtures/studio/` stand in for Studio inputs. The HTTP surface is `GET /v1/scans/:id/studio-export`.

**Consequences.** When a real Studio contract is inspected, a mapping layer is added without changing the export schema's major version unless required. Nothing here calls out to a Studio endpoint.

---

## ADR-013 One concurrent analysis job per runner replica; concurrency is a configuration value

**Status:** Accepted (Stage A)

**Context.** The mission asks to start with a single concurrent job. Budget enforcement and cost measurement are simpler with one.

**Decision.** `RUNNER_MAX_CONCURRENCY` defaults to 1. Claiming is `UPDATE ... WHERE status='queued' ... ORDER BY created_at LIMIT 1` with lease and fence token assignment; a runner with a free slot claims at most that many.

**Consequences.** Queued jobs wait; the API reports queue position. Horizontal scale is additional replicas, each with its own worker id.

---

## ADR-014 Development model allocation is separate from runtime model configuration

**Status:** Accepted (Stage A)

**Context.** Fable 5.1 coordinates this build; Sonnet 5.5 and Haiku 5.5 implement; none of this implies availability at runtime.

**Decision.** Runtime model selection is only ever `ANALYSIS_MODEL` (and the fallback `ANALYSIS_FALLBACK_MODEL`, optional). Docs and code never hard-code a Fable identifier. The default is `claude-sonnet-5-5` because it is the current general-availability Sonnet listed in the Claude API reference consulted on 2026-10-12; operators may change it.

**Consequences.** Cost tables in the runbook are parameterised by model.

---

## ADR-015 The service workspace uses pnpm; the upstream root keeps npm

**Status:** Accepted (Stage B)

**Context.** `npm install` (npm 10.9.4, Node 22.22) crashes with `TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's `#loadPeerSet` for the `service/` workspace, both inside and outside the repository tree and with every dependency installed individually without error. pnpm 10.28 installs the same workspace cleanly.

**Decision.** `service/` is a pnpm workspace (`pnpm-workspace.yaml`, `packageManager: pnpm@10.28.0`, `workspace:*` links, committed `pnpm-lock.yaml`). The upstream root stays on npm with its original `package-lock.json`, untouched. Dockerfiles install pnpm with `corepack`.

**Consequences.** Two package managers in one repository, separated by directory. Sub-agents must not change `service/pnpm-lock.yaml` or any `package.json`; dependency additions are requested in handovers and applied by the coordinator.
