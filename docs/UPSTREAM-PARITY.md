# Upstream Parity

This document records how the public upstream project was imported, what it provides, what this repository changes, and how parity is verified. The factual inventory that backs it is `docs/UPSTREAM-INVENTORY.md`.

## 1. Baseline

| Item | Value |
| --- | --- |
| Upstream | `https://github.com/oh-my-mermaid/oh-my-mermaid` |
| Upstream commit | `38ccdb69298adec949177c92c88d6e3ddfb5bab7` (`fix: use cross-platform command for binary detection on Windows (#22)`) |
| Upstream version | `0.2.0` (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) |
| Import method | `git remote add upstream …; git fetch upstream main; git reset --hard upstream/main` on an empty branch; full history (17 commits) preserved |
| Baseline marker | tag `upstream-baseline` on that commit; the first non-upstream commit on `claude/eloquent-einstein-ncos6k` is the Stage A documentation commit |
| Re-sync | `git fetch upstream main && git merge upstream/main` |
| Diff of upstream files | `git diff upstream-baseline -- . ':!service' ':!docs' ':!.railway'` |

## 2. License notices

Upstream is MIT licensed: `LICENSE`, "Copyright (c) 2025 oh-my-mermaid". The file is kept verbatim at the repository root and is included in the npm `files` list. The service code under `service/` is a derivative work that carries the same MIT notice in `service/LICENSE` with an additional copyright line for the service authors; it must not be relicensed without keeping the upstream notice. The three JavaScript libraries vendored for the hosted viewer carry their own licenses in `service/apps/api/static/vendor/LICENSES.md`: dagre (MIT), marked (MIT), DOMPurify (Apache-2.0 OR MPL-2.0).

## 3. Upstream build and test results (baseline, this environment)

| Command | Result |
| --- | --- |
| `npm ci` | ok (Node v22.22.0, npm 10.9.4) |
| `npm run build` | ok: `dist/cli.js`, `dist/index.js`, `.d.ts`, source maps, `dist/viewer.html` |
| `npm test` | 8 files, 37 tests passed (vitest 4.1.0) |
| `node scripts/check-version-sync.js` | ok (0.2.0 in all three manifests) |

No upstream failures were observed. The following upstream behaviours are documented, not fixed, because they are upstream's to decide (recorded from the inventory): `omm login` help text says "omm.dev" while the code targets `ohmymermaid.com`; `omm org members` prints a URL rather than opening a browser; `omm config` is absent from `omm help`; `commandClassField` is imported but never dispatched; `PLAN.md` describes an `omm serve` command and mermaid.js usage that the shipped code does not have; `omm diff` (lightweight `parseMermaid`) records the label token instead of the target node id for edges written as `a -->|"label"| b[...]` (observed by `service/test/parity/cli.test.ts`).

## 4. Public repository functionality versus externally hosted functionality

| Capability | Where it lives | Available after cloning? |
| --- | --- | --- |
| `omm` CLI (local commands: init, setup, update, list, tree, read, write, show, delete, status, diff, refs, validate, view, config, help, version, legacy `<path> <field>` alias) | repository | yes |
| Skills `/omm-scan`, `/omm-push`, `/omm-view` | repository (`skills/`) | yes; `/omm-scan` needs an AI coding tool and a globally installed `omm` |
| Local viewer (`omm view`) | repository (`src/server/`, `viewer.html`) | yes; loads `dagre`, `marked` and Google Fonts from the public internet at page load |
| `.omm` file format, validator, differ, refs | repository | yes |
| Platform registration (`omm setup` for Claude Code, Codex, Cursor, OpenClaw, Antigravity) | repository | yes, shells out to the respective tools |
| Cloud: `omm login`, `link`, `push`, `pull`, `share`, `org` | client code in repository; **server at `https://ohmymermaid.com` is not in the repository** | client code yes; the hosted backend no. Cloning does not clone the backend. This service neither re-implements nor depends on it. |
| npm release pipeline | `.github/workflows/release.yml` | present; needs `NPM_TOKEN` and the upstream npm package ownership |

## 5. Parity matrix

"Preserved" means the upstream behaviour is unchanged and exercised by a test in this repository. "Hooked" means a small upstream edit that keeps the default behaviour identical and adds an opt-in for the service. "Reused" means the service consumes the upstream code as a dependency.

| Area | Upstream item | Status in this repo | Verification |
| --- | --- | --- | --- |
| CLI | every command in `src/cli.ts` | Preserved | root `npm test`; `service/test/parity/cli.test.ts` runs `node dist/cli.js help`, `write`, `read`, `tree`, `validate`, `diff` on a temp project |
| CLI | `--version` | Preserved | parity test |
| Skills | `skills/omm-scan/SKILL.md` text | Preserved (file unchanged); Reused by the service prompt bundle with `omm write` → `omm_write` rewrite | `prompt-bundle.test.ts` asserts the rewrite leaves the catalogue and diagram rules byte-identical |
| Skills | `omm-push`, `omm-view` | Preserved | file hash check in parity test |
| Plugin manifests | `.claude-plugin/*.json` | Preserved | `check-version-sync` in CI |
| Viewer | parser, layout, navigation, SSE live reload, theme, postMessage | Preserved for `omm view`; Hooked for hosting (ADR-003) | `viewer-hooks.test.ts`; `omm view` smoke test |
| Viewer | CDN scripts and Google Fonts | Preserved in `omm view` (same URLs); the hosted copy rewrites them to vendored files at serve time | `viewer.test.ts` asserts no `cdn.jsdelivr.net`/`fonts.googleapis.com` in served HTML |
| Viewer API | `/api/classes`, `/api/class/:name`, `/refs`, `/nodes`, `/node/:path+`, `/diff`, `/events` | Preserved locally; re-implemented read-only behind `/v1/scans/:id/viewer-api/` over the published tree | `viewer-api.test.ts` compares responses against upstream `handleApi` on the same tree |
| Format | `.omm` layout, 7 fields, `meta.yaml`, `config.yaml`, `prev_diagram` | Preserved; service writes through upstream `writeNodeField` | `omm-tree.test.ts` round-trips a published bundle through upstream `listNodes/showNode` and `omm validate` |
| Validation | `validateDiagram` rules and palette | Preserved; Reused in the validate stage | `validate-stage.test.ts` |
| Diff | `diffMermaid`, `formatDiff` | Preserved; Reused in comparisons | `comparison.test.ts` |
| Config | `OMM_API_URL` | Preserved (unused by the service) | — |
| Cloud commands | login/link/push/pull/share/org | Preserved as code; not used by the service | parity test asserts the commands still exist in `omm help` |
| Tests | `src/__tests__/*` (37 tests) | Preserved | root `npm test` |
| Build | tsup config, `dist/` outputs | Preserved | root `npm run build` |
| CI | `check-version-sync.yml`, `release.yml` | Preserved; a new workflow `service-ci.yml` runs the service suite separately | — |
| READMEs | 5 languages | Preserved; a short "Hosted service" pointer section appended to `README.md` and mirrored in the translations per `CLAUDE.md` rules | — |

## 6. Upstream files changed in this repository

Kept to the minimum needed for hosting. Each is listed with the reason and the exact nature of the change. This table is maintained as changes land; the parity test fails if a file outside this list differs from `upstream-baseline`.

| File | Change | Reason |
| --- | --- | --- |
| `src/server/viewer.html` | (Stage B) add `window.__ommApiBase` prefix to the two fetch call sites, add `window.__ommSanitizeHtml` hook around `marked.parse`, replace inline `on*=` attributes with `addEventListener` in the existing module script | hosting under a per-scan prefix, sanitized Markdown, CSP without inline handlers (ADR-003) |
| `src/index.ts` | (Stage B, only if required) export additional store helpers already present in `src/lib/store.ts` | service consumes upstream through the public API (ADR-002) |
| `README*.md` | (Stage F) one short section pointing at `service/README.md` | discoverability; translations updated in the same commit per `CLAUDE.md` |
| `.gitignore` | (Stage B) add `service/**/node_modules`, `service/**/dist`, `.railway/node_modules` | monorepo hygiene |

No other upstream file is modified. The upstream `package.json`, lockfile, `tsconfig.json`, `tsup.config.ts`, skills, plugin manifests, tests and workflows are byte-identical to the baseline.

## 7. How to confirm parity locally

```bash
# upstream unchanged except the listed files
git diff --stat upstream-baseline -- . ':!service' ':!docs' ':!.railway' ':!.github/workflows/service-ci.yml'

# upstream build and tests
npm ci && npm run build && npm test

# service parity suite (Stage C onward)
cd service && npm ci && npm run test:parity
```
