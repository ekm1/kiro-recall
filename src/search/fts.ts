// Keyword search over message text via FTS5. Always available, zero deps.

import { getDb } from "../store/db.ts";

export interface SearchHit {
  sessionId: string;
  projectPath: string;
  projectName: string;
  title: string;
  role: string;
  idx: number;
  snippet: string;
  updatedAt: number;
}

// Escape a user query into a safe FTS5 MATCH string. We quote each token so
// punctuation in the query can't produce FTS syntax errors.
function toMatchQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, "").trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return tokens.join(" ");
}

export function searchMessages(
  query: string,
  opts: { projectId?: number; repo?: string; limit?: number } = {},
): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) {
    return [];
  }
  const limit = opts.limit ?? 30;
  const db = getDb();

  const params: Array<string | number> = [match];
  const filters: string[] = [];
  let repoJoin = "";
  if (opts.repo !== undefined) {
    repoJoin = "JOIN session_repos sr ON sr.session_id = s.id";
    filters.push("sr.repo = ?");
    params.push(opts.repo);
  }
  if (opts.projectId !== undefined) {
    filters.push("s.project_id = ?");
    params.push(opts.projectId);
  }
  const whereExtra = filters.length ? "AND " + filters.join(" AND ") : "";
  params.push(limit);

  try {
    return db
      .query(
        `SELECT
            s.id AS sessionId,
            p.path AS projectPath,
            p.name AS projectName,
            s.title AS title,
            m.role AS role,
            m.idx AS idx,
            snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet,
            s.updated_at AS updatedAt
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
         ${repoJoin}
         WHERE messages_fts MATCH ? ${whereExtra}
         ORDER BY bm25(messages_fts) ASC
         LIMIT ?`,
      )
      .all(...params) as SearchHit[];
  } catch {
    return [];
  }
}
