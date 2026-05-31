// Optional semantic search via sqlite-vec + a local embedding model.
//
// Design choice (coupling invariant): vector search is a pure enhancement.
// When KIRO_RECALL_VECTOR is off, or the optional deps aren't installed, every
// function here is a safe no-op. The product fully works on FTS alone.
//
// We deliberately avoid uvx/python/chroma (the cold-start failure mode that
// motivated this rebuild). Embeddings come from a JS-native model via
// Transformers.js if available; otherwise vector search silently disables.

import { VECTOR_ENABLED } from "../config.ts";
import { log } from "../log.ts";
import { getDb } from "../store/db.ts";

let embedder: ((text: string) => Promise<Float32Array>) | null = null;
let initTried = false;
let available = false;

// Lazily load the embedding backend. Best-effort: failure => disabled.
async function ensureEmbedder(): Promise<boolean> {
  if (!VECTOR_ENABLED) {
    return false;
  }
  if (initTried) {
    return available;
  }
  initTried = true;
  try {
    // Dynamic import so the dependency is optional at install time.
    const mod: any = await import("@xenova/transformers").catch(() => null);
    if (!mod) {
      log.warn("VECTOR", "@xenova/transformers not installed; vector search disabled");
      return false;
    }
    const pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    embedder = async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      return Float32Array.from(out.data as number[]);
    };
    ensureVectorTable();
    available = true;
    log.info("VECTOR", "embedder ready (all-MiniLM-L6-v2)");
  } catch (e) {
    log.warn("VECTOR", "init failed; vector search disabled", { error: String(e) });
    available = false;
  }
  return available;
}

function ensureVectorTable(): void {
  // Plain table of embeddings; cosine computed in JS. Avoids a native sqlite-vec
  // build dependency while keeping the option open to upgrade later.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
  `);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // vectors are normalized => dot product == cosine similarity
}

// Index any messages lacking an embedding. Called by the summarize/runner or
// on demand. Bounded batch to avoid long stalls.
export async function indexPendingVectors(batch = 200): Promise<number> {
  if (!(await ensureEmbedder()) || !embedder) {
    return 0;
  }
  const db = getDb();
  const rows = db
    .query(
      `SELECT m.id, m.session_id, s.project_id, m.text
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.id NOT IN (SELECT message_id FROM message_vectors)
       LIMIT ?`,
    )
    .all(batch) as Array<{
    id: number;
    session_id: string;
    project_id: number;
    text: string;
  }>;

  let done = 0;
  for (const r of rows) {
    try {
      const v = await embedder(r.text.slice(0, 2000));
      db.query(
        "INSERT OR REPLACE INTO message_vectors(message_id, session_id, project_id, dim, vec) VALUES (?, ?, ?, ?, ?)",
      ).run(r.id, r.session_id, r.project_id, v.length, Buffer.from(v.buffer));
      done++;
    } catch {
      // skip this message
    }
  }
  return done;
}

export async function vectorSearch(
  query: string,
  opts: { projectId?: number; limit?: number } = {},
): Promise<Array<{ sessionId: string; title: string; snippet: string }>> {
  if (!(await ensureEmbedder()) || !embedder) {
    return [];
  }
  const db = getDb();
  const qv = await embedder(query);

  const params: Array<number> = [];
  let filter = "";
  if (opts.projectId !== undefined) {
    filter = "WHERE mv.project_id = ?";
    params.push(opts.projectId);
  }
  const rows = db
    .query(
      `SELECT mv.message_id, mv.session_id, mv.vec, m.text, s.title
       FROM message_vectors mv
       JOIN messages m ON m.id = mv.message_id
       JOIN sessions s ON s.id = mv.session_id
       ${filter}`,
    )
    .all(...params) as Array<{
    message_id: number;
    session_id: string;
    vec: Uint8Array;
    text: string;
    title: string;
  }>;

  const scored = rows.map((r) => {
    const v = new Float32Array(
      r.vec.buffer,
      r.vec.byteOffset,
      r.vec.byteLength / 4,
    );
    return { r, score: cosine(qv, v) };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, opts.limit ?? 10).map(({ r }) => ({
    sessionId: r.session_id,
    title: r.title,
    snippet: r.text.slice(0, 160).replace(/\s+/g, " "),
  }));
}
