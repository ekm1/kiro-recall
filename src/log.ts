// Minimal structured logger. Single feedback channel: stdout + a daily file.

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { LOG_DIR } from "./config.ts";

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

let fileReady = false;

function ensureDir(): void {
  if (!fileReady) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      fileReady = true;
    } catch {
      // Logging must never crash the daemon.
    }
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const extraStr = extra === undefined ? "" : " " + safeJson(extra);
  const line = `[${ts}] [${level}] [${scope}] ${msg}${extraStr}`;
  // eslint-disable-next-line no-console
  console.log(line);
  ensureDir();
  try {
    const day = ts.slice(0, 10);
    appendFileSync(join(LOG_DIR, `kiro-recall-${day}.log`), line + "\n");
  } catch {
    // ignore file errors
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (scope: string, msg: string, extra?: unknown) => write("INFO", scope, msg, extra),
  warn: (scope: string, msg: string, extra?: unknown) => write("WARN", scope, msg, extra),
  error: (scope: string, msg: string, extra?: unknown) => write("ERROR", scope, msg, extra),
  debug: (scope: string, msg: string, extra?: unknown) => {
    if (process.env.KIRO_RECALL_DEBUG) {
      write("DEBUG", scope, msg, extra);
    }
  },
};
