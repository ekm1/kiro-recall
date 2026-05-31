// Normalized domain types. The parser converts Kiro's raw JSON into these;
// everything downstream (store, search, api, mcp) speaks only these shapes.

export type Role = "user" | "assistant" | "tool" | "system";

export interface NormalizedMessage {
  idx: number;
  role: Role;
  text: string;
}

export interface RepoTag {
  path: string; // absolute repo root
  refCount: number; // how many file-path references pointed into this repo
}

export interface NormalizedSession {
  sessionId: string;
  projectPath: string; // Kiro's primary workspace root (fallback grouping)
  title: string;
  sessionType: string | null;
  model: string | null;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms (file mtime)
  messages: NormalizedMessage[];
  contentHash: string; // hash of messages, for idempotent upsert
  repos: RepoTag[]; // repos the chat actually touched (method 2 attribution)
  primaryRepo: string; // most-referenced repo, or projectPath fallback
}

export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  dateCreated: number;
  workspaceDirectory: string;
}
