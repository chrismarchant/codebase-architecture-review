# C2 — Repository authorization, immutable retrieval, exporter safety, inventory (Sonnet 5.5)

Spec: SS00 §3.2 stages 1–3, §5.2, §5.3 (filesystem containment, size bounds), §8.1 inventory; ADR-010.

## Owns

- `service/packages/core/src/retrieval/`: `url-policy.ts` (parse + allow-list + SSRF guard), `providers/github.ts`, `providers/generic-git.ts`, `resolver.ts` (ref → SHA), `exporter.ts` (fetch one commit, `git archive`, safe extraction), `index.ts`
- `service/packages/core/src/inventory/`: `builder.ts` (walk snapshot → `Inventory`), `language.ts` (extension → language map), `index.ts`
- `service/packages/core/test/retrieval/**`, `test/inventory/**`
- `service/fixtures/repos/hostile-fs/` — a **builder script** (`build.ts`, invoked from tests) that creates a temporary Git repository containing: a symlink pointing outside the tree, a symlink loop, a file named with a leading dot, a `.git/hooks`-style directory committed as `hooks/`, a 2 MiB file, a `.gitattributes` with a `filter=` entry, a nested `.gitmodules`, a Git LFS pointer file, and a normal `src/` tree. Commit it with a deterministic author/date.

## Requirements

1. **URL policy** `parseRepositoryUrl(url, allowlist)`: accepts only `https://`; host must be in `RETRIEVAL_HOST_ALLOWLIST` (comma-separated, exact or `*.suffix`); rejects userinfo, ports other than 443, IP literals, `localhost`, `.local`, `.internal`; path must match `/{owner}/{repo}(.git)?` for GitHub. Additionally `assertPublicAddress(host)` resolves the host with `dns.promises.lookup({ all: true })` and rejects any loopback, link-local, private (RFC1918), unique-local, CGNAT, multicast or unspecified address, for v4 and v6, including v4-mapped v6. Both are pure/injectable (`lookup` is a parameter) so tests do not hit the network.
2. **GitHub provider** (`fetch` injected): `GET /repos/{owner}/{repo}` and `GET /repos/{owner}/{repo}/commits/{ref}` with `Authorization: Bearer <token>` when a token is given; maps 401/403/404 to `AuthorizationError`, 5xx/network to retryable `RetrievalError`. Returns `{ sha, defaultBranch, isPrivate }`. The resolved SHA MUST equal `request.sha` when that is provided, else `ShaMismatch`.
3. **Generic provider**: `git ls-remote <url> <ref>` with `spawn` (never a shell string), environment restricted to `PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, credential via `GIT_ASKPASS` helper script written to a 0600 temp file, removed afterwards.
4. **Exporter** `exportCommit({ url, sha, token?, destDir, budgets, timeoutMs })`:
   - `git -c core.hooksPath=/dev/null -c core.symlinks=false -c core.fsmonitor=false -c protocol.allow=never -c protocol.https.allow=always -c transfer.fsckObjects=true clone --bare --filter=blob:none --no-tags --depth 1 --revision <sha>` is **not** portable across git versions; implement as: `git init --bare`, `git fetch --filter=blob:none --no-tags --depth 1 <url> <sha>` (fall back to a full fetch of the sha without `--filter` if the server refuses), then `git archive --format=tar <sha>` piped into a **streaming tar reader** (`tar` package `Parser`) that materialises entries into `destDir` with these rules: regular files only; skip symlinks, hardlinks, devices, FIFOs (record as excluded with reason); reject entries whose normalised path escapes `destDir` or contains `..` or is absolute; skip files over `maxFileBytes`; stop adding files once `maxFiles` or `maxBytes` is reached (record `over_*` exclusions); never extract `.git` directories (a committed directory literally named `.git` is skipped); `.gitmodules` recorded as `submodule` exclusion for each listed path; files whose first line is `version https://git-lfs.github.com/spec/v1` recorded as `lfs_pointer`. Files are written with mode 0644, directories 0755; after extraction run `chmod -R a-w destDir`.
   - Credentials: pass via `-c http.extraheader=Authorization: Bearer <token>` **through a temp config file referenced by `GIT_CONFIG_GLOBAL`** (0600), not on the command line; delete the file in `finally`. Child env contains only `PATH`, `HOME` (temp), `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`, `LC_ALL=C`.
   - Timeout kills the process group. Return `{ sha, snapshotSha256, fileCount, bytes, excluded[] }` where `snapshotSha256` is a hash over the sorted list of `path\0sha256\n` lines.
5. **Inventory builder** `buildInventory(snapshotDir, excludedFromExport)`: walks with `fs.opendir` (no symlink following), computes per-file sha256 and line count for text files (≤ `maxFileBytes`), detects binary by NUL in first 8 KiB, maps languages by extension, applies default exclude globs (`node_modules/**`, `vendor/**`, `dist/**`, `build/**`, `.git/**`, `*.min.js`, lockfiles are **included** but flagged `language: 'lockfile'`). Produces `Inventory` validated by the contract schema.

## Tests (minimum)

- `url-policy.test.ts`: table of accepted/rejected URLs; SSRF guard with injected lookup returning 10.0.0.1, 127.0.0.1, 169.254.169.254, fe80::1, ::ffff:10.0.0.1, 100.64.0.1 → rejected; public address → accepted.
- `github.test.ts`: injected fetch; token header present only when token given; 404 → AuthorizationError; sha mismatch.
- `exporter.test.ts`: builds the hostile fixture repo locally (file:// URL is allowed **only in tests** through an explicit `allowFileUrlForTests` option that the exporter refuses unless `NODE_ENV==='test'`); asserts: no symlinks in `destDir`, loop symlink skipped, no file outside `destDir`, 2 MiB file excluded with `over_file_byte_cap` when `maxFileBytes=1 MiB`, LFS pointer recorded, `hooks/` content present as plain files but nothing executed (assert a canary file the hook would create does not exist), `destDir` read-only, snapshot hash deterministic across two exports.
- `inventory.test.ts`: totals, language map, binary detection, excluded globs.

## Acceptance

SS00 §13 A3, A5, A6, and the "no execution" half of A4 for retrieval.
