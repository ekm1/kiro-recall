// SQLite store using bun:sqlite. Schema + migrations live here.
// The DB is a *derived* index — disposable and rebuildable from Kiro's files.

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { DB_PATH } from "../config.ts";

let db: Database | null = null;

export function getDb(): Database {
  if (db) {
    return db;
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      session_type TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      primary_repo TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    -- Repos a session actually touched (method 2 attribution). Many-to-many:
    -- one session can belong to several repos.
    CREATE TABLE IF NOT EXISTS session_repos (
      session_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      ref_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, repo),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_repos_repo ON session_repos(repo);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, idx);

    -- FTS5 over message text. External-content table mirrors messages.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      text,
      content='observations',
      content_rowid='id'
    );

    -- Tracks last successful full scan etc.
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Additive migration for DBs created before primary_repo existed.
  const cols = d.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "primary_repo")) {
    d.exec("ALTER TABLE sessions ADD COLUMN primary_repo TEXT;");
  }
  d.exec("CREATE INDEX IF NOT EXISTS idx_sessions_primary_repo ON sessions(primary_repo);");
}

export function setMeta(key: string, value: string): void {
  getDb()
    .query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getMeta(key: string): string | null {
  const row = getDb().query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

// For --rebuild: wipe derived data, keep schema.
export function wipeAll(): void {
  const d = getDb();
  d.exec(`
    DELETE FROM observations;
    DELETE FROM session_repos;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM projects;
    INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
    INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
  `);
}
