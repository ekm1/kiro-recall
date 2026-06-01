# kiro-recall

Persistent, browsable conversation memory for Kiro IDE — a claude-mem-style
memory that **reads Kiro's own session transcripts** instead of relying on hooks.

> **Note:** This is a personal pet project, built and used for my own purposes.
> **100% of the code in this repository is AI-generated.** Use at your own risk;
> no guarantees or support are implied.

- No hooks, no shim, no chroma/uvx. Just reads the JSON Kiro already writes.
- Chats are grouped by the **repo they actually touched** (not Kiro's primary
  workspace root), recovered by matching file paths in each transcript. Chats
  with no recognizable repo path land in an **Untagged** bucket so they're never
  hidden.
- **Hybrid search**: keyword (FTS5) and semantic (vector) signals are fused into
  one ranked list. Retrieval is global by default; the current repo only boosts
  ranking, it never filters results out.
- A web UI to browse history per repo, plus MCP recall tools in chat.
- Semantic (vector) search is **on by default**; LLM observations are off by default.
- **Retention**: sessions untouched for 30 days are pruned automatically to keep
  the index small and relevant (configurable, or disable entirely).

## How it works

```
Kiro writes <sessionId>.json transcripts
        │
        ▼
 kiro-recall daemon (Bun)
   scan + watch  → SQLite (FTS5 + vectors)  → REST API + web UI :37800
     │   │                                          │
     │   └─ retention prune (drops stale sessions)  │
     │                                              │
     ▲                                              │
     │ auto-started + kept alive by…                │
   kiro-recall MCP server  ← Kiro spawns this every session
        │
        ▼
   kiro_recall_search_project / search_global / recall / get_session  (recall in chat)
```

The MCP server is spawned by Kiro on every session. On boot it ensures the
background daemon is running (spawns it detached if not). So: install once,
and whenever Kiro runs, the daemon + UI + recall are live.

### Search: hybrid + global

Each search pulls two independent signals **across all repos**:

- **Keyword (FTS5)** — exact term matching. Long natural-language queries first
  try implicit-AND (all terms); if that finds nothing, they fall back to OR so
  the query still recalls something instead of returning empty.
- **Semantic (vector)** — meaning-based matching via local embeddings, so
  "what's blocking the migration" can match "WRITE ops still on ebet" even with
  no shared words.

The two lists are merged with **reciprocal-rank fusion** into a single ranking;
a hit found by both signals is reinforced. Scope (the current repo/project) is a
**soft boost** — it nudges local hits up but never filters cross-repo results
out. This matters because a chat about repo X is often logged under repo Y when
Kiro's workspace root differs from the code being discussed.

### Repo attribution & the Untagged bucket

A session is tagged with every repo whose file paths appear in its transcript.
Sessions with no recognizable repo path (e.g. a brand-new chat that hasn't
mentioned a file yet) get no tag — they surface under **Untagged** in the UI,
sorted by last activity, so they're always reachable.

### Retention

On every full scan the daemon prunes sessions whose **last activity**
(`updated_at`) is older than the retention window (default 30 days). Pruning
cascades to messages, repo tags, observations, the FTS index, and vector
embeddings, and drops now-empty projects. The scanner also skips transcript
files older than the window up front, so aged-out chats aren't re-ingested.
Set the window to `0` to keep everything forever.

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
| `kiro_recall_search_project` | Hybrid search with the **current repo boosted** (auto-detected). Default for "how did we do X here" — but still returns relevant hits from other repos. |
| `kiro_recall_search_global` | Hybrid search with no scope boost — preferences, recurring patterns, how something was solved elsewhere. |
| `kiro_recall_recall` | List recent sessions (current repo, or `global: true` for all). |
| `kiro_recall_get_session` | Fetch a full transcript by its `[session:…]` id. |

Both search tools retrieve globally and fuse keyword + semantic results; the
only difference is whether the current repo gets a ranking boost. Each match is
tagged with the signal(s) that found it (`keyword`, `semantic`, or both). They
accept `after` / `before` (ISO 8601 date filters), `contextSize` (surrounding
messages per hit, default 2), and `limit` / `offset` for pagination (results end
with a hint telling the agent how to page further).

## Config (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `KIRO_RECALL_PORT` | `37800` | HTTP/UI port |
| `KIRO_RECALL_DATA_DIR` | `~/.kiro-recall` | DB + logs (disposable) |
| `KIRO_RECALL_AGENT_DIR` | auto | Override Kiro's `globalStorage` agent dir |
| `KIRO_RECALL_WATCH` | `true` | live file watcher |
| `KIRO_RECALL_POLL_INTERVAL_MS` | `15000` | poll-fallback interval |
| `KIRO_RECALL_VECTOR` | `true` | semantic search (uses the optional `@xenova/transformers` dep) |
| `KIRO_RECALL_RETENTION_DAYS` | `30` | prune sessions idle longer than this; `0` keeps everything |
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
enabled = true

[retention]
days = 30   # 0 = keep everything

[summarize]
enabled = false

[search]
threshold = 0.2
context_size = 2
max_results = 15
```

## Notes

- Semantic search is on by default: the first time the daemon indexes, it
  downloads the `all-MiniLM-L6-v2` model (~tens of MB) once. If the optional
  `@xenova/transformers` dep is unavailable, search silently falls back to FTS.
  Turn it off with `KIRO_RECALL_VECTOR=0`.
- The store is a **derived index** — delete `~/.kiro-recall` and re-scan to rebuild.
  (Re-scan only recovers chats still within the retention window; pruned ones are
  gone unless retention is disabled.)
- Repo attribution is heuristic: chats with no file-path references aren't tagged
  to a repo and show up under **Untagged** in the UI.
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
