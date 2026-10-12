# Handover — how to resume this build

Last updated: Stage C wave 1 merged (C1, C2, C3, H1); wave 2 (C4, C5) in progress (2026-10-12).

## Where things are

| Item | Location |
| --- | --- |
| Branch | `claude/eloquent-einstein-ncos6k` (remote: `origin` = `chrismarchant/codebase-architecture-review`) |
| Upstream baseline | tag `upstream-baseline` = `38ccdb69298adec949177c92c88d6e3ddfb5bab7` |
| Specification | `docs/SS00-architecture-review.md` |
| Decisions | `docs/DECISIONS.md` (ADR-001 … ADR-015) |
| Parity | `docs/UPSTREAM-PARITY.md`, `docs/UPSTREAM-INVENTORY.md` |
| Contracts (frozen) | `service/packages/contracts/src/*.ts`, generated `schemas/*.schema.json` |
| Core interfaces (frozen) | `service/packages/core/src/{config.ts,db/db.ts,jobs/store.ts,artifacts/store.ts,agent/runtime.ts,index.ts}` |
| Briefs | `docs/briefs/*.md` (common rules in `README.md`) |
| Reports from tasks | `docs/reports/<task>.md` (created by tasks as they finish) |

## Model allocation (verified in this environment)

Sub-agent models `sonnet` → `claude-sonnet-5-5` and `haiku` → `claude-haiku-5-5` were verified by probe. The coordinator is Fable 5.1. Runtime analysis model is configuration only (`ANALYSIS_MODEL`, default `claude-sonnet-5-5`), never any development model.

## Stage status

| Stage | Status | Notes |
| --- | --- | --- |
| A — baseline and architecture | done | committed `f657fa1` |
| B — contracts and scaffolding | done | committed `1174715`, `3dc76db`; pnpm workspace |
| C — delegated implementation | wave 1 merged (`68096d3`, `157f780`, `69266d5`, `a34270d`); wave 2 running: C4, C5 | wave 3: C6, C7 |
| D — Railway runtime pass | pending | Fable design + Sonnet implementation; uses `.railway/railway.ts` (ADR-007) |
| E — Security Studio adapter | pending | brief C7 |
| F — verification, Codex package | pending | `docs/CODEX-REVIEW-PACKAGE.md`, `docs/TEST-EVIDENCE.md` |

## How to continue without the coordinator

1. Read `docs/briefs/README.md`, then the brief for the next unfinished task in this order: C1, C2, C3, H1 → C4, C5 → C6, C7 → D → F.
2. Run a Sonnet 5.5 session per brief (Haiku 5.5 for H-tasks). Give the session the brief path, the common rules, and the spec sections the brief names. Require the handover format.
3. After each wave: from `service/` run `pnpm typecheck && pnpm vitest run`; from the root run `npm test`. Commit with Conventional Commits and the attribution trailer. Apply any "interface changes requested" yourself (the frozen files are coordinator-owned) and record them in `docs/DECISIONS.md` if they change a contract.
4. Stage D needs the facts in SS00 §10 (fetched from Railway docs on 2026-10-12); re-fetch before relying on them.
5. Never deploy, merge, modify Security Studio, or run paid analysis without a spend ceiling under this directive.

## Operational notes

- Sub-agent sessions share a Sonnet usage limit; the first C4/C5 launch (12:5x UTC) was terminated by HTTP 429 "session limit" before doing any work and relaunched at 13:15 UTC after the reset. If a task fails this way, relaunch it with the same prompt; nothing partial is written.
- The C3 follow-up (`749bd6a`) added `PreToolUse` hooks so the snapshot path policy and read accounting run on every built-in tool call, not only on calls that reach the permission prompt.

## Environment facts

- Node 22.22, npm 10.9.4 (root project), pnpm 10.28 (service), git available, Docker CLI present but **no daemon** (image builds cannot be verified here; record that honestly).
- Outbound HTTPS goes through a proxy; npm registry reachable.
