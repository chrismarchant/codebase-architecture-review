# Architecture Review service

An authenticated, on-demand service. It takes a Git repository, runs an analysis agent over an
immutable snapshot and publishes the review (`.omm` tree, `architecture.json`, `evidence.json`,
`review.md`, manifest). It uses the upstream oh-my-mermaid build output via `packages/core/src/upstream`
(ADR-002) and copies no upstream source.

## Layout

- `apps/api`: HTTP API, web UI, wake calls and the bounded reconciler
- `apps/runner`: claims jobs, retrieves snapshots, runs the agent, validates and publishes
- `packages/contracts`: zod contracts (v1.0, frozen), generated `schemas/` and `openapi.json`
- `packages/core`: config, database, job store, artifact store, agent runtime, upstream shim
- `fixtures/repos/sample-app`: plain-file sample repository for tests (never executed)

## Commands

Run from `service/`. The workspace uses pnpm, not npm (ADR-015).

```bash
pnpm install       # install workspace dependencies
pnpm typecheck     # tsc -b across packages and apps
pnpm test          # vitest: unit, parity and live projects (live skipped unless ANALYSIS_LIVE=1)
pnpm dev:api       # run the API with tsx
pnpm dev:runner    # run the runner with tsx
pnpm schemas       # regenerate packages/contracts/schemas from the zod contracts
```

## Configuration

Variables are parsed in `packages/core/src/config.ts` and documented, with `.env.example` blocks,
in `docs/ENV-TEMPLATE.md`. Never commit a `.env` file or a real secret.

## Documentation

- `../docs/SS00-architecture-review.md`: specification (HTTP contract in section 6, Railway behaviour in section 10)
- `../docs/DECISIONS.md`: architecture decision records
- `../docs/ENV-TEMPLATE.md`: environment variables
- `packages/contracts/openapi.json`: HTTP API description (OpenAPI 3.1)
- `apps/api/static/vendor/LICENSES.md`: licenses for the vendored browser libraries
