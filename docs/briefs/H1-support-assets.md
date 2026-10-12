# H1 — Support assets: OpenAPI document, environment template, sample fixture repository, vendored viewer libraries (Haiku 5.5)

Routine support work. No security, authorization, job-semantics or architectural decisions: where the spec is silent, copy what the spec or an existing file already does and note the gap in the handover.

## Owns

- `service/packages/contracts/openapi.json`
- `docs/ENV-TEMPLATE.md`
- `service/fixtures/repos/sample-app/` (plain files, no `.git`)
- `service/apps/api/static/vendor/` (`dagre.min.js`, `marked.umd.js`, `purify.min.js`, `LICENSES.md`)
- `service/README.md` (short orientation only)

## Deliverables

1. **OpenAPI 3.1** `openapi.json` describing every route in SS00 §6 with request/response schemas referencing the generated JSON Schemas by relative `$ref` (`./schemas/<name>.schema.json#`), the `Idempotency-Key` header on `POST /v1/scans`, `Idempotency-Replayed` response header, bearer and cookie security schemes, 401/404/409/422/429 error responses using `error.schema.json`, SSE content type for `/v1/scans/{id}/events`, and `application/octet-stream` for artifact downloads. Validate it parses as JSON and that every `$ref` target file exists (write a tiny node script in a temp dir to check; do not add dependencies).
2. **`docs/ENV-TEMPLATE.md`**: one table per service (API, runner, both) listing every variable from `service/packages/core/src/config.ts` with: name, required/optional, default, description, which stage uses it, and whether it is a secret. Then a `.env.example` block for each service. Mark the Railway-provided bucket variables (`BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`) and how they map to `S3_*`.
3. **Sample fixture repository** at `service/fixtures/repos/sample-app/`: a small but realistic TypeScript web service (about 25–40 files, under 200 KiB total): `package.json`, `src/server/{index.ts,routes/*.ts,middleware/*.ts}`, `src/services/*.ts`, `src/db/{client.ts,migrations/*.sql}`, `src/workers/queue.ts`, `src/integrations/{stripe.ts,mail.ts}`, `README.md`, a `Dockerfile`, a `.github/workflows/ci.yml`, a `tests/` folder, and a `docs/` folder. The code must be plausible and internally consistent (imports resolve to files that exist) but it is never executed. Include at least one clear HTTP entry point, one queue consumer, one external integration and one database access layer so that evidence-backed perspectives (`overall-architecture`, `request-lifecycle`, `data-flow`, `external-integrations`) are possible.
4. **Vendored libraries**: copy `service/apps/api/node_modules/dagre/dist/dagre.min.js`, `service/apps/api/node_modules/marked/lib/marked.umd.js`, `service/apps/api/node_modules/dompurify/dist/purify.min.js` into `service/apps/api/static/vendor/`, and write `LICENSES.md` with each library's name, version (from its `package.json`), license identifier and the full license text copied from the package.
5. **`service/README.md`**: 40 lines maximum: what the service is, the directory layout, the commands (`pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm dev:api`, `pnpm dev:runner`), and pointers to the docs.

## Handover

Use the standard format from `docs/briefs/README.md`. List any variable in `config.ts` whose purpose you could not determine from SS00 so the coordinator can fill it in.
