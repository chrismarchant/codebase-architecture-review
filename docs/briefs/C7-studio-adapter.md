# C7 — Security Studio compatibility adapter (Sonnet 5.5) — Stage E

Spec: SS00 §12; ADR-012. Depends on C4 (architecture/evidence/coverage builders) and C5 (route plumbing).

## Owns

- `service/packages/core/src/studio/`: `export.ts` (`buildStudioExport`), `revision.ts` (`checkRevisionMatch`), `fixtures.ts` (loader for the fixture inputs), `index.ts`
- `service/packages/core/test/studio/**`
- `service/fixtures/studio/`: `studio-request.sample.json` (a stand-in for what a Studio caller would send: `{ capability, repository: { url, commitSha }, expectedSchemaVersions }`), `studio-findings.sample.json` (a stand-in findings list with file paths, used to exercise `findingsMapping`)
- `service/apps/api/src/routes/studio.ts` (one file; register it from the existing route index with a one-line import — coordinate by appending only)

## Requirements

1. `buildStudioExport({ scan, manifest, architecture, evidence, coverage }) → StudioExport`: projection per the contract; `artifactHashes` from the manifest; `evidenceSummary.unsupportedComponents` = components with zero `observed` evidence; `findingsMapping.byPath` built from component `paths` (longest-prefix first, deduplicated).
2. `checkRevisionMatch(exp, { commitSha | null }) → RevisionMatch`.
3. `mapFindingsToComponents(exp, findings: Array<{ file: string }>) → Array<{ file, componentIds }>` using `findingsMapping` (longest prefix wins; empty when none).
4. Route `GET /v1/scans/:id/studio-export` (ownership check reused from C5; 409 `not_published` when the scan is not succeeded); optional query `?studioSha=<sha>` adds `revisionMatch` to the response envelope `{ export, revisionMatch }`.
5. Nothing here contacts any external system. Do not add configuration variables.

## Tests

- `export.test.ts`: schema validity; hashes equal manifest; unsupported count; mapping longest prefix; fixture findings mapped (A18).
- `revision.test.ts`: match, mismatch (message contains both SHAs), unknown.
- `route.test.ts` in `apps/api/test/`: 404 for foreign principal, 409 unpublished, 200 with `revisionMatch` when `studioSha` given.

## Acceptance

SS00 §13 A18.
