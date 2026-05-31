// Central configuration. Precedence for every knob: KIRO_RECALL_* env var >
// config.toml file > built-in default. Single source of truth for runtime
// knobs — feedback/observability invariant.
//
// The optional config file lets users with non-standard installs override
// paths and tune search without env vars. It is found at (first existing):
//   $KIRO_RECALL_CONFIG
//   $XDG_CONFIG_HOME/kiro-recall/config.toml  (~/.config/... by default)
//   ~/Library/Application Support/kiro-recall/config.toml   (macOS)
//   %APPDATA%/kiro-recall/config.toml                       (Windows)

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

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

// ---- Minimal TOML reader -------------------------------------------------
// Supports exactly what our config needs: [section] / [a.b] headers, key=value
// with string / number / boolean / array-of-string values, and # comments.
// Intentionally tiny (no external dep); unknown/odd lines are ignored.

function parseTomlValue(raw: string): unknown {
  let v = raw.trim();
  if (v.startsWith("[")) {
    const inner = v.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (!inner) {
      return [];
    }
    return inner
      .split(",")
      .map((x) => parseTomlValue(x))
      .filter((x) => x !== "" && x !== undefined);
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  // Strip trailing inline comment for bare scalars.
  const hash = v.indexOf(" #");
  if (hash !== -1) {
    v = v.slice(0, hash).trim();
  }
  if (v === "true") {
    return true;
  }
  if (v === "false") {
    return false;
  }
  const n = Number(v);
  if (v !== "" && Number.isFinite(n)) {
    return n;
  }
  return v;
}

function parseToml(src: string): Record<string, any> {
  const root: Record<string, any> = {};
  let cur: Record<string, any> = root;
  for (const line of src.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) {
      continue;
    }
    const section = s.match(/^\[([^\]]+)\]$/);
    if (section) {
      cur = root;
      for (const part of section[1].split(".").map((p) => p.trim())) {
        cur[part] = cur[part] && typeof cur[part] === "object" ? cur[part] : {};
        cur = cur[part];
      }
      continue;
    }
    const eq = s.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = s.slice(0, eq).trim();
    cur[key] = parseTomlValue(s.slice(eq + 1));
  }
  return root;
}

function configFilePath(): string | null {
  const override = env.KIRO_RECALL_CONFIG;
  if (override) {
    return existsSync(override) ? override : null;
  }
  const candidates = [
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kiro-recall", "config.toml"),
    join(homedir(), "Library", "Application Support", "kiro-recall", "config.toml"),
    ...(env.APPDATA ? [join(env.APPDATA, "kiro-recall", "config.toml")] : []),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const fileConfig: Record<string, any> = (() => {
  try {
    const p = configFilePath();
    return p ? parseToml(readFileSync(p, "utf-8")) : {};
  } catch {
    return {}; // never let a malformed config file break startup
  }
})();

// Look up a dotted path (e.g. "search.threshold") in the parsed file config.
function fc(path: string): unknown {
  return path
    .split(".")
    .reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), fileConfig);
}

// Resolvers: env wins, then file, then default.
function cfgBool(envVal: string | undefined, filePath: string, def: boolean): boolean {
  if (envVal !== undefined) {
    return bool(envVal, def);
  }
  const f = fc(filePath);
  if (typeof f === "boolean") {
    return f;
  }
  if (typeof f === "string") {
    return bool(f, def);
  }
  return def;
}

function cfgInt(envVal: string | undefined, filePath: string, def: number): number {
  if (envVal !== undefined) {
    return int(envVal, def);
  }
  const f = fc(filePath);
  if (typeof f === "number") {
    return f;
  }
  if (typeof f === "string") {
    const n = Number(f);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return def;
}

function cfgNum(envVal: string | undefined, filePath: string, def: number): number {
  return cfgInt(envVal, filePath, def); // same coercion; kept distinct for clarity
}

function cfgStr(envVal: string | undefined, filePath: string, def: string): string {
  if (envVal !== undefined && envVal !== "") {
    return envVal;
  }
  const f = fc(filePath);
  if (typeof f === "string" && f) {
    return f;
  }
  return def;
}

// ---- Resolved configuration ----------------------------------------------

// Data dir holds our derived store + logs. Fully disposable/rebuildable.
export const DATA_DIR = cfgStr(
  env.KIRO_RECALL_DATA_DIR,
  "paths.data_dir",
  join(homedir(), ".kiro-recall"),
);
export const DB_PATH = join(DATA_DIR, "kiro-recall.db");
export const LOG_DIR = join(DATA_DIR, "logs");

// Explicit override for Kiro's globalStorage agent dir (used by paths.ts).
// Empty string => auto-detect by platform.
export const AGENT_DIR_OVERRIDE = cfgStr(env.KIRO_RECALL_AGENT_DIR, "paths.agent_dir", "");

// HTTP server (REST + webview UI).
export const HOST = cfgStr(env.KIRO_RECALL_HOST, "server.host", "127.0.0.1");
export const PORT = cfgInt(env.KIRO_RECALL_PORT, "server.port", 37800);

// Ingest tuning.
export const WATCH_DEBOUNCE_MS = int(env.KIRO_RECALL_WATCH_DEBOUNCE_MS, 2000);
export const POLL_INTERVAL_MS = int(env.KIRO_RECALL_POLL_INTERVAL_MS, 15000);
export const WATCH_ENABLED = cfgBool(env.KIRO_RECALL_WATCH, "watch.enabled", true);

// Semantic (vector) search is ON by default. The embedding backend
// (@xenova/transformers) ships as an optional dependency; if it isn't present
// at runtime, vector search degrades to a safe no-op and FTS still works.
// Disable explicitly with KIRO_RECALL_VECTOR=0 or [vector] enabled = false.
export const VECTOR_ENABLED = cfgBool(env.KIRO_RECALL_VECTOR, "vector.enabled", true);
// LLM observations stay off by default (needs a provider API key).
export const SUMMARIZE_ENABLED = cfgBool(
  env.KIRO_RECALL_SUMMARIZE,
  "summarize.enabled",
  false,
);

// Ingest Kiro's *.chat execution logs (the real agent output) in addition to
// the workspace-session transcripts. On by default; disable with
// KIRO_RECALL_CHAT=0 or [chat] enabled = false.
export const CHAT_INGEST_ENABLED = cfgBool(env.KIRO_RECALL_CHAT, "chat.enabled", true);

// Search tuning (used by FTS + vector search and the MCP tools).
//   threshold     : minimum cosine similarity for a vector hit (0..1).
//   context_size  : messages before/after a hit returned as context.
//   max_results   : default page size for MCP search.
export const SEARCH_THRESHOLD = cfgNum(
  env.KIRO_RECALL_SEARCH_THRESHOLD,
  "search.threshold",
  0.2,
);
export const SEARCH_CONTEXT_SIZE = cfgInt(
  env.KIRO_RECALL_SEARCH_CONTEXT_SIZE,
  "search.context_size",
  2,
);
export const SEARCH_MAX_RESULTS = cfgInt(
  env.KIRO_RECALL_SEARCH_MAX_RESULTS,
  "search.max_results",
  15,
);

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
