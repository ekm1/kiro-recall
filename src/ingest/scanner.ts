// Full scan of Kiro's workspace-sessions tree. Idempotent: safe to run
// repeatedly. Backfills all history on first run (solves "predates capture").

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { workspaceSessionsDir, chatFiles } from "../paths.ts";
import { parseSessionFile, parseSessionIndex } from "./parser.ts";
import { parseChatFile } from "./chat.ts";
import { loadRepoRegistry, type RepoRegistry } from "./repos.ts";
import {
  applyIndexTimestamp,
  upsertProject,
  upsertSession,
} from "../store/sessions.ts";
import { setMeta } from "../store/db.ts";
import { CHAT_INGEST_ENABLED } from "../config.ts";
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
function scanProjectDir(dir: string, registry: RepoRegistry): Omit<ScanResult, "projects"> {
  let filesSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let errors = 0;

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
    const raw = readJson(filePath);
    if (!raw) {
      errors++;
      continue;
    }
    const session = parseSessionFile(raw, projectPath, mtimeMs, registry);
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

// Scan Kiro's *.chat execution logs (the real agent output). Reuses the same
// idempotent upsert path; content-hash makes re-scans no-ops.
function scanChatFiles(registry: RepoRegistry): Omit<ScanResult, "projects"> {
  let filesSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of chatFiles()) {
    filesSeen++;
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // keep default
    }
    const raw = readJson(file);
    if (!raw) {
      errors++;
      continue;
    }
    const session = parseChatFile(raw, file, mtimeMs, registry);
    if (!session) {
      continue; // not a usable .chat / no text
    }
    try {
      if (upsertSession(session)) {
        upserted++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors++;
      log.warn("CHAT", "upsert failed", {
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { filesSeen, upserted, skipped, errors };
}

export function fullScan(): ScanResult {
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

  for (const dir of projectDirs) {
    const r = scanProjectDir(dir, registry);
    result.projects++;
    result.filesSeen += r.filesSeen;
    result.upserted += r.upserted;
    result.skipped += r.skipped;
    result.errors += r.errors;
  }

  // Additional source: Kiro's *.chat execution logs (real agent output).
  if (CHAT_INGEST_ENABLED) {
    const c = scanChatFiles(registry);
    result.filesSeen += c.filesSeen;
    result.upserted += c.upserted;
    result.skipped += c.skipped;
    result.errors += c.errors;
    if (c.filesSeen > 0) {
      log.info("CHAT", "chat-file scan", c);
    }
  }

  setMeta("last_scan", String(Date.now()));
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
