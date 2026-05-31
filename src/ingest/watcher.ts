// Live ingest. Two mechanisms, both idempotent against the scanner:
//   1. fs.watch on the workspace-sessions root (debounced per project dir)
//   2. periodic poll fallback (catches missed fs events / atomic renames)
//
// Timing invariant: every path funnels into scanSingleProjectDir / fullScan,
// which skip unchanged sessions by content hash. Duplicate events are harmless.

import { watch, type FSWatcher } from "fs";
import { join, dirname } from "path";
import { workspaceSessionsDir } from "../paths.ts";
import { scanSingleProjectDir, fullScan } from "./scanner.ts";
import { WATCH_DEBOUNCE_MS, POLL_INTERVAL_MS } from "../config.ts";
import { log } from "../log.ts";

let watcher: FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleProjectScan(projectDir: string): void {
  const existing = pending.get(projectDir);
  if (existing) {
    clearTimeout(existing);
  }
  pending.set(
    projectDir,
    setTimeout(() => {
      pending.delete(projectDir);
      try {
        scanSingleProjectDir(projectDir);
      } catch (e) {
        log.warn("WATCH", "scan failed", { projectDir, error: String(e) });
      }
    }, WATCH_DEBOUNCE_MS),
  );
}

export function startWatcher(): void {
  const root = workspaceSessionsDir();
  if (!root) {
    log.warn("WATCH", "no workspace-sessions dir; watcher disabled");
    return;
  }

  try {
    // Recursive watch: filename arrives as "<projectDir>/<file>.json".
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".json")) {
        return;
      }
      // filename is relative to root; first segment is the project dir.
      const rel = String(filename);
      const firstSlash = rel.indexOf("/");
      const projectSegment = firstSlash === -1 ? rel : rel.slice(0, firstSlash);
      if (firstSlash === -1) {
        // event on the dir itself or a top-level file — rescan that dir below
        return;
      }
      scheduleProjectScan(join(root, projectSegment));
    });
    log.info("WATCH", "watching", { root });
  } catch (e) {
    log.warn("WATCH", "fs.watch failed; relying on poll", { error: String(e) });
  }

  // Poll fallback — cheap full scan on an interval (content-hash skips no-ops).
  pollTimer = setInterval(() => {
    try {
      fullScan();
    } catch (e) {
      log.warn("WATCH", "poll scan failed", { error: String(e) });
    }
  }, POLL_INTERVAL_MS);
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const t of pending.values()) {
    clearTimeout(t);
  }
  pending.clear();
}

// silence unused import in some bundlers
void dirname;
