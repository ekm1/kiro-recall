// Central configuration. All values overridable via KIRO_RECALL_* env vars.
// Single source of truth for runtime knobs — feedback/observability invariant.

import { homedir } from "os";
import { join } from "path";

const env = process.env;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "on";
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Data dir holds our derived store + logs. Fully disposable/rebuildable.
export const DATA_DIR = env.KIRO_RECALL_DATA_DIR || join(homedir(), ".kiro-recall");
export const DB_PATH = join(DATA_DIR, "kiro-recall.db");
export const LOG_DIR = join(DATA_DIR, "logs");

// HTTP server (REST + webview UI).
export const HOST = env.KIRO_RECALL_HOST || "127.0.0.1";
export const PORT = int(env.KIRO_RECALL_PORT, 37800);

// Ingest tuning.
export const WATCH_DEBOUNCE_MS = int(env.KIRO_RECALL_WATCH_DEBOUNCE_MS, 2000);
export const POLL_INTERVAL_MS = int(env.KIRO_RECALL_POLL_INTERVAL_MS, 15000);
export const WATCH_ENABLED = bool(env.KIRO_RECALL_WATCH, true);

// Optional layers (off by default — zero cost, zero external deps).
export const VECTOR_ENABLED = bool(env.KIRO_RECALL_VECTOR, false);
export const SUMMARIZE_ENABLED = bool(env.KIRO_RECALL_SUMMARIZE, false);

// Idle shutdown: stop the daemon when the IDE is gone so it doesn't linger.
// Checked periodically; the daemon exits if Kiro hasn't been seen for this long.
export const IDLE_SHUTDOWN_MS = int(env.KIRO_RECALL_IDLE_SHUTDOWN_MS, 5 * 60 * 1000);
export const IDLE_CHECK_INTERVAL_MS = int(env.KIRO_RECALL_IDLE_CHECK_MS, 60 * 1000);
// Set KIRO_RECALL_IDLE_SHUTDOWN_MS=0 to disable idle shutdown entirely.

// Summarize provider config (only used when SUMMARIZE_ENABLED).
export const SUMMARIZE_PROVIDER = env.KIRO_RECALL_SUMMARIZE_PROVIDER || "none";
export const SUMMARIZE_MODEL = env.KIRO_RECALL_SUMMARIZE_MODEL || "claude-3-5-haiku-latest";
export const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || env.KIRO_RECALL_ANTHROPIC_API_KEY || "";
export const OPENAI_API_KEY = env.OPENAI_API_KEY || env.KIRO_RECALL_OPENAI_API_KEY || "";
