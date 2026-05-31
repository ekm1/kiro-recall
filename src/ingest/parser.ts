// Converts Kiro's raw session JSON into NormalizedSession.
//
// Source shapes (verified against live data):
//  - <sessionId>.json : {
//      sessionId, title, workspaceDirectory, sessionType, selectedModel,
//      defaultModelTitle, history: [ { message: { role, content } } ]
//    }
//    where content is either a string (assistant) or an array of parts
//    [{ type: "text", text }, ...] (user). Other part types tolerated.
//  - sessions.json : [ { sessionId, title, dateCreated, workspaceDirectory } ]
//
// Defensive by design: unknown shapes are skipped, never throw. If Kiro changes
// its schema, we degrade (fewer messages) instead of crashing the daemon.

import { createHash } from "crypto";
import type {
  NormalizedMessage,
  NormalizedSession,
  Role,
  SessionIndexEntry,
} from "../types.ts";
import { attributeRepos, type RepoRegistry } from "./repos.ts";

function toRole(raw: unknown): Role {
  switch (raw) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "bot":
      return "assistant";
    case "tool":
      return "tool";
    case "system":
      return "system";
    default:
      return "assistant";
  }
}

// Extract plain text from a message's `content`, which may be a string or an
// array of typed parts. Joins text parts; renders tool parts compactly.
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        out.push(p.text);
      } else if (typeof p.content === "string") {
        out.push(p.content);
      }
      // Unknown part types (images, tool blobs) contribute no searchable text.
    }
  }
  return out.join("\n");
}

// Kiro prepends a large injected system/identity prompt to (usually) the first
// user turn of a session. It's boilerplate, not conversation, and indexing it
// pollutes FTS + embeddings (every session would "match" on prompt text).
// Detect it conservatively: only skip when the message *starts with* one of
// these known leading markers, so we never drop real user content.
const SYSTEM_PROMPT_PREFIXES = [
  "<identity>",
  "<key_kiro_features>",
  "<goal>",
  "<rules>",
  "<system>",
  "You are Kiro,",
];

function isSystemPrompt(text: string): boolean {
  const head = text.trimStart();
  return SYSTEM_PROMPT_PREFIXES.some((p) => head.startsWith(p));
}

function hashMessages(messages: NormalizedMessage[]): string {
  const h = createHash("sha256");
  for (const m of messages) {
    h.update(m.role);
    h.update("\u0000");
    h.update(m.text);
    h.update("\u0001");
  }
  return h.digest("hex").slice(0, 32);
}

// Parse a <sessionId>.json transcript file. Returns null if it is not a usable
// transcript (e.g. it's the sessions.json index, or malformed).
export function parseSessionFile(
  raw: unknown,
  projectPathFallback: string,
  fileMtimeMs: number,
  registry: RepoRegistry,
): NormalizedSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const history = obj.history;
  if (!Array.isArray(history)) {
    return null; // not a transcript
  }

  const sessionId =
    typeof obj.sessionId === "string" && obj.sessionId.length > 0
      ? obj.sessionId
      : null;
  if (!sessionId) {
    return null;
  }

  const messages: NormalizedMessage[] = [];
  let idx = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const m = message as Record<string, unknown>;
    const text = extractText(m.content).trim();
    if (text.length === 0) {
      continue; // skip empty/tool-only frames from the searchable record
    }
    if (isSystemPrompt(text)) {
      continue; // skip Kiro's injected system/identity prompt (not conversation)
    }
    messages.push({ idx: idx++, role: toRole(m.role), text });
  }

  const projectPath =
    typeof obj.workspaceDirectory === "string" && obj.workspaceDirectory.length > 0
      ? obj.workspaceDirectory
      : typeof obj.workspacePath === "string" && obj.workspacePath.length > 0
        ? (obj.workspacePath as string)
        : projectPathFallback;

  const title =
    typeof obj.title === "string" && obj.title.length > 0
      ? obj.title
      : firstUserLine(messages) || sessionId;

  const model =
    typeof obj.defaultModelTitle === "string"
      ? obj.defaultModelTitle
      : typeof obj.selectedModel === "string"
        ? (obj.selectedModel as string)
        : null;

  const sessionType =
    typeof obj.sessionType === "string" ? (obj.sessionType as string) : null;

  // Method 2: attribute repos by scanning transcript text for file paths that
  // fall under known repo roots. Multi-tag: a chat belongs to every repo it
  // meaningfully touched. Primary = most-referenced; fallback to projectPath.
  const attribution = attributeRepos(
    messages.map((m) => m.text),
    registry,
  );
  const repos = [...attribution.counts.entries()]
    .map(([path, refCount]) => ({ path, refCount }))
    .sort((a, b) => b.refCount - a.refCount);
  const primaryRepo = repos.length > 0 ? repos[0].path : projectPath;

  return {
    sessionId,
    projectPath,
    title: title.slice(0, 300),
    sessionType,
    model,
    createdAt: fileMtimeMs, // refined from sessions.json index when available
    updatedAt: fileMtimeMs,
    messages,
    contentHash: hashMessages(messages),
    repos,
    primaryRepo,
  };
}

function firstUserLine(messages: NormalizedMessage[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first) {
    return null;
  }
  return first.text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? null;
}

// Parse the sessions.json index (per-project). Returns [] on any problem.
export function parseSessionIndex(raw: unknown): SessionIndexEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionIndexEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    if (typeof o.sessionId !== "string") {
      continue;
    }
    out.push({
      sessionId: o.sessionId,
      title: typeof o.title === "string" ? o.title : o.sessionId,
      dateCreated: Number(o.dateCreated) || 0,
      workspaceDirectory:
        typeof o.workspaceDirectory === "string" ? o.workspaceDirectory : "",
    });
  }
  return out;
}
