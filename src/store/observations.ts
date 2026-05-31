// Observation persistence (optional LLM-derived summaries). Reads are always
// safe (return [] when none). Writes used only by the summarize layer.

import { getDb } from "./db.ts";

export interface ObservationRow {
  id: number;
  session_id: string;
  project_id: number;
  kind: string;
  text: string;
  created_at: number;
}

export function listObservations(sessionId: string): ObservationRow[] {
  return getDb()
    .query("SELECT * FROM observations WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId) as ObservationRow[];
}

export function replaceObservations(
  sessionId: string,
  projectId: number,
  items: Array<{ kind: string; text: string }>,
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    // keep observations_fts in sync
    const old = db
      .query("SELECT id, text FROM observations WHERE session_id = ?")
      .all(sessionId) as Array<{ id: number; text: string }>;
    for (const r of old) {
      db.query(
        "INSERT INTO observations_fts(observations_fts, rowid, text) VALUES('delete', ?, ?)",
      ).run(r.id, r.text);
    }
    db.query("DELETE FROM observations WHERE session_id = ?").run(sessionId);

    const insert = db.query(
      "INSERT INTO observations(session_id, project_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    );
    const now = Date.now();
    for (const it of items) {
      const row = insert.get(sessionId, projectId, it.kind, it.text, now) as {
        id: number;
      };
      db.query("INSERT INTO observations_fts(rowid, text) VALUES (?, ?)").run(
        row.id,
        it.text,
      );
    }
  });
  tx();
}

export function searchObservations(query: string, limit = 20) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
  if (!tokens) {
    return [];
  }
  try {
    return getDb()
      .query(
        `SELECT o.session_id AS sessionId, o.kind AS kind, o.text AS text,
                p.path AS projectPath, p.name AS projectName
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         JOIN projects p ON p.id = o.project_id
         WHERE observations_fts MATCH ?
         ORDER BY bm25(observations_fts) ASC
         LIMIT ?`,
      )
      .all(tokens, limit) as Array<{
      sessionId: string;
      kind: string;
      text: string;
      projectPath: string;
      projectName: string;
    }>;
  } catch {
    return [];
  }
}
