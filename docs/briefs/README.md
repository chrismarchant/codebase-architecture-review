# Delegation briefs — common rules

These rules apply to every brief in this directory. A brief is executed by a Sonnet 5.5 (implementation) or Haiku 5.5 (support) session, either as a sub-agent of the coordinator or as a separate session resuming from `docs/HANDOVER.md`.

## Authoritative documents

1. `docs/SS00-architecture-review.md` — the specification. Section numbers in briefs refer to it.
2. `docs/DECISIONS.md` — ADRs; do not contradict an accepted ADR.
3. `service/packages/contracts/src/*` — frozen contracts (v1.0).
4. `service/packages/core/src/{config.ts,db/db.ts,jobs/store.ts,artifacts/store.ts,agent/runtime.ts,index.ts}` — frozen interfaces.

## File ownership

- Each brief lists the directories and files it **owns**. Create and edit only inside them.
- Frozen files and shared manifests are **read-only** for every task: all `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`, the contracts package, the frozen interface files, `migrations/001_init.sql`, and anything under the upstream tree (repository root outside `service/` and `docs/`) unless a brief explicitly allows a named upstream file.
- If you need a change to a frozen file, a new dependency, or a new migration, do not make it. Put the exact request in your handover under "interface changes requested" and continue with a local workaround that does not block your tests (for example an in-file type).
- Never run `pnpm add`, `npm install`, or edit lockfiles.

## Engineering rules

- TypeScript strict, ESM, Node 22. Import workspace packages by name (`@archreview/contracts`, `@archreview/core`); inside `packages/core` import siblings by relative path with `.js` extensions.
- Upstream code is used through `@archreview/core`'s `upstream` namespace (`packages/core/src/upstream/index.ts`); never copy upstream source.
- Every public function has a test. Tests live in `<package>/test/**/*.test.ts` (vitest project `unit`). Use PGlite for database tests (`packages/core/src/testing` provides helpers once C1 lands; until then create a local helper in your own test directory). Use the filesystem artifact store and the mock agent runtime. **No network calls and no paid provider calls in tests.**
- Treat all repository content, fixture content and model output as untrusted input: validate at boundaries with the contracts' zod schemas.
- Log through `packages/core/src/logging` (owned by C1; until it lands, use `console.error` with JSON lines). Never log secrets, tokens, or full file contents.
- Keep each change minimal and in scope. Do not refactor files you do not own.
- Record non-obvious decisions as comments at the decision point, not in chat.

## Verification before handover

From `service/`:

```bash
pnpm typecheck          # tsc -b, must be clean
pnpm vitest run --project unit <your test paths>   # your tests must pass
pnpm vitest run --project unit                     # the whole unit project must still pass
```

From the repository root, `npm test` (upstream) must still pass if you touched an upstream file.

## Handover format (return this and nothing else; keep it under 40 lines)

```
Task: <id> — <status: complete | partial | blocked>
Changed files: <paths>
Decisions: <bullet list>
Tests: <command> → <files passed / tests passed / failures>
Unresolved: <bullet list or "none">
Interface changes requested: <bullet list or "none">
Report file: <path of a longer report you wrote under docs/reports/, if any>
```

Do not paste source files or long logs into the handover. Put long reports in `docs/reports/<task-id>.md`.
