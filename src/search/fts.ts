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
  // Relevance: derived from bm25 (higher = better). Note this is *not* on the
  // same scale as vector cosine scores; the two are presented separately.
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number; // total matches ignoring limit/offset (capped by the query)
}

export interface SearchOpts {
  projectId?: number;
  repo?: string;
  limit?: number;
  offset?: number;
  after?: number; // epoch ms, inclusive (session updated_at >= after)
  before?: number; // epoch ms, exclusive (session updated_at < before)
}

// Tokenize + quote a user query into safe FTS5 prefix terms. Quoting each token
// means punctuation in the query can't produce FTS syntax errors.
function toTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, "").trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
}

// Build an FTS5 MATCH string. Default joiner is a space (implicit AND).
function toMatchQuery(query: string, joiner: " " | " OR " = " "): string {
  return toTerms(query).join(joiner);
}

export function searchMessages(query: string, opts: SearchOpts = {}): SearchResult {
  const terms = toTerms(query);
  if (terms.length === 0) {
    return { hits: [], total: 0 };
  }
  // Precision-first: try implicit-AND (all terms must match). If that yields
  // nothing AND there are multiple terms, retry with OR so long natural-language
  // queries still recall relevant chats instead of returning empty.
  const andResult = runMatch(toMatchQuery(query), opts);
  if (andResult.total > 0 || terms.length < 2) {
    return andResult;
  }
  return runMatch(toMatchQuery(query, " OR "), opts);
}

function runMatch(match: string, opts: SearchOpts): SearchResult {
  if (!match) {
    return { hits: [], total: 0 };
  }
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;
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
  if (opts.after !== undefined) {
    filters.push("s.updated_at >= ?");
    params.push(opts.after);
  }
  if (opts.before !== undefined) {
    filters.push("s.updated_at < ?");
    params.push(opts.before);
  }
  const whereExtra = filters.length ? "AND " + filters.join(" AND ") : "";
  // params currently holds [match, ...filterValues] — reused by the count query.
  const matchAndFilterParams = [...params];
  params.push(limit, offset);

  try {
    // Total is computed separately: FTS5 auxiliary functions (bm25/snippet)
    // cannot be combined with window functions like COUNT(*) OVER() in one query.
    const countRow = db
      .query(
        `SELECT COUNT(*) AS total
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_id
           ${repoJoin}
           WHERE messages_fts MATCH ? ${whereExtra}`,
      )
      .get(...matchAndFilterParams) as { total: number } | undefined;
    const total = countRow?.total ?? 0;

    const rows = db
      .query(
        `SELECT
            s.id AS sessionId,
            p.path AS projectPath,
            p.name AS projectName,
            s.title AS title,
            m.role AS role,
            m.idx AS idx,
            snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet,
            s.updated_at AS updatedAt,
            bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
         ${repoJoin}
         WHERE messages_fts MATCH ? ${whereExtra}
         ORDER BY bm25(messages_fts) ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params) as Array<Omit<SearchHit, "score"> & { rank: number }>;

    const hits: SearchHit[] = rows.map(({ rank, ...rest }) => ({
      ...rest,
      // bm25 is lower-is-better (often negative); negate for a higher-is-better
      // score that preserves ordering. Rounded for stable display.
      score: Math.round(-rank * 10000) / 10000,
    }));
    return { hits, total };
  } catch {
    return { hits: [], total: 0 };
  }
}
