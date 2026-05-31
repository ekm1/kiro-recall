// Parse Kiro's per-execution *.chat files into NormalizedSession.
//
// Why this exists: the workspace-session transcripts (<sessionId>.json) store
// the assistant turn's content as a short stub ("On it."). The real agent
// output — reasoning + tool calls — lives in separate *.chat files. This is
// the same source danilop/kiro-total-recall reads; we ingest it too so recall
// surfaces actual answers instead of the stub.
//
// Faithful to danilop's tolerant parsing (multiple container keys, role/content
// fallbacks, skip <identity>/empty), but we additionally run method-2 repo
// attribution over the content so these sessions group under the repo they
// actually touched — instead of danilop's "parent directory name" heuristic.
//
// Defensive by design: unknown shapes return null, never throw.

import { basename, dirname } from "path";
import type { NormalizedMessage, NormalizedSession } from "../types.ts";
import { extractText, hashMessages, isSystemPrompt, toRole } from "./parser.ts";
import { attributeRepos, type RepoRegistry } from "./repos.ts";

// Pull the message array out of a .chat file, tolerating the shapes danilop
// handles: { chat: [...] } | { messages: [...] } | { history: [...] } |
// { conversation: { messages: [...] } } | a bare array.
function extractMessageList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.chat)) {
    return o.chat;
  }
  if (Array.isArray(o.messages)) {
    return o.messages;
  }
  if (Array.isArray(o.history)) {
    return o.history;
  }
  const conv = o.conversation;
  if (conv && typeof conv === "object" && Array.isArray((conv as Record<string, unknown>).messages)) {
    return (conv as Record<string, unknown>).messages as unknown[];
  }
  return null;
}

function firstUserLine(messages: NormalizedMessage[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first) {
    return null;
  }
  return first.text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? null;
}

export function parseChatFile(
  raw: unknown,
  filePath: string,
  fileMtimeMs: number,
  registry: RepoRegistry,
): NormalizedSession | null {
  const list = extractMessageList(raw);
  if (!list) {
    return null;
  }

  const messages: NormalizedMessage[] = [];
  let idx = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const m = entry as Record<string, unknown>;
    const nested =
      m.message && typeof m.message === "object"
        ? (m.message as Record<string, unknown>)
        : undefined;

    // Role/content may sit on the entry directly or on a nested `message`.
    const rawRole = m.role ?? m.type ?? nested?.role;
    const rawContent = m.content ?? m.text ?? nested?.content ?? nested?.text ?? m.message;

    const text = extractText(rawContent).trim();
    if (text.length === 0) {
      continue; // tool blobs / non-text parts contribute no searchable text
    }
    if (isSystemPrompt(text)) {
      continue; // skip injected system/identity prompts
    }
    messages.push({ idx: idx++, role: toRole(rawRole), text });
  }

  if (messages.length === 0) {
    return null;
  }

  // Namespace the id so a .chat-derived session never collides with a
  // transcript session in the store.
  const stem = basename(filePath).replace(/\.chat$/i, "");
  const sessionId = `chat:${stem}`;

  // Method-2 attribution from file paths mentioned in the content.
  const attribution = attributeRepos(
    messages.map((msg) => msg.text),
    registry,
  );
  const repos = [...attribution.counts.entries()]
    .map(([path, refCount]) => ({ path, refCount }))
    .sort((a, b) => b.refCount - a.refCount);

  // Group under the touched repo when known; else fall back to the parent dir
  // (danilop's heuristic) so the session still lands somewhere coherent.
  const parentDirName = basename(dirname(filePath)) || "agent-sessions";
  const projectPath = repos.length > 0 ? repos[0].path : parentDirName;
  const primaryRepo = repos.length > 0 ? repos[0].path : projectPath;

  const title = firstUserLine(messages) || `agent session ${stem.slice(0, 8)}`;

  return {
    sessionId,
    projectPath,
    title: title.slice(0, 300),
    sessionType: "agent-execution",
    model: null,
    createdAt: fileMtimeMs, // .chat files carry no reliable per-message ts here
    updatedAt: fileMtimeMs,
    messages,
    contentHash: hashMessages(messages),
    repos,
    primaryRepo,
  };
}
