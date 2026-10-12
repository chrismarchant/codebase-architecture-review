# oh-my-mermaid upstream inventory

Factual record of what the upstream oh-my-mermaid code does. No judgements are made.

- Snapshot: git tag `upstream-baseline`, commit `38ccdb69298adec949177c92c88d6e3ddfb5bab7`, package `oh-my-mermaid` v0.2.0.
- Paths are relative to the repository root. `path:line` cites the source.
- Commands run for this document (all read-only except the build, which regenerates the gitignored `dist/`): `npm test`, `npm run build`, `node dist/cli.js --version`, `node dist/cli.js help`, `node dist/cli.js config`, `node dist/cli.js share`, `node dist/cli.js bogus-cmd`.

Effect codes used in section 1:

| Code | Meaning |
| --- | --- |
| FS | Reads or writes the local filesystem |
| CLOUD | HTTP request to the ohmymermaid API (`src/lib/cloud.ts`) |
| BROWSER | Launches a browser with a URL |
| NET-LOCAL | Starts an HTTP server on localhost |
| NPM / GIT / CLAUDE-CLI | Runs `npm`, `git`, or the external `claude` CLI |

---

## 1. CLI commands

Entry point `src/cli.ts`. Dispatch is in `main()` (`src/cli.ts:67-227`). Global command names are listed at `src/cli.ts:26`.

| Command | Arguments / flags | Behaviour | Effects | Source |
| --- | --- | --- | --- | --- |
| `omm init` | none | Creates `.omm/` and `config.yaml` (`version: 0.1.0`) if missing. Otherwise prints "already initialized". | FS | `src/commands/init.ts:3-12`, `src/lib/store.ts:46-56` |
| `omm setup` | `[platform]`, `--list`, `--teardown` | No argument: for each detected platform, runs setup, or teardown with `--teardown`. With an id: same, for that platform only, and errors if it is not detected. `--list`: prints detection and setup status. | FS, CLAUDE-CLI (claude platform), local `which` | `src/commands/setup.ts:3-69` |
| `omm update` | none | Runs `npm update -g oh-my-mermaid`, then runs `omm setup` through `execFileSync`, found on PATH. | NPM | `src/commands/update.ts:3-23` |
| `omm list` | none | Prints top-level perspective names (directories in `.omm/` not starting with `.`), sorted. | FS | `src/commands/list.ts`, `src/lib/store.ts:76-83` |
| `omm tree [path]` | optional `perspective[/child...]` | Prints an indented element tree. No argument: all perspectives. | FS | `src/commands/tree.ts` |
| `omm read <path> <field>` | path, field | Writes the field file content to stdout. A missing field prints nothing and exits 0. Missing arguments exit 1. | FS | `src/commands/read-write.ts:23-42` |
| `omm write <path> <field> <text or ->` | path, field; text words joined with a space, or `-` to read stdin | Writes the field and creates the element directory. Top-level writes update `meta.yaml` (git commit and branch). Writing `diagram` saves the previous text to `prev_diagram`. | FS, GIT (top-level writes only: `git rev-parse --short HEAD`, `git branch --show-current`) | `src/commands/read-write.ts:44-79`, `src/lib/store.ts:126-183, 251-274`, `src/lib/meta.ts:9-46` |
| `omm show <path>` | path | Prints each non-empty field under a `--- field: NAME ---` header, then `meta` as YAML. | FS | `src/commands/show.ts:4-21` |
| `omm delete <path>` | path | Recursively removes the element directory, children included. Does not update the parent's `children` list. | FS | `src/commands/delete.ts`, `src/lib/store.ts:236-241` |
| `omm status` | none | For each perspective, prints `updated` and `update_count` from `meta.yaml`. | FS | `src/commands/status.ts` |
| `omm diff <class>` | element path | Compares `prev_diagram` (in `meta.yaml`) with `diagram.mmd`. Prints added and removed nodes and edges. | FS | `src/commands/diff.ts`, `src/lib/diff.ts` |
| `omm refs [--reverse] <class>` | element; `--reverse` flag | Default: lists elements whose diagrams reference this one. `--reverse`: lists the `@refs` this element's diagram contains. | FS | `src/commands/refs.ts` |
| `omm validate [path]` | optional element | Runs the validation rules (section 6) on one element or all. Exit 1 if any error. | FS | `src/commands/validate.ts:29-52` |
| `omm view [--port N]` | `--port <n>` only when it is the 2nd and 3rd arguments | Starts the localhost viewer on port 3000 by default. On EADDRINUSE it tries the next port. Starts a watcher on `.omm/`. | NET-LOCAL, FS (watch) | `src/commands/view.ts`, `src/server/index.ts:26-73` |
| `omm login` | none | Starts a loopback HTTP server on a random port, with a 60 s timeout. Opens `<api>/auth/cli?callback=http://localhost:<port>/callback` with shell `open`. Stores the returned token and handle. | BROWSER, NET-LOCAL, FS (credentials) | `src/commands/login.ts:20-86` |
| `omm logout` | none | Deletes the `token` key from the credentials file. Keeps `handle` and `default_org`. | FS | `src/commands/logout.ts`, `src/lib/cloud.ts:80-84` |
| `omm link [org/slug]` | `org/slug`, `slug`, or none | Requires a token. With `org/slug`: no network call. Otherwise: `GET /api/cli/orgs`, then picks the only org or prompts on stdin. Default project slug is the cwd basename. Writes `cloud.project_slug` and `cloud.org_slug` to `config.yaml`. | CLOUD (org list only), FS | `src/commands/link.ts:75-119` |
| `omm push` | none | Requires a token and a linked slug. `POST /api/push` with every file under `.omm/` (recursive), `git_commit` (short SHA), and `org_slug`. | CLOUD, GIT, FS (read) | `src/commands/push.ts:34-83` |
| `omm pull` | none | Requires a token and a linked slug. `GET /api/pull?slug=...&org_slug=...`. Writes returned files into `.omm/` after a path check. Does not delete local files. | CLOUD, FS | `src/commands/pull.ts:8-58`, `src/lib/cloud-paths.ts` |
| `omm share` | none | Prints `<api>/p/<org>/<slug>` (or `<api>/p/<slug>`) and a note about the dashboard Share button. No network call. No login check. | FS (read) | `src/commands/share.ts:7-34` |
| `omm org list` | `list` | Requires a token. `GET /api/cli/orgs`. Prints orgs (`*` marks the default). Saves `handle` if returned. | CLOUD, FS | `src/commands/org.ts:26-58` |
| `omm org switch <slug>` | `switch <slug>` | Requires a token. Checks the slug against `GET /api/cli/orgs`. If that response is not OK, saves the default anyway. Writes `default_org`. | CLOUD, FS | `src/commands/org.ts:60-82` |
| `omm org members [slug]` | `members [slug]` | Requires a token. Prints the settings URL to stderr. No network call. | FS (read) | `src/commands/org.ts:84-94` |
| `omm config [key [value]]` | none, one key, or key and value | No arguments: prints config as YAML. One key: prints its value, or the default (`language` defaults to `English`). Two arguments: writes the key as a string to `config.yaml`. | FS | `src/commands/config.ts:30-60` |
| `omm help`, `-h`, `--help`, or no arguments | none | Prints usage text. | none | `src/cli.ts:28-65, 70-73` |
| `omm --version`, `-v`, `version` | none | Prints `omm <version>` from `package.json`. | none | `src/cli.ts:75-81` |
| Legacy `omm <path> <field> [content]` | 2 or more arguments, first argument not a global command | 3 or more arguments: write (content joined with spaces, or `-` for stdin). Exactly 2: read. | FS | `src/cli.ts:206-217` |
| Anything else | | Prints "unknown command" and exits 1. | none | `src/cli.ts:219-220` |

Notes:
- `omm config` is dispatched (`src/cli.ts:106`) and listed in `GLOBAL_COMMANDS` (`src/cli.ts:26`), but is absent from the help text (`src/cli.ts:29-63`).
- `commandClassField` (`src/commands/class-field.ts`) is imported at `src/cli.ts:4` but never dispatched.
- Help text says `omm login` logs in to "omm.dev" (`src/cli.ts:51`). The default API URL is `https://ohmymermaid.com` (`src/lib/cloud.ts:7`).
- Help text says `omm org members` "opens web" (`src/cli.ts:59`). The code only prints the URL (`src/commands/org.ts:93`).
- `omm view 4000` (no `--port`) is ignored: the port stays 3000 (`src/cli.ts:166-173`).
- Read commands, `list`, `status`, and `diff` return exit 0 when `.omm/` is missing. They print a message only (`src/lib/store.ts:32-38`).
- Commands that need a token exit 1 with "not logged in" (`src/commands/push.ts:37-41`, `pull.ts:11-15`, `link.ts:78-82`, `org.ts:4-8`).

---

## 2. Coding-agent skills

Skills are in `skills/<name>/SKILL.md`. Trigger phrases are taken from each `description` frontmatter field.

| Skill | Trigger phrases | What the agent is instructed to run | External dependencies |
| --- | --- | --- | --- |
| `omm-scan` (`skills/omm-scan/SKILL.md`) | "omm scan", "scan architecture", "update architecture", "refresh diagrams" | `command -v omm`, or else `npm install -g oh-my-mermaid`. `omm config language`. Glob and Read for analysis. Then `omm write <perspective> diagram -` and `omm write <path> <field> -` for description, context, constraint, concern, todo, and note (one Bash call each). Does not call `omm list`. | `omm` on PATH (global npm install). No login. No network from `omm` itself. |
| `omm-push` (`skills/omm-push/SKILL.md`) | "omm push", "push to cloud", "deploy architecture", "share architecture" | `command -v omm`, or else npm install. Step 1: `omm share`, and on a "not logged in" error, `omm login`. Step 2: `omm share`, and on a "no project slug" error, `omm link`. Step 3: `omm push`. Maps 401, 403 (free plan limit), and network errors to messages. | `omm` CLI. Cloud account and login (GitHub OAuth per skill text). Network to ohmymermaid.com. |
| `omm-view` (`skills/omm-view/SKILL.md`) | "omm view", "open viewer", "show diagrams", "view architecture", "open architecture" | `command -v omm`, or else npm install. `omm list` (stop if empty). `omm view` or `omm view --port <port>`. Reports `http://localhost:3000`. | `omm` CLI. No login. The browser then loads CDN assets (section 4). |

Notes:
- The `omm-push` Step 1 check expects `omm share` to fail with "not logged in". `commandShare` never reads the token (`src/commands/share.ts:7-34`), so that branch is not reached through `omm share`.
- `omm-push` step 4 prints the view URL as `https://ohmymermaid.com/p/{slug}` (no org segment). The CLI prints the URL it receives from the server, or `<api>/dashboard` (`src/commands/push.ts:82-83`).
- `skills/` is located at runtime by `getSkillsSource()` (`src/lib/platforms/utils.ts:45-59`) for platform installs.

---

## 3. Platform integrations

Registry: `src/lib/platforms/index.ts:10`. `ALL_PLATFORMS = [claude, codex, cursor, openclaw, antigravity]`. Interface: `src/lib/platforms/types.ts`. Shared helpers: `src/lib/platforms/utils.ts`.

`hasCommand(bin)` runs `which <bin>` (or `where` on win32) (`utils.ts:86-94`).

| Platform (id) | Detection | `isSetup()` check | `omm setup` does | `omm setup --teardown` removes |
| --- | --- | --- | --- | --- |
| Claude Code (`claude`) | `which claude` (`claude.ts:36-38`) | `claude plugin list` output has an `oh-my-mermaid` entry with a `Version:` equal to the package version (`claude.ts:15-46`) | Uninstalls an existing plugin if present (`claude.ts:55`). Runs `claude plugin marketplace add oh-my-mermaid/oh-my-mermaid` (`:59`), then `claude plugin install oh-my-mermaid` (`:61`). Writes no files itself. | Runs `claude plugin uninstall oh-my-mermaid` and `claude plugin marketplace remove oh-my-mermaid` (`:72-73`). |
| Codex (`codex`) | `which codex` | `~/.agents/skills/oh-my-mermaid` exists (`codex.ts:17-19`) | Creates a directory symlink `~/.agents/skills/oh-my-mermaid` to the package `skills/` directory. Removes any existing target first (`codex.ts:28-34`). | Deletes `~/.agents/skills/oh-my-mermaid` (`codex.ts:37-41`). |
| Cursor (`cursor`) | `which cursor`, or `./.cursor/` exists in the cwd (`cursor.ts:43-48`) | `./.cursor-plugin/plugin.json` has `version` equal to the package version (`cursor.ts:13-56`) | Copies the package `skills/` into `./.cursor-plugin/skills/` (copies, not a symlink). Copies `agents/` if found (none in this repo). Writes `./.cursor-plugin/plugin.json` with name, displayName, description, version, author, homepage, license, and skills keys (`cursor.ts:58-102`). | Deletes `./.cursor-plugin/` in the cwd (`cursor.ts:104-109`). |
| OpenClaw (`openclaw`) | `which openclaw` | `~/.openclaw/skills/oh-my-mermaid` exists | Symlink `~/.openclaw/skills/oh-my-mermaid` to the package `skills/` directory (`openclaw.ts:28-34`). | Deletes `~/.openclaw/skills/oh-my-mermaid`. |
| Antigravity (`antigravity`) | `which antigravity` | `~/.gemini/antigravity/skills/oh-my-mermaid` exists | Symlink `~/.gemini/antigravity/skills/oh-my-mermaid` to the package `skills/` directory (`antigravity.ts:28-34`). | Deletes that path. |

Notes:
- `omm setup <id>` errors if the platform is not detected (`src/commands/setup.ts:27-30`). `omm setup` with no argument only touches detected platforms (`setup.ts:46-66`).
- `getAgentsSource()` looks for `agents/` (`utils.ts:34-42`). No `agents/` directory exists in this repository, so the cursor manifest has no `agents` key.
- `.cursor-plugin/` is listed in `.gitignore`.
- Symlink sources resolve to the installed package's `skills/` directory, via `getSkillsSource()`.

---

## 4. Viewer behaviour

Server: `src/server/index.ts`. API handler: `src/server/api.ts`. Watcher and SSE: `src/server/watcher.ts`. Page: `src/server/viewer.html` (copied to `dist/viewer.html` by the tsup `onSuccess` hook, `tsup.config.ts:13`).

### 4a. HTTP routes

No route checks `req.method`. Every route answers the same way for any method. Requests are routed on the raw `url.pathname`, with no percent-decoding.

| Route | Response | CORS `Access-Control-Allow-Origin: *` | Source |
| --- | --- | --- | --- |
| `GET /` and `GET /index.html` | `200 text/html`: `viewer.html` with `<script>window.__projectName="<cwd basename>";</script>` inserted before `</head>` | No | `src/server/index.ts:47-53` |
| `GET /events` | SSE stream (see 4b) | Yes | `src/server/index.ts:33-35`, `watcher.ts:7-20` |
| `GET /api/classes` | JSON array of perspective names | Yes | `src/server/api.ts:16-19` |
| `GET /api/class/:name` | JSON `{name, description, diagram, constraint, concern, context, todo, note, meta}` (absent fields omitted). `404 {"error":"class not found"}` if the directory is missing. | Yes (also on the 404) | `api.ts:22-31` |
| `GET /api/class/:name/diff` | `{added_nodes, removed_nodes, added_edges, removed_edges, has_changes, prev_diagram, current_diagram}`. If there is no previous diagram, `200 {"error":"no diff available","has_changes":false}`. | Yes | `api.ts:34-47` |
| `GET /api/class/:name/refs` | `{incoming: RefEntry[], outgoing: RefEntry[]}` where a RefEntry is `{source_class, target_class, node_id}` | Yes | `api.ts:50-57` |
| `GET /api/class/:perspective/nodes` | `{perspective, children}` | Yes | `api.ts:60-65` |
| `GET /api/class/:perspective/node/:path+` | If the last segment is `nodes`: `{perspective, path, children}` for the parent. Otherwise: element data plus `children`. `404 {"error":"node not found"}` if missing. | Yes | `api.ts:68-89` |
| Any other `/api/*` path | `404 {"error":"not found"}` | No (set directly in `index.ts`, not via the `json` helper) | `src/server/index.ts:39-44` |
| Any other path | `404` text `Not Found` | No | `src/server/index.ts:56-57` |

Notes:
- `:name` and `:perspective` match one path segment (`[^/]+`). Nested elements are reached only through the `/node/` route.
- The `json` helper in `api.ts:6-9` sets the CORS header on every API response it writes, including 404 and error bodies.
- If port `N` is in use, the server logs and calls `startServer(N+1)`, recursively (`index.ts:60-68`).
- Bind: `server.listen(port)` is called with no host argument (`index.ts:70`). `login.ts:62` does the same for its callback server.

### 4b. SSE endpoint

`GET /events` (`src/server/watcher.ts:7-20`):
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`.
- First frame: `data: connected`.
- Change frame: `event: change` with `data: {"file": <filename or null>, "time": <epoch ms>}`.
- Changes come from `fs.watch(.omm/, {recursive: true})` (`watcher.ts:31-43`), debounced 300 ms (`watcher.ts:39-42`).
- Clients are removed on `close` (`watcher.ts:17-19`). The watcher starts once per process (`watcher.ts:32`).

The viewer subscribes at `viewer.html:1546-1553`. On a `change` event it re-runs `init()` and reopens the selected element.

### 4c. External resources loaded by `viewer.html`

| Line | Tag | URL | Notes |
| --- | --- | --- | --- |
| 7 | `<script src>` | `https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js` | Version pinned to 0.8.5. Used for layout (`dagre.graphlib.Graph`, `dagre.layout`, lines 538, 561, 709, 722). |
| 8 | `<script src>` | `https://cdn.jsdelivr.net/npm/marked/marked.min.js` | No version pin. Used as `marked.parse` (line 1087). |
| 9 | `<link href>` | `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap` | Google Fonts stylesheet (Inter, Geist Mono, Plus Jakarta Sans). |

Only these three external URLs appear in `viewer.html`. The `http://www.w3.org/2000/svg` strings are XML namespaces, not requests.

### 4d. Client-side libraries

- dagre 0.8.5: graph layout.
- marked (unpinned): Markdown rendering of field text.
- Diagrams are drawn as inline SVG by the viewer's own code (`viewer.html:764`, `1230`).
- Mermaid.js is not loaded. The word "mermaid" in the page appears only in the `<title>`. `PLAN.md` line 116 says `viewer.html` uses mermaid.js, which does not match the shipped page.

### 4e. `window.__projectName`

Injected server-side (`src/server/index.ts:50`) as `window.__projectName=<JSON.stringify(basename(cwd))>`. Read at `viewer.html:1507`. Used for the nav title and mobile title, falling back to `'omm'`.

### 4f. postMessage behaviour

The viewer checks `window.parent !== window` before sending. Both sends use target origin `'*'`.

| Direction | Message | Sent or handled at | Notes |
| --- | --- | --- | --- |
| viewer to parent | `{type:'classes-loaded', classes, refs}` | `viewer.html:1523` | Sent after `init()` finishes. |
| viewer to parent | `{type:'class-selected', className}` | `viewer.html:1079` | Sent when an element is selected. |
| parent to viewer | `{type:'select-class', className}` | listener at `viewer.html:1527-1535` | Calls `window.__openSb(className)` if defined. The listener does not check `event.origin`. |

### 4g. Browser storage

One key, `localStorage['omm-theme']` (`viewer.html:326`), holds the theme. Reads and writes go through try/catch wrappers (`viewer.html:314-325`). It is the only storage use in the page.

---

## 5. `.omm` file format

Source: `src/types.ts`, `src/lib/store.ts`, `src/lib/meta.ts`.

### 5a. Directory layout

```
.omm/
├── config.yaml                  version, language?, theme? (type only), cloud.{project_slug, org_slug}
└── <perspective>/               top-level directory = perspective
    ├── description.md           field files: each optional, written by `omm write`
    ├── diagram.mmd
    ├── constraint.md
    ├── concern.md
    ├── context.md
    ├── todo.md
    ├── note.md
    ├── meta.yaml                written automatically
    └── <child>/                 nested element = subdirectory, same file set
        └── <grandchild>/ ...    any depth
```

### 5b. Fields and file names

Source: `src/types.ts:1-12`.

| Field | File |
| --- | --- |
| `description` | `description.md` |
| `diagram` | `diagram.mmd` |
| `constraint` | `constraint.md` |
| `concern` | `concern.md` |
| `context` | `context.md` |
| `todo` | `todo.md` |
| `note` | `note.md` |

### 5c. `meta.yaml` keys

Source: `src/types.ts:16-28` (`ClassMeta`), `src/lib/meta.ts:21-46` (top-level writer), `src/lib/store.ts:185-197, 126-183` (nested writer).

| Key | Written by | Meaning |
| --- | --- | --- |
| `created` | both | ISO timestamp, set on first write. |
| `updated` | both | ISO timestamp of the last field write. |
| `update_count` | both | Incremented on each field write. |
| `last_field` | both | Name of the last field written. |
| `git_commit` | top-level writer only | Short SHA from `git rev-parse --short HEAD` in the cwd. Omitted if git fails. |
| `git_branch` | top-level writer only | From `git branch --show-current`. Omitted if git fails. |
| `prev_diagram` | both | Diagram text before the most recent diagram write (see 5f). |
| `kind` | nested writer only | `perspective` (depth 0) or `nested-class` (depth 1+). |
| `title` | nested writer only | Last path segment, or the perspective name. |
| `children` | nested writer (both parent and child) | Sorted list of child directory names. |
| `parentPath` | nested writer only | Ancestor names below the perspective. Absent at depth 0. |

Verified against samples: `.omm/overall-architecture/cli/meta.yaml` (nested, `parentPath: []`) has no `git_commit` key. Top-level `meta.yaml` files have `git_commit` and `git_branch`.

### 5d. `config.yaml` keys

Source: `src/types.ts:42-46` (`OmmConfig`), `src/lib/store.ts:46-56`.

| Key | Written by | Read by |
| --- | --- | --- |
| `version` | `initOmm`, always `0.1.0` (`store.ts:53`) | not read by any command |
| `language` | `omm config language <value>` | `omm config language` (default `English`, `config.ts:49`). `omm-scan` skill Step 0. |
| `theme` | type declaration only | no code reads or writes it |
| `cloud.project_slug` | `omm link` (`link.ts:110-116`) | `push`, `pull`, `share` |
| `cloud.org_slug` | `omm link` | `push`, `pull`, `share`. Falls back to credentials `default_org`. |

Any other key can be written with `omm config <key> <value>` (`config.ts:55-59`). The file is rewritten in full with `YAML.stringify`.

### 5e. Nesting rules

- A perspective is a directory directly under `.omm/` whose name does not start with `.` (`store.ts:76-83`).
- A nested element is a subdirectory, not starting with `.`, at any depth (`store.ts:106-115`).
- The element name is the directory name. CLI paths use `/` (`src/commands/read-write.ts:18-21`).
- Diagram node IDs are expected to match child directory names (`skills/omm-scan/SKILL.md:14, 72, 150`). The validator does not check this.

### 5f. How `prev_diagram` is stored

- Before `diagram.mmd` is overwritten, the current diagram text is copied into `meta.yaml` as `prev_diagram` (`store.ts:257-266` for top-level, `store.ts:138-147` for nested).
- The copy happens only if `meta.yaml` already exists. The first diagram write therefore stores no `prev_diagram`.
- It is one slot. Each diagram write replaces it with the diagram immediately before.
- It is a YAML string holding the full Mermaid source.
- It is read by `omm diff` (`src/commands/diff.ts:18-19`) and by `GET /api/class/:name/diff` (`src/server/api.ts:37-40`).

---

## 6. Diagram conventions

Source: `src/lib/validate.ts`, `src/lib/refs.ts`, `src/lib/diff.ts`.

### 6a. Validation rules

`validateDiagram(text, context?)` (`validate.ts:58`). `omm validate` always passes a context (`src/commands/validate.ts:11`). Only `error` level makes `valid` false. Exit code 1 only on errors.

| Rule | Level | Trigger | Check | Source |
| --- | --- | --- | --- | --- |
| `graph-declaration` | error | Always. Reported at line 1. | First non-blank, non-`%%` line must be `graph` or `flowchart`, then one of LR, RL, TD, TB, BT, case-insensitive, and nothing else (`GRAPH_DECL`). | `validate.ts:18, 63-71` |
| `balanced-brackets` | error | Every non-blank, non-`%%` line | Counts `[ ]`, `( )`, `{ }` outside double quotes. Each pair must match. | `validate.ts:33-49, 78-86` |
| `edge-label` | warning | Line contains `-->`, `==>`, or `-.->`, and is not a directive line | Line must contain a `\|label\|`. The `-.->` pattern has an unescaped `.` (`validate.ts:23`). | `validate.ts:21-24, 88-98` |
| `classdef-name` | warning | Line starts with `classDef` | Name must be one of `external`, `concern`, `entry`, `store`. | `validate.ts:7, 100-112` |
| `classdef-color` | warning | `classDef` with a valid name | Each declared `fill`, `stroke`, or `color` must equal the palette value (case-insensitive). Other attributes are ignored. | `validate.ts:113-129` |
| `ref-self` | error | Only when a context is passed | `@x` where `x` is the element's own name. | `validate.ts:133-141` |
| `ref-exists` | error | Only when a context is passed | `@x` not in the list of top-level element names. | `validate.ts:143-148` |
| `node-count` | warning | Always | Node count from `parseMermaid`: 1 or 2 nodes, or more than 15. Zero nodes gives no warning. | `validate.ts:153-168` |

Notes:
- `allClasses` is `listClasses()`, which returns only top-level directories (`commands/validate.ts:32`, `store.ts:76-83`). A reference to a nested element name therefore fails `ref-exists`.

### 6b. classDef names and palette

Source: `src/lib/validate.ts:7-14`. The same values appear in `skills/omm-scan/SKILL.md` (lines 163-175).

| Name | fill | stroke | color |
| --- | --- | --- | --- |
| `external` | `#585b70` | `#585b70` | `#cdd6f4` |
| `concern` | `#f38ba8` | `#f38ba8` | `#1e1e2e` |
| `entry` | `#89b4fa` | `#89b4fa` | `#1e1e2e` |
| `store` | `#a6e3a1` | `#a6e3a1` | `#1e1e2e` |

### 6c. `@ref` reference syntax

- Pattern: `/@([\w-]+)/g` (`src/lib/refs.ts:4`). It matches `@` followed by letters, digits, `_`, or `-`.
- No position check. Any `@name` in the diagram text counts, including inside quoted labels.
- `extractRefs` de-duplicates and keeps first-seen order (`refs.ts:9-19`).
- Outgoing refs (`getOutgoingRefs`): refs in the element's own `diagram.mmd` (`refs.ts:24-34`).
- Incoming refs (`getIncomingRefs`): scans every top-level element's diagram for the name (`refs.ts:39-59`).
- `buildRefGraph` exists (`refs.ts:64-74`) and is exported from `src/index.ts:5`. The CLI does not call it.

### 6d. Mermaid parser used by diff and node counting

`parseMermaid` (`src/lib/diff.ts:12-58`) is regex-based. It recognises arrows `-->`, `--o`, `--x`, `---`, `-.->`, `==>`, `~~>`, and `--|label|`. It skips directive lines (`graph`, `classDef`, `class `, `click `, `style `, `linkStyle`, `subgraph`, `end`, `%%`). Quotes are stripped from node IDs. `diffMermaid` and `formatDiff` are at `diff.ts:60-98`.

---

## 7. Configuration

### 7a. Environment variables

Searched with `grep -rn process.env src scripts` (tests excluded).

| Variable | Read at | Effect | Default |
| --- | --- | --- | --- |
| `OMM_API_URL` | `src/lib/cloud.ts:32` (`getApiUrl`, used by every cloud call, the login URL, and printed links), `src/commands/org.ts:93` | Overrides the base URL for all API and browser URLs | `https://ohmymermaid.com` (`cloud.ts:7`) |
| `RELEASE_CURRENT_VERSION` | `scripts/release-decision.js:42` | Input to the release decision | `''` |
| `RELEASE_PREVIOUS_VERSION` | `scripts/release-decision.js:43` | Input | `''` |
| `RELEASE_NPM_PUBLISHED` | `scripts/release-decision.js:44` | Input (set by `release.yml:72`) | `false` |
| `RELEASE_TAG_EXISTS` | `scripts/release-decision.js:45` | Input (set by `release.yml:73`) | `false` |
| `RELEASE_GITHUB_RELEASE_EXISTS` | `scripts/release-decision.js:46` | Input (set by `release.yml:74`) | `false` |

Other environment values read in CI are secrets, named only: `GITHUB_TOKEN` (`release.yml:44, 113`) and `NPM_TOKEN` (`release.yml:101`, as `NODE_AUTH_TOKEN`).

The code also uses `os.homedir()` for the credentials directory and the platform symlink targets, and `process.platform` in `utils.ts:87`.

### 7b. Config and state files

| Path | Read or written by | Format | Notes |
| --- | --- | --- | --- |
| `~/.omm/credentials.json` | `src/lib/cloud.ts` (login, logout, org, link) | JSON: `token`, `handle`, `default_org` | See 7c. |
| `<cwd>/.omm/config.yaml` | `store.ts`, `link.ts`, `config.ts`, `push`, `pull`, `share` | YAML | Keys in 5d. |
| `<cwd>/.omm/**/meta.yaml` | `store.ts`, `meta.ts` | YAML | Keys in 5c. |
| `<cwd>/.omm/**/*.md`, `*.mmd` | `store.ts` | Text | Field files (5b). |
| `<cwd>/.cursor-plugin/plugin.json`, `skills/`, `agents/` | `cursor.ts` | JSON and copied files | Project-local. Gitignored. |
| `~/.agents/skills/oh-my-mermaid` | `codex.ts` | Symlink | |
| `~/.openclaw/skills/oh-my-mermaid` | `openclaw.ts` | Symlink | |
| `~/.gemini/antigravity/skills/oh-my-mermaid` | `antigravity.ts` | Symlink | |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | `scripts/sync-version.js` | JSON | Repository files. The sync script is the only writer. |
| `dist/` | `tsup` | Build output | Gitignored. |

### 7c. Credentials

- Path: `~/.omm/credentials.json` (`src/lib/cloud.ts:5-6`).
- Directory created with default mode (`cloud.ts:45-48`).
- File written with `{ mode: 0o600 }` on every write (`cloud.ts:49`). Node applies the mode only when it creates the file, so an existing file keeps its existing permissions.
- Written as `JSON.stringify(creds, null, 2)`.
- Token sent as `Authorization: Bearer <token>` on every API request (`cloud.ts:95-97`) to the URL from `getApiUrl()`.
- Login receives the token as the `token` query parameter on the loopback callback (`login.ts:35`). The success page does not echo it (`login.ts:39-46`).
- `syncHandleCredentials` updates `default_org` when it still equals the previous handle (`cloud.ts:15-25`).

---

## 8. Tests

### 8a. Test files and titles

All 8 files are in `src/__tests__/`. Titles below are the `describe` › `it` strings.

- **`cloud-paths.test.ts`**. Covers `src/lib/cloud-paths.ts`.
  - `resolvePullDestination`: "allows safe paths inside the .omm directory"; "rejects paths that escape the .omm directory" (2 tests)
- **`credentials.test.ts`**. Covers `syncHandleCredentials` in `src/lib/cloud.ts`.
  - `syncHandleCredentials`: "updates default_org when it still points at the old personal handle"; "preserves a team default_org when the user intentionally switched away"; "fills default_org for first-time credentials" (3 tests)
- **`cursor.test.ts`**. Covers `src/lib/platforms/cursor.ts` (mocks `platforms/utils.js`).
  - "cursor platform version-aware setup detection": "returns false when the cursor plugin manifest is missing"; "returns false when the installed cursor plugin manifest version is stale"; "returns true when the installed cursor plugin manifest matches the current package version" (3 tests)
- **`release-decision.test.ts`**. Covers `scripts/release-decision.js`.
  - `decideReleaseAction`: "skips only when version is unchanged and all artifacts already exist"; "retries release when version is unchanged but npm publish is missing"; "releases when version changed even if no artifacts exist yet"; "continues when some artifacts exist but others are missing" (4 tests)
- **`store.test.ts`**. Covers `src/lib/store.ts`.
  - `ensureOmmForWrite`: "creates .omm/ and config.yaml when missing"; "is a no-op when .omm/ already exists"
  - `ensureOmmForRead`: "returns false when .omm/ is missing (no auto-create)"; "returns true when .omm/ exists"
  - `writeField with lazy-init`: "creates .omm/ + config.yaml + field file when .omm/ missing"; "creates meta.yaml after writing a field"; "works normally when .omm/ already exists" (7 tests)
- **`update.test.ts`**. Covers `src/commands/update.ts` (mocks `node:child_process`).
  - `commandUpdate`: "re-runs setup through a fresh omm subprocess after npm update succeeds"; "fails when the fresh setup subprocess fails" (2 tests)
- **`validate.test.ts`**. Covers `src/lib/validate.ts`.
  - `validateDiagram`: "passes a valid diagram with no issues"; "errors on missing graph declaration"; "errors on unbalanced brackets (quote-aware)"; "does not false-positive on brackets inside quotes"; "warns on edge without label (-->, ==>, -.->)"; "errors on @ref to nonexistent class"; "errors on self @ref"; "allows general cycles (not self-ref)"; "warns on invalid classDef name"; "warns on wrong classDef color (checks declared attributes only)"; "passes classDef with correct colors in any attribute order"; "warns on too many nodes"; "warns on too few nodes"; "skips ref checks when no context provided" (14 tests)
- **`version-sync.test.ts`**. Covers `scripts/check-version-sync.js`.
  - "check-version-sync helpers": "accepts matching package, plugin, marketplace, and lockfile versions"; "reports all mismatched versions, including a stale package-lock root package version" (2 tests)

Total: 37 tests in 8 files.

### 8b. `npm test`

Run from the repo root. Runner: `vitest run`, v4.1.0.

```
Test Files  8 passed (8)
     Tests  37 passed (37)
  Start at  08:39:01
  Duration  784ms (transform 425ms, setup 0ms, import 614ms, tests 176ms)
```

Exit status: success. The run also printed stderr lines from the store tests (`Created .omm/ directory...`, `wrote ...`), which are expected output from those tests.

### 8c. `npm run build`

Run from the repo root. Runner: `tsup` 8.5.1.

- Result: success, exit 0. ESM build and DTS build both reported success.
- `dist/` before the build was regenerated (`clean: true`). It is gitignored and not tracked. A pre-build copy was kept in the scratchpad. Every file's byte size matched after the build.
- Output files in `dist/`:

| File | Size |
| --- | --- |
| `cli.js` (bin entry, shebang present) | 68,484 bytes (66.88 KB) |
| `cli.js.map` | 137,972 bytes |
| `cli.d.ts` | 20 bytes |
| `index.js` | 19,202 bytes (18.75 KB) |
| `index.js.map` | 39,361 bytes |
| `index.d.ts` | 4,997 bytes (4.88 KB) |
| `viewer.html` (copied by `onSuccess`) | 72,832 bytes |

---

## 9. Build, packaging and CI

### 9a. `package.json` scripts

Source: `package.json:35-42`.

| Script | Command | Notes |
| --- | --- | --- |
| `build` | `tsup` | |
| `dev` | `tsup --watch` | |
| `test` | `vitest run` | |
| `check-version-sync` | `node scripts/check-version-sync.js` | |
| `sync-version` | `node scripts/sync-version.js` | |
| `prepublishOnly` | `npm run build && npm run sync-version` | Runs before `npm publish`. |

### 9b. Package fields

Source: `package.json`.

- `name`: `oh-my-mermaid`. `version`: `0.2.0`. `type`: `module`. `license`: `MIT`. `author`: empty string.
- `bin`: `{"omm": "dist/cli.js"}`.
- `main`: `./dist/index.js`. `types`: `./dist/index.d.ts`. No `exports` field.
- `files`: `dist/`, `skills/`, `.claude-plugin/`, `LICENSE`. Not included: `src/`, `scripts/`, `.omm/`, `docs/`, README translations.
- `engines`: `node >=18`.
- `repository`: `git+https://github.com/oh-my-mermaid/oh-my-mermaid.git`.

### 9c. Dependencies

| Package | Kind | Declared | Locked (`package-lock.json`) |
| --- | --- | --- | --- |
| `yaml` | runtime | `^2.8.3` | 2.8.3 |
| `@types/node` | dev | `^25.5.0` | 25.5.0 |
| `tsup` | dev | `^8.5.1` | 8.5.1 |
| `typescript` | dev | `^5.9.3` | 5.9.3 |
| `vitest` | dev | `^4.1.0` | 4.1.0 |

`yaml` is the only runtime dependency. Everything else uses Node built-ins.

### 9d. Build configuration

- `tsup.config.ts`: entries `cli` (`src/cli.ts`) and `index` (`src/index.ts`). Format `esm`. `dts: true`. `clean: true`. `splitting: false`. `sourcemap: true`. `onSuccess`: copies `src/server/viewer.html` to `dist/`.
- `tsconfig.json`: target `ES2022`, module `ESNext`, `moduleResolution: bundler`, `strict`, `rootDir: src`, `outDir: dist`, `declaration`, `sourceMap`, `resolveJsonModule`. `include: src/**/*`.
- No `vitest.config` file. Vitest runs with its defaults.

### 9e. GitHub workflows

| File | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/release.yml` | `push` to `main` that changes `package.json` | Node 20. Compares `package.json` version with `HEAD~1`. Checks npm (`npm view`), remote tag (`git ls-remote`), and GitHub release (`gh release view`). Runs `scripts/release-decision.js`. If releasing: `npm ci`, `npm test`, `npm run build`, `npm run sync-version`, `npm run check-version-sync`, then `git diff --exit-code` on the two plugin manifests and the lockfile. Then `npm publish --provenance --access public` if not on npm. Creates and pushes tag `v<version>` if missing. Creates a GitHub release with generated notes if missing. Permissions: `contents: write`, `id-token: write`. |
| `.github/workflows/check-version-sync.yml` | `pull_request` touching `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `scripts/sync-version.js`, or `scripts/check-version-sync.js` | Node 20. Runs `npm run check-version-sync`. No `npm ci`. |

No workflow runs `npm test` or `npm run build` on pull requests. `npm test` runs only inside `release.yml`, and only when that workflow decides to release.

### 9f. `scripts/*.js`

- `scripts/sync-version.js`: copies the version from `package.json` into `.claude-plugin/plugin.json` (`version`) and `.claude-plugin/marketplace.json` (`plugins[0].version`). Writes 2-space JSON with a trailing newline. Does not touch `package-lock.json`.
- `scripts/check-version-sync.js`: compares `package.json` version with plugin.json, marketplace `plugins[0].version`, `package-lock.json` `version`, and `package-lock.json` `packages[""].version`. On mismatch, prints `::error::` lines and sets exit code 1. Exports helpers used by the tests. Its message suggests `npm version <patch|minor|major> && npm run sync-version`.
- `scripts/release-decision.js`: `decideReleaseAction()`. Returns `{changed, shouldRelease, reason}`. Release if the version changed, or if any artifact (npm, tag, GitHub release) is missing. Otherwise skip. Reads `RELEASE_*` env vars and prints JSON.

### 9g. Version-sync rules

- `CLAUDE.md` lines 16-19: follow Semantic Versioning, and sync the version across `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
- The check script also enforces `package-lock.json` (`version` and `packages[""].version`). `CLAUDE.md` does not mention the lockfile.
- `prepublishOnly` runs the build and `sync-version`.
- `CLAUDE.md` lines 21-24: Conventional Commits, and a co-author tag for AI-assisted commits.

---

## 10. External cloud dependencies

Every network destination the code can contact, and the command that uses it.

Labels used below:
- **Public repository code**: this project's own public code, or public open-source code from a public registry or CDN (npm package, GitHub repository, public GitHub Action).
- **Externally hosted service not included in this repository**: a service endpoint whose server side is not in this repository.

| Destination | Used by | Trigger | Label |
| --- | --- | --- | --- |
| `https://ohmymermaid.com` (or `OMM_API_URL`): `POST /api/push`, `GET /api/pull`, `GET /api/cli/orgs` | `apiRequest` (`src/lib/cloud.ts:86-106`) via `push.ts:72`, `pull.ts:40`, `link.ts:27`, `org.ts:27, 67` | `omm push`, `omm pull`, `omm link` (without `org/slug`), `omm org list`, `omm org switch` | Externally hosted service not included in this repository |
| `https://ohmymermaid.com/auth/cli?callback=...` opened in the browser | `src/commands/login.ts:65-68` | `omm login` | Externally hosted service not included in this repository |
| Printed URLs only (no request): `/p/<org>/<slug>`, `/dashboard`, `/org/<slug>/settings`, `/auth/login` | `share.ts:31`, `push.ts:82-83`, `org.ts:93`, `link.ts:43` | `omm share`, `omm push` (after success), `omm org members`, `omm link` (error text) | Externally hosted service not included in this repository |
| `https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js` | `viewer.html:7` (loaded by the browser) | `omm view` page load | Public repository code (public npm package, pinned) |
| `https://cdn.jsdelivr.net/npm/marked/marked.min.js` | `viewer.html:8` (loaded by the browser) | `omm view` page load | Public repository code (public npm package, unpinned) |
| `https://fonts.googleapis.com/css2?...` | `viewer.html:9` (loaded by the browser) | `omm view` page load | Externally hosted service not included in this repository |
| `https://github.com/oh-my-mermaid/oh-my-mermaid` (`claude plugin marketplace add oh-my-mermaid/oh-my-mermaid`) | `claude.ts:59` via the external `claude` CLI | `omm setup` (claude platform) | Public repository code (this repository, fetched by `claude`) |
| npm registry: `npm update -g oh-my-mermaid` | `update.ts:7` | `omm update` | Public repository code (npm package) |
| npm registry: `npm install -g oh-my-mermaid` | `SKILL.md` prerequisites (run by the agent) | skills `omm-scan`, `omm-push`, `omm-view` | Public repository code (npm package) |
| npm registry: `npm view`, `npm publish --provenance` to registry.npmjs.org | `.github/workflows/release.yml:49, 99` | CI release | Public repository code (npm package) |
| GitHub remote: `git ls-remote --tags origin`, `git push origin <tag>` | `release.yml:55, 107-108` | CI release | Public repository code (this repository) |
| GitHub API: `gh release view`, `gh release create` | `release.yml:61, 116` | CI release | Externally hosted service not included in this repository |
| GitHub Actions `actions/checkout@v4`, `actions/setup-node@v4` | workflows | CI | Public repository code (public GitHub Actions) |
| `http://localhost:<random port>/callback` (loopback) | `login.ts:23, 62` | `omm login` | Local only (not external). The browser redirects here. |
| `http://localhost:3000` (default, `--port`) | `src/server/index.ts:70` | `omm view` | Local only |

Local programs the code runs (not network): `git rev-parse` and `git branch` (`meta.ts:11-13`, `push.ts:26`); `which` or `where` (`utils.ts:86-94`); `claude plugin ...` (`claude.ts`); `npm update -g` and the re-exec of `omm setup` (`update.ts:7, 19`); `open` (`login.ts:68`).

No `npx` invocation exists in the repository code or workflows.

---

## 11. Repository metadata

### 11a. License

- `LICENSE`: MIT License. Line 3: `Copyright (c) 2025 oh-my-mermaid`.
- `package.json`: `"license": "MIT"`.

### 11b. README languages

Five README files, each with a language-link line at the top.

| File | Language | Translation note at top |
| --- | --- | --- |
| `README.md` | English (source) | n/a |
| `README.ko.md` | Korean | "이 문서는 영어 README를 번역한 것입니다..." |
| `README.ja.md` | Japanese | Present (Japanese text) |
| `README.zh.md` | Chinese | Present (Chinese text) |
| `README.tr.md` | Turkish | Present, with different wording: "Bazı terimler bilinçli olarak İngilizce bırakılmıştır." |

`CLAUDE.md` lines 3-14 list `README.ko.md`, `README.ja.md`, and `README.zh.md` as the maintained translations. `README.tr.md` is not in that list. Its note also differs from the template in `CLAUDE.md` line 12.

`CLAUDE.md` line 9 says every README should have the language-link line. The `README.tr.md` link line matches the other four.

### 11c. `docs/` contents

| File | Content |
| --- | --- |
| `docs/ROADMAP.md` | Roadmap, see 11d |
| `docs/demo.gif` | Demo animation (about 1.38 MB) |
| `docs/logo.jpg` | Logo (about 111 KB) |
| `docs/screenshot.png` | Screenshot (about 205 KB) |

### 11d. `docs/ROADMAP.md` summary

The file lists four planned items. (1) Sub-agent scan pipeline: split `/omm-scan` into parallel per-perspective analysis. (2) Incremental analysis: detect changed files and update only affected perspectives. (3) AI-powered search in the viewer: natural-language queries across the docs. (4) Guide and onboarding skill: a planned `/omm-guide` skill that walks developers through the architecture.

### 11e. `PLAN.md` summary

`PLAN.md` is an implementation plan written in Korean. It describes the original design: the seven-file element structure with `meta.yaml`, a CLI command list, skill design, and a planned project layout. It names a few things that differ from the shipped code: `omm serve` (`PLAN.md:55`, shipped command is `omm view`), `omm init` copying skills into `.claude/skills/` (`PLAN.md:13, 47`), a `test/` directory (`PLAN.md:121`, shipped tests are in `src/__tests__/`), and a viewer that uses mermaid.js and marked.js from a CDN (`PLAN.md:116`, shipped viewer loads dagre and marked).

### 11f. `.omm/` self-scan contents

Config: `.omm/config.yaml` has `version: 0.1.0` and a `cloud` block with `project_slug: oh-my-mermaid` and `org_slug: hitkoo`. `language` is not set.

| Perspective | Elements (perspective root plus nested) | Direct children | Diagrams (`diagram.mmd`) |
| --- | --- | --- | --- |
| `command-surface` | 21 (1 + 20) | 20 | 1 (root) |
| `data-flow` | 12 (1 + 11) | 11 | 1 (root) |
| `overall-architecture` | 29 (1 + 28) | 12 | 4 (root, `commands`, `platforms`, `server`) |
| **Total** | **62** | | **6** |

Field files present in the self-scan: `description.md` (62, one per element), `diagram.mmd` (6), `constraint.md` (1), and `context.md` (1). Each element directory also has a `meta.yaml`. No `concern.md`, `todo.md`, or `note.md` exists in the self-scan.

### 11g. Other notes

- Repository state at the end of this task: `git status` is clean apart from this file. `dist/` is regenerated and gitignored.
- User-facing strings containing the word "class" (`CLAUDE.md` lines 28-32 list "class" under Terminology): `omm diff <class>` and `omm refs [--reverse] <class>` usage errors (`src/cli.ts:140, 158`), and `class not found` in the viewer API (`src/server/api.ts:26`). The help text uses `<path>` instead.
