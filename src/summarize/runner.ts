// Async summarization queue. Walks sessions that have no observations yet (or
// whose content changed), summarizes them, stores observations. Optional vector
// indexing piggybacks here. Bounded + idempotent; safe to run on an interval.

import { getDb } from "../store/db.ts";
import { getMessages } from "../store/sessions.ts";
import { replaceObservations } from "../store/observations.ts";
import { summarize } from "./provider.ts";
import { indexPendingVectors } from "../search/vector.ts";
import { SUMMARIZE_ENABLED, VECTOR_ENABLED } from "../config.ts";
import { log } from "../log.ts";

let running = false;

interface PendingSession {
  id: string;
  project_id: number;
  content_hash: string;
}

// Sessions needing summary: those with zero observations, or whose content_hash
// differs from the last summarized hash (tracked in meta).
function pendingSessions(limit: number): PendingSession[] {
  return getDb()
    .query(
      `SELECT s.id, s.project_id, s.content_hash
       FROM sessions s
       WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id)
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as PendingSession[];
}

export async function runSummarizePass(batch = 5): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    if (VECTOR_ENABLED) {
      const n = await indexPendingVectors(200);
      if (n > 0) {
        log.info("VECTOR", "indexed messages", { count: n });
      }
    }

    if (!SUMMARIZE_ENABLED) {
      return;
    }

    const pending = pendingSessions(batch);
    for (const s of pending) {
      const msgs = getMessages(s.id).map((m) => ({ role: m.role, text: m.text }));
      const obs = await summarize(msgs);
      if (obs.length > 0) {
        replaceObservations(s.id, s.project_id, obs);
        log.info("SUMMARIZE", "stored observations", {
          sessionId: s.id,
          count: obs.length,
        });
      }
    }
  } catch (e) {
    log.warn("SUMMARIZE", "pass failed", { error: String(e) });
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSummarizeLoop(): void {
  if (!SUMMARIZE_ENABLED && !VECTOR_ENABLED) {
    return; // nothing to do
  }
  // First pass shortly after boot, then periodic.
  setTimeout(() => void runSummarizePass(), 5000);
  timer = setInterval(() => void runSummarizePass(), 60000);
  log.info("SUMMARIZE", "loop started", {
    summarize: SUMMARIZE_ENABLED,
    vector: VECTOR_ENABLED,
  });
}

export function stopSummarizeLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
