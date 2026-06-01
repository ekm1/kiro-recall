// Full scan of Kiro's workspace-sessions tree. Idempotent: safe to run
// repeatedly. Backfills all history on first run (solves "predates capture").

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { workspaceSessionsDir } from "../paths.ts";
import { parseSessionFile, parseSessionIndex } from "./parser.ts";
import { loadRepoRegistry, type RepoRegistry } from "./repos.ts";
import { buildExecMap, type ExecMap } from "./execlog.ts";
import {
  applyIndexTimestamp,
  upsertProject,
  upsertSession,
} from "../store/sessions.ts";
import { setMeta, pruneOlderThan } from "../store/db.ts";
import { CHAT_INGEST_ENABLED, RETENTION_DAYS } from "../config.ts";
import { log } from "../log.ts";
import type { SessionIndexEntry } from "../types.ts";

export interface ScanResult {
  projects: number;
  filesSeen: number;
  upserted: number;
  skipped: number;
  errors: number;
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Scan a single project directory (named by base64url workspace path).
function scanProjectDir(
  dir: string,
  registry: RepoRegistry,
  execMap?: ExecMap,
): Omit<ScanResult, "projects"> {
  let filesSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let errors = 0;

  // Retention cutoff: ignore transcript files not touched within the window.
  // Keeps the index lean and avoids re-ingesting chats the pruner will drop.
  const cutoffMs = RETENTION_DAYS > 0 ? Date.now() - RETENTION_DAYS * 86400000 : 0;

  // 1. Read the index for authoritative titles/timestamps + project path.
  let index: SessionIndexEntry[] = [];
  let projectPath = "";
  const indexPath = join(dir, "sessions.json");
  const indexRaw = readJson(indexPath);
  if (indexRaw) {
    index = parseSessionIndex(indexRaw);
    projectPath = index.find((e) => e.workspaceDirectory)?.workspaceDirectory ?? "";
  }
  const indexById = new Map(index.map((e) => [e.sessionId, e]));

  // 2. Parse each transcript file.
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { filesSeen, upserted, skipped, errors: errors + 1 };
  }

  if (projectPath) {
    upsertProject(projectPath, Date.now());
  }

  for (const name of entries) {
    if (!name.endsWith(".json") || name === "sessions.json") {
      continue;
    }
    const filePath = join(dir, name);
    filesSeen++;
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      // keep default
    }
    // Skip files outside the retention window (cheap mtime gate, pre-parse).
    if (cutoffMs > 0 && mtimeMs < cutoffMs) {
      skipped++;
      continue;
    }
    const raw = readJson(filePath);
    if (!raw) {
      errors++;
      continue;
    }
    const session = parseSessionFile(raw, projectPath, mtimeMs, registry, execMap);
    if (!session) {
      continue; // not a transcript / unusable
    }
    try {
      const changed = upsertSession(session);
      if (changed) {
        upserted++;
        const idx = indexById.get(session.sessionId);
        if (idx) {
          applyIndexTimestamp(session.sessionId, idx.dateCreated);
        }
      } else {
        skipped++;
      }
    } catch (e) {
      errors++;
      log.warn("SCAN", "upsert failed", {
        sessionId: session.sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { filesSeen, upserted, skipped, errors };
}

export async function fullScan(): Promise<ScanResult> {
  const root = workspaceSessionsDir();
  const result: ScanResult = {
    projects: 0,
    filesSeen: 0,
    upserted: 0,
    skipped: 0,
    errors: 0,
  };
  if (!root) {
    log.error("SCAN", "Kiro workspace-sessions directory not found");
    return result;
  }

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch (e) {
    log.error("SCAN", "failed to read root", { error: String(e) });
    return result;
  }

  const registry = loadRepoRegistry(true);

  // Build the exec-store enrichment map (executionId -> real assistant text)
  // so transcript "On it." stubs get replaced with the actual output. Gated by
  // config; incremental via a persisted mtime manifest so it's cheap after the
  // first pass. Failure here must never block transcript ingestion.
  let execMap: ExecMap | undefined;
  if (CHAT_INGEST_ENABLED) {
    try {
      const r = await buildExecMap();
      execMap = r.map;
      log.info("EXECLOG", "enrichment map built", {
        executions: r.map.size,
        filesSeen: r.filesSeen,
        parsed: r.parsed,
        reused: r.reused,
        errors: r.errors,
      });
    } catch (e) {
      log.warn("EXECLOG", "enrichment failed, proceeding without it", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  for (const dir of projectDirs) {
    const r = scanProjectDir(dir, registry, execMap);
    result.projects++;
    result.filesSeen += r.filesSeen;
    result.upserted += r.upserted;
    result.skipped += r.skipped;
    result.errors += r.errors;
  }

  setMeta("last_scan", String(Date.now()));

  // Retention prune: drop anything that aged out of the window this pass.
  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const removed = pruneOlderThan(cutoff);
    if (removed > 0) {
      log.info("RETENTION", "pruned stale sessions", { removed, retentionDays: RETENTION_DAYS });
    }
  }

  log.info("SCAN", "full scan complete", result);
  return result;
}

// Scan a single project dir given its on-disk path (used by the watcher).
export function scanSingleProjectDir(dir: string): void {
  const registry = loadRepoRegistry();
  const r = scanProjectDir(dir, registry);
  if (r.upserted > 0) {
    log.info("SCAN", "incremental update", { dir, ...r });
  }
}
