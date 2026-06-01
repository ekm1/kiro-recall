// Enrichment from Kiro's per-execution agent logs (the "exec store").
//
// Problem this solves: workspace-session transcripts store the assistant turn's
// content as a stub ("On it."). The real generated output — prose + reasoning —
// lives in separate per-execution JSON files under the agent dir, keyed by a
// top-level `executionId` that equals the `executionId` on the transcript's
// assistant turn. We read those, extract the real text, and return a map
// executionId -> assistant text so the parser can splice it onto the right turn.
//
// Performance: the exec store is large (thousands of multi-MB files) and the
// `chatSessionId` sits AFTER a big `input` blob, so we cannot cheaply filter by
// session. Instead we:
//   1. enumerate exec files (cheap, directory walk),
//   2. skip any whose mtime is unchanged since last pass (persisted manifest),
//   3. full-parse only new/changed files, with bounded concurrency,
//   4. persist {path -> mtime, executionId, text} so future passes are cheap.
// The map is cached across rebuilds via the manifest, so the expensive first
// pass is paid once.
//
// Defensive by design: unknown shapes are skipped, never throw.

import { readFile, stat } from "fs/promises";
import { execLogFiles } from "../paths.ts";
import { getMeta, setMeta } from "../store/db.ts";
import { log } from "../log.ts";

// How many files to read+parse concurrently. I/O-bound, so a modest fan-out
// gives most of the win without exhausting file descriptors.
const READ_CONCURRENCY = 24;

export interface ExecText {
  // Concatenated assistant prose ("say" actions), in order.
  say: string;
  // Concatenated reasoning ("reasoning" actions), in order.
  reasoning: string;
}

export type ExecMap = Map<string, ExecText>;

// Persisted manifest: path -> { mtime, executionId, say, reasoning }. Lives in
// the meta table as one JSON blob. Survives --rebuild (which only wipes the
// derived session/message tables), so the costly first parse isn't repeated.
interface ManifestEntry {
  m: number; // mtime ms
  e: string; // executionId
  s: string; // say text
  r: string; // reasoning text
}
type Manifest = Record<string, ManifestEntry>;

const MANIFEST_KEY = "execlog_manifest_v1";

function loadManifest(): Manifest {
  const raw = getMeta(MANIFEST_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Manifest) : {};
  } catch {
    return {};
  }
}

function saveManifest(m: Manifest): void {
  try {
    setMeta(MANIFEST_KEY, JSON.stringify(m));
  } catch (e) {
    log.warn("EXECLOG", "manifest save failed", { error: String(e) });
  }
}

// Pull executionId + say/reasoning text out of one parsed exec-log object.
// Returns null if it isn't a usable exec log.
function extractFromExecObject(raw: unknown): { executionId: string; text: ExecText } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const executionId = typeof o.executionId === "string" ? o.executionId : null;
  if (!executionId) {
    return null;
  }
  const actions = Array.isArray(o.actions) ? o.actions : [];
  const says: string[] = [];
  const reasons: string[] = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") {
      continue;
    }
    const act = a as Record<string, unknown>;
    const type = act.actionType;
    const output = act.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    const message = (output as Record<string, unknown>).message;
    if (typeof message !== "string" || message.trim().length === 0) {
      continue;
    }
    if (type === "say") {
      says.push(message);
    } else if (type === "reasoning") {
      reasons.push(message);
    }
  }
  if (says.length === 0 && reasons.length === 0) {
    return null; // nothing searchable (pure tool-call execution)
  }
  return {
    executionId,
    text: { say: says.join("\n\n"), reasoning: reasons.join("\n\n") },
  };
}

// Run an async worker over items with bounded concurrency.
async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(run());
  }
  await Promise.all(runners);
}

export interface BuildExecMapResult {
  map: ExecMap;
  filesSeen: number;
  parsed: number; // newly read+parsed this pass
  reused: number; // served from manifest (unchanged)
  errors: number;
}

// Build the executionId -> assistant-text map. Incremental: only new/changed
// files are read; unchanged files come from the persisted manifest.
export async function buildExecMap(): Promise<BuildExecMapResult> {
  const files = execLogFiles();
  const prev = loadManifest();
  const next: Manifest = {};
  const map: ExecMap = new Map();

  let parsed = 0;
  let reused = 0;
  let errors = 0;

  // First, stat all files (cheap) and split into reuse vs parse.
  const toParse: string[] = [];
  await mapLimit(files, READ_CONCURRENCY, async (file) => {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      errors++;
      return;
    }
    const cached = prev[file];
    if (cached && cached.m === mtimeMs) {
      next[file] = cached;
      if (cached.e) {
        map.set(cached.e, { say: cached.s, reasoning: cached.r });
      }
      reused++;
    } else {
      // Carry mtime forward; content filled in during the parse pass.
      toParse.push(file);
      next[file] = { m: mtimeMs, e: "", s: "", r: "" };
    }
  });

  // Parse only the new/changed files, bounded concurrency.
  await mapLimit(toParse, READ_CONCURRENCY, async (file) => {
    let buf: string;
    try {
      buf = await readFile(file, "utf-8");
    } catch {
      errors++;
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(buf);
    } catch {
      // Not JSON / partial write — leave as empty manifest entry (mtime kept,
      // so we won't retry until it changes).
      return;
    }
    const extracted = extractFromExecObject(obj);
    if (!extracted) {
      return;
    }
    map.set(extracted.executionId, extracted.text);
    const entry = next[file];
    if (entry) {
      entry.e = extracted.executionId;
      entry.s = extracted.text.say;
      entry.r = extracted.text.reasoning;
    }
    parsed++;
  });

  saveManifest(next);

  return { map, filesSeen: files.length, parsed, reused, errors };
}
