// Session/message persistence. Idempotent upsert keyed by sessionId; skips work
// when content_hash is unchanged (timing invariant: re-scans are no-ops).

import { basename } from "path";
import { getDb } from "./db.ts";
import type { NormalizedSession } from "../types.ts";

function projectName(path: string): string {
  return basename(path) || path;
}

export function upsertProject(path: string, seenAt: number): number {
  const db = getDb();
  db.query(
    `INSERT INTO projects(path, name, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`,
  ).run(path, projectName(path), seenAt);
  const row = db.query("SELECT id FROM projects WHERE path = ?").get(path) as
    | { id: number }
    | undefined;
  return row!.id;
}

// Returns true if the session was inserted/updated, false if skipped (unchanged).
export function upsertSession(session: NormalizedSession): boolean {
  const db = getDb();
  const projectId = upsertProject(session.projectPath, session.updatedAt);

  const existing = db
    .query("SELECT content_hash FROM sessions WHERE id = ?")
    .get(session.sessionId) as { content_hash: string } | undefined;

  if (existing && existing.content_hash === session.contentHash) {
    return false; // unchanged — idempotent skip
  }

  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO sessions
         (id, project_id, title, session_type, model, created_at, updated_at, message_count, content_hash, primary_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         title = excluded.title,
         session_type = excluded.session_type,
         model = excluded.model,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         message_count = excluded.message_count,
         content_hash = excluded.content_hash,
         primary_repo = excluded.primary_repo`,
    ).run(
      session.sessionId,
      projectId,
      session.title,
      session.sessionType,
      session.model,
      session.createdAt,
      session.updatedAt,
      session.messages.length,
      session.contentHash,
      session.primaryRepo,
    );

    // Replace repo tags.
    db.query("DELETE FROM session_repos WHERE session_id = ?").run(session.sessionId);
    const insertRepo = db.query(
      "INSERT INTO session_repos(session_id, repo, ref_count) VALUES (?, ?, ?)",
    );
    for (const r of session.repos) {
      insertRepo.run(session.sessionId, r.path, r.refCount);
    }

    // Replace messages wholesale (transcripts are append-mostly but cheap to redo).
    // Keep FTS in sync via explicit delete+insert against the external-content table.
    const oldRows = db
      .query("SELECT id FROM messages WHERE session_id = ?")
      .all(session.sessionId) as Array<{ id: number }>;
    for (const r of oldRows) {
      db.query("INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', ?, (SELECT text FROM messages WHERE id = ?))").run(
        r.id,
        r.id,
      );
    }
    db.query("DELETE FROM messages WHERE session_id = ?").run(session.sessionId);

    const insert = db.query(
      "INSERT INTO messages(session_id, idx, role, text) VALUES (?, ?, ?, ?) RETURNING id",
    );
    for (const m of session.messages) {
      const row = insert.get(session.sessionId, m.idx, m.role, m.text) as {
        id: number;
      };
      db.query("INSERT INTO messages_fts(rowid, text) VALUES (?, ?)").run(
        row.id,
        m.text,
      );
    }
  });
  tx();
  return true;
}

// Refine created_at from the sessions.json index (authoritative timestamp).
export function applyIndexTimestamp(sessionId: string, dateCreated: number): void {
  if (!dateCreated) {
    return;
  }
  getDb()
    .query("UPDATE sessions SET created_at = ? WHERE id = ? AND ? > 0")
    .run(dateCreated, sessionId, dateCreated);
}

// ---- Queries for API / MCP ----

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  session_count: number;
  last_seen: number;
}

export function listProjects(): ProjectRow[] {
  return getDb()
    .query(
      `SELECT p.id, p.path, p.name, p.last_seen,
              COUNT(s.id) AS session_count
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY p.last_seen DESC`,
    )
    .all() as ProjectRow[];
}

export interface SessionRow {
  id: string;
  project_id: number;
  project_path: string;
  title: string;
  session_type: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export function listSessions(projectId?: number, limit = 200): SessionRow[] {
  const db = getDb();
  if (projectId !== undefined) {
    return db
      .query(
        `SELECT s.*, p.path AS project_path FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.project_id = ?
         ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as SessionRow[];
  }
  return db
    .query(
      `SELECT s.*, p.path AS project_path FROM sessions s
       JOIN projects p ON p.id = s.project_id
       ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(limit) as SessionRow[];
}

export interface MessageRow {
  id: number;
  session_id: string;
  idx: number;
  role: string;
  text: string;
}

export function getMessages(sessionId: string): MessageRow[] {
  return getDb()
    .query("SELECT * FROM messages WHERE session_id = ? ORDER BY idx ASC")
    .all(sessionId) as MessageRow[];
}

export function getSession(sessionId: string): SessionRow | null {
  return (
    (getDb()
      .query(
        `SELECT s.*, p.path AS project_path FROM sessions s
         JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined) ?? null
  );
}

export function counts(): { projects: number; sessions: number; messages: number } {
  const db = getDb();
  const p = db.query("SELECT COUNT(*) AS c FROM projects").get() as { c: number };
  const s = db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
  const m = db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
  return { projects: p.c, sessions: s.c, messages: m.c };
}

// ---- Repo-centric views (method 2: group by repo actually touched) ----

export interface RepoListRow {
  repo: string;
  name: string;
  session_count: number;
}

function repoName(path: string): string {
  return basename(path) || path;
}

// All repos that any session touched, with how many sessions touched each.
export function listRepos(): RepoListRow[] {
  const rows = getDb()
    .query(
      `SELECT repo, COUNT(DISTINCT session_id) AS session_count
       FROM session_repos
       GROUP BY repo
       ORDER BY session_count DESC`,
    )
    .all() as Array<{ repo: string; session_count: number }>;
  return rows.map((r) => ({
    repo: r.repo,
    name: repoName(r.repo),
    session_count: r.session_count,
  }));
}

// Sessions that touched a given repo, most-recent first.
export function listSessionsByRepo(repo: string, limit = 200): SessionRow[] {
  return getDb()
    .query(
      `SELECT s.*, p.path AS project_path FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN session_repos sr ON sr.session_id = s.id
       WHERE sr.repo = ?
       ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(repo, limit) as SessionRow[];
}

export interface SessionRepoRow {
  repo: string;
  ref_count: number;
}

export function getSessionRepos(sessionId: string): SessionRepoRow[] {
  return getDb()
    .query(
      "SELECT repo, ref_count FROM session_repos WHERE session_id = ? ORDER BY ref_count DESC",
    )
    .all(sessionId) as SessionRepoRow[];
}
