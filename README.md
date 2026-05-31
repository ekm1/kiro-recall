# kiro-recall

Persistent, browsable conversation memory for Kiro IDE — a claude-mem-style
memory that **reads Kiro's own session transcripts** instead of relying on hooks.

- No hooks, no shim, no chroma/uvx. Just reads the JSON Kiro already writes.
- Chats are grouped by the **repo they actually touched** (not Kiro's primary
  workspace root), recovered by matching file paths in each transcript.
- Search (FTS5), a web UI to browse history per repo, and MCP recall tools in chat.
- Optional semantic (vector) search and LLM observations — off by default.

## How it works

```
Kiro writes <sessionId>.json transcripts
        │
        ▼
 kiro-recall daemon (Bun)
   scan + watch  → SQLite (FTS5)  → REST API + web UI :37800
        ▲
        │ auto-started + kept alive by…
   kiro-recall MCP server  ← Kiro spawns this every session
        │
        ▼
   kiro_recall_search_project / search_global / recall / get_session  (recall in chat)
```

The MCP server is spawned by Kiro on every session. On boot it ensures the
background daemon is running (spawns it detached if not). So: install once,
and whenever Kiro runs, the daemon + UI + recall are live.

## Install

```bash
bun install --registry https://registry.npmjs.org
bun run install-kiro
```

This:
1. Registers the `kiro-recall` MCP server in `~/.kiro/settings/mcp.json` (merged,
   never clobbers other servers).
2. Writes `~/.kiro/steering/kiro-recall.md` so the agent recalls memory proactively.

Then **reload Kiro** (Command Palette → "Developer: Reload Window"). The daemon
auto-starts; browse history at http://127.0.0.1:37800.

## Uninstall

```bash
bun run uninstall-kiro   # removes MCP entry + steering; leaves your DB intact
```

## Commands

| Command | What |
|---------|------|
| `bun run scan` | one-shot scan, then exit |
| `bun run rebuild` | wipe derived DB + full re-scan |
| `bun run start` | run the daemon in the foreground |
| `bun run daemon` | ensure the daemon is running (detached) |
| `bun run status` | daemon health + pid |
| `bun run stop` | stop the daemon |
| `bun run mcp` | run the MCP server (normally Kiro does this) |

## Recall tools (MCP)

The agent gets four read-only tools (auto-approved on install):

| Tool | What |
|------|------|
| `kiro_recall_search_project` | Search memory for the **current repo** (auto-detected from the workspace). Default for "how did we do X here". |
| `kiro_recall_search_global` | Search memory across **all** repos — preferences, recurring patterns, how something was solved elsewhere. |
| `kiro_recall_recall` | List recent sessions (current repo, or `global: true` for all). |
| `kiro_recall_get_session` | Fetch a full transcript by its `[session:…]` id. |

The two search tools accept `after` / `before` (ISO 8601 date filters),
`contextSize` (surrounding messages per hit, default 2), and `limit` / `offset`
for pagination (results end with a hint telling the agent how to page further).
Results include a relevance score and the surrounding conversation context.

## Config (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `KIRO_RECALL_PORT` | `37800` | HTTP/UI port |
| `KIRO_RECALL_DATA_DIR` | `~/.kiro-recall` | DB + logs (disposable) |
| `KIRO_RECALL_AGENT_DIR` | auto | Override Kiro's `globalStorage` agent dir |
| `KIRO_RECALL_WATCH` | `true` | live file watcher |
| `KIRO_RECALL_POLL_INTERVAL_MS` | `15000` | poll-fallback interval |
| `KIRO_RECALL_VECTOR` | `false` | semantic search (needs `@xenova/transformers`) |
| `KIRO_RECALL_SUMMARIZE` | `false` | LLM observations (needs a provider key) |
| `KIRO_RECALL_SEARCH_THRESHOLD` | `0.2` | min cosine similarity for a vector hit |
| `KIRO_RECALL_SEARCH_CONTEXT_SIZE` | `2` | messages of context per search hit |
| `KIRO_RECALL_SEARCH_MAX_RESULTS` | `15` | default page size for MCP search |
| `KIRO_RECALL_CONFIG` | auto | explicit path to a `config.toml` |

## Config file (optional)

Instead of env vars you can drop a `config.toml` at
`~/.config/kiro-recall/config.toml` (or `$KIRO_RECALL_CONFIG`). Env vars always
win over the file, which wins over defaults.

```toml
[server]
port = 37800

[paths]
data_dir = "~/.kiro-recall"
# agent_dir = "/custom/path/to/globalStorage/kiro.kiroagent"

[vector]
enabled = false

[summarize]
enabled = false

[search]
threshold = 0.2
context_size = 2
max_results = 15
```

## Notes

- The store is a **derived index** — delete `~/.kiro-recall` and re-scan to rebuild.
- Repo attribution is heuristic: chats with no file-path references fall back to
  Kiro's primary workspace root.
- The currently-open Kiro session is not searchable until Kiro flushes it to disk.

## Releasing

Releases are cut by GitHub Actions (`.github/workflows/release.yml`) on any
`v*` tag push. The workflow verifies the tag matches `package.json`, parses all
entrypoints under Bun, builds release notes from the git log, and publishes a
GitHub Release with a source tarball. No npm publish.

```bash
# bump version in package.json first, then:
git tag v0.1.0
git push origin v0.1.0
```

Pre-release tags (containing a hyphen, e.g. `v0.2.0-rc.1`) are marked as
pre-releases automatically.
