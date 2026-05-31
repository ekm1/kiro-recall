// Daemon entry point. Orchestrates: scan → watch → HTTP API + UI → summarize.
//
// Flags:
//   --scan-once   run a full scan and exit
//   --rebuild     wipe derived DB, full scan, exit
//   (default)     scan, start watcher + HTTP server, stay running
//
// Writes a PID file and handles SIGTERM/SIGINT so daemon-manager can stop it.

import { fullScan } from "./ingest/scanner.ts";
import { getDb, wipeAll } from "./store/db.ts";
import { counts } from "./store/sessions.ts";
import { startServer } from "./api/server.ts";
import { startWatcher, stopWatcher } from "./ingest/watcher.ts";
import { startSummarizeLoop, stopSummarizeLoop } from "./summarize/runner.ts";
import { startIdleMonitor, stopIdleMonitor } from "./ingest/idle.ts";
import { WATCH_ENABLED, DATA_DIR } from "./config.ts";
import { log } from "./log.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const PID_FILE = join(DATA_DIR, "daemon.pid");

function writePid(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid));
  } catch {
    // non-fatal
  }
}

function installShutdownHandlers(): void {
  const shutdown = (sig: string) => {
    log.info("DAEMON", "shutting down", { signal: sig });
    stopWatcher();
    stopSummarizeLoop();
    stopIdleMonitor();
    try {
      rmSync(PID_FILE, { force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return;
}

function gracefulExit(): void {
  stopWatcher();
  stopSummarizeLoop();
  stopIdleMonitor();
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    // ignore
  }
  process.exit(0);
}

function main(): void {
  const args = new Set(process.argv.slice(2));

  getDb(); // init schema

  if (args.has("--rebuild")) {
    log.info("DAEMON", "rebuild: wiping derived store");
    wipeAll();
  }

  const result = fullScan();
  log.info("DAEMON", "scan result", { ...result, totals: counts() });

  if (args.has("--scan-once") || args.has("--rebuild")) {
    process.exit(0);
  }

  writePid();
  installShutdownHandlers();

  startServer();

  if (WATCH_ENABLED) {
    startWatcher();
  }

  startSummarizeLoop();

  startIdleMonitor(gracefulExit);

  log.info("DAEMON", "running", { pid: process.pid });
}

main();
