// MCP stdio server — exposes recall tools to Kiro's agent.
//
// Tools:
//   kiro_recall_search(query, project?, limit?)  -> matching past messages/observations
//   kiro_recall_recall(project?, limit?)         -> recent sessions/decisions for a project
//   kiro_recall_get_session(sessionId)           -> full transcript of one session
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
  getSession,
} from "../store/sessions.ts";
import { VECTOR_ENABLED } from "../config.ts";
import { vectorSearch } from "../search/vector.ts";
import { ensureDaemonRunning } from "../daemon-manager.ts";

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

async function doSearch(query: string, project?: string, limit = 15): Promise<string> {
  const repo = resolveRepo(project);
  const projectId = repo ? undefined : resolveProjectId(project);
  const kw = searchMessages(query, { repo, projectId, limit });
  const obs = searchObservations(query, Math.min(limit, 10));
  let semantic: Array<{ sessionId: string; title: string; snippet: string }> = [];
  if (VECTOR_ENABLED) {
    semantic = await vectorSearch(query, { projectId, limit: Math.min(limit, 10) });
  }

  if (kw.length === 0 && obs.length === 0 && semantic.length === 0) {
    return `No memory found for "${query}".`;
  }

  const lines: string[] = [];
  if (obs.length) {
    lines.push("## Observations");
    for (const o of obs) {
      lines.push(`- [${o.kind}] (${o.projectName}) ${o.text}`);
    }
  }
  if (kw.length) {
    lines.push("## Conversation matches");
    for (const h of kw) {
      lines.push(
        `- (${h.projectName}) "${h.title}" — ${h.role}: ${h.snippet}  [session:${h.sessionId}]`,
      );
    }
  }
  if (semantic.length) {
    lines.push("## Semantically related");
    for (const s of semantic) {
      lines.push(`- "${s.title}": ${s.snippet}  [session:${s.sessionId}]`);
    }
  }
  return lines.join("\n");
}

function doRecall(project?: string, limit = 10): string {
  // Prefer repo-based recall (method 2): sessions that actually touched the repo.
  const repo = resolveRepo(project);
  const sessions = repo
    ? listSessionsByRepo(repo, limit)
    : listSessions(resolveProjectId(project), limit);
  if (sessions.length === 0) {
    return project
      ? `No past sessions found for "${project}".`
      : "No past sessions found.";
  }
  const label = repo ? repo.split("/").pop() : project;
  const lines = [`## Recent sessions${label ? ` for ${label}` : ""}`];
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

const TOOLS = [
  {
    name: "kiro_recall_search",
    description:
      "Search past Kiro conversations and derived observations across projects. Use to recall how something was done, decided, or fixed before.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        project: {
          type: "string",
          description: "Optional project name or path to scope the search",
        },
        limit: { type: "number", description: "Max results (default 15)" },
      },
      required: ["query"],
    },
  },
  {
    name: "kiro_recall_recall",
    description:
      "List recent conversation sessions for a project (or all). Use at the start of work to recall recent context.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project name or path" },
        limit: { type: "number", description: "Max sessions (default 10)" },
      },
    },
  },
  {
    name: "kiro_recall_get_session",
    description: "Fetch the full transcript of a specific past session by id.",
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

  const server = new Server(
    { name: "kiro-recall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    let text = "";
    try {
      if (name === "kiro_recall_search") {
        text = await doSearch(
          String(a.query ?? ""),
          a.project ? String(a.project) : undefined,
          typeof a.limit === "number" ? a.limit : undefined,
        );
      } else if (name === "kiro_recall_recall") {
        text = doRecall(
          a.project ? String(a.project) : undefined,
          typeof a.limit === "number" ? a.limit : undefined,
        );
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
