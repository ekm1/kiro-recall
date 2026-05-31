// Optional semantic search via a local embedding model + a plain SQLite vector
// table (cosine in JS). No uvx/python/chroma.
//
// Design choice (coupling invariant): vector search is a pure enhancement.
// When KIRO_RECALL_VECTOR is off, or the optional deps aren't installed, every
// function here is a safe no-op. The product fully works on FTS alone.

import { createHash } from "crypto";
import { SEARCH_THRESHOLD, VECTOR_ENABLED } from "../config.ts";
import { log } from "../log.ts";
import { getDb } from "../store/db.ts";

// Single-text and batch embedders. Both produce L2-normalized vectors so a dot
// product equals cosine similarity.
let embedOne: ((text: string) => Promise<Float32Array>) | null = null;
let embedMany: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
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
    // @ts-ignore optional peer dep — only resolvable when the user installs it.
    const mod: any = await import("@xenova/transformers").catch(() => null);
    if (!mod) {
      log.warn("VECTOR", "@xenova/transformers not installed; vector search disabled");
      return false;
    }
    const pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    embedOne = async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      return Float32Array.from(out.data as number[]);
    };
    embedMany = async (texts: string[]) => {
      if (texts.length === 0) {
        return [];
      }
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      const data = out.data as Float32Array | number[];
      const dim = out.dims[out.dims.length - 1] as number;
      const result: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        result.push(Float32Array.from((data as any).slice(i * dim, (i + 1) * dim)));
      }
      return result;
    };
    ensureVectorTables();
    available = true;
    log.info("VECTOR", "embedder ready (all-MiniLM-L6-v2)");
  } catch (e) {
    log.warn("VECTOR", "init failed; vector search disabled", { error: String(e) });
    available = false;
  }
  return available;
}

// Warm the model in the background so the first real query/index isn't slow.
// Fire-and-forget; safe no-op when vector search is disabled.
export function preloadEmbedder(): void {
  if (!VECTOR_ENABLED) {
    return;
  }
  void ensureEmbedder().then((ok) => {
    if (ok) {
      log.info("VECTOR", "embedder preloaded");
    }
  });
}

function ensureVectorTables(): void {
  // message_vectors: per-message embedding. vector_cache: embedding keyed by a
  // hash of the (truncated) text, so identical messages embed only once.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vector_cache (
      text_hash TEXT PRIMARY KEY,
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

function embedText(text: string): string {
  return text.slice(0, 2000);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// Index any messages lacking an embedding. Batches the embed call and reuses
// cached embeddings for identical text. Bounded batch to avoid long stalls.
export async function indexPendingVectors(batch = 200): Promise<number> {
  if (!(await ensureEmbedder()) || !embedMany) {
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
  if (rows.length === 0) {
    return 0;
  }

  // Resolve each row's embedding hash; collect the unique misses to embed once.
  const getCache = db.query("SELECT vec, dim FROM vector_cache WHERE text_hash = ?");
  const putCache = db.query(
    "INSERT OR REPLACE INTO vector_cache(text_hash, dim, vec) VALUES (?, ?, ?)",
  );
  const insertVec = db.query(
    "INSERT OR REPLACE INTO message_vectors(message_id, session_id, project_id, dim, vec) VALUES (?, ?, ?, ?, ?)",
  );

  const vecByHash = new Map<string, Float32Array>();
  const rowHashes: string[] = [];
  const missTexts: string[] = [];
  const missHashes: string[] = [];

  for (const r of rows) {
    const t = embedText(r.text);
    const h = hashText(t);
    rowHashes.push(h);
    if (vecByHash.has(h)) {
      continue;
    }
    const cached = getCache.get(h) as { vec: Uint8Array; dim: number } | undefined;
    if (cached) {
      vecByHash.set(
        h,
        new Float32Array(cached.vec.buffer, cached.vec.byteOffset, cached.vec.byteLength / 4),
      );
    } else if (!missHashes.includes(h)) {
      missHashes.push(h);
      missTexts.push(t);
    }
  }

  // Embed all cache-misses in chunks, then persist to the cache.
  const CHUNK = 32;
  for (let i = 0; i < missTexts.length; i += CHUNK) {
    const slice = missTexts.slice(i, i + CHUNK);
    let vecs: Float32Array[];
    try {
      vecs = await embedMany(slice);
    } catch {
      continue; // skip this chunk on failure
    }
    for (let j = 0; j < slice.length; j++) {
      const h = missHashes[i + j];
      const v = vecs[j];
      if (!v) {
        continue;
      }
      vecByHash.set(h, v);
      try {
        putCache.run(h, v.length, Buffer.from(v.buffer));
      } catch {
        // cache write is best-effort
      }
    }
  }

  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const v = vecByHash.get(rowHashes[i]);
    if (!v) {
      continue;
    }
    try {
      insertVec.run(r.id, r.session_id, r.project_id, v.length, Buffer.from(v.buffer));
      done++;
    } catch {
      // skip this message
    }
  }
  return done;
}

export interface VectorHit {
  sessionId: string;
  title: string;
  idx: number;
  snippet: string;
  score: number;
}

export async function vectorSearch(
  query: string,
  opts: {
    projectId?: number;
    limit?: number;
    threshold?: number;
    after?: number;
    before?: number;
  } = {},
): Promise<VectorHit[]> {
  if (!(await ensureEmbedder()) || !embedOne) {
    return [];
  }
  const db = getDb();
  const qv = await embedOne(query);
  const threshold = opts.threshold ?? SEARCH_THRESHOLD;

  const params: Array<number> = [];
  const filters: string[] = [];
  if (opts.projectId !== undefined) {
    filters.push("mv.project_id = ?");
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
  const where = filters.length ? "WHERE " + filters.join(" AND ") : "";

  const rows = db
    .query(
      `SELECT mv.message_id, mv.session_id, mv.vec, m.text, m.idx, s.title
       FROM message_vectors mv
       JOIN messages m ON m.id = mv.message_id
       JOIN sessions s ON s.id = mv.session_id
       ${where}`,
    )
    .all(...params) as Array<{
    message_id: number;
    session_id: string;
    vec: Uint8Array;
    text: string;
    idx: number;
    title: string;
  }>;

  const scored = rows
    .map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      return { r, score: cosine(qv, v) };
    })
    .filter((s) => s.score >= threshold); // similarity floor
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, opts.limit ?? 10).map(({ r, score }) => ({
    sessionId: r.session_id,
    title: r.title,
    idx: r.idx,
    snippet: r.text.slice(0, 160).replace(/\s+/g, " "),
    score: Math.round(score * 10000) / 10000,
  }));
}
