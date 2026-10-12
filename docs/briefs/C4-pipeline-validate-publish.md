# C4 — Pipeline orchestration, checkpoints, validation stage, artifact generation, publication (Sonnet 5.5)

Spec: SS00 §3 (all), §8.2–§8.6, §9, §11; ADR-005, ADR-011. Depends on C1 (job store, artifact stores, crypto), C2 (retrieval, inventory) and C3 (tool host, runtimes) being merged. Read their barrels before starting.

## Owns

- `service/packages/core/src/pipeline/`: `runner-loop.ts` is **not** yours (C6); you own `stages/{authorize,retrieve,inventory,analyze,validate,publish,cleanup}.ts`, `job-context.ts` (fenced store wrapper that throws `FencedOut` on `false`), `checkpoint.ts` (upload/download of the attempt checkpoint prefix), `run-job.ts` (executes stages in order from the checkpointed stage, handles cancellation, budgets, retryable vs terminal failures), `index.ts`
- `service/packages/core/src/validate/`: `omm-tree.ts` (structural checks over an `.omm` directory), `mermaid.ts` (upstream `validateDiagram` wrapper + label HTML/`javascript:` rejection + child-directory reference checks), `index.ts`
- `service/packages/core/src/publish/`: `architecture-builder.ts` (`.omm` tree + evidence → `Architecture`), `coverage-builder.ts`, `review-md.ts`, `manifest.ts`, `bundle.ts` (tar.gz), `index.ts`
- `service/packages/core/test/pipeline/**`, `test/validate/**`, `test/publish/**`

## Requirements

1. **Stage functions** share the signature `(ctx: JobContext) => Promise<void>` where `JobContext` wraps `{ job, fence, store: JobStore, artifacts: ArtifactStore, runtime: AgentRuntime, env: RunnerEnv, workspace, logger, signal }` and exposes `ctx.fenced.setStage/…` that throw `FencedOut` when the store returns `false`, `ctx.checkCancelled()` that throws `Cancelled` when `cancel_requested` is set, and `ctx.event(level, code, message, data?)`.
2. **run-job** `runJob(ctx)`: determines the starting stage from `job.checkpoint?.stage` (resume) or `authorize`; on resume downloads the previous attempt's checkpoint objects into the new attempt prefix (copy) and into the workspace; verifies `snapshotSha256` after re-retrieval (`snapshot_mismatch` → terminal failure); runs stages in `STAGE_ORDER`; maps `Cancelled` → `markCancelled`, `FencedOut` → stop silently (log only), `BudgetExceeded`/`budget_exhausted` → continue to `validate` and `publish` with `outcome: 'partial'`, retryable errors → `fail(..., retryable: true, backoff = 30 s × 2^attempt)`, other errors → terminal `fail`. Always runs `cleanup` (workspace removal, secret clear) in `finally`, even when fenced out.
3. **Stages**:
   - `authorize`: url policy + provider access check (C2); records provider kind; stores resolved SHA via `setCommit`.
   - `retrieve`: reads the sealed retrieval secret (C1 `openSecret`), exports the commit into `workspace/snapshot`, then `clearRetrievalSecret`; checkpoint `commitSha`, `snapshotSha256`.
   - `inventory`: builds inventory, uploads `inventory.json` to the attempt prefix, checkpoint.
   - `analyze`: builds the prompt bundle, creates the tool host over `workspace/out/.omm`, runs the runtime with an `AbortController` that fires on `maxTimeSeconds`, on `cancel_requested` (poll every `CANCEL_POLL_MS`) and on SIGTERM (ctx.signal); after **each** `perspective_done` progress event uploads that perspective's `.omm` subtree to the checkpoint prefix and updates `perspectivesCompleted`; records usage via `setUsage`; on resume, restores completed perspectives from the checkpoint prefix into `out/.omm` before starting and passes `perspectivesCompleted` to the runtime.
   - `validate`: runs `validate/omm-tree.ts` and `validate/mermaid.ts`; writes `validation.json`; errors (not warnings) make the outcome `partial` but do not fail the job unless there are zero valid perspectives (`no_valid_output` terminal failure).
   - `publish`: builds `architecture.json` (component ids via `componentIdFor`; `kind` from children; `paths` parsed from label second lines and `description` backticked paths; relationships from edges; entry points from `classDef entry` usage and label heuristics, marked `interpretation` unless evidence says `observed`; trust boundaries only when evidence items of kind `observed` exist, else `interpretation`), `evidence.json`, `coverage.json` (tool host stats + inventory + exclusions + unread directories computed as directories with zero read files), `review.md`, uploads the `.omm` tree under `omm/`, computes `manifest.json` with SHA-256 of every uploaded artifact, builds `bundle.tar.gz` (contains `.omm/`, JSON artifacts, `review.md`, `manifest.json`), uploads it, then calls `store.publish(fence, outcome, manifestSha256)`. If `publish` returns `false` the stage throws `FencedOut` (artifacts stay unreferenced).
   - `cleanup`: removes workspace directories, wipes temp files, releases nothing else (lease release is C6's loop responsibility on exit).
4. **Validation rules** (each a named rule in `validation.json`): `graph-declaration`, `balanced-brackets`, `edge-label`, `classdef-name`, `classdef-color`, `node-count` (from upstream, same levels); plus `child-ref-missing` (error: child directory not referenced by any node id of the parent diagram), `node-not-child` (warning: diagram node id that is neither a child directory nor a leaf), `self-reference` (error), `label-html` (error: `<`, `>`, `javascript:` or `data:` in any label), `description-missing` (error: element directory without `description.md`), `meta-invalid` (error: `meta.yaml` not parseable or `children` not matching directories), `path-unsafe` (error: directory name failing `ElementSegment`).
5. **review.md** structure: title, coverage banner (complete / partial with the limits hit), repository and commit, perspectives table, components table (path, kind, evidence observed/interpretation counts), "Claims without observed evidence" list, validation summary, budget/usage summary, and the fixed closing statement from SS00 §8.5.
6. **Manifest** must validate against the contract; `service.upstreamBaseline` is the constant `38ccdb69298adec949177c92c88d6e3ddfb5bab7`; `ommVersion` from `upstream.upstreamVersion()`.

## Tests (minimum)

- `run-job.test.ts` with PGlite store, fs artifact store, mock runtime and the `mini-app` fixture (C3): full run → `succeeded/complete`, manifest lists every artifact with matching hashes, `.omm` round-trips through upstream `listPerspectives/showNode`; restart scenario: abort after the first perspective (script `cancel-midway` or an injected abort), expire the lease, re-claim with a new fence, run again → completed perspectives are restored and not re-run (assert the mock runtime received `perspectivesCompleted`), publication pointer equals the second fence; stale-worker scenario: first context keeps running after being fenced out and its `publish` throws `FencedOut` while the second succeeds (A8); cancellation → `cancelled`, no publication; budget exhaustion → `succeeded/partial`, `coverage.complete=false`, `review.md` banner present (A9, A13).
- `validate.test.ts`: each rule triggers on a crafted tree; a tree produced by the mock fixture has zero errors (A11).
- `architecture-builder.test.ts`: stable ids across two builds; relationships and children correct; entry points; evidence linkage (A14, A15 precondition).
- `manifest.test.ts`, `bundle.test.ts` (extract and compare hashes).

## Acceptance

SS00 §13 A7 (publish side), A8, A9, A10, A11, A13, A14.
