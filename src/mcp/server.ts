// MCP stdio server — exposes recall tools to Kiro's agent.
//
// Tools:
//   kiro_recall_search_project  -> search memory for the CURRENT repo (auto-scoped)
//   kiro_recall_search_global   -> search memory across ALL repos/workspaces
//   kiro_recall_recall          -> recent sessions (current repo, or all)
//   kiro_recall_get_session     -> full transcript of one session
//
// Read-only. Fast (FTS). Never blocks. Runs against the same SQLite store the
// daemon populates, so it works whether or not the HTTP daemon is running.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDb } from "../store/db.ts";
import { searchMessages } from "../search/fts.ts";
import { searchObservations } from "../store/observations.ts";
import {
  listProjects,
  listSessions,
  listRepos,
  listSessionsByRepo,
  getMessages,
  getMessageWindow,
  getSession,
  repoHasSession,
} from "../store/sessions.ts";
import { SEARCH_CONTEXT_SIZE, SEARCH_MAX_RESULTS, VECTOR_ENABLED } from "../config.ts";
import { preloadEmbedder, vectorSearch } from "../search/vector.ts";
import { ensureDaemonRunning } from "../daemon-manager.ts";

// ---- Scope resolution -----------------------------------------------------

// Detect the workspace Kiro spawned us in. Order matters: explicit Kiro env
// signals first, then the spawn cwd (reliable when Kiro sets the child's cwd),
// then PWD as a last resort (it can be stale/inherited, so it must not win
// over process.cwd()).
function currentWorkspace(): string | undefined {
  const env = process.env;
  const candidates = [
    env.KIRO_PROJECT_DIR,
    env.KIRO_WORKSPACE_ROOT,
    env.KIRO_WORKSPACE,
    process.cwd(),
    env.PWD,
  ];
  for (const c of candidates) {
    if (c && (c.startsWith("/") || /^[A-Za-z]:[\\/]/.test(c))) {
      return c;
    }
  }
  return undefined;
}

// Resolve a free-text project/repo hint to a concrete repo root path.
function resolveRepo(hint?: string): string | undefined {
  if (!hint) {
    return undefined;
  }
  const repos = listRepos();
  const lower = hint.toLowerCase();
  const match =
    repos.find((r) => r.repo === hint) ||
    repos.find((r) => r.name.toLowerCase() === lower) ||
    repos.find((r) => r.repo.toLowerCase().includes(lower));
  return match?.repo;
}

function resolveProjectId(project?: string): number | undefined {
  if (!project) {
    return undefined;
  }
  const all = listProjects();
  const lower = project.toLowerCase();
  const match =
    all.find((p) => p.path === project) ||
    all.find((p) => p.name.toLowerCase() === lower) ||
    all.find((p) => p.path.toLowerCase().includes(lower));
  return match?.id;
}

interface Scope {
  repo?: string;
  projectId?: number;
  label?: string;
  // True when a project scope was requested but couldn't be resolved to any
  // known repo/project (so the caller can show a friendly empty message).
  unresolved?: boolean;
}

function resolveScope(global: boolean, project?: string): Scope {
  if (global) {
    return { label: "all repos" };
  }
  const hint = project ?? currentWorkspace();
  if (!hint) {
    return { label: "all repos" }; // can't detect a workspace — search broadly
  }
  const repo = resolveRepo(hint);
  if (repo) {
    return { repo, label: repo.split("/").pop() || repo };
  }
  const projectId = resolveProjectId(hint);
  if (projectId !== undefined) {
    return { projectId, label: hint.split("/").pop() || hint };
  }
  return { unresolved: true, label: hint.split("/").pop() || hint };
}

// ---- Helpers --------------------------------------------------------------

// Parse an ISO 8601 date (or date-time) to epoch ms. Returns undefined on junk.
function parseDateMs(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const s = value.length === 10 ? `${value}T00:00:00` : value;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + " …" : t;
}

// Collapse near-duplicate hits within the same session: if two matches are
// within 2*contextSize messages of each other their context windows overlap,
// so keep only the higher-scored one. Mirrors total-recall's dedup.
function dedupeHits<T extends { sessionId: string; idx: number; score: number }>(
  hits: T[],
  contextSize: number,
): T[] {
  const bySession = new Map<string, T[]>();
  for (const h of hits) {
    const arr = bySession.get(h.sessionId);
    if (arr) {
      arr.push(h);
    } else {
      bySession.set(h.sessionId, [h]);
    }
  }
  const dist = 2 * Math.max(contextSize, 1);
  const out: T[] = [];
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.idx - b.idx);
    const kept: T[] = [];
    for (const h of arr) {
      const last = kept[kept.length - 1];
      if (last && h.idx - last.idx <= dist) {
        if (h.score > last.score) {
          kept[kept.length - 1] = h;
        }
      } else {
        kept.push(h);
      }
    }
    out.push(...kept);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function genHint(
  total: number,
  offset: number,
  count: number,
  pageSize: number,
  hasMore: boolean,
): string {
  if (total === 0) {
    return "No matches. Try different terms or kiro_recall_search_global.";
  }
  const start = offset + 1;
  const end = offset + count;
  if (hasMore) {
    return `Showing ${start}-${end} of ${total}. Use offset: ${offset + pageSize} for more.`;
  }
  if (start === 1) {
    return `Showing all ${total} matches.`;
  }
  return `Showing ${start}-${end} of ${total} (final page).`;
}

interface SearchArgs {
  query: string;
  project?: string;
  global?: boolean;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  contextSize?: number;
}

// A unified hit used after fusing FTS + vector results. Carries enough to
// render a context window and attribute the source signal(s).
interface FusedHit {
  sessionId: string;
  projectId?: number;
  projectName: string;
  title: string;
  idx: number;
  score: number; // fused RRF score (higher = better)
  sources: string[]; // which signals matched: "keyword" / "semantic"
}

// Reciprocal-rank fusion constant. Each ranked list contributes 1/(k+rank) to a
// hit's score. Robust because it needs only rank order, not comparable raw
// scores (bm25 vs cosine aren't on one scale).
const RRF_K = 60;

async function doSearch(args: SearchArgs): Promise<string> {
  const query = args.query.trim();
  if (!query) {
    return "Provide a search query.";
  }
  // Scope is now a SOFT signal only — it boosts ranking, never filters. Chats
  // are often logged under a different repo than the code they discuss, so
  // hard-scoping silently hid relevant memory. Retrieval is always global.
  const scope = resolveScope(args.global ?? false, args.project);
  const boostRepo = scope.repo;
  const boostProjectId = scope.projectId;

  const limit = args.limit ?? SEARCH_MAX_RESULTS;
  const offset = Math.max(args.offset ?? 0, 0);
  const contextSize = Math.min(Math.max(args.contextSize ?? SEARCH_CONTEXT_SIZE, 0), 5);
  const after = parseDateMs(args.after);
  const before = parseDateMs(args.before);

  // Pull both signals globally (no repo/project filter), then fuse.
  const want = (offset + limit) * 3;
  const { hits: ftsHits } = searchMessages(query, { limit: want, offset: 0, after, before });
  let semantic: Awaited<ReturnType<typeof vectorSearch>> = [];
  if (VECTOR_ENABLED) {
    semantic = await vectorSearch(query, { limit: want, after, before });
  }

  // Fuse via RRF, keyed by session+message so the same hit from both signals
  // reinforces instead of duplicating.
  const fused = new Map<string, FusedHit>();
  const bump = (
    key: string,
    base: Omit<FusedHit, "score" | "sources">,
    rank: number,
    src: string,
  ) => {
    const existing = fused.get(key);
    const inc = 1 / (RRF_K + rank);
    if (existing) {
      existing.score += inc;
      if (!existing.sources.includes(src)) {
        existing.sources.push(src);
      }
    } else {
      fused.set(key, { ...base, score: inc, sources: [src] });
    }
  };
  ftsHits.forEach((h, i) =>
    bump(
      `${h.sessionId}:${h.idx}`,
      { sessionId: h.sessionId, projectName: h.projectName, title: h.title, idx: h.idx },
      i,
      "keyword",
    ),
  );
  semantic.forEach((h, i) =>
    bump(
      `${h.sessionId}:${h.idx}`,
      {
        sessionId: h.sessionId,
        projectId: h.projectId,
        projectName: h.projectName,
        title: h.title,
        idx: h.idx,
      },
      i,
      "semantic",
    ),
  );

  // Soft scope boost: nudge hits from the current repo/project up without
  // excluding anything from other repos.
  const SCOPE_BOOST = 1 / (RRF_K + 1); // ~one extra top-rank vote
  if (boostRepo || boostProjectId !== undefined) {
    for (const h of fused.values()) {
      const inRepo = boostRepo ? repoHasSession(boostRepo, h.sessionId) : false;
      const inProject = boostProjectId !== undefined && h.projectId === boostProjectId;
      if (inRepo || inProject) {
        h.score += SCOPE_BOOST;
      }
    }
  }

  const ranked = dedupeHits([...fused.values()], contextSize);
  const total = ranked.length;
  const pageHits = ranked.slice(offset, offset + limit);
  const hasMore = offset + pageHits.length < total;

  const obs = searchObservations(query, 5);

  if (pageHits.length === 0 && obs.length === 0) {
    return `No memory found for "${query}".`;
  }

  const lines: string[] = [];
  lines.push(`# Recall: "${query}"${scope.label ? ` (boosted: ${scope.label})` : ""}`);

  if (obs.length) {
    lines.push("", "## Observations");
    for (const o of obs) {
      lines.push(`- [${o.kind}] (${o.projectName}) ${o.text}`);
    }
  }

  if (pageHits.length) {
    lines.push("", `## Matches`);
    for (const h of pageHits) {
      const tag = h.sources.join("+");
      lines.push("", `### "${h.title}" · ${h.projectName} · ${tag} [session:${h.sessionId}]`);
      const window = getMessageWindow(h.sessionId, h.idx, contextSize);
      for (const m of window) {
        const mark = m.idx === h.idx ? "» " : "  ";
        lines.push(`${mark}${m.role}: ${oneLine(m.text)}`);
      }
    }
  }

  lines.push("", `_${genHint(total, offset, pageHits.length, limit, hasMore)}_`);
  return lines.join("\n");
}

function doRecall(project?: string, limit = 10, global = false): string {
  const scope = resolveScope(global, project);
  if (scope.unresolved) {
    return `No past sessions found for "${scope.label}".`;
  }
  const sessions = scope.repo
    ? listSessionsByRepo(scope.repo, limit)
    : listSessions(scope.projectId, limit);
  if (sessions.length === 0) {
    return scope.label && scope.label !== "all repos"
      ? `No past sessions found for "${scope.label}".`
      : "No past sessions found.";
  }
  const lines = [`## Recent sessions${scope.label ? ` for ${scope.label}` : ""}`];
  for (const s of sessions) {
    const when = new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`- ${when} · "${s.title}" (${s.message_count} msgs) [session:${s.id}]`);
  }
  return lines.join("\n");
}

function doGetSession(sessionId: string): string {
  const session = getSession(sessionId);
  if (!session) {
    return `Session ${sessionId} not found.`;
  }
  const msgs = getMessages(sessionId);
  const lines = [`# ${session.title}`, `Project: ${session.project_path}`, ""];
  for (const m of msgs) {
    lines.push(`### ${m.role}`);
    lines.push(m.text.length > 2000 ? m.text.slice(0, 2000) + " …[truncated]" : m.text);
    lines.push("");
  }
  return lines.join("\n");
}

// Shared parameter schema for the two search tools.
const SEARCH_PARAMS = {
  query: { type: "string", description: "Keywords or a short phrase to search for" },
  after: {
    type: "string",
    description: "Only sessions on/after this date (inclusive). ISO 8601, e.g. 2025-01-15",
  },
  before: {
    type: "string",
    description: "Only sessions before this date (exclusive). ISO 8601, e.g. 2025-02-01",
  },
  limit: { type: "number", description: `Page size (default ${SEARCH_MAX_RESULTS})` },
  offset: { type: "number", description: "Skip this many results, for pagination (default 0)" },
  contextSize: {
    type: "number",
    description: `Messages of surrounding context per hit (default ${SEARCH_CONTEXT_SIZE}, max 5)`,
  },
};

const TOOLS = [
  {
    name: "kiro_recall_search_project",
    description:
      "Search past Kiro conversations for the CURRENT repo/workspace (auto-detected). " +
      "Use to recall how something in THIS codebase was done, decided, or fixed — e.g. " +
      "\"like we discussed\", \"how did we fix\", \"what did we decide about\", or before " +
      "touching an unfamiliar feature/file. Returns matches with surrounding context.",
    inputSchema: {
      type: "object",
      properties: {
        ...SEARCH_PARAMS,
        project: {
          type: "string",
          description:
            "Optional: override the auto-detected repo with a project name or path",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "kiro_recall_search_global",
    description:
      "Search past Kiro conversations across ALL repos and workspaces. Use for cross-project " +
      "recall: personal preferences, recurring patterns, or how something was solved in a " +
      "DIFFERENT project (\"what's my usual approach to…\", \"have we ever…\").",
    inputSchema: {
      type: "object",
      properties: { ...SEARCH_PARAMS },
      required: ["query"],
    },
  },
  {
    name: "kiro_recall_recall",
    description:
      "List recent conversation sessions for the current repo (or all repos with global=true). " +
      "Use at the start of work to recall recent context before diving in.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project name or path to scope to" },
        global: { type: "boolean", description: "List across all repos (default false)" },
        limit: { type: "number", description: "Max sessions (default 10)" },
      },
    },
  },
  {
    name: "kiro_recall_get_session",
    description:
      "Fetch the full transcript of a specific past session by id (the [session:…] id from a " +
      "search/recall result).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session id" },
      },
      required: ["sessionId"],
    },
  },
];

async function main(): Promise<void> {
  getDb(); // ensure schema exists (read-only use is fine if empty)

  // Install-once UX: when Kiro spawns this MCP server, make sure the background
  // daemon (scan + watch + UI) is alive. Best-effort, never blocks startup.
  ensureDaemonRunning()
    .then((r) => process.stderr.write(`kiro-recall: daemon ${r}\n`))
    .catch(() => {});

  // Warm the embedding model so the first semantic search isn't slow. No-op
  // unless vector search is enabled. Fire-and-forget.
  if (VECTOR_ENABLED) {
    preloadEmbedder();
  }

  const server = new Server(
    { name: "kiro-recall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    const num = (k: string): number | undefined =>
      typeof a[k] === "number" ? (a[k] as number) : undefined;
    const str = (k: string): string | undefined =>
      a[k] !== undefined ? String(a[k]) : undefined;

    let text = "";
    try {
      if (name === "kiro_recall_search_project" || name === "kiro_recall_search_global") {
        text = await doSearch({
          query: String(a.query ?? ""),
          project: str("project"),
          global: name === "kiro_recall_search_global",
          after: str("after"),
          before: str("before"),
          limit: num("limit"),
          offset: num("offset"),
          contextSize: num("contextSize"),
        });
      } else if (name === "kiro_recall_search") {
        // Back-compat: old single tool. Project scope if a project is given,
        // otherwise global.
        text = await doSearch({
          query: String(a.query ?? ""),
          project: str("project"),
          global: a.project === undefined,
          after: str("after"),
          before: str("before"),
          limit: num("limit"),
          offset: num("offset"),
          contextSize: num("contextSize"),
        });
      } else if (name === "kiro_recall_recall") {
        text = doRecall(str("project"), num("limit") ?? 10, a.global === true);
      } else if (name === "kiro_recall_get_session") {
        text = doGetSession(String(a.sessionId ?? ""));
      } else {
        text = `Unknown tool: ${name}`;
      }
    } catch (e) {
      text = `kiro-recall error: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { content: [{ type: "text", text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`kiro-recall mcp failed: ${e}\n`);
  process.exit(1);
});
